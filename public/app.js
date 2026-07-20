const $ = (id) => document.getElementById(id);

// ---- Shared ambient particle engine ----
// Particles rise and sway continuously (rAF loop, never gated to scroll),
// recycling back to the bottom once they drift off the top — so the field
// keeps refreshing itself indefinitely ("constantly moving").
function createAmbientField(canvas, opts = {}) {
  const {
    colors = ['#98E2C6', '#BFEDEF', '#C4B7CB'],
    density = 9000,
    maxCount = 150,
    riseSpeed = [8, 22],
    swayAmp = [4, 14],
    alphaRange = [0.35, 0.85],
    sizeRange = [1, 3.2],
    reducedSpeedMul = 0.3,
    extraOffset = null, // (p, now) => { dx, dy, alphaMul }
  } = opts;

  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, particles = [];

  const rand = (range) => range[0] + Math.random() * (range[1] - range[0]);

  function spawn(randomY) {
    return {
      x: Math.random() * w,
      y: randomY ? Math.random() * h : h + 12,
      r: rand(sizeRange),
      color: colors[Math.floor(Math.random() * colors.length)],
      speed: rand(riseSpeed),
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: 0.25 + Math.random() * 0.35,
      swayAmp: rand(swayAmp),
      alpha: rand(alphaRange),
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(maxCount, Math.max(12, Math.floor((w * h) / density)));
    particles = Array.from({ length: count }, () => spawn(true));
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const speedMul = reduceMotion ? reducedSpeedMul : 1;

    ctx.clearRect(0, 0, w, h);
    particles.forEach((p) => {
      p.y -= p.speed * speedMul * dt;
      const sway = Math.sin((now / 1000) * p.swaySpeed + p.swayPhase) * p.swayAmp * speedMul;
      let x = p.x + sway;
      let y = p.y;
      let alphaMul = 1;

      if (extraOffset) {
        const extra = extraOffset(p, now);
        if (extra) {
          x += extra.dx || 0;
          y += extra.dy || 0;
          if (typeof extra.alphaMul === 'number') alphaMul = extra.alphaMul;
        }
      }

      if (p.y < -10) Object.assign(p, spawn(false));
      if (alphaMul <= 0) return;

      ctx.beginPath();
      ctx.arc(x, y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha * alphaMul;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
  return { get particles() { return particles; } };
}

// Whole-page ambient layer — always visible, drifts continuously regardless of scroll.
createAmbientField($('pageParticles'), {
  colors: ['#70A692', '#C4B7CB', '#BFEDEF'],
  density: 26000,
  maxCount: 60,
  riseSpeed: [6, 14],
  swayAmp: [3, 8],
  alphaRange: [0.18, 0.4],
  sizeRange: [1, 2.2],
});

// Hero panel ambient layer — same field, denser and brighter against the dark hero.
createAmbientField($('heroCanvas'), {
  colors: ['#98E2C6', '#BFEDEF', '#C4B7CB'],
  density: 9000,
  maxCount: 90,
  riseSpeed: [10, 24],
  alphaRange: [0.4, 0.85],
});

// ---- Welcome intro: continuous ambient particles + scroll-driven burst ----
(function initWelcome() {
  const wrap = $('welcomeWrap');
  const canvas = $('particleCanvas');
  const content = document.querySelector('.welcome-content');
  const cue = $('scrollCue');
  if (!wrap || !canvas) return;

  function scrollProgress() {
    const rect = wrap.getBoundingClientRect();
    const total = wrap.offsetHeight - window.innerHeight;
    if (total <= 0) return 1;
    return Math.min(Math.max(-rect.top / total, 0), 1);
  }

  let cachedProgress = 0;

  createAmbientField(canvas, {
    colors: ['#98E2C6', '#BFEDEF', '#C4B7CB'],
    density: 9000,
    maxCount: 150,
    riseSpeed: [6, 16],
    alphaRange: [0.5, 0.95],
    extraOffset: (p) => {
      const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const burst = cachedProgress * 260;
      return {
        dx: (dx / dist) * burst,
        dy: (dy / dist) * burst - cachedProgress * 80,
        alphaMul: Math.max(0, 1 - cachedProgress * 1.1),
      };
    },
  });

  function tick() {
    cachedProgress = scrollProgress();
    if (content) {
      const scale = 1 - cachedProgress * 0.25;
      content.style.transform = `translateY(${-cachedProgress * 60}px) scale(${scale})`;
      content.style.opacity = String(Math.max(0, 1 - cachedProgress * 1.3));
    }
    if (cue) cue.style.opacity = String(Math.max(0, 1 - cachedProgress * 6));
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

// ---- Live recipient count preview ----
function countRecipients(csv) {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return Math.max(lines.length - 1, 0); // minus header row
}

$('recipientsCsv').addEventListener('input', () => {
  const n = countRecipients($('recipientsCsv').value);
  $('recipientCount').textContent = n > 0 ? `${n} recipient(s) detected` : '';
});

// ---- Recipient file upload (click or drag/drop) — CSV, TXT, TSV, JSON, VCF, XLSX, XLS ----
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SUPPORTED_EXTENSIONS = ['csv', 'txt', 'tsv', 'json', 'vcf', 'xlsx', 'xls'];

function getExtension(filename) {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function extractEmailsToCsv(text) {
  const found = text.match(EMAIL_RE) || [];
  const unique = [...new Set(found.map((e) => e.toLowerCase()))];
  return 'email\n' + unique.join('\n');
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsArrayBuffer(file);
  });
}

async function extractTextFromExcel(file) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Excel support failed to load — check your internet connection.');
  }
  const buffer = await readFileAsArrayBuffer(file);
  const workbook = XLSX.read(buffer, { type: 'array' });
  // Pull every cell from every sheet as text, then extract emails from that.
  return workbook.SheetNames
    .map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
    .join('\n');
}

async function loadRecipientsFile(file) {
  const statusEl = $('csvFileStatus');
  if (!file) return;

  const ext = getExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    statusEl.textContent = `Unsupported file type ".${ext}". Use CSV, TXT, TSV, JSON, VCF, XLSX, or XLS.`;
    statusEl.className = 'hint error';
    return;
  }

  statusEl.textContent = `Reading "${file.name}"…`;
  statusEl.className = 'hint';

  try {
    let csvText;

    if (ext === 'csv') {
      // CSV keeps its own columns as-is, so {{name}}, {{company}}, etc. still work.
      csvText = await readFileAsText(file);
    } else if (ext === 'xlsx' || ext === 'xls') {
      const rawText = await extractTextFromExcel(file);
      csvText = extractEmailsToCsv(rawText);
    } else {
      // txt, tsv, json, vcf — no guaranteed column structure, so just pull emails.
      const rawText = await readFileAsText(file);
      csvText = extractEmailsToCsv(rawText);
    }

    $('recipientsCsv').value = csvText;
    const n = countRecipients(csvText);

    if (n === 0) {
      statusEl.textContent = `No email addresses found in "${file.name}".`;
      statusEl.className = 'hint error';
      return;
    }

    $('recipientCount').textContent = `${n} recipient(s) detected`;
    statusEl.textContent = `Loaded "${file.name}" — ${n} recipient(s).`;
    statusEl.className = 'hint success';
  } catch (err) {
    statusEl.textContent = err.message || 'Could not read that file.';
    statusEl.className = 'hint error';
  }
}

const dropzone = $('csvDropzone');
$('csvFile').addEventListener('change', (e) => loadRecipientsFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  loadRecipientsFile(file);
});

// ---- SMTP provider presets (autofill host/port only — credentials stay manual) ----
const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: '587' },
  outlook: { host: 'smtp.office365.com', port: '587' },
  yahoo: { host: 'smtp.mail.yahoo.com', port: '587' },
  zoho: { host: 'smtp.zoho.com', port: '587' },
  sendgrid: { host: 'smtp.sendgrid.net', port: '587' },
  custom: null,
};

$('smtpProvider').addEventListener('change', (e) => {
  const preset = SMTP_PRESETS[e.target.value];
  if (!preset) return;
  $('smtpHost').value = preset.host;
  $('smtpPort').value = preset.port;
});

// ---- AI generate ----
$('generateBtn').addEventListener('click', async () => {
  const prompt = $('aiPrompt').value.trim();
  const statusEl = $('generateStatus');
  statusEl.className = 'status';

  if (!prompt) {
    statusEl.textContent = 'Describe the campaign first.';
    statusEl.className = 'status error';
    return;
  }

  const btn = $('generateBtn');
  btn.disabled = true;
  statusEl.textContent = 'Generating draft…';

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        tone: $('tone').value,
        audience: $('audience').value,
      }),
    });
    const contentType = res.headers.get('content-type') || '';

let data;

if (contentType.includes('application/json')) {
  data = await res.json();
} else {
  const text = await res.text();
  throw new Error(
    `Server returned ${res.status}: ${text.substring(0, 150)}`
  );
}

if (!res.ok) {
  throw new Error(data.error || `Request failed (${res.status})`);
}

    $('subject').value = data.subject || '';
    $('bodyHtml').value = data.body_html || '';
    statusEl.textContent = 'Draft ready — review and edit before sending.';
    statusEl.className = 'status success';
  } catch (err) {
    statusEl.textContent = 'Network error: ' + err.message;
    statusEl.className = 'status error';
  } finally {
    btn.disabled = false;
  }
});

// ---- Your campaigns: list + per-recipient sent/failed/opened detail ----
let selectedCampaignId = null;
let statusPollTimer = null;
let statusPollsLeft = 0;

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderCampaignSummary(summary) {
  const el = $('campaignSummary');
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="summary-pill">Subject: <strong>${summary.subject || '(none)'}</strong></span>
    <span class="summary-pill">Sent: <strong>${summary.sent}</strong> / ${summary.total}</span>
    <span class="summary-pill">Failed: <strong>${summary.failed}</strong></span>
    <span class="summary-pill">Opened: <strong>${summary.opened}</strong></span>
  `;
}

function renderRecipientRows(recipients) {
  const body = $('statusTableBody');
  const empty = $('statusEmpty');
  body.innerHTML = '';

  if (!recipients || recipients.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  recipients.forEach((r) => {
    const row = document.createElement('tr');

    let deliveryHtml;
    if (r.status === 'sent') {
      deliveryHtml = `<span class="status-badge sent">&#10003; sent${r.sentAt ? ' · ' + formatTime(r.sentAt) : ''}</span>`;
    } else if (r.status === 'failed') {
      deliveryHtml = `<span class="status-badge failed">&#10007; failed${r.error ? ' — ' + r.error : ''}</span>`;
    } else {
      deliveryHtml = `<span class="status-badge pending">&hellip; pending</span>`;
    }

    const openedHtml = r.opened
      ? `<span class="opened-badge opened">&#9673; open detected${r.openedAt ? ' · ' + formatTime(r.openedAt) : ''}</span>`
      : `<span class="opened-badge not-opened">not opened yet</span>`;

    row.innerHTML = `
      <td>${r.email}</td>
      <td>${deliveryHtml}</td>
      <td>${openedHtml}</td>
    `;
    body.appendChild(row);
  });
}

async function loadCampaignStatus(campaignId) {
  try {
    const res = await fetch(`/api/campaign/${campaignId}/status`);
    if (!res.ok) return;
    const data = await res.json();
    renderCampaignSummary(data);
    renderRecipientRows(data.recipients);
  } catch (err) {
    // silent — next poll/refresh will retry
  }
}

function startStatusPolling(campaignId) {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollsLeft = 300; // ~30 min at 6s intervals, then auto-stop
  statusPollTimer = setInterval(() => {
    if (statusPollsLeft <= 0 || selectedCampaignId !== campaignId) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
      return;
    }
    statusPollsLeft -= 1;
    loadCampaignStatus(campaignId);
  }, 6000);
}

function selectCampaign(campaignId) {
  selectedCampaignId = campaignId || null;
  if (!selectedCampaignId) {
    $('campaignSummary').classList.add('hidden');
    renderRecipientRows([]);
    if (statusPollTimer) clearInterval(statusPollTimer);
    return;
  }
  loadCampaignStatus(selectedCampaignId);
  startStatusPolling(selectedCampaignId);
}

async function loadCampaignsList(preselectId) {
  const select = $('campaignSelect');
  try {
    const res = await fetch('/api/campaigns');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.campaigns || [];

    select.innerHTML = '';
    if (list.length === 0) {
      select.innerHTML = '<option value="">No campaigns sent yet</option>';
      selectCampaign(null);
      return;
    }

    list.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.campaignId;
      const when = new Date(c.createdAt * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      opt.textContent = `${c.subject || '(no subject)'} — ${c.sent}/${c.total} sent — ${when}`;
      select.appendChild(opt);
    });

    const toSelect = preselectId && list.some((c) => c.campaignId === preselectId)
      ? preselectId
      : list[0].campaignId;
    select.value = toSelect;
    selectCampaign(toSelect);
  } catch (err) {
    // silent — Refresh button lets the user retry
  }
}

$('campaignSelect').addEventListener('change', (e) => selectCampaign(e.target.value));
$('refreshCampaignsBtn').addEventListener('click', () => loadCampaignsList(selectedCampaignId));

// Populate the campaigns list on page load (covers server restarts / reloads).
loadCampaignsList();

// ---- Send campaign (SSE progress) ----
$('sendBtn').addEventListener('click', async () => {
  const subject = $('subject').value.trim();
  const bodyHtml = $('bodyHtml').value.trim();
  const recipientsCsv = $('recipientsCsv').value.trim();
  const smtp = {
    host: $('smtpHost').value.trim(),
    port: $('smtpPort').value.trim() || '587',
    user: $('smtpUser').value.trim(),
    pass: $('smtpPass').value,
    fromName: $('fromName').value.trim(),
  };
  const delayMs = $('delayMs').value.trim() || '500';

  const log = $('log');
  const progressWrap = $('progressWrap');
  const progressFill = $('progressFill');
  const progressText = $('progressText');

  if (!subject || !bodyHtml || !recipientsCsv || !smtp.host || !smtp.user || !smtp.pass) {
    alert('Please fill in subject, body, recipients CSV, and SMTP settings before sending.');
    return;
  }

  const btn = $('sendBtn');
  btn.disabled = true;
  log.innerHTML = '';
  progressWrap.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = 'Connecting…';

  try {
    const response = await fetch('/api/send-campaign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtp, subject, bodyHtml, recipientsCsv, delayMs }),
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      progressText.textContent = data.error || 'Failed to start campaign.';
      progressText.classList.add('error');
      btn.disabled = false;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop(); // keep incomplete chunk for next read

      for (const chunk of chunks) {
        if (!chunk.startsWith('data: ')) continue;
        const evt = JSON.parse(chunk.slice(6));
        handleEvent(evt);
      }
    }
  } catch (err) {
    progressText.textContent = 'Connection error: ' + err.message;
  } finally {
    btn.disabled = false;
  }

  function handleEvent(evt) {
    if (evt.type === 'start') {
      progressText.textContent = `Sending 0 / ${evt.total}…`;
      if (evt.trackingUnreachable) {
        const warn = document.createElement('li');
        warn.className = 'failed';
        warn.innerHTML = `<span>&#9888; Open tracking won't work</span><span>set PUBLIC_BASE_URL in .env — see .env.example</span>`;
        log.prepend(warn);
      }
    } else if (evt.type === 'progress') {
      const pct = Math.round((evt.index / evt.total) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `Sending ${evt.index} / ${evt.total}…`;

      const li = document.createElement('li');
      li.className = evt.status;
      li.innerHTML = `<span>${evt.email}</span><span>${evt.status === 'sent' ? '✓ sent' : '✗ ' + (evt.error || 'failed')}</span>`;
      log.prepend(li);
    } else if (evt.type === 'done') {
      progressFill.style.width = '100%';
      progressText.textContent = `Done — ${evt.sent} sent, ${evt.failed} failed (of ${evt.total}).`;
      if (evt.campaignId) loadCampaignsList(evt.campaignId);
    } else if (evt.type === 'fatal') {
      progressText.textContent = evt.message;
      progressText.classList.add('error');
    }
  }
});

// ---------- Steps line: fills in as the 01-04 steps scroll through view ----------
(function () {
  const grid = document.getElementById('stepsGrid');
  const fill = document.getElementById('stepsLineFill');
  if (!grid || !fill) return;

  function updateStepsLine() {
    const rect = grid.getBoundingClientRect();
    const vh = window.innerHeight;
    const start = vh * 0.85;   // grid top enters this point -> progress starts
    const end = vh * 0.25;     // grid top reaches this point -> progress complete
    let progress = (start - rect.top) / (start - end);
    progress = Math.max(0, Math.min(1, progress));
    fill.style.width = (progress * 100) + '%';
  }

  window.addEventListener('scroll', updateStepsLine, { passive: true });
  window.addEventListener('resize', updateStepsLine);
  updateStepsLine();
})();
