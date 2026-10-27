'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// Links built from data (note URLs, OpenRouter pages) may only use these schemes; anything else,
// javascript: and data: included, becomes a dead link. Escape the result as usual.
// Parsed the way the browser will: web and mail links, same-origin paths and hashes, and the two deep-link
// shapes ZAAFPulse builds itself (obsidian://open?vault=…, logseq://graph/…). Links from imported data
// cannot open other app actions (obsidian://new, advanced-uri …).
const safeUrl = (v) => {
  const u = String(v ?? '').trim();
  if (/^obsidian:\/\/open\?vault=/i.test(u) || /^logseq:\/\/graph\//i.test(u)) return u;
  let parsed;
  try {
    parsed = new URL(u, location.origin);
  } catch {
    return '#';
  }
  if (['http:', 'https:', 'mailto:'].includes(parsed.protocol) && /^(https?|mailto):/i.test(u)) return u;
  if (parsed.origin === location.origin && /^[/#]/.test(u)) return u;
  return '#';
};
const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
const fmtN = (n) => (n < 10000 ? whole.format(Math.round(n)) : compact.format(n));
const fmtUSD = (n) =>
  n >= 10000
    ? '$' + compact.format(n)
    : '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (x) => `${(x * 100).toFixed(x >= 0.995 || x < 0.1 ? 1 : 0)}%`;
function ago(ts) {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dur(sec) {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
const fmtDate = (ts) =>
  new Date(ts).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayLabel = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
// lowerIsBetter flips the color (e.g. hallucinations going down is good), not the arrow.
function delta(cur, prev, lowerIsBetter = false) {
  if (!prev) return '';
  const d = (cur - prev) / prev;
  const cls = Math.abs(d) < 0.005 ? 'flat' : d > 0 !== lowerIsBetter ? 'up' : 'down';
  const arrow = cls === 'flat' ? '→' : d > 0 ? '↑' : '↓';
  return `<small class="delta ${cls}">${arrow} ${Math.abs(d * 100).toFixed(1)}%</small>`;
}
const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/* ---------- icons (stroke, 24 grid) ---------- */
const ICON_PATHS = {
  pulse: '<path d="M3 12h4l2.5-6 4 13 2.5-7H21"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  sparkle:
    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  zap: '<path d="M13 3L4 14h7l-1 7 9-11h-7z"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
  dollar:
    '<path d="M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3S9.5 10.5 12 11s4.5 1.3 4.5 3.2-2 3.3-4.5 3.3-4.5-1.3-4.5-3"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
  endpoint: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>',
  code: '<path d="M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15"/>',
  chat: '<path d="M4 5.5h16v10H9l-5 4z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  brain:
    '<path d="M9 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10.5a3 3 0 0 0 1 2.3A3 3 0 0 0 6.5 18 3 3 0 0 0 12 19V5.5A3 3 0 0 0 9 4.5zM15 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.3 3 3 0 0 1-1.5 5.2A3 3 0 0 1 12 19"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  wave: '<path d="M3 12h3l3-7 4 14 3-7h5"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
  ghost:
    '<path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.6L14.4 20 12 18.4 9.6 20l-2.3-1.6z"/><path d="M9.5 10.5h.01M14.5 10.5h.01"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  compass: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  anchor: '<circle cx="12" cy="5.5" r="2"/><path d="M12 7.5V20"/><path d="M5 13a7 7 0 0 0 14 0"/><path d="M8.5 11h7"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
};
function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}
function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root))
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, el.classList.contains('brand-mark') ? 20 : 16);
}

/* ---------- app metadata ---------- */
// Tools with readable usage logs get series colors (fixed order: Claude Code = slot 1, Codex = slot 2).
const SERIES = [
  { id: 'claude', name: 'Claude Code', color: 'var(--series-claude)' },
  { id: 'codex', name: 'Codex', color: 'var(--series-codex)' },
];
const APPS = {
  claude: {
    name: 'CLAUDE CODE',
    role: 'Agentic coding · CLI & IDE',
    icon: 'terminal',
    chip: 'blue',
    logs: true,
    desc: 'Coding agent in the terminal and VS Code. Token usage read from local session transcripts.',
  },
  codex: {
    name: 'CODEX',
    role: 'OpenAI coding agent',
    icon: 'code',
    chip: 'amber',
    logs: true,
    desc: 'OpenAI Codex sessions from the desktop app and CLI, with plan rate-limit readings.',
  },
  'claude-desktop': {
    name: 'CLAUDE DESKTOP',
    role: 'Chat & cowork assistant',
    icon: 'chat',
    chip: 'violet',
    desc: 'Claude desktop app. Conversations live in the cloud, so only live presence is tracked here.',
  },
  chatgpt: {
    name: 'CHATGPT',
    role: 'Chat assistant',
    icon: 'chat',
    chip: 'green',
    desc: 'ChatGPT desktop app. Usage is held server-side; live presence and resource use only.',
  },
  antigravity: {
    name: 'ANTIGRAVITY',
    role: 'Gemini agentic IDE',
    icon: 'layers',
    chip: 'violet',
    desc: 'Google Antigravity IDE and Gemini tooling. Live presence and resource use only.',
  },
  cursor: {
    name: 'CURSOR',
    role: 'AI code editor',
    icon: 'code',
    chip: 'blue',
    desc: 'Cursor editor. Live presence and resource use only.',
  },
  kiro: {
    name: 'KIRO',
    role: 'Spec-driven agentic IDE',
    icon: 'code',
    chip: 'amber',
    desc: 'Kiro IDE and CLI. Live presence and resource use only; it can use the AI Command Center MCP server.',
  },
  ollama: {
    name: 'OLLAMA',
    role: 'Local models',
    icon: 'cube',
    chip: 'green',
    desc: 'Runs open models on this machine. Live presence and resource use only.',
  },
  lmstudio: {
    name: 'LM STUDIO',
    role: 'Local models',
    icon: 'cube',
    chip: 'amber',
    desc: 'Runs open models on this machine. Live presence and resource use only.',
  },
};

/* ---------- state ---------- */
const state = {
  range: store.get('range', '30'),
  metric: store.get('metric', 'cost'),
  toolFilter: 'all',
  logNote: '', // the Overview's empty-state note as last drawn
  search: '',
  data: null,
  live: null,
  route: 'overview',
  history: {}, // app id -> recent CPU samples
};
const TITLES = {
  overview: 'OVERVIEW',
  squad: 'AI OFFICE',
  sessions: 'SESSIONS',
  trace: 'TRACE EXPLORER',
  projects: 'PROJECTS',
  agents: 'AGENT SKILLS',
  quality: 'QUALITY & SAFETY',
  brain: 'SECOND BRAIN',
  live: 'LIVE MONITOR',
  integrations: 'INTEGRATIONS',
  endpoint: 'ENDPOINT',
  gateway: 'AGENT GATEWAY',
  skills: 'AGENT SKILLS',
  rag: 'RAG SERVICE',
  a2a: 'AGENT-TO-AGENT',
  settings: 'SETTINGS',
  datasets: 'DATASETS',
  cost: 'COST CONTROL',
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('signed out');
  } // server mode: session ended
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// Where this copy runs (from /api/platform): OS, secret store, server mode. Defaults suit a Mac.
const ZP = {
  os: 'macos',
  secretStore: { id: 'keychain', label: 'macOS Keychain' },
  serverMode: false,
  auth: false,
  baseUrl: location.origin,
};
const storeName = () => ({ keychain: 'Keychain', libsecret: 'keyring' })[ZP.secretStore.id] || 'secret file';
const storeLong = () => ZP.secretStore.label || 'secret store';
const localOnlyLabel = () => (ZP.serverMode ? 'server mode · sign-in' : '127.0.0.1 only');
async function signOut() {
  await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(
    () => {},
  );
  location.href = '/login.html';
}
async function loadSummary() {
  state.data = await api(`/api/summary?range=${state.range}`);
  paintChrome();
}
async function loadLive() {
  try {
    state.live = await api('/api/live');
    const seen = new Set();
    for (const a of state.live.apps) {
      (state.history[a.id] ||= []).push(a.cpu);
      seen.add(a.id);
    }
    recordLive(state.live);
    for (const [id, h] of Object.entries(state.history)) {
      if (!seen.has(id)) h.push(0);
      if (h.length > 60) h.splice(0, h.length - 60); // 5 minutes at 5-second polling
    }
    paintChrome();
  } catch {
    /* server restarting */
  }
}

/* ---------- chrome ---------- */
function paintChrome() {
  const d = state.data;
  const live = state.live;
  if (d) {
    $('#user-name').textContent = d.config.userName;
    $('#user-initials').textContent = initials(d.config.userName);
    $('#ws-host').textContent = d.config.host || 'This laptop';
    $('#ws-initials').textContent = initials((d.config.host || 'ML').replace(/[-_]/g, ' '));
    $('#b-sessions').textContent = d.kpis.sessions || '';
  }
  if (live) {
    $('#b-live').textContent = live.apps.length || '';
    $('#b-squad').textContent = new Set([...live.installed, ...live.apps.map((a) => a.id)]).size || '';
    const busy = live.index && live.index.indexing;
    $('#collector-status').textContent = busy ? `Indexing ${live.index.done}/${live.index.total}` : 'Operational';
    $('#collector-status').classList.toggle('busy', !!busy);
    $('#collector-dot').classList.toggle('busy', !!busy);
  }
}

/* ---------- tooltip ---------- */
const tip = $('#tooltip');
function showTip(e, html) {
  tip.innerHTML = html;
  tip.classList.add('show');
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = e.clientX + pad;
  let y = e.clientY - h - pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y < 8) y = e.clientY + pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => tip.classList.remove('show');

/* ---------- shared blocks ---------- */
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function rangeControl() {
  const opts = [
    ['7', '7d'],
    ['30', '30d'],
    ['90', '90d'],
    ['all', 'All'],
  ];
  return `<div class="segmented" role="group" aria-label="Time range">${opts
    .map(([v, l]) => `<button data-range="${v}" aria-pressed="${state.range === v}">${l}</button>`)
    .join('')}</div>`;
}
function rangeText() {
  const r = state.range;
  return r === 'all' ? 'all time' : `last ${r} days`;
}
function hero(eyebrow, title, sub, extra = '') {
  return `<div class="hero"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${sub}</p></div>
    <div class="hero-actions">${extra}${rangeControl()}</div></div>`;
}
function barList(rows, { value, label, color, fmt = fmtN, empty = 'Nothing recorded in this range.' }) {
  if (!rows.length) return `<div class="empty">${empty}</div>`;
  const max = Math.max(...rows.map(value), 1);
  return `<div class="barlist">${rows
    .map(
      (
        r,
        i,
      ) => `<div class="barrow" data-tip="${esc(typeof label(r) === 'string' ? label(r).replace(/<[^>]+>/g, '') : '')}: ${esc(fmt(value(r)))}">
    <div class="label">${label(r)}</div><div class="val num">${fmt(value(r))}</div>
    <div class="track"><i style="--i:${i};width:${Math.max(1.5, (value(r) / max) * 100)}%;background:${color(r)}"></i></div></div>`,
    )
    .join('')}</div>`;
}
const seriesColor = (id) => (SERIES.find((s) => s.id === id) || {}).color || 'var(--accent)';
const legend = (series = SERIES) =>
  `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;

// Token types: a validated 4-slot categorical set, kept apart from the tool colors.
const TOKEN_TYPES = [
  { id: 'input', name: 'Input', color: 'var(--tt-input)' },
  { id: 'output', name: 'Output', color: 'var(--tt-output)' },
  { id: 'cacheRead', name: 'Cache read', color: 'var(--tt-cread)' },
  { id: 'cacheWrite', name: 'Cache write', color: 'var(--tt-cwrite)' },
];
const SURFACES = {
  desktop: 'Claude desktop app',
  vscode: 'VS Code',
  cli: 'Terminal',
  codex_work_desktop: 'Codex desktop',
  'codex-chrome-extension-sidepanel': 'Codex in Chrome',
  'sdk-ts': 'Agent SDK',
  unknown: 'Unknown',
};

/* ---------- count-up ---------- */
const FORMATS = {
  usd: fmtUSD,
  n: fmtN,
  int: (v) => whole.format(Math.round(v)),
  pad2: (v) => String(Math.round(v)).padStart(2, '0'),
  pct: fmtPct,
};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function countUp(root) {
  for (const el of $$('[data-count]', root)) {
    const to = Number(el.dataset.count);
    const fmt = FORMATS[el.dataset.fmt] || fmtN;
    if (reduceMotion.matches || !to) {
      el.textContent = fmt(to);
      continue;
    }
    const t0 = performance.now();
    const ms = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - (1 - p) ** 3;
      el.textContent = fmt(to * e);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
// Drop the entrance class once motion has played, so redraws (resize, refresh) stay still.
const settleTimers = new WeakMap();
function settle(el, ms = 2200) {
  clearTimeout(settleTimers.get(el));
  settleTimers.set(
    el,
    setTimeout(() => el.classList.remove('animate'), ms),
  );
}
const counter = (value, fmt) => `<span data-count="${value}" data-fmt="${fmt}">${FORMATS[fmt](value)}</span>`;

/* ---------- charts ---------- */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function topRoundedBar(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function axis(svg, { W, m, ih, max, fmt }) {
  const y = (v) => m.t + ih - (v / max) * ih;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    const yy = Math.round(y(v)) + 0.5;
    svg.push(`<line class="${i ? 'gridline' : 'baseline'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`);
    svg.push(`<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end" class="num">${fmt(v)}</text>`);
  }
  return y;
}
// Stacked daily bars. series: [{ id, name, color, get(row) }]
function drawStacked(el, { rows, series, fmt, height = 240, label = 'Daily values', extraTip }) {
  const W = el.clientWidth;
  const H = height;
  const m = { t: 12, r: 6, b: 26, l: 52 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(0, ...rows.map((d) => series.reduce((a, s) => a + s.get(d), 0))));
  const step = iw / rows.length;
  const bw = Math.max(2, Math.min(26, step * 0.64));
  const svg = [];
  axis(svg, { W, m, ih, max, fmt });
  const every = Math.ceil(64 / step);
  rows.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = m.t + ih;
    let first = true;
    const drawn = series.filter((s) => s.get(d) > 0);
    svg.push(`<g class="bar" style="--i:${i}">`);
    drawn.forEach((s, j) => {
      let h = (s.get(d) / max) * ih;
      if (!first) {
        base -= 2;
        h -= 2;
      } // 2px surface gap between stacked segments
      if (h <= 0.5) return;
      const top = base - h;
      const path = j === drawn.length - 1 ? topRoundedBar(x, top, bw, h, 4) : `M${x},${base}V${top}H${x + bw}V${base}Z`;
      svg.push(`<path d="${path}" fill="${s.color}"/>`);
      base = top;
      first = false;
    });
    svg.push('</g>');
    if (i % every === 0)
      svg.push(`<text x="${m.l + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${dayLabel(d.date)}</text>`);
    svg.push(`<rect class="hit" data-i="${i}" x="${m.l + i * step}" y="${m.t}" width="${step}" height="${ih}"/>`);
  });
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${svg.join('')}</svg>`;
  el.onmousemove = (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i == null) return hideTip();
    const d = rows[i];
    const lines = series
      .map(
        (s) =>
          `<div class="row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><span class="num">${fmt(s.get(d))}</span></div>`,
      )
      .join('');
    showTip(e, `<b>${dayLabel(d.date)}</b>${lines}${extraTip ? extraTip(d) : ''}`);
  };
  el.onmouseleave = hideTip;
}
function drawDaily(el) {
  const metric = state.metric;
  const fmt = metric === 'cost' ? fmtUSD : fmtN;
  drawStacked(el, {
    rows: state.data.daily,
    fmt,
    label: `Daily ${metric} by tool, ${rangeText()}`,
    series: SERIES.map((s) => ({ ...s, get: (d) => d[s.id][metric] })),
    extraTip: (d) =>
      `<div class="row"><span>Sessions</span><span class="num">${SERIES.reduce((a, s) => a + d[s.id].sessions, 0)}</span></div>`,
  });
}
// Month-to-date cumulative spend, dashed projection to month end, optional budget line. One $ axis.
function drawCumulative(el) {
  const { month, config } = state.data;
  const budget = config.monthlyBudgetUSD;
  let run = 0;
  const pts = month.daily.map((d) => ({ date: d.date, day: d.cost, total: (run += d.cost) }));
  const W = el.clientWidth;
  const H = 220;
  const m = { t: 14, r: 10, b: 26, l: 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = niceMax(Math.max(month.projected, budget || 0, run));
  const svg = [];
  const y = axis(svg, { W, m, ih, max, fmt: fmtUSD });
  const x = (dayIdx) => m.l + (dayIdx / Math.max(1, month.daysInMonth - 1)) * iw;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join('');
  const last = pts.length - 1;
  svg.push(
    `<path d="${line}L${x(last)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--accent)" fill-opacity=".10" class="fade"/>`,
  );
  if (budget) {
    svg.push(
      `<line x1="${m.l}" x2="${W - m.r}" y1="${y(budget)}" y2="${y(budget)}" stroke="var(--bad)" stroke-width="1.5" stroke-dasharray="4 4"/>`,
    );
    // Put the budget label under its line when it would collide with the projection label.
    const below = Math.abs(y(budget) - y(month.projected)) < 18;
    svg.push(
      `<text x="${W - m.r}" y="${below ? y(budget) + 14 : y(budget) - 6}" text-anchor="end">Budget ${fmtUSD(budget)}</text>`,
    );
  }
  svg.push(
    `<path d="M${x(last)},${y(run)}L${x(month.daysInMonth - 1)},${y(month.projected)}" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 5" fill="none" class="fade"/>`,
  );
  svg.push(
    `<text x="${x(month.daysInMonth - 1)}" y="${Math.max(12, y(month.projected) - 8)}" text-anchor="end">Projected ${fmtUSD(month.projected)}</text>`,
  );
  svg.push(
    `<path d="${line}" stroke="var(--accent)" stroke-width="2.5" fill="none" stroke-linejoin="round" pathLength="1" class="draw"/>`,
  );
  svg.push(
    `<circle cx="${x(last)}" cy="${y(run)}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" class="fade"/>`,
  );
  [0, Math.floor((month.daysInMonth - 1) / 2), month.daysInMonth - 1].forEach((i) =>
    svg.push(
      `<text x="${x(i)}" y="${H - 8}" text-anchor="${i ? (i === month.daysInMonth - 1 ? 'end' : 'middle') : 'start'}">${new Date(new Date().getFullYear(), new Date().getMonth(), i + 1).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</text>`,
    ),
  );
  pts.forEach((p, i) =>
    svg.push(
      `<rect class="hit" data-i="${i}" x="${x(i) - iw / month.daysInMonth / 2}" y="${m.t}" width="${iw / month.daysInMonth}" height="${ih}"/>`,
    ),
  );
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Cumulative spend this month with projection">${svg.join('')}</svg>`;
  el.onmousemove = (e) => {
    const i = e.target.dataset && e.target.dataset.i;
    if (i == null) return hideTip();
    const p = pts[i];
    showTip(
      e,
      `<b>${dayLabel(p.date)}</b><div class="row"><span>That day</span><span class="num">${fmtUSD(p.day)}</span></div><div class="row"><span>Month to date</span><span class="num">${fmtUSD(p.total)}</span></div>`,
    );
  };
  el.onmouseleave = hideTip;
}
function sparkline(values, color) {
  const W = 120;
  const H = 30;
  if (values.length < 2)
    return `<svg width="${W}" height="${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${H - 2}" y2="${H - 2}" stroke="var(--grid)"/></svg>`;
  const max = Math.max(1, ...values);
  const pts = values.map(
    (v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - (v / max) * (H - 6)).toFixed(1)}`,
  );
  return `<svg width="${W}" height="${H}" aria-hidden="true"><path d="M${pts.join('L')}L${W},${H}L0,${H}Z" fill="${color}" fill-opacity=".12"/><path d="M${pts.join('L')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/></svg>`;
}
// 100% stacked bar with a labeled legend table (the text carries the values, not color alone).
function composition(parts, fmt) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return `<div class="comp" role="img" aria-label="${esc(parts.map((p) => `${p.name} ${fmtPct(p.value / total)}`).join(', '))}">
    ${parts
      .filter((p) => p.value > 0)
      .map(
        (p, i) =>
          `<i style="--i:${i};flex-grow:${p.value / total};background:${p.color}" data-tip="${esc(p.name)}: ${esc(fmt(p.value))} (${fmtPct(p.value / total)})"></i>`,
      )
      .join('')}</div>
    <table class="comp-table"><tbody>${parts.map((p) => `<tr><td><span class="tool-dot" style="background:${p.color}"></span>${esc(p.name)}</td><td class="r num">${fmt(p.value)}</td><td class="r num muted">${fmtPct(p.value / total)}</td></tr>`).join('')}</tbody></table>`;
}
const HEAT = [0, 1, 2, 3, 4, 5].map((i) => `var(--heat-${i})`);
function heatmap(h) {
  const max = Math.max(1, ...h.flat());
  const bin = (v) => (v === 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)));
  const days = [
    [1, 'Mon'],
    [2, 'Tue'],
    [3, 'Wed'],
    [4, 'Thu'],
    [5, 'Fri'],
    [6, 'Sat'],
    [0, 'Sun'],
  ];
  let html = '<div class="heat" role="img" aria-label="Model calls by weekday and hour">';
  days.forEach(([di, dl], row) => {
    html += `<div class="hl">${dl}</div>`;
    for (let hr = 0; hr < 24; hr++) {
      const v = h[di][hr];
      html += `<div class="c" style="--i:${row + hr};background:${HEAT[bin(v)]}" data-tip="${dl} ${String(hr).padStart(2, '0')}:00 · ${whole.format(v)} calls"></div>`;
    }
  });
  html +=
    '<div></div>' +
    Array.from({ length: 24 }, (_, i) => `<div style="text-align:center">${i % 6 === 0 ? i : ''}</div>`).join('');
  html += '</div>';
  html += `<div class="heat-scale">Fewer ${HEAT.map((c) => `<i style="background:${c}"></i>`).join('')} More</div>`;
  return html;
}

/* ---------- views ---------- */
function kpiCard({ title, chip, ic, drill, value, fmt, after = '', sub, extra = '' }) {
  return `<div class="card kpi" role="button" tabindex="0" data-drill="${drill}" aria-label="${esc(title)}: open details">
    <div class="kpi-head">${title}<span class="chip ${chip}">${icon(ic)}</span></div>
    <div class="kpi-value num">${counter(value, fmt)} ${after}</div>${extra}<div class="kpi-sub">${sub}</div>
    <div class="kpi-more">View details <span aria-hidden="true">→</span></div></div>`;
}

function squadCards(limit) {
  const d = state.data;
  const live = state.live || { apps: [], installed: [] };
  const running = Object.fromEntries(live.apps.map((a) => [a.id, a]));
  const ids = [...new Set(['claude', 'codex', ...live.installed, ...live.apps.map((a) => a.id)])].filter(
    (id) => APPS[id],
  );
  ids.sort((a, b) => !!running[b] - !!running[a] || !!APPS[b].logs - !!APPS[a].logs);
  const cards = ids.slice(0, limit).map((id) => {
    const meta = APPS[id];
    const r = running[id];
    const t = d.tools.find((x) => x.id === id);
    const s = squadLive(r, live.installed.includes(id), t); // squadPatch keeps these current after the first draw
    const stats = t
      ? `<div><b class="num">${t.sessions}</b><span>sessions</span></div><div><b class="num">${fmtN(t.tokens)}</b><span>tokens</span></div><div><b class="num">${t.cost ? fmtUSD(t.cost) : '—'}</b><span>est. cost</span></div>`
      : `<div><b class="num">${s.stats[0]}</b><span>CPU</span></div><div><b class="num">${s.stats[1]}</b><span>memory</span></div><div><b class="num">${s.stats[2]}</b><span>uptime</span></div>`;
    const tags =
      t && t.models.length
        ? `<div class="tags">${t.models
            .slice(0, 3)
            .map((m) => `<span class="tag">${esc(m.name)}</span>`)
            .join('')}</div>`
        : '';
    return `<div class="card agent" data-app-card="${id}">
      <div class="agent-top"><span class="agent-icon chip ${meta.chip}">${icon(meta.icon, 18)}</span>
        <div><div class="agent-name">${meta.name}</div><div class="agent-role">${meta.role}</div></div></div>
      <div class="status ${s.cls}"><i></i>${s.text}</div>${RT_CARD_IDS.includes(id) ? `<div class="rt-slot" data-rt-slot="${id}"></div>` : ''}
      <p class="agent-desc">${meta.desc}</p>${tags}
      <div class="agent-stats">${stats}</div></div>`;
  });
  return { html: cards.join(''), total: ids.length, running: live.apps.length };
}

function limitsBlock() {
  const l = state.data.codexLimits;
  if (!l)
    return '<div class="empty">No plan-limit readings found. Claude Code does not write its limits to disk.</div>';
  const win = (w, label) => {
    if (!w) return '';
    const p = w.used_percent / 100;
    const reset = w.resets_at ? new Date(w.resets_at * 1000) : null;
    return `<div class="limit"><div class="limit-top"><b>Codex · ${label}</b><span class="num">${w.used_percent.toFixed(0)}% used${reset ? (reset > Date.now() ? ` · resets ${fmtDate(reset)}` : ' · window has reset since') : ''}</span></div>
      <div class="meter"><i class="${p > 0.9 ? 'over' : ''}" style="width:${Math.min(100, p * 100)}%"></i></div></div>`;
  };
  const mins = (w) =>
    w && w.window_minutes >= 1440
      ? `${Math.round(w.window_minutes / 1440)}-day window`
      : w
        ? `${Math.round(w.window_minutes / 60)}-hour window`
        : '';
  return (
    win(l.primary, mins(l.primary)) +
    win(l.secondary, mins(l.secondary)) +
    `<div class="kpi-sub">Plan: ${esc(l.plan_type || 'unknown')} · read ${ago(l.ts)}</div>`
  );
}

function projectsTable(rows, compactMode) {
  if (!rows.length) return '<div class="empty">No projects match.</div>';
  return `<div class="table-wrap"><table class="${compactMode ? 'compact-table' : ''}"><thead><tr><th>Project</th>${compactMode ? '' : '<th>Tools</th>'}<th class="r">Sessions</th>${compactMode ? '' : '<th class="r">Calls</th><th class="r">Output</th>'}<th class="r">Tokens</th><th class="r">Est. cost</th><th class="r">Last active</th></tr></thead><tbody>
  ${rows
    .map(
      (
        p,
      ) => `<tr><td><div class="clip" title="${esc(p.path)}">${esc(p.name)}</div>${compactMode ? '' : `<div class="sub clip">${esc(p.path)}</div>`}</td>
    ${
      compactMode
        ? ''
        : `<td>${Object.keys(p.tools)
            .map(
              (t) =>
                `<span class="tool-dot" style="background:${seriesColor(t)}"></span>${esc(SERIES.find((s) => s.id === t)?.name || t)}`,
            )
            .join(' &nbsp;')}</td>`
    }
    <td class="r num">${p.sessions}</td>${compactMode ? '' : `<td class="r num">${fmtN(p.calls)}</td><td class="r num">${fmtN(p.output)}</td>`}
    <td class="r num">${fmtN(p.tokens)}</td><td class="r num">${p.cost ? fmtUSD(p.cost) : '—'}</td><td class="r sub">${ago(p.last)}</td></tr>`,
    )
    .join('')}
  </tbody></table></div>`;
}

function matches(...fields) {
  const q = state.search.trim().toLowerCase();
  return (
    !q ||
    fields.some((f) =>
      String(f || '')
        .toLowerCase()
        .includes(q),
    )
  );
}

const SETTINGS_BUDGETS_DOC = 'https://github.com/rifqifitriady/ZAAFPulse/blob/main/docs/cost.md#budgets';
async function viewSettings(el) {
  const cfg = await api('/api/config');
  const theme = store.get('theme', 'system');
  el.innerHTML = `<div class="holo-deck"><div class="hero"><div><div class="eyebrow">SETTINGS</div><h1>Preferences</h1><p>Stored in config.json next to the app. Model prices stay current from the providers' list prices.</p></div></div>
  <div class="grid two" style="margin-top:0">
    <div class="card"><div class="card-head"><h3>Profile & budget</h3></div>
      <form class="form" id="profile-form">
        <label>Display name<input class="input" name="userName" value="${esc(cfg.userName)}" maxlength="60"></label>
        <label>Monthly budget (USD, API-equivalent)<input class="input" name="monthlyBudgetUSD" type="number" min="0" step="1" value="${Number(cfg.monthlyBudgetUSD) || 0}" ${cfg.monthlyBudgetManaged ? 'disabled' : ''}></label>
        <p class="muted" style="margin:-4px 0 0">${cfg.monthlyBudgetManaged ? 'This budget was edited in Budgets, so it is changed there now.' : 'Read as the monthly budget in Budgets, with alerts at 50 and 80 %.'} <a href="${SETTINGS_BUDGETS_DOC}" target="_blank" rel="noopener">Manage in Budgets</a></p>
        <label>Obsidian vault path<input class="input" name="vaultPath" value="${esc((cfg.vaultPaths || [])[0] || '')}" placeholder="Empty = the vault Obsidian has open"></label>
        <label>Theme<select class="input" name="theme">${['system', 'light', 'dark'].map((t) => `<option ${t === theme ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <div><button class="btn" type="submit">Save</button> <span class="saved" id="profile-saved"></span></div>
      </form></div>
    <div class="card"><div class="card-head"><h3>How cost is estimated</h3></div>
      <p class="muted" style="margin-top:0">Each model call's tokens are multiplied by the price for the longest matching model prefix (for example <code>claude-opus-5-5</code> beats <code>claude-opus-5</code>). Cache reads and cache writes have their own rates. Models with no matching prefix count as $0 and are listed in the banner on Overview.</p>
      <p class="muted">Prices are USD per 1M tokens and update automatically from OpenRouter's public model list, which carries each provider's list price. Edit a model to pin your own price, or add a prefix such as <code>gpt-6</code> for models the list does not have.</p></div>
  </div>
  ${evalsSettingsShell()}
  ${monitorsSettingsShell()}
  ${runtimesSettingsShell()}
  <section class="holo panel" id="prices-panel" style="margin-top:16px"><div class="skeleton" style="height:220px"></div></section></div>`;

  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    store.set('theme', f.get('theme'));
    applyTheme();
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: f.get('userName'),
        ...(cfg.monthlyBudgetManaged ? {} : { monthlyBudgetUSD: Number(f.get('monthlyBudgetUSD')) }),
        vaultPath: f.get('vaultPath'),
      }),
    });
    state.vault = null; // re-read the vault on the next visit
    $('#profile-saved').textContent = 'Saved';
    await loadSummary();
  };
  mountEvalsSettings();
  mountMonitorsSettings();
  mountRuntimesSettings();
  loadPrices().catch((err) => {
    $('#prices-panel').innerHTML = holoEmpty(`Could not load prices: ${esc(err.message)}`);
  });
}

/* ---------- drill-down drawer ---------- */
const tiles = (items) =>
  `<div class="tiles">${items
    .map(
      ([label, value, sub]) =>
        `<div class="tile"><span>${label}</span><b class="num">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`,
    )
    .join('')}</div>`;
const dsec = (i, title, html, meta = '') =>
  `<section class="dsec" style="--i:${i}"><div class="dsec-head"><h4>${title}</h4>${meta ? `<span class="meta">${meta}</span>` : ''}</div>${html}</section>`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const toolName = (id) => SERIES.find((s) => s.id === id)?.name || id;

const DRILLS = {
  apps() {
    const live = state.live || { apps: [], installed: [] };
    const cpu = live.apps.reduce((a, x) => a + x.cpu, 0);
    const mem = live.apps.reduce((a, x) => a + x.memMB, 0);
    const idle = live.installed.filter((id) => !live.apps.some((a) => a.id === id));
    const maxMem = Math.max(1, ...live.apps.map((a) => a.memMB));
    const rows = live.apps
      .map((a, i) => {
        const meta = APPS[a.id] || { icon: 'cpu', chip: 'blue', name: a.name };
        return `<div class="app-row" style="--i:${i}">
        <span class="agent-icon chip ${meta.chip}">${icon(meta.icon, 16)}</span>
        <div class="app-main"><b>${esc(a.name)}</b><small>${a.processes} process${a.processes === 1 ? '' : 'es'} · up ${dur(a.uptimeSec)}</small>
          <div class="track mem"><i style="--i:${i};width:${Math.max(2, (a.memMB / maxMem) * 100)}%"></i></div></div>
        <div class="app-spark">${sparkline(state.history[a.id] || [], 'var(--accent)')}</div>
        <div class="app-num"><b class="num">${a.cpu.toFixed(1)}%</b><small class="num">${whole.format(a.memMB)} MB</small></div></div>`;
      })
      .join('');
    return {
      eyebrow: 'DRILL-DOWN · LIVE',
      title: 'Active AI apps',
      body:
        tiles([
          ['Running now', counter(live.apps.length, 'int'), `${live.installed.length} installed`],
          ['Total CPU', `${cpu.toFixed(1)}%`, 'of one core = 100%'],
          ['Total memory', `${(mem / 1024).toFixed(2)} GB`, 'across all AI apps'],
          [
            'Processes',
            counter(
              live.apps.reduce((a, x) => a + x.processes, 0),
              'int',
            ),
            'including helpers',
          ],
        ]) +
        dsec(
          1,
          'Running now',
          rows || '<div class="empty">No AI apps are running.</div>',
          'CPU over the last 5 minutes · bar = memory',
        ) +
        (idle.length
          ? dsec(
              2,
              'Installed, not running',
              `<div class="tags">${idle.map((id) => `<span class="tag">${esc(APPS[id]?.name || id)}</span>`).join('')}</div>`,
            )
          : '') +
        `<p class="drawer-note">CPU is sampled every 5 seconds while this page is open.</p><a class="btn ghost" href="#live">Open live monitor →</a>`,
    };
  },

  sessions() {
    const d = state.data;
    const k = d.kpis;
    const durations = d.sessions.map((s) => (s.end - s.start) / 1000);
    const busiest = [...d.sessions].sort((a, b) => b.calls - a.calls).slice(0, 5);
    return {
      eyebrow: `DRILL-DOWN · ${rangeText().toUpperCase()}`,
      title: 'Sessions',
      body:
        tiles([
          ['Sessions', counter(k.sessions, 'int'), `${k.prevSessions} in the previous period`],
          ['Prompts typed', counter(k.prompts, 'int'), 'by you, not by tools'],
          ['Prompts per session', (k.prompts / Math.max(1, k.sessions)).toFixed(1), 'average'],
          ['Typical length', dur(median(durations)), 'median session'],
        ]) +
        dsec(1, 'Sessions per day', `<div class="chart" data-chart="sessions"></div>${legend()}`) +
        `<div class="dgrid">${dsec(
          2,
          'By tool',
          barList(
            d.tools.filter((t) => t.sessions),
            {
              value: (t) => t.sessions,
              label: (t) => esc(t.name),
              color: (t) => seriesColor(t.id),
              fmt: (v) => whole.format(v),
            },
          ),
        )}
        ${dsec(3, 'By surface', barList(d.entrypoints, { value: (e) => e.count, label: (e) => esc(SURFACES[e.name] || e.name), color: () => 'var(--accent)', fmt: (v) => whole.format(v) }))}</div>` +
        dsec(
          4,
          'Busiest sessions',
          `<div class="table-wrap"><table><thead><tr><th>Project</th><th class="r">Prompts</th><th class="r">Calls</th><th class="r">Length</th></tr></thead><tbody>
          ${busiest.map((s) => `<tr><td><div class="clip"><span class="tool-dot" style="background:${seriesColor(s.tool)}"></span>${esc(s.project)}</div><div class="sub">${fmtDate(s.start)}</div></td><td class="r num">${s.prompts}</td><td class="r num">${fmtN(s.calls)}</td><td class="r num">${dur((s.end - s.start) / 1000)}</td></tr>`).join('')}
          </tbody></table></div>`,
          'by model calls',
        ) +
        '<a class="btn ghost" href="#sessions">Open session log →</a>',
      charts: {
        sessions: (el) =>
          drawStacked(el, {
            rows: d.daily,
            height: 190,
            fmt: (v) => whole.format(Math.round(v)),
            label: 'Sessions per day by tool',
            series: SERIES.map((s) => ({ ...s, get: (row) => row[s.id].sessions })),
          }),
      },
    };
  },

  tokens() {
    const d = state.data;
    const k = d.kpis;
    const c = k.composition;
    return {
      eyebrow: `DRILL-DOWN · ${rangeText().toUpperCase()}`,
      title: 'Tokens processed',
      body:
        tiles([
          ['Total tokens', counter(k.tokens, 'n'), delta(k.tokens, k.prevTokens)],
          ['Output', counter(c.output, 'n'), 'written by the models'],
          ['Output per prompt', fmtN(c.output / Math.max(1, k.prompts)), 'average'],
          ['Context per call', fmtN(k.tokens / Math.max(1, k.calls)), 'average tokens'],
        ]) +
        dsec(
          1,
          'What the tokens are',
          composition(
            TOKEN_TYPES.map((t) => ({ ...t, value: c[t.id] })),
            fmtN,
          ) +
            `<p class="drawer-note">${fmtPct(k.cacheHitRate)} of the input context was read from cache. Cache reads cost about a tenth of normal input, so a large token count does not mean a matching cost.</p>`,
        ) +
        dsec(2, 'Tokens per day', `<div class="chart" data-chart="tokens"></div>${legend()}`) +
        dsec(
          3,
          'By model',
          barList(d.models.slice(0, 6), {
            value: (m) => m.tokens,
            label: (m) => `${esc(m.model)}<small>${fmtN(m.output)} output</small>`,
            color: (m) => seriesColor(m.tool),
          }),
        ) +
        '<a class="btn ghost" href="#skills/usage">See tools and agents →</a>',
      charts: {
        tokens: (el) =>
          drawStacked(el, {
            rows: d.daily,
            height: 190,
            fmt: fmtN,
            label: 'Tokens per day by tool',
            series: SERIES.map((s) => ({ ...s, get: (row) => row[s.id].tokens })),
          }),
      },
    };
  },

  spend() {
    const d = state.data;
    const k = d.kpis;
    const budget = d.config.monthlyBudgetUSD;
    const parts = TOKEN_TYPES.map((t) => ({ ...t, value: k.costParts[t.id] }));
    // Server tools (web search) are billed per call, not per token.
    if (k.costParts.tools)
      parts.push({ id: 'tools', name: 'Server tools', color: 'var(--accent)', value: k.costParts.tools });
    const biggest = [...parts].sort((a, b) => b.value - a.value)[0];
    const byCost = (rows) =>
      rows
        .filter((r) => r.cost > 0)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 5);
    return {
      eyebrow: `DRILL-DOWN · ${rangeText().toUpperCase()}`,
      title: 'Estimated spend',
      body:
        tiles([
          ['In range', counter(k.cost, 'usd'), delta(k.cost, k.prevCost)],
          [
            'This month',
            counter(k.monthCost, 'usd'),
            `${Math.floor(d.month.daysElapsed) + 1} of ${d.month.daysInMonth} days`,
          ],
          ['Projected month end', counter(d.month.projected, 'usd'), 'at the current daily pace'],
          budget
            ? [
                'Budget left',
                fmtUSD(Math.max(0, budget - k.monthCost)),
                `${Math.round((k.monthCost / budget) * 100)}% of ${fmtUSD(budget)} used`,
              ]
            : ['Budget', '—', '<a href="#settings">Set a monthly budget</a>'],
        ]) +
        dsec(
          1,
          'This month so far',
          `<div class="chart" data-chart="cumulative"></div>
          <div class="legend"><span><i style="background:var(--accent)"></i>Month to date</span><span><i style="background:var(--muted)"></i>Projection</span>${budget ? '<span><i style="background:var(--bad)"></i>Budget</span>' : ''}</div>`,
        ) +
        dsec(
          2,
          'Where the money goes',
          composition(parts, fmtUSD) +
            (biggest && biggest.value
              ? `<p class="drawer-note"><b>${biggest.name}</b> is the largest share at ${fmtPct(biggest.value / Math.max(1e-9, k.cost))} of estimated spend.</p>`
              : ''),
        ) +
        `<div class="dgrid">${dsec(3, 'By model', barList(byCost(d.models), { value: (m) => m.cost, label: (m) => esc(m.model), color: (m) => seriesColor(m.tool), fmt: fmtUSD }))}
        ${dsec(4, 'By project', barList(byCost(d.projects), { value: (p) => p.cost, label: (p) => esc(p.name), color: () => 'var(--accent)', fmt: fmtUSD }))}</div>` +
        dsec(
          5,
          'Most expensive sessions',
          `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Model</th><th class="r">Calls</th><th class="r">Est. cost</th></tr></thead><tbody>
          ${d.topCostSessions.map((s) => `<tr><td><div class="clip">${esc(s.project)}</div><div class="sub">${fmtDate(s.start)}</div></td><td>${esc(s.model || '')}</td><td class="r num">${fmtN(s.calls)}</td><td class="r num">${fmtUSD(s.cost)}</td></tr>`).join('')}
          </tbody></table></div>`,
        ) +
        '<a class="btn ghost" href="#settings">Edit prices and budget →</a>',
      charts: { cumulative: drawCumulative },
    };
  },
};

const drawer = { kind: null, opener: null, charts: null };
function paintDrawer(animate) {
  // The alerts and agent drawers repaint in place (public/monitorsview.js), so keyboard focus survives a refresh.
  if (!animate && drawer.kind && Object.hasOwn(MONITOR_DRILLS, drawer.kind)) return monPaintDrawer();
  if (!drawer.kind || !state.data) return;
  const body = $('#drawer-body');
  const scroll = body.scrollTop;
  const v = DRILLS[drawer.kind]();
  $('#drawer-eyebrow').textContent = v.eyebrow;
  $('#drawer-title').textContent = v.title;
  body.classList.toggle('animate', animate && !reduceMotion.matches);
  body.innerHTML = v.body;
  drawer.charts = v.charts || null;
  drawDrawerCharts();
  if (animate) {
    body.scrollTop = 0;
    countUp(body);
    settle(body);
  } else body.scrollTop = scroll;
}
function drawDrawerCharts() {
  if (!drawer.charts) return;
  for (const el of $$('#drawer-body [data-chart]')) drawer.charts[el.dataset.chart]?.(el);
}
function openDrill(kind, opener) {
  drawer.kind = kind;
  drawer.opener = opener;
  const d = $('#drawer');
  const b = $('#drawer-backdrop');
  d.hidden = false;
  b.hidden = false;
  document.body.classList.add('drawer-locked');
  paintDrawer(true);
  requestAnimationFrame(() => {
    d.classList.add('open');
    b.classList.add('open');
  });
  $('#drawer-close').focus({ preventScroll: true });
}
function closeDrill(restoreFocus = true) {
  if (!drawer.kind) return;
  const d = $('#drawer');
  const b = $('#drawer-backdrop');
  d.classList.remove('open');
  b.classList.remove('open');
  document.body.classList.remove('drawer-locked');
  const opener = drawer.opener;
  drawer.kind = null;
  drawer.charts = null;
  setTimeout(
    () => {
      if (!drawer.kind) {
        d.hidden = true;
        b.hidden = true;
      }
    },
    reduceMotion.matches ? 0 : 320,
  );
  hideTip();
  if (restoreFocus && opener && document.contains(opener)) opener.focus({ preventScroll: true });
}

/* ---------- routing & render ---------- */
const VIEWS = {
  overview: viewOverview,
  squad: viewSquadPage,
  sessions: viewSessions,
  trace: viewTrace,
  projects: viewProjects,
  agents: viewAgents,
  quality: viewQualityPage,
  brain: viewBrain,
  live: viewLive,
  integrations: viewIntegrationsPage,
  endpoint: viewEndpoint,
  gateway: viewGateway,
  skills: viewSkillsPage,
  rag: viewRag,
  a2a: viewA2a,
  datasets: viewDatasets,
  cost: viewCost,
};
// Pages that moved when the sidebar was regrouped (AI Observability / Agentic Workspace).
const ROUTE_MOVED = { agents: '#skills/usage' };
Object.assign(DRILLS, QUALITY_DRILLS, BRAIN_DRILLS, OPENROUTER_DRILLS);
// The bell's alerts and an agent's controls (public/monitorsview.js) open in the same drawer.
Object.assign(DRILLS, MONITOR_DRILLS);
function drawPageCharts() {
  const c = $('#daily-chart');
  if (c) drawDaily(c);
  const q = $('#quality-chart');
  if (q) drawQualityChart(q);
}

// animate: entrance motion for route/range changes; background refreshes repaint quietly.
function render(animate = true) {
  const el = $('#view');
  [state.route, state.sub = ''] = (location.hash.slice(1) || 'overview').split('?')[0].split('/');
  if (ROUTE_MOVED[state.route]) {
    location.replace(ROUTE_MOVED[state.route]);
    return;
  }
  if (!VIEWS[state.route] && state.route !== 'settings') state.route = 'overview';
  const subMeta = (SUBPAGES[state.route] || []).find(([slug]) => slug && slug === state.sub);
  if (!subMeta) state.sub = '';
  $('#crumb').textContent = TITLES[state.route] + (subMeta ? ` / ${subMeta[1].toUpperCase()}` : '');
  const group = $('#crumb-group');
  if (group)
    group.textContent = ['endpoint', 'gateway', 'skills', 'integrations', 'a2a', 'rag'].includes(state.route)
      ? 'AGENTIC WORKSPACE'
      : state.route === 'settings'
        ? 'PREFERENCES'
        : 'AI OBSERVABILITY';
  const full = state.sub ? `${state.route}/${state.sub}` : state.route;
  for (const a of $$('nav a'))
    a.classList.toggle(
      'active',
      a.classList.contains('nav-sub')
        ? a.dataset.route === full || (!state.sub && a.dataset.route === `${state.route}/`)
        : a.dataset.route === state.route,
    );
  // Sub-pages show only under the section you are in, so the whole menu fits without scrolling.
  for (const a of $$('nav a.nav-sub')) a.hidden = a.dataset.route.split('/')[0] !== state.route;
  for (const a of $$('nav a:not(.nav-sub)'))
    a.classList.toggle(
      'open',
      a.dataset.route === state.route && !!document.querySelector(`nav a.nav-sub[data-route^="${state.route}/"]`),
    );
  $('#sidebar').classList.remove('open');
  hideTip();
  el.classList.toggle('animate', animate && !reduceMotion.matches);
  unmountBrain();
  unmountStages();
  if (state.route === 'settings') return viewSettings(el);
  if (!state.data && !['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'].includes(state.route)) {
    el.innerHTML =
      '<div class="grid kpis">' +
      '<div class="skeleton"></div>'.repeat(4) +
      '</div><div class="skeleton" style="height:260px"></div>';
    return;
  }
  el.innerHTML = VIEWS[state.route]();
  drawPageCharts();
  if (state.route === 'live') mountLive();
  if (state.route === 'overview') mountOverview();
  if (state.route === 'squad') mountSquadPage();
  if (state.route === 'quality') mountQualityPage();
  if (state.route === 'sessions') mountSessions();
  if (state.route === 'trace') mountTrace();
  if (state.route === 'datasets') mountDatasets();
  if (state.route === 'cost') mountCost();
  if (state.route === 'projects') mountProjects();
  if (state.route === 'skills' && state.sub === 'usage') mountAgents();
  if (state.route === 'integrations') mountIntegrations();
  if (
    ['gateway', 'rag', 'a2a', 'endpoint'].includes(state.route) ||
    (state.route === 'skills' && state.sub !== 'usage')
  )
    mountGateway();
  if (state.route === 'brain')
    mountBrain().catch((err) => {
      $('#brain-sub').textContent = `Could not read the vault: ${err.message}`;
    });
  if (animate) {
    countUp(el);
    settle(el);
  }
}

document.addEventListener('click', async (e) => {
  const dr = e.target.closest('[data-drill]');
  if (dr) {
    openDrill(dr.dataset.drill, dr);
    return;
  }
  const r = e.target.closest('[data-range]');
  if (r) {
    state.range = r.dataset.range;
    store.set('range', state.range);
    await loadSummary();
    render();
    return;
  }
  const m = e.target.closest('[data-metric]');
  if (m) {
    state.metric = m.dataset.metric;
    store.set('metric', state.metric);
    for (const b of $$('[data-metric]')) b.setAttribute('aria-pressed', String(b === m));
    const c = $('#daily-chart');
    if (c) {
      c.classList.remove('animate');
      void c.offsetWidth;
      c.classList.toggle('animate', !reduceMotion.matches);
      drawDaily(c);
      settle(c, 1400);
    }
    return;
  }
  const t = e.target.closest('[data-tool]');
  if (t) {
    state.toolFilter = t.dataset.tool;
    render(false);
  }
});
document.addEventListener('keydown', (e) => {
  if (drawer.kind && e.key === 'Escape') {
    closeDrill();
    return;
  }
  if (drawer.kind && e.key === 'Tab') {
    // keep focus inside the open drawer
    const f = $$('#drawer a[href], #drawer button, #drawer [tabindex="0"]').filter((x) => x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
      e.preventDefault();
      f[0].focus();
    }
    return;
  }
  const dr = e.target.closest && e.target.closest('[data-drill]');
  if (dr && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDrill(dr.dataset.drill, dr);
  }
});
$('#drawer-close').onclick = () => closeDrill();
$('#drawer-backdrop').onclick = () => closeDrill();
document.addEventListener('mousemove', (e) => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (t) showTip(e, esc(t.dataset.tip));
  else if (!e.target.closest('.chart, .stage')) hideTip();
});
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  if (!['sessions', 'projects'].includes(state.route)) location.hash = 'sessions';
  else render(false);
});
$('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
$('#rescan').onclick = async (e) => {
  const b = e.currentTarget;
  b.classList.add('spinning');
  await api('/api/rescan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const wait = setInterval(async () => {
    await loadLive();
    if (!state.live.index.indexing) {
      clearInterval(wait);
      b.classList.remove('spinning');
      await loadSummary();
      if (state.route !== 'settings') render();
      paintDrawer(false);
    }
  }, 800);
};
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawPageCharts();
    drawDrawerCharts();
  }, 120);
});
addEventListener('hashchange', () => {
  closeDrill(false);
  if (typeof forgetSecret === 'function') forgetSecret();
  render();
});

function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

(async function boot() {
  Object.assign(ZP, await api('/api/platform').catch(() => ({})));
  if (ZP.auth) {
    const role = $('.user-role');
    if (role) role.innerHTML = '<button class="link-btn" type="button" id="sign-out">Admin · sign out</button>';
    $('#sign-out')?.addEventListener('click', signOut);
  } else if (ZP.os !== 'macos') {
    const role = $('.user-role');
    if (role) role.textContent = `${ZP.osLabel} · local`;
  }
  applyTheme();
  hydrateIcons();
  monMountBell(); // the alerts bell polls on its own, every 15 s while the page is on screen
  costBadge(); // Cost Control's badge: budgets used up or projected over (public/costview.js)
  render(false);
  await Promise.all([
    loadLive(),
    loadSummary().catch((err) => {
      $('#view').innerHTML = `<div class="card empty">Could not load data: ${esc(err.message)}</div>`;
    }),
  ]);
  render();
  // Live data refreshes often; summaries follow the server's one-minute rescan.
  const indexing = () => !!(state.live && state.live.index && state.live.index.indexing);
  let wasIndexing = indexing();
  setInterval(async () => {
    await loadLive();
    if (state.route === 'live' && !updateLive()) render(false);
    // AI Office and the Overview draw the Installed AI tools cards once; their status and CPU follow every poll.
    if ((state.route === 'squad' || state.route === 'overview') && state.data)
      squadPatch(document, state.live, state.data.tools);
    // The Overview's empty-state note follows the first index (its progress is in the live data) and the first logs
    // found; the summary is reloaded once, when the index finishes, not at every progress step.
    const finished = wasIndexing && !indexing();
    wasIndexing = indexing();
    if (state.route === 'overview' && state.data && !$('#view').contains(document.activeElement)) {
      const step = liveNoteStep(state.logNote, overviewNote(state.data), finished);
      if (step === 'summary') await loadSummary().catch(() => {});
      if (step) render(false);
    }
    if (drawer.kind === 'apps') paintDrawer(false);
  }, 5000);
  setInterval(async () => {
    costBadge(); // before the summary: the badge refreshes even when the summary does not load
    await loadSummary();
    if (state.route === 'live' && updateLive()) {
      /* patched in place */
    } else if (
      !['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'].includes(state.route) &&
      !$('#view').contains(document.activeElement)
    )
      render(false); // squad, trace and cost pages poll on their own
    if (drawer.kind && drawer.kind !== 'apps') paintDrawer(false);
  }, 60000);
})();
