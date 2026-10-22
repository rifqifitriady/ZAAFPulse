// Where a monitor alert goes: a desktop notification and an optional webhook. Neither carries content. The
// notification text is the rule title, the state change, two numbers and the masked session title; the webhook body
// is the seven fields below and no text at all. Every OS command is spawned with an argument array and no shell:
// the macOS text goes in as osascript argv, the Linux text as notify-send arguments, and the Windows text through
// environment variables read by a script that is a constant. A failure is logged once and never thrown.
const childProcess = require('child_process');
const { RULES } = require('./rules');
const { maskTitle } = require('../trace/model');

const MAX_TITLE = 80;
const SPAWN_TIMEOUT_MS = 15e3;
const WEBHOOK_TIMEOUT_MS = 10e3;
const BACKOFF_MS = [1000, 4000, 16000]; // three retries after the first try
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const OWN_HEADERS = new Set(['content-type', 'content-length', 'host', 'transfer-encoding']);
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

// Fixed text: the alert never gets interpolated into it. The toast text nodes are set with CreateTextNode, so a title
// cannot add markup either. The balloon is the fallback for hosts where the toast API is not available.
const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$title = $env:ZP_TITLE
$text = $env:ZP_TEXT
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null
  $nodes.Item(1).AppendChild($xml.CreateTextNode($text)) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ZAAFPulse').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $balloon = New-Object System.Windows.Forms.NotifyIcon
  $balloon.Icon = [System.Drawing.SystemIcons]::Information
  $balloon.BalloonTipTitle = $title
  $balloon.BalloonTipText = $text
  $balloon.Visible = $true
  $balloon.ShowBalloonTip(10000)
  Start-Sleep -Seconds 6
  $balloon.Dispose()
}
`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? v : null);
const fmt = (n) => String(Math.round(n * 100) / 100);
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  function textOf(alert, sessionTitle) {
    const rule = RULES.find((r) => r.id === alert.rule);
    const word = alert.state === 'triggered' ? 'Triggered' : alert.state === 'ok' ? 'Resolved' : null;
    if (!word) return null;
    let line = word;
    if (isNum(alert.value)) line += `: ${fmt(alert.value)}`;
    if (isNum(alert.threshold))
      line += isNum(alert.value) ? ` (limit ${fmt(alert.threshold)})` : ` (limit: ${fmt(alert.threshold)})`;
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
    if (platform === 'win32')
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', '-'],
        opts: {
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
          env: { ...process.env, ZP_TITLE: title, ZP_TEXT: text },
        },
        stdin: WINDOWS_SCRIPT,
      };
    return {
      cmd: 'notify-send',
      args: ['--app-name=ZAAFPulse', title, text],
      opts: { stdio: 'ignore', windowsHide: true },
    };
  }

  function sendDesktop(alert, sessionTitle) {
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
        const msg = textOf(alert, sessionTitle);
        if (!msg) return finish({ ok: false, error: 'This state has no notification' });
        const c = commandFor(msg);
        child = spawn(c.cmd, c.args, c.opts);
        child.on('error', (err) => finish({ ok: false, error: maskErr(err) }));
        child.on('close', (code) =>
          finish(code === 0 ? { ok: true } : { ok: false, error: `${c.cmd} exited with ${code}` }),
        );
        if (c.stdin !== undefined && child.stdin) {
          child.stdin.on('error', () => {}); // a child that exits early closes the pipe
          child.stdin.end(c.stdin);
        }
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

  // The URL and the headers are secret references; they are read again on every send, so a changed secret applies.
  function resolveWebhook(cfg) {
    const url = secrets.resolve(cfg.url, 'webhook.url');
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
    const headers = cfg.headers == null ? {} : parseHeaders(secrets.resolve(cfg.headers, 'webhook.headers'));
    return { url: u.toString(), headers };
  }

  const payloadOf = (a) => ({
    rule: typeof a.rule === 'string' ? a.rule : null,
    state: typeof a.state === 'string' ? a.state : null,
    previous: typeof a.previous === 'string' ? a.previous : null,
    value: num(a.value),
    threshold: num(a.threshold),
    // The raw session id is the owner's own identifier, not content; the spec lists it.
    sessionId: typeof a.sessionId === 'string' ? a.sessionId : null,
    ts: num(a.ts),
  });

  async function sendWebhook(alert, cfg, { retries = BACKOFF_MS.length } = {}) {
    let target;
    try {
      target = resolveWebhook(cfg);
    } catch (err) {
      return { ok: false, error: maskErr(err) }; // a configuration problem does not get better by retrying
    }
    const body = JSON.stringify(payloadOf(alert));
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
        error = `The webhook answered HTTP ${res.status}`;
      } catch (err) {
        error = maskErr(err);
      }
    }
    return { ok: false, error };
  }

  async function notify(alert, { title } = {}) {
    const out = { desktop: false, webhook: false };
    if (!alert || typeof alert !== 'object') return out;
    const cfg = current();
    const jobs = [];
    if (cfg.desktop !== false)
      jobs.push(
        sendDesktop(alert, title).then((r) => {
          out.desktop = r.ok;
          if (!r.ok) safeLog(`Monitor desktop notification failed: ${r.error}`);
        }),
      );
    if (cfg.webhook && cfg.webhook.url)
      jobs.push(
        sendWebhook(alert, cfg.webhook).then((r) => {
          out.webhook = r.ok;
          if (!r.ok) safeLog(`Monitor webhook failed, dropped: ${r.error}`);
        }),
      );
    await Promise.all(jobs);
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

  return { notify, test };
}

module.exports = { createChannels, WINDOWS_SCRIPT };
