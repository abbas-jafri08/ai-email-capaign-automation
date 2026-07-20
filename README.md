# AI Email Campaign Automation Agent (Python)

A simple, self-hosted tool for drafting and sending bulk personalized email campaigns.
Python/Flask backend + a plain HTML/CSS/JS frontend. Runs locally or on Vercel.

- **AI drafting**: describe your campaign, get a subject line + HTML body back (via Groq).
- **Bulk sending**: paste a CSV of recipients, and each email is personalized with `{{name}}`, `{{company}}`, or any column in your CSV.
- **Live progress**: a real-time log shows each email as it sends (or fails), streamed to the browser via Server-Sent Events.
- **Open tracking**: a 1x1 pixel marks each recipient "opened" once their mail client loads it.
- **Any SMTP provider**: Gmail, Outlook, SendGrid, Mailgun, your own mail server, etc. (uses Python's built-in `smtplib`).

## Run locally

```bash
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # optional — see below
python app.py
```

Then open **http://localhost:3000**.

Everything works locally with zero extra setup (campaign data falls back to an
in-memory store). The one thing that **won't** work locally is "opened"
tracking, unless you tunnel your machine with something like `ngrok http 3000`
and set `PUBLIC_BASE_URL` to the https URL it gives you — your own laptop
isn't reachable from the outside world, so a recipient's mail client can
never load the tracking pixel otherwise.

### Optional: AI drafting

The "Generate with AI" button calls Groq. Skip this entirely if you'd rather
write your own subject/body — everything else works without it.

```
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
```

## Deploying to Vercel

This app is set up to deploy to Vercel as-is (Python/Flask serverless
function + a static `public/` frontend). Two things are **required** in
production that aren't required locally:

### 1. A Redis database (for campaigns + "opened" tracking to actually work)

Serverless functions don't share memory between requests — each invocation
can run on a different, short-lived process. The request that sends an email
and the later request that serves the tracking-pixel hit almost never land
on the same process, so without a shared store, "opened" can never register
and "Your campaigns" can appear empty after a redeploy or under any real
traffic. This app already talks to Upstash Redis for exactly this reason
(`store.py`) — you just need to create one and set two env vars:

1. Create a free database at [console.upstash.com](https://console.upstash.com)
   (or add "Upstash" from the Vercel Marketplace/Integrations to your project,
   which creates one and injects these vars for you automatically).
2. In your Vercel project → **Settings → Environment Variables**, add:
   ```
   UPSTASH_REDIS_REST_URL=...
   UPSTASH_REDIS_REST_TOKEN=...
   ```

### 2. `PUBLIC_BASE_URL`

Set this to your production domain (e.g. `https://your-project.vercel.app`
or a custom domain), also under **Settings → Environment Variables**. If you
skip it, the app falls back to the requesting domain, which technically works
on Vercel — but Vercel preview deployments get a new URL every time, which
would break the pixel link in emails you already sent from a previous
preview. Setting it explicitly to your stable production domain avoids that.

### 3. Deploy

```bash
npm i -g vercel     # if you don't have the CLI
vercel               # first run: links/creates the project, deploys a preview
vercel --prod        # deploy to your production domain
```

Or just connect the repo in the Vercel dashboard (Import Project → your repo) —
either way, no extra build config is needed beyond what's already in this
repo; Vercel auto-detects `app.py` as the Flask entrypoint and serves
everything in `public/` as static assets.

Also add `GROQ_API_KEY` / `GROQ_MODEL` there too if you want AI drafting in
production.

### Vercel limitations worth knowing about

- **Execution time limit.** `vercel.json` requests 60s (`maxDuration`) for the
  send-campaign function, but the **Hobby (free) plan hard-caps every
  function at 10 seconds regardless of what you set** — Pro/Enterprise plans
  can actually use up to 60s+. At the default 500ms delay between sends, that
  means a free-plan deployment can safely send roughly ~15–18 emails per
  request before Vercel kills the function mid-send. For bigger lists, either
  upgrade to Pro, or lower the delay and send in smaller batches (re-run
  "Send Campaign" with a trimmed CSV) until this is worth turning into a
  proper queued/background sender.
- **"Opened" tracking is inherently approximate**, on any host — most mail
  clients (Gmail, Outlook, etc.) block remote images until the recipient
  clicks "display images", so a real open can still show as "not opened yet".
  Apple Mail's Privacy Protection does the opposite — it preloads images
  immediately on delivery, so it can show "opened" even if nobody looked.
  This is a limitation of pixel tracking generally, not a bug in this app.

## Use it

1. **Describe your campaign** (e.g. "announce a 20% early-bird discount, ends Friday") and click **Generate with AI**, or just type your own subject and HTML body directly.
2. **Paste your recipient list as CSV.** First row must be headers, and must include an `email` column:
   ```
   email,name,company
   jane@example.com,Jane,Acme Corp
   john@example.com,John,Globex Inc
   ```
   Any column can be used as a placeholder in your subject/body, e.g. `{{name}}`, `{{company}}`.
3. **Enter your SMTP settings.** For Gmail, use `smtp.gmail.com`, port `587`, and a Google **App Password** (not your normal password — you need 2FA enabled on your Google account to generate one).
4. Click **Send Campaign** and watch the live log as each email goes out. A small delay between sends (default 500ms) is included to avoid tripping spam filters or provider rate limits.

## Notes & limitations

- This is a lightweight tool meant for small-to-medium lists (dozens to low thousands) sent through a standard SMTP account — it is **not** a replacement for a dedicated ESP (SendGrid, Mailgun, etc.) if you need very high volume, bounce handling, unsubscribe management, or deliverability tooling at scale.
- SMTP credentials are only used in-memory for the duration of a send — they are never written to disk.
- Always include a clear unsubscribe mechanism and comply with applicable email regulations (CAN-SPAM, GDPR, etc.) for any real-world campaign.

## Project structure

```
faang-email-campaign-agent/
├── app.py               # Flask backend: AI generation + SMTP sending (SSE progress)
├── store.py             # Campaign storage: Upstash Redis (prod) / in-memory (local fallback)
├── vercel.json           # Vercel function config (maxDuration)
├── requirements.txt
├── .env.example
└── public/               # Served directly by Vercel's CDN
    ├── index.html        # Campaign builder UI
    ├── style.css
    └── app.js
```
