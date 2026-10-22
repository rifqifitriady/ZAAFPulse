'use strict';
/* Monitors in the dashboard: the bell and its alerts drawer, Settings → Monitors, and the agent controls (pause,
   resume, stop) in the trace explorer, the Live monitor and the AI Office. Everything shown comes from /api/monitors,
   /api/alerts and /api/agents and reaches the page as text: esc() in templates, textContent elsewhere (S1). The
   helpers at the top are pure, so test/monitors-ui.test.js runs them without a browser. */

const MON_APP = {
  claude: 'Claude Code',
  codex: 'Codex',
  'claude-desktop': 'Claude Desktop',
  chatgpt: 'ChatGPT',
  antigravity: 'Antigravity / Gemini',
  cursor: 'Cursor',
  kiro: 'Kiro',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};
const MON_STATE = { ok: 'OK', triggered: 'Triggered', no_data: 'No data', snoozed: 'Snoozed', off: 'Off' };
// The server sends a code for an automatic pause, never its reason text; these are the words for each code.
const MON_PAUSE_WHY = {
  several: 'several matching processes, so the owner has to pick one',
  none: 'no matching process was found',
  windows: 'not available on Windows',
  'not-indexed': 'the session is not indexed yet',
  unreadable: 'the process list could not be read',
  refused: 'the process was gone or had changed',
};
// How each parameter is asked for. minPassRate is a share (0–1) on the server and a percentage in the form.
const MON_PARAMS = {
  limitUSD: { label: 'Daily limit (USD)', step: '0.01', empty: 'budget ÷ 30' },
  maxUSD: { label: 'Limit per 10 min (USD)', step: '0.01' },
  maxCalls: { label: 'Tool calls in one turn', step: '1', int: true },
  stuckMin: { label: 'Minutes without a log line', step: '1' },
  dropPoints: { label: 'Allowed drop (points)', step: '0.5' },
  minPassRate: { label: 'Minimum pass rate (%)', step: '1', pct: true },
  minSamples: { label: 'Minimum samples', step: '1', int: true }, // evaluator checks, or tool results for accuracy
  windowMin: { label: 'Window (minutes)', step: '1' },
};
const MON_SECRETS_DOC = 'https://github.com/rifqifitriady/ZAAFPulse/blob/main/docs/integrations.md#storing-a-secret';
const MON_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const MON_MAX_TITLE = 80;
const MON_MAX_SHOWN = 200;

const monNum = (v) => typeof v === 'number' && Number.isFinite(v);
// One line of text from the server: control characters out, spaces folded, clipped. Markup stays text.
const monText = (v, max = MON_MAX_SHOWN) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const monUSD = (n) => '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monRound = (n) => String(Math.round(n * 10) / 10);
const monPct = (r) => `${Math.round(r * 100)}%`;
const monPlural = (n, one) => `${monRound(n)} ${n === 1 ? one : `${one}s`}`;
// Only a key the trace explorer could have made becomes a link; anything else is no link at all.
const monHref = (key) =>
  typeof key === 'string' && MON_KEY_RE.test(key) ? `#trace?key=${encodeURIComponent(key)}` : null;
const monAppName = (id) =>
  typeof id === 'string' && id ? (Object.hasOwn(MON_APP, id) ? MON_APP[id] : monText(id, 40)) : 'Agent';
function monRuleTitle(id, rules) {
  const list = Array.isArray(rules) ? rules : rules && typeof rules === 'object' ? Object.values(rules) : [];
  const r = list.find((x) => x && x.id === id);
  return monText(r && r.title, MON_MAX_TITLE) || monText(id, 40) || 'Monitor';
}

// Value against threshold, in the rule's own unit. tool_loop means two things: a threshold of 1 is the loop-signal
// path (the value counts signals), anything else is tool calls in one turn against maxCalls.
const MON_MEASURE = {
  daily_cost: [(v) => `${monUSD(v)} today`, 'against a daily limit of', monUSD],
  month_projection: [(v) => `${monUSD(v)} projected`, 'against a budget of', monUSD],
  cost_burn: [(v) => `${monUSD(v)} in 10 min`, 'against a limit of', monUSD],
  agent_stuck: [(v) => `${monRound(v)} min without a new log line`, 'against a limit of', (t) => `${monRound(t)} min`],
  accuracy_drop: [
    (v) => `${monRound(v)} points below the previous 7 days`,
    'against an allowed drop of',
    (t) => `${monRound(t)} points`,
  ],
  eval_pass_rate: [(v) => `${monPct(v)} passed`, 'against a minimum of', monPct],
  unsafe_content: [(v) => `${monPlural(v, 'unsafe finding')} in the window`, null, null],
};
function monMeasure(rule, value, threshold) {
  const v = monNum(value) ? value : null;
  const t = monNum(threshold) ? threshold : null;
  if (v === null && t === null) return '';
  let spec = Object.hasOwn(MON_MEASURE, rule) ? MON_MEASURE[rule] : [monRound, 'against', monRound];
  if (rule === 'tool_loop')
    spec =
      t === 1 && v !== null && v > 0
        ? [(x) => `${monPlural(x, 'loop signal')} in 10 min`, null, null]
        : [(x) => `${monPlural(x, 'tool call')} in one turn`, 'against a limit of', monRound];
  const [fv, join, ft] = spec;
  if (v === null) return ft ? `limit ${ft(t)}` : '';
  if (t === null || !join) return fv(v);
  return `${fv(v)} ${join} ${ft(t)}`;
}

// Why agent control is off, from /api/monitors/status agents.reason, as the end of a sentence.
const MON_OFF = { server: 'agent control is off on this server', docker: 'agent control is off in Docker' };
const monOffText = (reason) => (reason === 'docker' ? MON_OFF.docker : MON_OFF.server);

/** One alert as lines of text: rule title, the change, value against threshold, session, trace link and time.
 *  `agents` is the status's agents block: while control is off, "no candidate" is worded as that. */
function alertLine(a, rules, agents) {
  if (!a || typeof a !== 'object') return null;
  const base = {
    id: typeof a.id === 'string' ? a.id : null,
    ts: monNum(a.ts) ? a.ts : null,
    title: monText(a.ruleTitle, MON_MAX_TITLE) || monRuleTitle(a.rule, rules),
    measure: monMeasure(a.rule, a.value, a.threshold),
    session: monText(a.title, MON_MAX_TITLE) || null,
    href: monHref(a.sessionKey),
  };
  let line;
  if (a.action !== undefined) {
    // An automatic pause: it has a code and no state change of its own.
    // With control off the engine finds no process and records `none`; that is not "nothing was running".
    const off = a.code === 'none' && agents && agents.available === false;
    const why =
      a.ok === true
        ? ''
        : off
          ? monOffText(agents.reason)
          : typeof a.code === 'string' && Object.hasOwn(MON_PAUSE_WHY, a.code)
            ? MON_PAUSE_WHY[a.code]
            : '';
    const change =
      a.ok === true ? 'Paused the agent' : why ? `Could not pause the agent: ${why}` : 'Could not pause the agent';
    line = { ...base, kind: 'pause', tone: a.ok === true ? 'warn' : 'bad', change };
  } else {
    const st = typeof a.state === 'string' ? a.state : '';
    const prev = typeof a.previous === 'string' ? a.previous : '';
    const word = (s) => (Object.hasOwn(MON_STATE, s) ? MON_STATE[s] : monText(s, 20) || 'Unknown');
    const change =
      st === 'triggered'
        ? 'Triggered'
        : st === 'ok' && prev === 'triggered'
          ? 'Resolved'
          : prev
            ? `${word(prev)} → ${word(st)}`
            : word(st);
    line = { ...base, kind: 'change', tone: st === 'triggered' ? 'bad' : st === 'ok' ? 'good' : 'muted', change };
  }
  line.text = [line.title, line.change, line.measure, line.session].filter(Boolean).join(' · ');
  return line;
}

/** How many alerts are newer than the last "Mark all read" (a time in ms, or the text localStorage gives back). */
function unreadCount(alerts, lastRead) {
  if (!Array.isArray(alerts)) return 0;
  const n = Number(lastRead);
  const since = Number.isFinite(n) ? n : 0;
  return alerts.filter((a) => a && monNum(a.ts) && a.ts > since).length;
}

/** The banner of a paused agent: "Paused because <rule>", who it is, and its session link. */
function pauseBanner(p, rules) {
  if (!p || typeof p !== 'object' || !Number.isInteger(p.pid)) return null;
  const text =
    p.by === 'rule'
      ? p.rule
        ? `Paused because ${monRuleTitle(p.rule, rules)}`
        : 'Paused by a monitor'
      : p.by === 'owner'
        ? 'Paused by you'
        : 'Paused (found stopped; this server did not record why)';
  return {
    text,
    who: `${monAppName(p.app)} · pid ${p.pid}`,
    href: monHref(p.sessionKey),
    pid: p.pid,
    startTime: monNum(p.startTime) ? p.startTime : null,
    since: monNum(p.since) ? p.since : null,
  };
}

// The paused list does not say which rule paused an agent; the latest successful pause alert of its session does.
function pausedWithRule(paused, alerts) {
  if (!Array.isArray(paused)) return [];
  const list = Array.isArray(alerts) ? alerts : [];
  return paused
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      if (p.by !== 'rule' || typeof p.sessionKey !== 'string') return { ...p };
      const until = monNum(p.since) ? p.since + 60e3 : Infinity;
      let best = null;
      for (const a of list) {
        if (!a || a.action !== 'pause' || a.ok !== true || a.sessionKey !== p.sessionKey) continue;
        if (typeof a.rule !== 'string' || !monNum(a.ts) || a.ts > until) continue;
        if (!best || a.ts > best.ts) best = a;
      }
      return best ? { ...p, rule: best.rule } : { ...p };
    });
}

const monClock = (ts) =>
  new Date(ts).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** A process that could run a session, as the owner chooses between them: app and pid, command, folder, start. */
function candidateLabel(c, fmt = monClock) {
  if (!c || typeof c !== 'object' || !Number.isInteger(c.pid)) return null;
  const name = monAppName(c.app);
  const head = `${name} · pid ${c.pid}`;
  const cwd = monText(c.cwd) || 'folder unknown';
  const started = monNum(c.startTime) ? `started ${fmt(c.startTime)}` : '';
  return {
    name,
    head,
    command: monText(c.command),
    cwd,
    started,
    paused: c.paused === true,
    text: [head, cwd, started].filter(Boolean).join(' · '),
  };
}

// A parameter as typed: empty is "back to the default" (null), anything else a number from 0 up.
function monParamValue(k, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { value: null };
  const n = Number(s);
  const spec = Object.hasOwn(MON_PARAMS, k) ? MON_PARAMS[k] : {};
  if (!Number.isFinite(n) || n < 0) return { error: 'Enter a number from 0 up, or leave it empty for the default' };
  if (spec.int && !Number.isInteger(n)) return { error: 'Enter a whole number' };
  if (spec.pct) return n > 100 ? { error: 'Enter a percentage up to 100' } : { value: Math.round(n * 100) / 1e4 };
  return { value: n };
}

// Why there is nothing to pause, resume or stop, in the owner's words; '' when there is something.
// `off` is the status's agents.reason ('server' or 'docker'); `reason` is the candidates' own ('not-indexed', …).
function monAgentNote({ available, off, pause, reason, candidates } = {}) {
  if (available === false && off === 'docker')
    return 'Agent control is off in Docker: a container cannot see or signal the agent processes on your machine. Run the dashboard on the same machine as the agent to pause, resume or stop it.';
  if (available === false)
    return 'Agent control is off on this server: it runs in server mode or uses password sign-in. Pause, resume and stop work on a dashboard on the same machine as the agent.';
  if (pause === false)
    return 'Windows has no pause, and it does not report the folder a process runs in, so ZAAFPulse cannot tell which process runs this session. Stop the agent from its own window.';
  if (reason === 'not-indexed')
    return 'This session is not in the index yet. Try again after the next scan, within a minute.';
  if (reason === 'unsupported') return 'Only Claude Code and Codex sessions can be linked to a process.';
  if (candidates === 0)
    return 'No running agent process matches this session: none runs in its folder and started before its first line.';
  return '';
}

// Any refusal of an agent action, as text. A 502 is Windows: taskkill without /F did not close the app.
function monActionError(e) {
  const st = e && Number.isInteger(e.status) ? e.status : 0;
  const msg = monText(e && e.message, 300) || 'the agent could not be controlled';
  const said = msg[0].toUpperCase() + msg.slice(1);
  if (st === 502)
    return `${said}. ${monText(e.hint, 300) || 'Windows asked the app to close and it did not. Close it from its own window.'}`;
  return st ? `${said} (${st})` : said;
}

/* ---------- browser side ---------- */
const MON = {
  alerts: [], // newest first
  loaded: false,
  busy: false,
  timer: 0,
  rules: null, // from /api/monitors, for rule titles
  status: null,
  statusAt: 0,
  statusReq: null,
  agent: null, // the target the agent drawer shows
  trace: null, // the target of the trace explorer's selected session
  strip: { msg: '', tone: '', busy: false },
};
const MON_TARGETS = new Map(); // container id -> { t, repaint }
const MON_READ_KEY = 'zp.alertsRead';
const MON_POLL_MS = 15000;
const MON_KEEP = 100;
const monLastRead = () => {
  const n = Number(store.get(MON_READ_KEY, 0));
  return Number.isFinite(n) ? n : 0;
};

// fetch with the server's { error, hint } and status kept, so a 409 or a 502 can be told apart and shown.
async function monApi(path, body) {
  const opts =
    body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error('the server did not answer'), { status: 0 });
  }
  if (r.status === 401) {
    location.href = '/login.html';
    throw Object.assign(new Error('signed out'), { status: 401 });
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok) {
    const msg = j && typeof j.error === 'string' ? j.error : `the server answered ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status, hint: j && typeof j.hint === 'string' ? j.hint : '' });
  }
  return j && typeof j === 'object' ? j : {};
}

function monLoadStatus(force = false) {
  if (!force && MON.status && Date.now() - MON.statusAt < 10000) return Promise.resolve(MON.status);
  if (MON.statusReq) return MON.statusReq;
  MON.statusReq = monApi('/api/monitors/status')
    .then((st) => {
      MON.status = st;
      MON.statusAt = Date.now();
      return st;
    })
    .finally(() => {
      MON.statusReq = null;
    });
  return MON.statusReq;
}
const monOffReason = () => (MON.status && MON.status.agents ? MON.status.agents.reason : null);
const monAgentsOff = () => !!(MON.status && MON.status.agents && MON.status.agents.available === false);
const monNoPause = () => !!(MON.status && MON.status.agents && MON.status.agents.pause === false);
const monPausedList = () => pausedWithRule(MON.status && MON.status.paused, MON.alerts);

/* ---- the bell ---- */
function monMountBell() {
  const right = document.querySelector('.topbar-right');
  if (!right || document.getElementById('mon-bell')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'mon-bell';
  b.className = 'icon-btn mon-bell';
  b.title = 'Alerts';
  b.setAttribute('aria-label', 'Alerts');
  b.innerHTML = `${icon('bell')}<b class="mon-bell-n" id="mon-bell-n" hidden></b>`;
  right.insertBefore(b, document.getElementById('rescan'));
  b.onclick = () => monOpenDrawer('alerts', b);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) monPoll();
  });
  monPoll();
  monApi('/api/monitors')
    .then((r) => {
      MON.rules = Array.isArray(r.rules) ? r.rules : null;
    })
    .catch(() => {});
}

function monMerge(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const seen = new Map(MON.alerts.map((a) => [a.id || `${a.ts}|${a.rule}|${a.instance}`, a]));
  for (const a of rows) if (a && typeof a === 'object') seen.set(a.id || `${a.ts}|${a.rule}|${a.instance}`, a);
  MON.alerts = [...seen.values()]
    .sort((x, y) => (monNum(y.ts) ? y.ts : 0) - (monNum(x.ts) ? x.ts : 0))
    .slice(0, MON_KEEP);
}

// New alerts every 15 s while the page is on screen; a hidden page waits for visibilitychange.
async function monPoll() {
  if (MON.busy) return;
  clearTimeout(MON.timer);
  MON.timer = 0;
  if (document.hidden) return;
  MON.busy = true;
  try {
    const newest = MON.alerts.reduce((m, a) => (monNum(a.ts) && a.ts > m ? a.ts : m), 0);
    // One millisecond back, deduplicated by id: an alert written in the same millisecond as the last one is not lost.
    const q = MON.loaded ? `?since=${Math.max(0, Math.floor(newest) - 1)}&limit=${MON_KEEP}` : `?limit=${MON_KEEP}`;
    const r = await monApi(`/api/alerts${q}`);
    monMerge(r.alerts);
    MON.loaded = true;
    if (monNeedsStatus()) await monLoadStatus(true).catch(() => null);
  } catch {
    /* an older server or a restart: the bell stays as it was */
  } finally {
    MON.busy = false;
  }
  monPaintBell();
  monRepaint();
  MON.timer = setTimeout(monPoll, MON_POLL_MS);
}

function monPaintBell() {
  const n = unreadCount(MON.alerts, monLastRead());
  const badge = document.getElementById('mon-bell-n');
  const bell = document.getElementById('mon-bell');
  if (!badge || !bell) return;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
  bell.setAttribute('aria-label', n ? `Alerts: ${n} unread` : 'Alerts');
  bell.classList.toggle('has-unread', n > 0);
}

function monMarkRead() {
  const newest = MON.alerts.reduce((m, a) => (monNum(a.ts) && a.ts > m ? a.ts : m), 0);
  // The newest alert's own time, not this clock: a server clock ahead of the browser would leave them unread.
  store.set(MON_READ_KEY, String(Math.max(newest, monLastRead())));
  monPaintBell();
  monRepaint();
}

const monNeedsStatus = () =>
  !!document.querySelector('[data-mon-strip]') || !!MON.trace || ['alerts', 'agent'].includes(drawer.kind);

// Everything that shows monitor data, painted again from what is loaded.
function monRepaint() {
  if (['alerts', 'agent'].includes(drawer.kind)) monPaintDrawer();
  monPaintStrips();
  if (MON.trace) monTracePaint();
}

/* ---- the drawer: alerts, and the agent of one session ---- */
function monOpenDrawer(kind, opener) {
  openDrill(kind, opener);
  // paintDrawer waits for the summary; the alerts and agent views do not need it.
  if (!state.data) monPaintDrawer();
  if (kind === 'alerts' && !MON.status) monLoadStatus().then(monRepaint, () => {});
}
function monPaintDrawer() {
  if (state.data) return paintDrawer(false);
  if (!drawer.kind || !DRILLS[drawer.kind]) return;
  const v = DRILLS[drawer.kind]();
  $('#drawer-eyebrow').textContent = v.eyebrow;
  $('#drawer-title').textContent = v.title;
  $('#drawer-body').innerHTML = v.body;
}

function monAlertRow(l, unread) {
  const session = l.session
    ? l.href
      ? `<a class="mon-session" href="${esc(l.href)}">${esc(l.session)} →</a>`
      : `<span class="mon-session">${esc(l.session)}</span>`
    : l.href
      ? `<a class="mon-session" href="${esc(l.href)}">Open the session →</a>`
      : '';
  const time = l.ts ? `<time class="mon-time" title="${esc(fmtDate(l.ts))}">${esc(ago(l.ts))}</time>` : '';
  return `<div class="mon-alert ${esc(l.tone)}${unread ? ' unread' : ''}" role="listitem">
    <i class="mon-dot" aria-hidden="true"></i>
    <div class="mon-alert-main"><div class="mon-alert-top"><b>${esc(l.title)}</b><span class="mon-change">${esc(l.change)}</span>${unread ? '<span class="mon-new">new</span>' : ''}</div>
      ${l.measure ? `<div class="mon-measure">${esc(l.measure)}</div>` : ''}${session}</div>${time}</div>`;
}

function monBannerHtml(p, actions) {
  const b = pauseBanner(p, MON.rules);
  if (!b) return '';
  const link = b.href ? `<a href="${esc(b.href)}">Session →</a>` : '';
  const btns = actions
    ? `<button type="button" class="btn ghost mon-sm" data-mon-strip-act="resume" data-pid="${esc(b.pid)}" data-start="${esc(b.startTime)}" ${MON.strip.busy ? 'disabled' : ''}>Resume</button><button type="button" class="btn ghost mon-sm danger" data-mon-strip-act="stop" data-pid="${esc(b.pid)}" data-start="${esc(b.startTime)}" ${MON.strip.busy ? 'disabled' : ''}>Stop</button>`
    : '';
  return `<div class="mon-banner" role="status"><span class="mon-pause-ic" aria-hidden="true">⏸</span><b>${esc(b.text)}</b><span class="mon-who">${esc(b.who)}${b.since ? ` · ${esc(ago(b.since))}` : ''}</span>${link}<span class="mon-spacer"></span>${btns}</div>`;
}
function monBannersHtml() {
  if (monAgentsOff()) return '';
  const banners = monPausedList()
    .map((p) => monBannerHtml(p, true))
    .join('');
  const msg = MON.strip.msg ? `<p class="mon-msg ${esc(MON.strip.tone)}" role="status">${esc(MON.strip.msg)}</p>` : '';
  return banners || msg ? `<div class="mon-banners">${banners}${msg}</div>` : '';
}

const MONITOR_DRILLS = {
  alerts() {
    const read = monLastRead();
    const agents = MON.status && MON.status.agents;
    const lines = MON.alerts.map((a) => alertLine(a, MON.rules, agents)).filter(Boolean);
    const unread = unreadCount(MON.alerts, read);
    const rows = lines.map((l) => monAlertRow(l, monNum(l.ts) && l.ts > read)).join('');
    const counts = MON.status && MON.status.counts;
    const now =
      counts && monNum(counts.triggered)
        ? `${counts.triggered} triggered now · ${counts.snoozed || 0} snoozed · ${counts.no_data || 0} without data`
        : '';
    return {
      eyebrow: 'MONITORS',
      title: 'Alerts',
      body: `<div class="mon-dhead"><span>${unread ? `${esc(unread)} unread` : 'All read'}${now ? ` · ${esc(now)}` : ''}</span>
        <button type="button" class="btn ghost mon-sm" data-mon-read ${unread ? '' : 'disabled'}>Mark all read</button></div>
        ${monBannersHtml()}
        ${
          rows
            ? `<div class="mon-alerts" role="list">${rows}</div>`
            : `<div class="empty">${MON.loaded ? 'No alerts yet. The monitors look every minute and on the live snapshot.' : 'Reading the alerts…'}</div>`
        }
        <p class="drawer-note">An alert is written when a rule changes state. "Mark all read" is kept in this browser only.</p>
        <a class="btn ghost" href="#settings/monitors">Monitor settings →</a>`,
    };
  },
  agent() {
    const t = MON.agent;
    if (!t) return { eyebrow: 'AGENT CONTROL', title: 'Agent', body: '' };
    const open = t.key && !location.hash.includes(`key=${encodeURIComponent(t.key)}`) ? monHref(t.key) : null;
    return {
      eyebrow: 'AGENT CONTROL',
      title: t.name || 'Agent of this session',
      body: `<div class="mon-agent" data-mon-target="drawer">${monAgentHtml(t, 'full')}</div>
        <p class="drawer-note">Pause stops the process where it is (SIGSTOP); Resume lets it go on. Stop sends an interrupt, then asks it to quit 5 s later if it is still running; it never force-kills. Every action is written to the agent audit log.</p>
        ${open ? `<a class="btn ghost" href="${esc(open)}">Open the session →</a>` : ''}`,
    };
  },
};

/* ---- agent control: one session's agent process ---- */
function monTarget(key, name) {
  return {
    key,
    name,
    loading: true,
    off: false,
    error: '',
    cands: [],
    canPause: true,
    reason: null,
    pick: null,
    busy: '',
    msg: '',
    tone: '',
  };
}
// One process: the same pid and start times within 2 s, the server's tolerance (lib/agents/control.js sameProcess).
// A start time comes from an age in whole seconds, so two reads of one process can differ by a second.
const MON_SAME_START_MS = 2000;
function monSameProc(a, b) {
  if (!a || !b || a.pid !== b.pid) return false;
  return monNum(a.startTime) && monNum(b.startTime) && Math.abs(a.startTime - b.startTime) <= MON_SAME_START_MS;
}
const monCandId = (c) => `${c.pid}:${c.startTime}`;
function monPicked(t) {
  if (typeof t.pick !== 'string') return null;
  const [pid, startTime] = t.pick.split(':').map(Number);
  return t.cands.find((c) => monSameProc(c, { pid, startTime })) || null;
}
// Paused if the candidate says so or the paused list has the same process.
function pausedEntryFor(c, list) {
  if (!c) return null;
  const p = (Array.isArray(list) ? list : []).find((x) => monSameProc(x, c));
  return p || (c.paused ? { pid: c.pid, startTime: c.startTime, app: c.app, by: null } : null);
}
const monPausedEntry = (c) => pausedEntryFor(c, monPausedList());

async function monLoadTarget(t) {
  t.loading = true;
  t.error = '';
  try {
    const st = await monLoadStatus().catch(() => null);
    if (st && st.agents && st.agents.available === false) {
      t.off = true;
      return;
    }
    const r = await monApi(`/api/agents/candidates?key=${encodeURIComponent(t.key)}`);
    t.cands = (Array.isArray(r.candidates) ? r.candidates : []).filter(
      (c) => c && Number.isInteger(c.pid) && monNum(c.startTime),
    );
    t.canPause = r.canPause !== false;
    t.reason = typeof r.reason === 'string' ? r.reason : null;
    // One candidate is the session's process; with several the owner chooses, nothing is picked for them.
    // A kept pick takes the reread start time, so the radio button still shows it.
    const kept = t.cands.length === 1 ? t.cands[0] : monPicked(t);
    t.pick = kept ? monCandId(kept) : null;
  } catch (e) {
    if (e.status === 403) t.off = true;
    else t.error = `Could not look for the agent: ${monText(e.message)}`;
  } finally {
    t.loading = false;
  }
}

function monStopText(c, win) {
  const l = candidateLabel(c) || { name: 'the agent', cwd: 'folder unknown' };
  return [
    'Stop ' + l.name + ' (pid ' + c.pid + ')?',
    'Folder: ' + l.cwd,
    '',
    win
      ? 'Windows asks the app to close (taskkill without /F). An app that does not close has to be closed from its own window.'
      : 'ZAAFPulse sends an interrupt (SIGINT) now and asks it to quit (SIGTERM) 5 s later if it is still running. It never force-kills.',
    'Claude Code may take the first interrupt as "stop this turn" and keep running.',
  ].join('\n');
}

function monDoneText(action, r) {
  if (r.demo) return `Demo mode: nothing was sent (${action}).`;
  if (action === 'pause') return 'Paused. The agent waits where it was until you resume it.';
  if (action === 'resume') return 'Resumed.';
  if (r.signal === 'taskkill') return 'Windows asked the app to close.';
  if (r.exited === true) return 'Stopped: the agent exited after the interrupt.';
  if (r.exited === false) return 'Still running after 5 s, so it was asked to quit (SIGTERM). Check its window.';
  return 'Interrupt sent. Whether it exited could not be checked.';
}

async function monAct(t, action, repaint) {
  const c = monPicked(t);
  if (!c || t.busy) return;
  if (action === 'stop' && !confirm(monStopText(c, !t.canPause))) return;
  t.busy = action;
  t.msg = '';
  repaint();
  try {
    const body = { key: t.key, pid: c.pid, startTime: c.startTime };
    if (action === 'stop') body.confirm = true;
    const r = await monApi(`/api/agents/${action}`, body);
    t.tone = 'good';
    t.msg = monDoneText(action, r);
    // A demo answer changes nothing, so the paused mark follows real answers only.
    if (!r.demo && action !== 'stop') c.paused = action === 'pause';
    if (!r.demo && action === 'stop') t.cands = t.cands.filter((x) => x !== c);
  } catch (e) {
    t.tone = 'bad';
    t.msg = monActionError(e);
  } finally {
    t.busy = '';
  }
  await monLoadStatus(true).catch(() => null);
  repaint();
  monRepaint();
}

function monCandHtml(t, c, choose) {
  const l = candidateLabel(c);
  const paused = monPausedEntry(c);
  const id = monCandId(c);
  const inner = `<span class="mon-cand-main"><b>${esc(l.head)}</b>${paused ? '<span class="mon-tag">paused</span>' : ''}
    ${l.command ? `<code>${esc(l.command)}</code>` : ''}<small>${esc(l.cwd)}${l.started ? ` · ${esc(l.started)}` : ''}</small></span>`;
  return choose
    ? `<label class="mon-cand${t.pick === id ? ' on' : ''}"><input type="radio" name="mon-pick" value="${esc(id)}" data-mon-pick ${t.pick === id ? 'checked' : ''}>${inner}</label>`
    : `<div class="mon-cand on">${inner}</div>`;
}

// The agent of a session: the full chooser (drawer) or one line (trace explorer).
function monAgentHtml(t, mode) {
  const full = mode === 'full';
  const note = (txt, cls = '') => `<p class="mon-note ${esc(cls)}">${esc(txt)}</p>`;
  if (t.loading) return full ? note('Looking for the agent process…') : '';
  if (t.off) return note(monAgentNote({ available: false, off: monOffReason() }), 'off');
  if (t.error) return note(t.error, 'bad');
  const why = monAgentNote({ available: true, pause: t.canPause, reason: t.reason, candidates: t.cands.length });
  if (!t.cands.length) return full || !t.canPause ? note(why, 'off') : '';
  const c = monPicked(t);
  const paused = monPausedEntry(c);
  const busy = t.busy ? 'disabled' : '';
  const msg = t.msg ? `<span class="mon-msg ${esc(t.tone)}" role="status">${esc(t.msg)}</span>` : '';
  const btn = (act, label, cls = '') =>
    `<button type="button" class="${full ? 'btn ghost' : 'tr-btn ghost'} mon-sm ${esc(cls)}" data-mon-act="${esc(act)}" ${c ? busy : 'disabled'}>${esc(t.busy === act ? `${label}…` : label)}</button>`;
  const winNote = t.canPause ? '' : note(monAgentNote({ available: true, pause: false }), 'off');
  if (!full) {
    if (t.cands.length > 1)
      return `<span>${esc(t.cands.length)} processes could run this session. ZAAFPulse does not guess which.</span>${msg}<button type="button" class="tr-btn ghost mon-sm" data-mon-choose>Choose…</button>`;
    const l = candidateLabel(c);
    if (paused) {
      const b = pauseBanner(paused, MON.rules);
      return `<b class="mon-paused-line">⏸ ${esc(b.text)}</b><span class="mon-who">${esc(l.head)}</span>${msg}${t.canPause ? btn('resume', 'Resume') : ''}${btn('stop', 'Stop', 'danger')}`;
    }
    return `<span class="mon-who">Agent: ${esc(l.text)}</span>${msg}${btn('stop', 'Stop', 'danger')}`;
  }
  const several = t.cands.length > 1;
  const cands = t.cands.map((x) => monCandHtml(t, x, several)).join('');
  const banner = paused ? monBannerHtml(paused, false) : '';
  const btns =
    (t.canPause ? (paused ? btn('resume', 'Resume') : btn('pause', 'Pause')) : '') + btn('stop', 'Stop', 'danger');
  return `${several ? `<p class="mon-note">${esc(t.cands.length)} processes run in this session's folder and started before it. Pick the one to control; ZAAFPulse does not guess.</p>` : ''}
    <div class="mon-cands" ${several ? 'role="radiogroup" aria-label="Agent process"' : ''}>${cands}</div>${banner}${winNote}
    <div class="mon-acts">${btns}${several && !c ? '<span class="mon-note">Pick a process first.</span>' : ''}</div>${msg}`;
}

function monPaintTarget(id) {
  const reg = MON_TARGETS.get(id);
  if (reg) reg.repaint();
}

// The agent drawer for a session, from its trace key or from a source and session id (Live monitor, AI Office).
async function monOpenAgent(ref, name, opener) {
  const t = ref.target || monTarget(ref.key || null, monText(name, MON_MAX_TITLE));
  MON.agent = t;
  MON_TARGETS.set('drawer', { t, repaint: () => drawer.kind === 'agent' && monPaintDrawer() });
  monOpenDrawer('agent', opener);
  if (ref.target) return;
  if (!t.key) {
    try {
      const q = `source=${encodeURIComponent(ref.src)}&sid=${encodeURIComponent(ref.sid)}`;
      t.key = (await monApi(`/api/trace/find?${q}`)).key || null;
    } catch (e) {
      t.loading = false;
      t.error =
        e.status === 404
          ? 'This session is not in the trace explorer yet, so its process cannot be found.'
          : `Could not find the session: ${monText(e.message)}`;
      if (MON.agent === t) monPaintTarget('drawer');
      return;
    }
  }
  await monLoadTarget(t);
  if (MON.agent === t) monPaintTarget('drawer');
}

// A small button for a session row; nothing when agent control is known to be off.
function monAgentButton(src, sid, name) {
  if (!['claude', 'codex'].includes(src) || typeof sid !== 'string' || !sid || monAgentsOff()) return '';
  return `<button type="button" class="mon-agent-btn" data-mon-agent data-src="${esc(src)}" data-sid="${esc(sid)}" data-name="${esc(name || '')}" title="Pause, resume or stop the agent of this session">Agent</button>`;
}

/* ---- the trace explorer: the selected session's agent ---- */
// Called by the trace explorer when a session is selected, and with null when the page goes away.
function monTraceSession(key) {
  const app = document.getElementById('tr-app');
  if (!key || !app) {
    MON.trace = null;
    MON_TARGETS.delete('trace');
    return;
  }
  if (!document.getElementById('mon-tr-agent')) {
    const box = document.createElement('div');
    box.id = 'mon-tr-agent';
    box.className = 'tr-notice mon-tr-agent';
    box.dataset.monTarget = 'trace';
    box.hidden = true;
    const after = document.getElementById('tr-off');
    if (after) after.after(box);
  }
  const btn = app.querySelector('[data-sub="3"]');
  if (btn && !btn.dataset.monBound) {
    btn.dataset.monBound = '1';
    btn.addEventListener('click', () => {
      const t = MON.trace;
      if (!t) return;
      // One process is the session's own: pause it. Several: the owner picks in the drawer.
      if (t.cands.length === 1) monAct(t, 'pause', monTracePaint);
      else if (t.cands.length > 1) monOpenAgent({ target: t }, null, btn);
    });
  }
  const t = monTarget(key, null);
  MON.trace = t;
  MON_TARGETS.set('trace', { t, repaint: monTracePaint });
  monTracePaint();
  monLoadTarget(t).then(() => {
    if (MON.trace === t) monTracePaint();
  });
}
function monTracePaint() {
  const t = MON.trace;
  const box = document.getElementById('mon-tr-agent');
  const btn = document.querySelector('#tr-app [data-sub="3"]');
  if (!t || !box) return;
  const html = monAgentHtml(t, 'inline');
  box.innerHTML = html;
  box.hidden = !html;
  box.classList.toggle('off', t.off || !t.canPause);
  box.classList.toggle('paused', !!monPausedEntry(monPicked(t)));
  if (btn) {
    const c = monPicked(t);
    // Shown only with something to pause: control on, pause supported, a process, and that process running.
    const show = !t.loading && !t.off && t.canPause && t.cands.length > 0 && !(c && monPausedEntry(c));
    btn.hidden = !show;
    btn.disabled = !!t.busy;
    btn.title =
      t.cands.length > 1 ? 'Several processes could run this session: pick one' : 'Pause the agent process (SIGSTOP)';
  }
  if (MON.agent === t && drawer.kind === 'agent') monPaintDrawer();
}

/* ---- Live monitor and AI Office: the paused agents ---- */
function monPaintStrips() {
  const strips = document.querySelectorAll('[data-mon-strip]');
  if (!strips.length) return;
  if (!MON.status && !MON.statusReq) monLoadStatus().then(monPaintStrips, () => {});
  const html = monBannersHtml();
  for (const el of strips) {
    if (el.contains(document.activeElement) && MON.strip.busy) continue;
    el.innerHTML = html;
    el.hidden = !html;
  }
}

async function monStripAct(action, pid, startTime) {
  const p = monPausedList().find((x) => monSameProc(x, { pid, startTime }));
  if (!p || MON.strip.busy) return;
  let c = { pid, startTime, app: p.app, cwd: null };
  // The confirmation names the folder; the paused list has none, the candidates of its session do.
  if (action === 'stop' && p.sessionKey) {
    try {
      const r = await monApi(`/api/agents/candidates?key=${encodeURIComponent(p.sessionKey)}`);
      const m = (r.candidates || []).find((x) => monSameProc(x, { pid, startTime }));
      if (m) c = m;
    } catch {
      /* the folder stays unknown */
    }
  }
  if (action === 'stop' && !confirm(monStopText(c, monNoPause()))) return;
  MON.strip = { msg: '', tone: '', busy: true };
  monPaintStrips();
  try {
    const body = { pid, startTime };
    if (p.sessionKey) body.key = p.sessionKey;
    if (action === 'stop') body.confirm = true;
    const r = await monApi(`/api/agents/${action}`, body);
    MON.strip = { msg: monDoneText(action, r), tone: 'good', busy: false };
  } catch (e) {
    MON.strip = { msg: monActionError(e), tone: 'bad', busy: false };
  }
  await monLoadStatus(true).catch(() => null);
  monRepaint();
}

/* ---------- Settings → Monitors ---------- */
function monitorsSettingsShell() {
  return `<section class="card mon-settings" id="mon-settings" aria-labelledby="mon-set-title">
    <div class="card-head"><h3 id="mon-set-title">Monitors</h3><span class="meta">rules on cost, quality and agent behaviour · checked every minute · stored in .data/monitors.json</span></div>
    <div class="ev-status" id="mon-status" role="status"><i aria-hidden="true"></i><span id="mon-status-msg">Reading the monitors…</span></div>
    <div class="mon-rules" id="mon-rules"><div class="skeleton" style="height:220px"></div></div>
    <div class="mon-channels" id="mon-channels"></div></section>`;
}

function monRuleNow(r) {
  if (!r.enabled) return 'Off. Turn it on to start checking.';
  const inst = Array.isArray(r.instances) ? r.instances : [];
  if (r.kind !== 'live') {
    const i = inst[0];
    if (!i) return 'Not checked yet.';
    const m = monMeasure(r.id, i.value, i.threshold);
    return i.state === 'no_data' ? `No data yet${m ? ` · ${m}` : ''}` : m || MON_STATE[i.state] || '';
  }
  if (!inst.length) return 'No session to check right now.';
  const hot = inst.filter((i) => i.state === 'triggered');
  const snoozed = inst.filter((i) => i.state === 'snoozed').length;
  const names = hot
    .map((i) => monText(i.title, 40))
    .filter(Boolean)
    .slice(0, 3);
  return [
    `${hot.length} of ${inst.length} session${inst.length === 1 ? '' : 's'} triggered${names.length ? `: ${names.join(', ')}` : ''}`,
    snoozed ? `${snoozed} snoozed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function monRuleCard(r, opts) {
  const st = Object.hasOwn(MON_STATE, r.state) ? r.state : 'no_data';
  const params = Object.keys(r.defaults || r.params || {})
    .filter((k) => Object.hasOwn(MON_PARAMS, k))
    .map((k) => {
      const spec = MON_PARAMS[k];
      const show = (v) => (monNum(v) ? String(spec.pct ? Math.round(v * 1000) / 10 : v) : '');
      const cur = r.params ? r.params[k] : null;
      const def = r.defaults ? r.defaults[k] : null;
      const ph = show(def) || spec.empty || '';
      return `<label class="mon-param">${esc(spec.label)}<input class="input" type="number" min="0" step="${esc(spec.step)}" inputmode="decimal" data-mon-param="${esc(k)}" value="${esc(show(cur))}" placeholder="${esc(ph)}" aria-label="${esc(r.title + ': ' + spec.label)}"></label>`;
    })
    .join('');
  const snoozed = monNum(r.snoozedUntil) && r.snoozedUntil > Date.now();
  const snooze = snoozed
    ? `<span class="mon-snoozed">Snoozed until ${esc(monClock(r.snoozedUntil))}</span><button type="button" class="btn ghost mon-sm" data-mon-snooze="off">Unsnooze</button>`
    : `<span class="mon-snooze-l">Snooze</span><button type="button" class="btn ghost mon-sm" data-mon-snooze="1h" ${r.enabled ? '' : 'disabled'}>1 h</button><button type="button" class="btn ghost mon-sm" data-mon-snooze="1d" ${r.enabled ? '' : 'disabled'}>1 day</button>`;
  const auto =
    r.mayAutoPause && opts.pause
      ? `<label class="ie-switch mon-auto" title="When this rule triggers, pause the one agent process of that session. Several or none: it tells you instead."><input type="checkbox" data-mon-autopause ${r.autoPause ? 'checked' : ''}><span></span>Pause the agent</label>`
      : '';
  return `<article class="mon-rule ${esc(st)}" data-mon-rule="${esc(r.id)}">
    <div class="mon-rule-head"><label class="ie-switch mon-enable"><input type="checkbox" data-mon-enable ${r.enabled ? 'checked' : ''} aria-label="${esc('Check ' + r.title)}"><span></span><b>${esc(r.title)}</b></label>
      <span class="mon-state ${esc(st)}">${esc(MON_STATE[st])}</span></div>
    <p class="mon-desc">${esc(r.describe)}</p>
    <p class="mon-now">${esc(monRuleNow(r))}</p>
    ${params ? `<div class="mon-params">${params}</div>` : ''}
    <div class="mon-rule-foot">${auto}<span class="mon-snooze">${snooze}</span></div>
    <span class="saved mon-saved" data-mon-saved role="status"></span></article>`;
}

function monSecretRow(field, label, configured, placeholder) {
  const modes = [
    ...(configured ? [['keep', 'Keep current']] : []),
    ['store', `Paste → save to ${storeName()}`],
    ['keychain', `${storeName()} item`],
    ['env', 'Environment variable'],
    ['none', configured ? 'Remove' : 'None'],
  ];
  const first = configured ? 'keep' : field === 'url' ? 'store' : 'none';
  return `<div class="ie-field mon-secret"><label>${esc(label)}</label>
    <div class="ie-secret"><select class="input" data-mon-wh-mode="${esc(field)}" aria-label="${esc(`${label}: where it is kept`)}">${modes.map(([m, l]) => `<option value="${esc(m)}" ${m === first ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <input class="input" data-mon-wh-val="${esc(field)}" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" ${first === 'store' ? 'type="password"' : 'hidden'} aria-label="${esc(label)}"></div></div>`;
}
const MON_WH_PLACEHOLDER = {
  url: { store: 'https://hooks.example.com/…', keychain: 'acc.monitors-webhook-url', env: 'MONITOR_WEBHOOK_URL' },
  headers: {
    store: 'Authorization: Bearer …',
    keychain: 'acc.monitors-webhook-headers',
    env: 'MONITOR_WEBHOOK_HEADERS',
  },
};

function monChannelsHtml(ch) {
  const w = ch.webhook || {};
  const state = w.configured
    ? `Set${w.headers ? ', with headers' : ''}. The URL is a secret reference, never in config.json.`
    : 'Not set.';
  return `<div class="mon-ch">
      <h4>Desktop notifications</h4>
      <label class="ie-switch ev-switch"><input type="checkbox" data-mon-desktop ${ch.desktop ? 'checked' : ''}><span></span>Notify on this computer</label>
      <p class="mon-desc">A notification holds the rule name, numbers and the session title, never anything said in the session.</p>
      <div class="mon-acts"><button type="button" class="btn ghost mon-sm" data-mon-test="desktop">Send test</button><span class="saved" data-mon-ch-msg="desktop" role="status"></span></div>
    </div>
    <form class="mon-ch" data-mon-webhook novalidate>
      <h4>Webhook</h4>
      <p class="mon-desc">${esc(state)}</p>
      ${w.problem ? `<p class="mon-msg bad">${esc(monText(w.problem, 300))}</p>` : ''}
      ${monSecretRow('url', 'URL', !!w.configured, MON_WH_PLACEHOLDER.url.store)}
      ${monSecretRow('headers', 'Headers (optional)', !!w.headers, MON_WH_PLACEHOLDER.headers.store)}
      <p class="mon-desc">Secrets never go into config.json: paste one to save it to the ${esc(storeLong())}, or name a ${esc(storeName())} item or an environment variable. <a href="${esc(MON_SECRETS_DOC)}" target="_blank" rel="noopener">How secrets are added</a>. The webhook receives <code>{ rule, state, previous, value, threshold, sessionId, ts }</code> and nothing else.</p>
      <div class="mon-acts"><button class="btn mon-sm" type="submit">Save webhook</button><button type="button" class="btn ghost mon-sm" data-mon-test="webhook" ${w.configured ? '' : 'disabled'}>Send test</button><span class="saved" data-mon-ch-msg="webhook" role="status"></span></div>
    </form>
    ${ch.sending === false ? '<p class="mon-note off mon-wide">This server sends nothing: it runs in demo mode or with ZAAFPULSE_NOTIFY=off. Settings are still saved.</p>' : ''}`;
}

async function mountMonitorsSettings() {
  const sec = $('#mon-settings');
  if (!sec) return;
  const S = { rules: [], channels: null, status: null };
  const say = (el, msg, bad = false) => {
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('bad', bad);
  };
  const statusLine = () => {
    const st = S.status;
    const box = $('#mon-status');
    const msg = $('#mon-status-msg');
    if (!box || !msg) return;
    const c = (st && st.counts) || {};
    const on = S.rules.filter((r) => r.enabled).length;
    const parts = [`${on} of ${S.rules.length} rules on`];
    if (st) {
      parts.push(
        `${c.triggered || 0} triggered · ${c.ok || 0} OK · ${c.no_data || 0} without data · ${c.snoozed || 0} snoozed`,
      );
      parts.push(st.lastAggregate ? `last check ${ago(st.lastAggregate)}` : 'not checked yet');
      if (st.agents && st.agents.available === false)
        parts.push(`${monOffText(st.agents.reason)}, so no rule pauses an agent`);
      else if (st.agents && st.agents.pause === false) parts.push('Windows has no pause, so no rule pauses an agent');
    }
    msg.textContent = parts.join(' · ');
    box.className = `ev-status ${c.triggered ? 'warn' : on ? 'good' : ''}`;
  };
  const opts = () => ({
    pause: !(S.status && S.status.agents && (S.status.agents.available === false || S.status.agents.pause === false)),
  });
  const paintRules = () => {
    const box = $('#mon-rules');
    if (box) box.innerHTML = S.rules.map((r) => monRuleCard(r, opts())).join('');
  };
  try {
    const [list, st] = await Promise.all([monApi('/api/monitors'), monApi('/api/monitors/status').catch(() => null)]);
    S.rules = Array.isArray(list.rules) ? list.rules : [];
    S.channels = list.channels || { desktop: true, webhook: {} };
    S.status = st;
    MON.rules = S.rules;
    if (st) {
      MON.status = st;
      MON.statusAt = Date.now();
    }
  } catch (e) {
    const box = $('#mon-rules');
    if (box) {
      box.innerHTML = '<div class="empty" id="mon-err"></div>';
      $('#mon-err').textContent = `Could not read the monitors: ${monText(e.message)}`;
    }
    return;
  }
  if (!sec.isConnected) return;
  statusLine();
  paintRules();
  $('#mon-channels').innerHTML = monChannelsHtml(S.channels);
  if (location.hash.startsWith('#settings/monitors')) sec.scrollIntoView({ block: 'start' });

  // One change to one rule; the reply is the rule as saved, and its card is drawn again from it.
  async function saveRule(card, patch, okText = 'Saved') {
    const id = card.dataset.monRule;
    const out = card.querySelector('[data-mon-saved]');
    say(out, 'Saving…');
    const focused =
      document.activeElement && card.contains(document.activeElement) ? document.activeElement.dataset.monParam : null;
    try {
      const r = await monApi(`/api/monitors/${encodeURIComponent(id)}`, patch);
      if (!sec.isConnected) return;
      S.rules = S.rules.map((x) => (x.id === id ? r : x));
      MON.rules = S.rules;
      const tmp = document.createElement('div');
      tmp.innerHTML = monRuleCard(r, opts());
      const next = tmp.firstElementChild;
      card.replaceWith(next);
      say(next.querySelector('[data-mon-saved]'), okText);
      if (focused) next.querySelector(`[data-mon-param="${CSS.escape(focused)}"]`)?.focus();
      statusLine();
    } catch (e) {
      say(out, monText(e.message, 300) || 'Could not save', true);
      // A refused switch goes back to what is saved.
      const r = S.rules.find((x) => x.id === id);
      if (r && patch.enabled !== undefined) card.querySelector('[data-mon-enable]').checked = r.enabled;
      if (r && patch.autoPause !== undefined) card.querySelector('[data-mon-autopause]').checked = r.autoPause;
    }
  }

  sec.addEventListener('change', (e) => {
    const card = e.target.closest('[data-mon-rule]');
    if (card && e.target.matches('[data-mon-enable]')) return void saveRule(card, { enabled: e.target.checked });
    if (card && e.target.matches('[data-mon-autopause]'))
      return void saveRule(
        card,
        { autoPause: e.target.checked },
        e.target.checked ? 'Saved: it pauses the agent' : 'Saved',
      );
    if (card && e.target.matches('[data-mon-param]')) {
      const k = e.target.dataset.monParam;
      const v = monParamValue(k, e.target.value);
      if (v.error) return say(card.querySelector('[data-mon-saved]'), v.error, true);
      return void saveRule(card, { params: { [k]: v.value } });
    }
    if (e.target.matches('[data-mon-desktop]')) return void saveChannels({ desktop: e.target.checked }, 'desktop');
    if (e.target.matches('[data-mon-wh-mode]')) {
      const f = e.target.dataset.monWhMode;
      const input = sec.querySelector(`[data-mon-wh-val="${f}"]`);
      const mode = e.target.value;
      input.hidden = !['store', 'keychain', 'env'].includes(mode);
      input.type = mode === 'store' ? 'password' : 'text';
      input.value = '';
      input.placeholder = (MON_WH_PLACEHOLDER[f] && MON_WH_PLACEHOLDER[f][mode]) || '';
    }
  });

  sec.addEventListener('click', async (e) => {
    const sn = e.target.closest('[data-mon-snooze]');
    if (sn) {
      const card = sn.closest('[data-mon-rule]');
      const v = sn.dataset.monSnooze;
      return void saveRule(card, { snooze: v === 'off' ? null : v }, v === 'off' ? 'Snooze cleared' : 'Snoozed');
    }
    const test = e.target.closest('[data-mon-test]');
    if (test) {
      const kind = test.dataset.monTest;
      const out = sec.querySelector(`[data-mon-ch-msg="${kind}"]`);
      test.disabled = true;
      say(out, 'Sending…');
      try {
        const r = await monApi('/api/monitors/test', { kind });
        if (r.demo) say(out, 'Demo mode: nothing was sent');
        else if (r.ok) say(out, kind === 'desktop' ? 'Sent: look for the notification' : 'Sent');
        else say(out, monText(r.error, 300) || 'The test was not sent', true);
      } catch (err) {
        say(out, monText(err.message, 300) || 'The test was not sent', true);
      } finally {
        test.disabled = false;
      }
    }
  });

  sec.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-mon-webhook]');
    if (!form) return;
    e.preventDefault();
    const body = {};
    for (const f of ['url', 'headers']) {
      const mode = form.querySelector(`[data-mon-wh-mode="${f}"]`).value;
      const v = form.querySelector(`[data-mon-wh-val="${f}"]`).value;
      if (mode === 'keep') continue;
      const key = f === 'url' ? 'webhookRef' : 'webhookHeadersRef';
      if (mode === 'store') body[key] = { mode, value: v };
      else if (mode === 'keychain') body[key] = { mode, service: v.trim() };
      else if (mode === 'env') body[key] = { mode, name: v.trim() };
      else body[key] = null;
    }
    // "None" on a field that was never set changes nothing.
    if (!S.channels.webhook.configured && body.webhookRef === null) delete body.webhookRef;
    if (!S.channels.webhook.headers && body.webhookHeadersRef === null) delete body.webhookHeadersRef;
    if (!Object.keys(body).length) return say(form.querySelector('[data-mon-ch-msg="webhook"]'), 'No changes');
    saveChannels(body, 'webhook');
  });

  async function saveChannels(body, kind) {
    const out = sec.querySelector(`[data-mon-ch-msg="${kind}"]`);
    say(out, 'Saving…');
    try {
      const ch = await monApi('/api/monitors/channels', body);
      if (!sec.isConnected) return;
      S.channels = ch;
      $('#mon-channels').innerHTML = monChannelsHtml(ch);
      say(sec.querySelector(`[data-mon-ch-msg="${kind}"]`), 'Saved');
    } catch (err) {
      say(out, monText(err.message, 300) || 'Could not save', true);
      if (kind === 'desktop') sec.querySelector('[data-mon-desktop]').checked = S.channels.desktop;
    }
  }
}

/* ---------- page-wide clicks ---------- */
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (!e.target.closest) return;
    if (e.target.closest('[data-mon-read]')) return void monMarkRead();
    const act = e.target.closest('[data-mon-act]');
    const host = e.target.closest('[data-mon-target]');
    if (act && host) {
      const reg = MON_TARGETS.get(host.dataset.monTarget);
      if (reg) monAct(reg.t, act.dataset.monAct, reg.repaint);
      return;
    }
    if (e.target.closest('[data-mon-choose]') && MON.trace)
      return void monOpenAgent({ target: MON.trace }, null, e.target);
    const ag = e.target.closest('[data-mon-agent]');
    if (ag) return void monOpenAgent({ src: ag.dataset.src, sid: ag.dataset.sid }, ag.dataset.name, ag);
    const sa = e.target.closest('[data-mon-strip-act]');
    if (sa) monStripAct(sa.dataset.monStripAct, Number(sa.dataset.pid), Number(sa.dataset.start));
  });
  document.addEventListener('change', (e) => {
    const pick = e.target.closest && e.target.closest('[data-mon-pick]');
    const host = pick && pick.closest('[data-mon-target]');
    const reg = host && MON_TARGETS.get(host.dataset.monTarget);
    if (!reg) return;
    reg.t.pick = pick.value;
    reg.t.msg = '';
    reg.repaint();
    // The same target may also be the trace explorer's.
    if (reg.t === MON.trace) monTracePaint();
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    alertLine,
    unreadCount,
    pauseBanner,
    pausedWithRule,
    candidateLabel,
    monParamValue,
    monAgentNote,
    monActionError,
    monMeasure,
    monSameProc,
    pausedEntryFor,
  };
