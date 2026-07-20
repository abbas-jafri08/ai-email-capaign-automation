"""
AI Email Campaign Automation Agent (Python / Flask)
----------------------------------------------------
- POST /api/generate                       -> AI-drafted subject + HTML body
- POST /api/send-campaign                   -> Sends personalized bulk emails via SMTP,
                                                streaming live progress back to the browser (SSE)
- GET  /api/campaigns                       -> List all campaigns sent this server run
- GET  /api/campaign/<campaign_id>/status   -> Per-recipient detail for one campaign
                                                (sent / failed / opened)
- GET  /api/track/<token>.gif               -> 1x1 tracking pixel, marks a recipient "opened"
- GET  /api/health                          -> Simple health check

Run:
    pip install -r requirements.txt
    cp .env.example .env    (fill in GROQ_API_KEY if you want AI drafting)
    python app.py
    open http://localhost:3000
"""

import os
import re
import csv
import io
import json
import time
import uuid
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import requests
from flask import Flask, request, jsonify, Response
from dotenv import load_dotenv

import store

load_dotenv()

# NOTE: no static_folder here. On Vercel, static assets are served straight
# from the public/ directory by the CDN, not by Flask — see public/.
# (Flask's static_folder should not be used for static files on Vercel.)
app = Flask(__name__)

PORT = int(os.environ.get("PORT", 3000))
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
# Used to build the tracking pixel URL embedded in outgoing emails.
# Falls back to the incoming request's host if not set.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")

PLACEHOLDER_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")

# 1x1 transparent GIF, served for every tracking pixel hit.
TRACKING_GIF = bytes.fromhex(
    "47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b"
)

# ---------------------------------------------------------------------------
# Campaign store (see store.py — Redis-backed on Vercel, in-memory locally)
# ---------------------------------------------------------------------------
# campaigns[campaign_id] = {
#     "subject": str,
#     "created_at": float,
#     "total": int,
#     "recipients": {
#         email: {
#             "token": str,
#             "status": "pending" | "sent" | "failed",
#             "error": str | None,
#             "sent_at": float | None,
#             "opened": bool,
#             "opened_at": float | None,
#         }
#     }
# }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def personalize(template: str, recipient: dict) -> str:
    """Replaces {{field}} with recipient data; leaves placeholder if missing."""

    def replace(match):
        key = match.group(1)
        value = recipient.get(key, "")
        return value if value else match.group(0)

    return PLACEHOLDER_RE.sub(replace, template)


def parse_csv(csv_text: str):
    """Parses CSV text into a list of recipient dicts. First row = headers."""
    csv_text = csv_text.strip()
    if not csv_text:
        return []
    reader = csv.DictReader(io.StringIO(csv_text))
    rows = []
    for row in reader:
        clean = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        rows.append(clean)
    return rows


def sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def build_tracking_pixel(base_url: str, token: str) -> str:
    return (
        f'<img src="{base_url}/api/track/{token}.gif" '
        f'width="1" height="1" style="display:none" alt="" />'
    )


def recipient_status_list(campaign_id: str):
    """Per-recipient detail for a campaign, in a frontend-friendly shape."""
    campaign = store.get_campaign(campaign_id)
    if not campaign:
        return None
    out = []
    for email, info in campaign["recipients"].items():
        out.append({
            "email": email,
            "status": info["status"],       # pending | sent | failed
            "error": info["error"],
            "sentAt": info["sent_at"],
            "opened": info["opened"],
            "openedAt": info["opened_at"],
        })
    return out


def campaign_summary(campaign_id: str, campaign: dict) -> dict:
    recipients = campaign["recipients"].values()
    sent = sum(1 for r in recipients if r["status"] == "sent")
    failed = sum(1 for r in recipients if r["status"] == "failed")
    opened = sum(1 for r in recipients if r["opened"])
    return {
        "campaignId": campaign_id,
        "subject": campaign["subject"],
        "createdAt": campaign["created_at"],
        "total": campaign["total"],
        "sent": sent,
        "failed": failed,
        "opened": opened,
    }


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
# On Vercel, everything in public/ (index.html, app.js, style.css) is served
# directly by the CDN — this Flask app only ever handles /api/* routes there.
# This route is just a convenience fallback for `python app.py` locally.

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


@app.route("/")
def index():
    from flask import send_from_directory
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:filename>")
def public_asset(filename):
    from flask import send_from_directory
    return send_from_directory(PUBLIC_DIR, filename)


# ---------------------------------------------------------------------------
# POST /api/generate -> AI-drafted subject + HTML body via Groq
# ---------------------------------------------------------------------------

@app.route("/api/generate", methods=["POST"])
def generate():
    body = request.get_json(force=True, silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    tone = body.get("tone") or "professional and friendly"
    audience = body.get("audience") or "general subscriber list"

    if not prompt:
        return jsonify({"error": "A prompt describing the campaign is required."}), 400

    if not GROQ_API_KEY:
        return jsonify({
            "error": (
                "No GROQ_API_KEY configured on the server. "
                "Add one to your .env file."
            )
        }), 400

    system_prompt = """You are an expert email marketing copywriter. Given a campaign brief, produce:
1. A compelling subject line (under 65 characters)
2. An HTML email body that uses {{name}} as a personalization placeholder for the recipient's name (and optionally other {{field}} placeholders the user's CSV might contain, like {{company}}).

Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{"subject": "...", "body_html": "..."}

The body_html should be simple, clean, inline-styled HTML suitable for an email client (use <p>, <a>, <strong>, etc. — no <script>, no external stylesheets). Keep it concise and persuasive."""

    user_msg = f"Campaign brief: {prompt}\nTone: {tone}\nTarget audience: {audience}"

    try:
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                "temperature": 0.7,
                "max_tokens": 1200,
            },
            timeout=60,
        )
    except requests.RequestException as e:
        return jsonify({"error": f"Request to Groq API failed: {e}"}), 502

    if resp.status_code != 200:
        return jsonify({"error": f"Groq API error: {resp.text}"}), 502

    data = resp.json()
    try:
        raw = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        return jsonify({"error": "Unexpected Groq response shape.", "raw": data}), 502

    cleaned = re.sub(r"```json|```", "", raw).strip()
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return jsonify({"error": "Could not parse AI response as JSON.", "raw": raw}), 502

    return jsonify(parsed)


# ---------------------------------------------------------------------------
# POST /api/send-campaign -> streams progress via Server-Sent Events (SSE)
# ---------------------------------------------------------------------------

@app.route("/api/send-campaign", methods=["POST"])
def send_campaign():
    body = request.get_json(force=True, silent=True) or {}
    smtp_cfg = body.get("smtp") or {}
    subject = body.get("subject")
    body_html = body.get("bodyHtml")
    recipients_csv = body.get("recipientsCsv") or ""
    delay_ms = body.get("delayMs")

    if not smtp_cfg.get("host") or not smtp_cfg.get("user") or not smtp_cfg.get("pass"):
        return jsonify({"error": "SMTP host, user, and password are required."}), 400
    if not subject or not body_html:
        return jsonify({"error": "Subject and body are required."}), 400

    recipients = parse_csv(recipients_csv)
    if not recipients:
        return jsonify({"error": "No valid recipients found in CSV."}), 400
    if "email" not in recipients[0]:
        return jsonify({"error": 'CSV must include an "email" column (first row = headers).'}), 400

    try:
        wait_seconds = max(int(delay_ms), 200) / 1000.0
    except (TypeError, ValueError):
        wait_seconds = 0.5

    # Base URL for the tracking pixel — prefer explicit config, else infer from this request.
    base_url = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    # If nobody set PUBLIC_BASE_URL and we're running locally, the tracking
    # pixel URL embedded in outgoing emails won't be reachable by recipients'
    # mail clients — "opened" will silently never fire. Surface that instead
    # of failing silently.
    tracking_unreachable = any(
        h in base_url for h in ("localhost", "127.0.0.1", "0.0.0.0")
    )

    # ---- Set up the campaign record + a tracking token per recipient ----
    campaign_id = uuid.uuid4().hex
    campaign_record = {
        "subject": subject,
        "created_at": time.time(),
        "total": 0,
        "recipients": {},
    }
    for recipient in recipients:
        email_addr = recipient.get("email")
        if not email_addr:
            continue
        token = uuid.uuid4().hex
        campaign_record["recipients"][email_addr] = {
            "token": token,
            "status": "pending",
            "error": None,
            "sent_at": None,
            "opened": False,
            "opened_at": None,
        }
        store.save_token(token, campaign_id, email_addr)
    campaign_record["total"] = len(campaign_record["recipients"])
    store.save_campaign(campaign_id, campaign_record)

    def generate_events():
        host = smtp_cfg["host"]
        try:
            port = int(smtp_cfg.get("port") or 587)
        except ValueError:
            port = 587
        user = smtp_cfg["user"]
        password = smtp_cfg["pass"]
        from_name = smtp_cfg.get("fromName") or ""

        # Connect
        try:
            if port == 465:
                server = smtplib.SMTP_SSL(host, port, timeout=20)
            else:
                server = smtplib.SMTP(host, port, timeout=20)
                server.starttls()
            server.login(user, password)
        except Exception as e:
            yield sse_event({"type": "fatal", "message": f"SMTP connection failed: {e}"})
            return

        total = len(recipients)
        yield sse_event({
            "type": "start",
            "total": total,
            "campaignId": campaign_id,
            "trackingUnreachable": tracking_unreachable,
        })

        sent = 0
        failed = 0

        for i, recipient in enumerate(recipients):
            email_addr = recipient.get("email")
            if not email_addr:
                continue

            rec_info = campaign_record["recipients"][email_addr]
            personalized_subject = personalize(subject, recipient)
            personalized_body = personalize(body_html, recipient)
            personalized_body += build_tracking_pixel(base_url, rec_info["token"])

            try:
                msg = MIMEMultipart("alternative")
                msg["Subject"] = personalized_subject
                msg["From"] = f'"{from_name}" <{user}>' if from_name else user
                msg["To"] = email_addr
                msg.attach(MIMEText(personalized_body, "html"))

                server.sendmail(user, [email_addr], msg.as_string())

                sent += 1
                rec_info["status"] = "sent"
                rec_info["sent_at"] = time.time()
                store.save_campaign(campaign_id, campaign_record)
                yield sse_event({
                    "type": "progress",
                    "index": i + 1,
                    "total": total,
                    "email": email_addr,
                    "status": "sent",
                })
            except Exception as e:
                failed += 1
                rec_info["status"] = "failed"
                rec_info["error"] = str(e)
                store.save_campaign(campaign_id, campaign_record)
                yield sse_event({
                    "type": "progress",
                    "index": i + 1,
                    "total": total,
                    "email": email_addr,
                    "status": "failed",
                    "error": str(e),
                })

            if i < total - 1:
                time.sleep(wait_seconds)

        try:
            server.quit()
        except Exception:
            pass

        yield sse_event({
            "type": "done",
            "sent": sent,
            "failed": failed,
            "total": total,
            "campaignId": campaign_id,
        })

    return Response(generate_events(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })


# ---------------------------------------------------------------------------
# GET /api/campaigns -> list of campaigns sent this server run, newest first
# ---------------------------------------------------------------------------

@app.route("/api/campaigns", methods=["GET"])
def list_campaigns():
    summaries = []
    for cid in store.list_campaign_ids():
        c = store.get_campaign(cid)
        if c:
            summaries.append(campaign_summary(cid, c))
    summaries.sort(key=lambda c: c["createdAt"], reverse=True)
    return jsonify({"campaigns": summaries})


# ---------------------------------------------------------------------------
# GET /api/campaign/<campaign_id>/status -> per-recipient sent/failed/opened
# ---------------------------------------------------------------------------

@app.route("/api/campaign/<campaign_id>/status", methods=["GET"])
def campaign_status(campaign_id):
    recipients = recipient_status_list(campaign_id)
    if recipients is None:
        return jsonify({"error": "Unknown campaign id."}), 404
    campaign = store.get_campaign(campaign_id)
    return jsonify({
        "campaignId": campaign_id,
        "recipients": recipients,
        **{k: v for k, v in campaign_summary(campaign_id, campaign).items() if k != "campaignId"},
    })


# ---------------------------------------------------------------------------
# GET /api/track/<token>.gif -> tracking pixel, marks recipient "opened"
# ---------------------------------------------------------------------------

@app.route("/api/track/<token>.gif", methods=["GET"])
def track_open(token):
    mapping = store.resolve_token(token)
    if mapping:
        campaign_id, email_addr = mapping
        store.mark_opened(campaign_id, email_addr)

    return Response(
        TRACKING_GIF,
        mimetype="image/gif",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "aiConfigured": bool(GROQ_API_KEY)})


if __name__ == "__main__":
    print(f"AI Email Campaign Agent running at http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True)