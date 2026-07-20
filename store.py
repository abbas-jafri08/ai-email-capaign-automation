"""
Persistent campaign store.

Why this file exists:
On Vercel (and any serverless host), every request can land on a different,
short-lived process. The old code kept campaigns in a plain Python dict in
memory — that only works when one long-running process handles every
request. In production the request that SENDS an email and the request that
later serves the recipient's TRACKING PIXEL hit are almost never the same
process, so the in-memory dict the pixel handler sees is empty and "opened"
can never update. This module swaps that dict for Upstash Redis (a REST-based
Redis you can query from any stateless function) so all instances share the
same state.

Local development without Redis configured still works: if UPSTASH_REDIS_REST_URL
/ UPSTASH_REDIS_REST_TOKEN aren't set, everything falls back to the same
in-memory dict as before (fine for `python app.py` on your own machine, NOT
fine for a real deployment with more than one recipient/instance).
"""

import os
import json
import time
import requests

UPSTASH_URL = os.environ.get("UPSTASH_REDIS_REST_URL", "").rstrip("/")
UPSTASH_TOKEN = os.environ.get("UPSTASH_REDIS_REST_TOKEN", "")
USE_REDIS = bool(UPSTASH_URL and UPSTASH_TOKEN)

# In-memory fallback (local dev only — do not rely on this in production)
_mem_campaigns: dict = {}
_mem_tokens: dict = {}
_mem_index: list = []


def _redis(*args):
    """Send one command to Upstash's REST API. Body = JSON array command form,
    which avoids URL-encoding issues with JSON values containing slashes etc."""
    resp = requests.post(
        UPSTASH_URL,
        headers={"Authorization": f"Bearer {UPSTASH_TOKEN}"},
        json=list(args),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json().get("result")


def save_campaign(campaign_id: str, campaign: dict) -> None:
    if USE_REDIS:
        _redis("SET", f"campaign:{campaign_id}", json.dumps(campaign))
        # keep an index list of campaign ids, newest first
        _redis("LREM", "campaigns:index", 0, campaign_id)
        _redis("LPUSH", "campaigns:index", campaign_id)
    else:
        _mem_campaigns[campaign_id] = campaign
        if campaign_id in _mem_index:
            _mem_index.remove(campaign_id)
        _mem_index.insert(0, campaign_id)


def get_campaign(campaign_id: str):
    if USE_REDIS:
        raw = _redis("GET", f"campaign:{campaign_id}")
        return json.loads(raw) if raw else None
    return _mem_campaigns.get(campaign_id)


def list_campaign_ids():
    if USE_REDIS:
        return _redis("LRANGE", "campaigns:index", 0, -1) or []
    return list(_mem_index)


def save_token(token: str, campaign_id: str, email: str) -> None:
    if USE_REDIS:
        _redis("SET", f"token:{token}", f"{campaign_id}|{email}")
    else:
        _mem_tokens[token] = (campaign_id, email)


def resolve_token(token: str):
    """Returns (campaign_id, email) or None."""
    if USE_REDIS:
        raw = _redis("GET", f"token:{token}")
        if not raw:
            return None
        campaign_id, email = raw.split("|", 1)
        return campaign_id, email
    return _mem_tokens.get(token)


def mark_opened(campaign_id: str, email: str) -> None:
    """Read-modify-write; first open wins (won't overwrite an existing timestamp)."""
    campaign = get_campaign(campaign_id)
    if not campaign:
        return
    rec = campaign.get("recipients", {}).get(email)
    if rec and not rec.get("opened"):
        rec["opened"] = True
        rec["opened_at"] = time.time()
        save_campaign(campaign_id, campaign)
