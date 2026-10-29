// Where a monitor alert goes: a desktop notification and an optional webhook. Neither carries content. The
// notification text is the rule title, the state change (or the fixed words for an automatic pause), two numbers and
// the masked session title; the webhook body is the seven fields below and no text at all, for state changes only.
// Every OS command is spawned with an argument array and no shell:
// the macOS text goes in as osascript argv, the Linux text as notify-send arguments, and the Windows text through
// environment variables read by a script that is a constant. A failure is logged once and never thrown.
// Callers must not await notify(): a webhook can take about 20 s to give up, and a burst is bounded here (two
// desktop notifications and four webhook sends in flight, 50 webhooks waiting), not by the caller.
const childProcess = require('child_process');
const { ruleById, isBudgetState } = require('./rules');
const { maskTitle } = require('../trace/model');
const { isDay } = require('../cost/days');

const MAX_TITLE = 80;
const SPAWN_TIMEOUT_MS = 15e3;
const WEBHOOK_TIMEOUT_MS = 10e3;
const BACKOFF_MS = [1000, 4000, 16000]; // three retries after the first try
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const OWN_HEADERS = new Set(['content-type', 'content-length', 'host', 'transfer-encoding']);
const MAX_DESKTOP = 2;
const MAX_WEBHOOKS = 4;
const MAX_QUEUED = 50;
const STATES = new Set(['ok', 'triggered', 'no_data', 'snoozed']);
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
// The desktop words for an automatic pause that did not happen, by the engine's code.
const PAUSE_WHY = {
  several: 'several matching processes',
  none: 'no matching process',
  windows: 'not available on Windows',
  'not-indexed': 'the session is not indexed yet',
  unreadable: 'the process list could not be read',
  refused: 'the process was gone or changed',
};
// The words for a budget alert (rule `budget`): the level it reached or fell back to, or its projection.
const PERIOD_WORD = { day: 'today', week: 'this week', month: 'this month' };
const rankOf = (s) =>
  s === 'exceeded' ? 100 : typeof s === 'string' && s.startsWith('warn_') ? Number(s.slice(5)) : 0;
function budgetWord(a) {
  const now = rankOf(a.state);
  const was = rankOf(a.previous);
  const also = a.projected === true ? ', projected to pass the budget' : '';
  if (now > was) return a.state === 'exceeded' ? 'Budget used up' : `Passed ${now} %${also}`;
  if (now < was) return a.state === 'ok' ? `Back under its levels${also}` : `Back to ${now} %${also}`;
  return a.projected === true ? 'Projected to pass the budget' : null;
}

// Fixed text: the alert never gets interpolated into it, and it is passed with -EncodedCommand (base64 of UTF-16LE), so
// PowerShell never reads it as interactive input from stdin. The title and text come from the environment and are
// XML-escaped before they go into the toast template. The AUMID is PowerShell's own registered one; an unregistered
// id makes Windows drop the toast without an error. The balloon is the fallback for hosts without the toast API.
// ZP_DRY_RUN=1 builds and parses the XML, prints OK and shows nothing (the CI test uses it).
const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$title = [System.Security.SecurityElement]::Escape($env:ZP_TITLE)
$text = [System.Security.SecurityElement]::Escape($env:ZP_TEXT)
$template = "<toast><visual><binding template='ToastText02'><text id='1'>$title</text><text id='2'>$text</text></binding></visual></toast>"
if ($env:ZP_DRY_RUN -eq '1') {
  $check = New-Object System.Xml.XmlDocument
  $check.LoadXml($template)
  Write-Output 'OK'
  exit 0
}
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $balloon = New-Object System.Windows.Forms.NotifyIcon
  $balloon.Icon = [System.Drawing.SystemIcons]::Information
  $balloon.BalloonTipTitle = $env:ZP_TITLE
  $balloon.BalloonTipText = $env:ZP_TEXT
  $balloon.Visible = $true
  $balloon.ShowBalloonTip(10000)
  Start-Sleep -Seconds 6
  $balloon.Dispose()
}
`;

const WINDOWS_ENCODED = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const escapeMarkup = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // notify-send renders markup
const fmt = (n) => String(Math.round(n * 100) / 100);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The weekly cost digest (Cost Control 5): one desktop line, and the webhook's one other body. Names are clipped and
// free of control characters; everything else is a number or null. No project folder and no text ever goes in.
const PATHLIKE = /^(?:[/~\\]|[A-Za-z]:[\\/])/; // a folder never goes out, whichever field it landed in
function nameOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  if (PATHLIKE.test(s.trim())) return null;
  const cut = Array.from(s).slice(0, 80).join(''); // by code point: no split surrogate pair
  return cut;
}
const listOf = (v, n) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, n) : []);
function digestLine(d) {
  const t = (d && d.totals) || {};
  const amount = (isNum(t.listUSD) ? t.listUSD : 0).toLocaleString('en', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const p = d && d.change && isNum(d.change.percent) ? Math.round(d.change.percent) : null;
  const change = p === null ? '' : ` (${p >= 0 ? '+' : '-'}${Math.abs(p)} %)`;
  const b = listOf(d && d.budgets, 100).length;
  const a = listOf(d && d.anomalies, 7).length;
  return `ZAAFPulse weekly cost: $${amount}${change}, ${b} budget${b === 1 ? '' : 's'} at risk, ${a} anomal${a === 1 ? 'y' : 'ies'}`;
}
function digestBody(d) {
  const w = (d && d.week) || {};
  const t = (d && d.totals) || {};
  const c = (d && d.change) || {};
  const r = d && d.recommendation;
  return {
    type: 'cost_digest',
    week: { from: isDay(w.from) ? w.from : null, to: isDay(w.to) ? w.to : null },
    totals: { listUSD: num(t.listUSD), billedUSD: num(t.billedUSD) },
    change: { listUSD: num(c.listUSD), percent: num(c.percent) },
    centers: listOf(d && d.centers, 3).map((x) => ({
      id: nameOf(x.id),
      name: nameOf(x.name),
      listUSD: num(x.listUSD),
    })),
    models: listOf(d && d.models, 3).map((x) => ({ model: nameOf(x.model), listUSD: num(x.listUSD) })),
    budgets: listOf(d && d.budgets, 100).map((x) => ({
      id: nameOf(x.id),
      name: nameOf(x.name),
      state: nameOf(x.state),
      projected: x.projected === true,
      percent: num(x.percent),
    })),
    anomalies: listOf(d && d.anomalies, 7).map((x) => ({
      day: isDay(x.day) ? x.day : null,
      spentUSD: num(x.spentUSD),
      expectedUSD: num(x.expectedUSD),
    })),
    recommendation:
      r && typeof r === 'object'
        ? { model: nameOf(r.model), candidate: nameOf(r.candidate), savingUSD: num(r.savingUSD) }
        : null,
  };
}

// The webhook checks, also used by the settings route before a pasted URL or header list is stored.
// An https:// URL (http:// only to this machine) without credentials in it; returns it normalised.
function checkWebhookUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('webhook.url: not a valid URL');
  }
  const loopback = LOOPBACK.test(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)))
    throw new Error('webhook.url: only https:// is allowed (http:// only to this machine)');
  if (u.username || u.password) throw new Error('webhook.url: put credentials in the headers, not in the URL');
  return u.toString();
}

function parseHeaders(raw) {
  const out = {};
  const put = (name, value) => {
    name = String(name).trim();
    value = String(value);
    if (!HEADER_NAME.test(name)) throw new Error('webhook headers: invalid header name');
    if (OWN_HEADERS.has(name.toLowerCase())) throw new Error(`webhook headers: ${name} is set by ZAAFPulse`);
    if (/[\r\n\0]/.test(value)) throw new Error('webhook headers: line breaks are not allowed in a value');
    out[name] = value.trim();
  };
  const s = String(raw).trim();
  if (s.startsWith('{')) {
    let obj;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new Error('webhook headers: expected a JSON object or "Name: value" lines');
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
      throw new Error('webhook headers: expected a JSON object');
    for (const [k, v] of Object.entries(obj)) put(k, v);
  } else {
    for (const line of s.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const at = line.indexOf(':');
      if (at < 1) throw new Error('webhook headers: expected "Name: value" lines');
      put(line.slice(0, at), line.slice(at + 1));
    }
  }
  return out;
}

const SAMPLE = {
  id: 'sample',
  ts: 0,
  rule: 'daily_cost',
  instance: 'all',
  sessionId: null,
  state: 'triggered',
  previous: 'ok',
  value: 12.5,
  threshold: 10,
};

function createChannels({
  spawn = childProcess.spawn,
  fetchImpl = fetch,
  secrets,
  settings = () => ({ desktop: true, webhook: null }),
  platform = process.platform,
  log = () => {},
  sleep = sleepFor, // the backoff waits, injectable so tests do not wait
  timeoutMs = WEBHOOK_TIMEOUT_MS,
} = {}) {
  const safeLog = (message) => {
    try {
      log(message);
    } catch {
      /* logging must not break an alert */
    }
  };
  const maskErr = (err) => {
    const msg =
      (err && (err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message)) || String(err);
    return secrets && secrets.mask ? secrets.mask(msg) : msg;
  };
  const current = () => {
    try {
      return settings() || {};
    } catch {
      return {};
    }
  };

  // ---- desktop ----
  // A pause outcome (a row with `action: 'pause'`) has its own words, chosen from a fixed table by its code: the
  // reason text it also carries is never shown.
  const wordOf = (alert) => {
    if (alert.action === 'pause') {
      if (alert.ok === true) return 'Agent paused';
      const why = PAUSE_WHY[alert.code];
      return why ? `Could not pause the agent: ${why}` : 'Could not pause the agent';
    }
    if (alert.rule === 'budget' && alert.action === undefined) return budgetWord(alert);
    if (alert.action !== undefined) return null;
    return alert.state === 'triggered' ? 'Triggered' : alert.state === 'ok' ? 'Resolved' : null;
  };

  function textOf(alert, sessionTitle) {
    const rule = ruleById(alert.rule);
    const word = wordOf(alert);
    if (!word) return null;
    let line = word;
    if (alert.rule === 'budget' && alert.action === undefined) {
      if (isNum(alert.value))
        line += `: ${Math.round(alert.value)} % of the budget ${PERIOD_WORD[alert.period] || 'this period'}`;
    } else {
      if (isNum(alert.value)) line += `: ${fmt(alert.value)}`;
      if (isNum(alert.threshold))
        line += isNum(alert.value) ? ` (limit ${fmt(alert.threshold)})` : ` (limit: ${fmt(alert.threshold)})`;
    }
    const session = maskTitle(typeof sessionTitle === 'string' ? sessionTitle : alert.title);
    const clipped = session
      ? session
          .replace(/[\u0000-\u001f]/g, ' ')
          .slice(0, MAX_TITLE)
          .trim()
      : '';
    return { title: `ZAAFPulse: ${rule ? rule.title : 'Alert'}`, text: clipped ? `${line}\n${clipped}` : line };
  }

  function commandFor({ title, text }) {
    if (platform === 'darwin')
      return {
        cmd: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 2 of argv) with title (item 1 of argv)',
          '-e',
          'end run',
          title,
          text,
        ],
        opts: { stdio: 'ignore', windowsHide: true },
      };
    if (platform === 'win32') {
      const env = { ...process.env, ZP_TITLE: title, ZP_TEXT: text };
      delete env.ZP_DRY_RUN; // only the CI test sets it, and it must not silence a real toast
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_ENCODED],
        opts: { stdio: 'ignore', windowsHide: true, env },
      };
    }
    // The daemon renders markup, so the text is escaped; "--" ends the options whatever the text starts with.
    return {
      cmd: 'notify-send',
      args: ['--app-name=ZAAFPulse', '--', escapeMarkup(title), escapeMarkup(text)],
      opts: { stdio: 'ignore', windowsHide: true },
    };
  }

  // `fixed` is a prebuilt { title, text } (the digest); otherwise the alert's own words.
  function sendDesktop(alert, sessionTitle, fixed = null) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let child = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      try {
        const msg = fixed || textOf(alert, sessionTitle);
        if (!msg) return finish({ ok: false, skipped: true });
        const c = commandFor(msg);
        child = spawn(c.cmd, c.args, c.opts);
        child.on('error', (err) => finish({ ok: false, error: maskErr(err) }));
        child.on('close', (code) =>
          finish(code === 0 ? { ok: true } : { ok: false, error: `${c.cmd} exited with ${code}` }),
        );
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish({ ok: false, error: 'The notification command did not finish' });
        }, SPAWN_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      } catch (err) {
        finish({ ok: false, error: maskErr(err) });
      }
    });
  }

  // ---- webhook ----
  // The URL and the headers are secret references; they are read again on every send, so a changed secret applies.
  function resolveWebhook(cfg) {
    const url = checkWebhookUrl(secrets.resolve(cfg.url, 'webhook.url'));
    const headers = cfg.headers == null ? {} : parseHeaders(secrets.resolve(cfg.headers, 'webhook.headers'));
    return { url, headers };
  }

  const payloadOf = (a) => ({
    // Known values only: a field of the alert that is not a rule id or a state never leaves the machine.
    rule: ruleById(a.rule) ? a.rule : null,
    state: STATES.has(a.state) || isBudgetState(a.state) ? a.state : null,
    previous: STATES.has(a.previous) || isBudgetState(a.previous) ? a.previous : null,
    value: num(a.value),
    threshold: num(a.threshold),
    // The raw session id is the owner's own identifier, not content; the spec lists it.
    sessionId: typeof a.sessionId === 'string' ? a.sessionId : null,
    ts: num(a.ts),
  });

  // `body` is a prebuilt JSON text (the digest); otherwise the alert's seven fields.
  async function sendWebhook(alert, cfg, { retries = BACKOFF_MS.length, body: prebuilt = null } = {}) {
    let target;
    try {
      target = resolveWebhook(cfg);
    } catch (err) {
      return { ok: false, error: maskErr(err) }; // a configuration problem does not get better by retrying
    }
    const body = prebuilt || JSON.stringify(payloadOf(alert));
    let error = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]);
      try {
        const res = await fetchImpl(target.url, {
          method: 'POST',
          headers: { ...target.headers, 'content-type': 'application/json' },
          body,
          redirect: 'manual', // a redirect would send the body somewhere the owner did not choose
          signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          if (res.body && res.body.cancel) await res.body.cancel();
        } catch {
          /* the body is not needed */
        }
        if (res.ok) return { ok: true };
        // A redirect means the URL is wrong: another try would hit the same answer.
        if (res.status >= 300 && res.status < 400)
          return {
            ok: false,
            error: `The webhook answered with a redirect (HTTP ${res.status}); redirects are not followed`,
          };
        error = `The webhook answered HTTP ${res.status}`;
      } catch (err) {
        error = maskErr(err);
      }
    }
    return { ok: false, error };
  }

  // Bounds for a burst of alerts: a few notifications at a time, and the oldest webhook sends give way to newer ones.
  let desktopActive = 0;
  let desktopHinted = false;
  let webhookActive = 0;
  let webhookHinted = false;
  const webhookQueue = [];

  async function desktopLimited(alert, sessionTitle, fixed = null) {
    if (!fixed && !textOf(alert, sessionTitle)) return { ok: false, skipped: true }; // no_data and snoozed show nothing
    if (desktopActive >= MAX_DESKTOP) {
      if (!desktopHinted && !fixed) {
        desktopHinted = true;
        safeLog(
          'Monitor desktop notifications: more alerts were raised than can be shown at once; see the Alerts list',
        );
      }
      return { ok: false, skipped: true };
    }
    desktopActive++;
    try {
      return await sendDesktop(alert, sessionTitle, fixed);
    } finally {
      if (--desktopActive === 0) desktopHinted = false;
    }
  }

  function pumpWebhooks() {
    while (webhookActive < MAX_WEBHOOKS && webhookQueue.length) {
      const job = webhookQueue.shift();
      webhookActive++;
      job.run().then((r) => {
        webhookActive--;
        job.resolve(r);
        pumpWebhooks();
        if (webhookActive === 0 && !webhookQueue.length) webhookHinted = false;
      });
    }
  }

  function webhookLimited(alert, cfg, body = null) {
    return new Promise((resolve) => {
      webhookQueue.push({ run: () => sendWebhook(alert, cfg, { body }), resolve });
      if (webhookQueue.length > MAX_QUEUED) {
        webhookQueue.shift().resolve({ ok: false, skipped: true });
        if (!webhookHinted) {
          webhookHinted = true;
          safeLog('Monitor webhook: too many alerts waiting, the oldest were dropped');
        }
      }
      pumpWebhooks();
    });
  }

  // Do not await this from the alert loop (see the top of the file); it resolves when both channels are done.
  // An action row (a pause outcome) goes to the desktop only: the webhook keeps its seven-field state changes.
  async function notify(alert, { title } = {}) {
    const out = { desktop: false, webhook: false };
    if (!alert || typeof alert !== 'object') return out;
    const cfg = current();
    const jobs = [];
    if (cfg.desktop !== false)
      jobs.push(
        desktopLimited(alert, title).then((r) => {
          out.desktop = r.ok;
          if (!r.ok && !r.skipped) safeLog(`Monitor desktop notification failed: ${r.error}`);
        }),
      );
    if (cfg.webhook && cfg.webhook.url && alert.action === undefined)
      jobs.push(
        webhookLimited(alert, cfg.webhook).then((r) => {
          out.webhook = r.ok;
          if (!r.ok && !r.skipped) safeLog(`Monitor webhook failed, dropped: ${r.error}`);
        }),
      );
    await Promise.all(jobs);
    return out;
  }

  // The weekly cost digest through the same bounds. Not logged here: the scheduler (lib/cost/digest.js) logs a failed
  // week once. `tried` counts the channels that are on; `ok` is true when at least one of them delivered.
  async function digest(d) {
    const out = { desktop: false, webhook: false, tried: 0, ok: false, errors: [] };
    if (!d || typeof d !== 'object') return out;
    const cfg = current();
    const jobs = [];
    // Built and checked before anything is sent: a bad figure must not leave a notice shown and then a retry.
    let line;
    let body;
    try {
      line = digestLine(d);
      body = JSON.stringify(digestBody(d));
    } catch (err) {
      out.errors.push(`digest: ${maskErr(err)}`);
      return out;
    }
    if (cfg.desktop !== false) {
      out.tried++;
      jobs.push(
        desktopLimited(null, null, { title: 'ZAAFPulse', text: line }).then((r) => {
          out.desktop = r.ok;
          if (!r.ok) out.errors.push(r.skipped ? 'desktop: busy' : `desktop: ${r.error}`);
        }),
      );
    }
    if (cfg.webhook && cfg.webhook.url) {
      out.tried++;
      jobs.push(
        webhookLimited(null, cfg.webhook, body).then((r) => {
          out.webhook = r.ok;
          if (!r.ok) out.errors.push(r.skipped ? 'webhook: dropped' : `webhook: ${r.error}`);
        }),
      );
    }
    await Promise.all(jobs);
    out.ok = out.desktop || out.webhook;
    return out;
  }

  // One try, so the owner sees the outcome of the button at once instead of after the backoff.
  async function test(kind) {
    if (kind === 'desktop') return sendDesktop(SAMPLE, 'Sample session');
    if (kind === 'webhook') {
      const cfg = current().webhook;
      if (!cfg || !cfg.url) return { ok: false, error: 'No webhook is set' };
      return sendWebhook({ ...SAMPLE, ts: Date.now() }, cfg, { retries: 0 });
    }
    return { ok: false, error: 'Unknown channel' };
  }

  return { notify, test, digest };
}

module.exports = { createChannels, checkWebhookUrl, parseHeaders, digestLine, digestBody, WINDOWS_SCRIPT };
