'use strict';
/* Trace & Session Explorer (#trace): the sessions and the selected turn as a tree on the left, the same turn
   as an animated map on the right, with one selection for both halves. A port of the approved mockup
   docs/superpowers/specs/mockups/split-view-v4.html; the map's motion comes from mockups/trace-map.html.
   Content is text only (S1): it is drawn through textNodes() and textFragment() with textContent, never as
   HTML. A masked secret is revealed one at a time on request and never kept (S2). */

/* ---------- pure helpers (no DOM; unit-tested in test/trace-ui.test.js) ---------- */
const TR_NUM = (v) => (Number.isFinite(v) ? v : 0);
// A table lookup by a value from a log: own keys only, so "constructor" or "__proto__" is just unknown.
const trOwn = (table, key, fallback) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : fallback);
const TR_COLOR = {
  session: '#4de8ff',
  turn: '#a98bff',
  chat: '#4de8ff',
  tool: '#ffb547',
  agent: '#ff4fd8',
  answer: '#43f0a3',
  unknown: '#8f98cc',
  error: '#ff5a6e',
};
const trColor = (s) => (s && s.status === 'error' ? TR_COLOR.error : trOwn(TR_COLOR, s && s.kind, TR_COLOR.unknown));
// The error categories lib/signals.js puts on a span, as the short words the tree and the detail show.
const TR_SIGNAL = {
  execution: 'command failed',
  environment: 'environment',
  hallucination: 'hallucination',
  process: 'process slip',
  rejection: 'rejected',
  interrupted: 'interrupted',
};

// A duration in the mockup's words: 40 ms, 4.1 s, 48 s, 2 m 10 s, 42 m, 1 h 5 m; nothing is a dash.
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 59.5) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const tot = Math.round(s);
  const m = Math.floor(tot / 60);
  const rs = tot % 60;
  if (m < 60) return rs && m < 10 ? `${m} m ${rs} s` : `${m} m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
}
const trTok = (n) => (!Number.isFinite(n) ? '0' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const trUsd = (n) => (!Number.isFinite(n) ? '' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

// "execute_tool Read" reads as "execute_tool · Read"; a subagent is its own name.
function trLabel(s) {
  const name = String((s && (s.name || s.op || s.kind)) || 'span');
  if (s && s.kind === 'agent') return name.replace(/^invoke_agent\s+/, '') || 'subagent';
  const m = /^(execute_tool|invoke_agent|chat)\s+(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

function trBadges(s) {
  const out = [];
  const sig = (Array.isArray(s.signals) ? s.signals : []).filter((x) => typeof x === 'string');
  if (s.status === 'error') out.push({ label: trOwn(TR_SIGNAL, sig[0], 'error'), tone: 'bad' });
  else if (s.status === 'running') out.push({ label: 'running', tone: 'info' });
  for (const x of sig.slice(s.status === 'error' ? 1 : 0)) out.push({ label: trOwn(TR_SIGNAL, x, x), tone: 'warn' });
  if (s.kind === 'agent') out.push({ label: 'subagent', tone: 'pink' });
  return out;
}

const trValid = (spans) => (Array.isArray(spans) ? spans : []).filter((s) => s && typeof s.id === 'string');
// Children by parent, each list in time order (ties keep the server's order). A span whose parent is
// missing, or is itself, counts as a root.
function trChildren(list) {
  const ids = new Set(list.map((s) => s.id));
  const order = new Map(list.map((s, i) => [s.id, i]));
  const kids = new Map();
  const roots = [];
  for (const s of list) {
    const p = s.parent != null && s.parent !== s.id && ids.has(s.parent) ? s.parent : null;
    if (p === null) roots.push(s);
    else (kids.get(p) || kids.set(p, []).get(p)).push(s);
  }
  const byTime = (a, b) => TR_NUM(a.start) - TR_NUM(b.start) || order.get(a.id) - order.get(b.id);
  roots.sort(byTime);
  for (const k of kids.values()) k.sort(byTime);
  return { kids, roots, byTime };
}

// The tree as rows in display order: depth first, children in time order. A collapsed node keeps its row
// and hides what is under it. Spans caught in a parent cycle become roots, so nothing is lost or loops.
function treeRows(spans, { collapsed } = {}) {
  const list = trValid(spans);
  const shut = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const { kids, roots, byTime } = trChildren(list);
  const reach = new Set();
  const walk = (start) => {
    const stack = [start];
    while (stack.length) {
      const s = stack.pop();
      if (reach.has(s.id)) continue;
      reach.add(s.id);
      for (const k of kids.get(s.id) || []) stack.push(k);
    }
  };
  roots.forEach(walk);
  for (const s of [...list].sort(byTime))
    if (!reach.has(s.id)) {
      roots.push(s);
      walk(s);
    }
  const rows = [];
  const seen = new Set();
  const stack = roots.map((s) => [s, 0]).reverse();
  while (stack.length) {
    const [s, depth] = stack.pop();
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const under = (kids.get(s.id) || []).filter((k) => !seen.has(k.id));
    const open = !shut.has(s.id);
    rows.push({
      id: s.id,
      parent: s.parent ?? null,
      depth,
      kind: s.kind || 'unknown',
      name: trLabel(s),
      start: Number.isFinite(s.start) ? s.start : null,
      end: Number.isFinite(s.end) ? s.end : null,
      status: s.status || 'unknown',
      badges: trBadges(s),
      kids: under.length,
      open,
    });
    if (open) for (let i = under.length - 1; i >= 0; i--) stack.push([under[i], depth + 1]);
  }
  return rows;
}

// The map's nodes: Session, Turn, then the turn's own steps in time order. A run of identical tool calls
// (same tool, target and outcome) folds into one node with a count; a subagent is one node that counts its
// own tool calls and cost.
function mapNodes(spans) {
  const list = trValid(spans);
  if (!list.length) return [];
  const { kids, byTime } = trChildren(list);
  const root = list.find((s) => s.kind === 'session') || list.find((s) => s.parent == null) || list[0];
  const turn = list.find((s) => s.kind === 'turn' && s !== root);
  const node = (s) => ({
    id: s.id,
    ids: [s.id],
    kind: s.kind || 'unknown',
    status: s.status || 'unknown',
    label: trLabel(s),
    model: s.model || null,
    tool: s.tool && typeof s.tool === 'object' ? s.tool : null,
    start: Number.isFinite(s.start) ? s.start : null,
    end: Number.isFinite(s.end) ? s.end : null,
    usage: s.usage || null,
    cost: Number.isFinite(s.cost) ? s.cost : null,
    signals: Array.isArray(s.signals) ? s.signals : [],
    count: 1,
    tools: 0,
  });
  const out = [node(root)];
  if (turn) out.push(node(turn));
  const parent = (turn || root).id;
  const steps = list.filter((s) => s.parent === parent && s !== root && s !== turn).sort(byTime);
  const same = (n, s) =>
    n.kind === 'tool' &&
    s.kind === 'tool' &&
    n.label === trLabel(s) &&
    (n.tool && n.tool.name) === (s.tool && s.tool.name) &&
    (n.tool && n.tool.target) === (s.tool && s.tool.target) &&
    (n.status === 'error') === (s.status === 'error');
  const below = (id) => {
    const acc = [];
    const stack = [...(kids.get(id) || [])];
    const seen = new Set();
    while (stack.length) {
      const s = stack.pop();
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      acc.push(s);
      stack.push(...(kids.get(s.id) || []));
    }
    return acc;
  };
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && same(prev, s)) {
      prev.ids.push(s.id);
      prev.count++;
      if (Number.isFinite(s.end)) prev.end = Math.max(TR_NUM(prev.end), s.end);
      continue;
    }
    const n = node(s);
    if (s.kind === 'agent') {
      const sub = below(s.id);
      n.tools = sub.filter((x) => x.kind === 'tool').length;
      const c = sub.reduce((a, x) => a + (Number.isFinite(x.cost) ? x.cost : 0), n.cost || 0);
      n.cost = c || n.cost;
    }
    out.push(n);
  }
  return out;
}

// A page of content as parts: plain runs and masked runs, in order. Masks that are out of range, backwards
// or overlap an earlier one are skipped; a masked part keeps its index for "show". Never markup (S1).
function textNodes(text, masked) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!s) return [];
  const out = [];
  let at = 0;
  (Array.isArray(masked) ? masked : []).forEach((m, index) => {
    if (!m || !Number.isInteger(m.start) || !Number.isInteger(m.end)) return;
    if (m.start < at || m.end <= m.start || m.end > s.length) return;
    if (m.start > at) out.push({ text: s.slice(at, m.start), masked: null });
    out.push({ text: s.slice(m.start, m.end), masked: String(m.label || 'secret'), index });
    at = m.end;
  });
  if (at < s.length) out.push({ text: s.slice(at), masked: null });
  return out;
}

// The parts as DOM: text nodes, and for each masked part a span (filled with textContent) and a "show"
// button. `doc` is the document, or a stand-in in the tests.
function textFragment(parts, doc, { offset = 0 } = {}) {
  const frag = doc.createDocumentFragment();
  for (const p of parts || []) {
    if (!p.masked) {
      frag.appendChild(doc.createTextNode(p.text));
      continue;
    }
    const wrap = doc.createElement('span');
    wrap.className = 'tr-mask';
    wrap.setAttribute('data-index', p.index);
    wrap.setAttribute('data-offset', offset);
    const shown = doc.createElement('span');
    shown.className = 'tr-mask-text';
    shown.textContent = p.text;
    const btn = doc.createElement('button');
    btn.className = 'tr-show';
    btn.type = 'button';
    btn.textContent = 'show';
    btn.setAttribute('aria-label', `Show the hidden ${p.masked}`);
    wrap.append(shown, btn);
    frag.appendChild(wrap);
  }
  return frag;
}

// Sources the live endpoint never changes: their sessions are not polled.
const TR_STATIC = new Set(['gateway', 'kiro', 'gemini', 'antigravity']);
// Whether a session may still be growing: its last span runs, or it ended under 10 minutes ago.
function trIsLive(sk, now = Date.now()) {
  if (!sk || !sk.session || TR_STATIC.has(sk.session.source)) return false;
  const spans = trValid(sk.spans);
  const last = spans.reduce((a, s) => (!a || TR_NUM(s.start) >= TR_NUM(a.start) ? s : a), null);
  if (last && last.status === 'running') return true;
  const end = sk.session.end;
  return Number.isFinite(end) && now - end < 10 * 60000;
}

// What the tree and the map are drawn from: a skeleton with the same shape needs no repaint.
const trShape = (sk) => {
  const spans = (sk && Array.isArray(sk.spans) && sk.spans) || [];
  const last = spans[spans.length - 1];
  const turns = (sk && Array.isArray(sk.turns) && sk.turns.length) || 0;
  return `${turns}|${spans.length}|${last && last.end}|${last && last.status}`;
};
// What a live poll does with its answer. A changed file is always adopted: the server keeps the content ids
// of its newest live skeletons only, so an older one stops reading text after a couple of growths, even when
// the file grew by lines that make no span. Only a new shape repaints the tree and the map.
function trLivePlan(cur, r) {
  if (!cur || !r || !r.changed || !r.skeleton) return { adopt: false, repaint: false };
  return { adopt: true, repaint: trShape(r.skeleton) !== trShape(cur) };
}

// The move a key press asks for: 'down'/'up' (j/k) or 'prev'/'next' turn (←/→), else null. Only with focus in
// the explorer or on the page itself, never while typing, never with a modifier (Shift too), and the arrows
// stay with the tabs, the range buttons, the chip row and the splitter.
const TR_TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
function trNavKey(e, page = []) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const t = e.target;
  const at = (sel) => !!(t && typeof t.closest === 'function' && t.closest(sel));
  if (!page.includes(t) && !at('#tr-app')) return null;
  if (at(TR_TYPING)) return null;
  if (e.key === 'j' || e.key === 'k') return e.key === 'j' ? 'down' : 'up';
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return null;
  if (at('[role="tab"], .tr-seg, .tr-chips, #tr-split')) return null;
  return e.key === 'ArrowLeft' ? 'prev' : 'next';
}
// The notice shown up front when the server shows no transcript text (S10), or '' when it does.
const trOffNote = (settings) =>
  settings && settings.content === false
    ? 'Content viewing is off (ZAAFPULSE_CONTENT): titles, prompts, replies and tool output are not shown.'
    : '';
// A drag starts with the main button only (a right click opens the menu, a middle click scrolls).
const trPrimary = (e) => !!e && e.button === 0;

/* ---------- view ---------- */
const TR_SRC = {
  claude: ['CC', '#d97757', 'Claude Code', 'Claude'],
  codex: ['CX', '#10a37f', 'Codex', 'Codex'],
  gateway: ['GW', '#555b7a', 'Gateway', 'Gateway'],
  kiro: ['KR', '#7b61ff', 'Kiro', 'Kiro'],
  gemini: ['GM', '#1fa2d6', 'Gemini CLI', 'Gemini'],
  antigravity: ['AG', '#4285f4', 'Antigravity', 'Antigravity'],
};
const trSrc = (id) =>
  trOwn(TR_SRC, id, null) || [String(id || '?').slice(0, 2).toUpperCase(), '#8f98cc', String(id), String(id)];
const TR_ROW_H = 34; // fixed, so a long tree can be windowed (P4)
const TR_WINDOW_AT = 300;
const TR_MAP_MAX = 150;

function viewTrace() {
  const legend = [
    ['#a98bff', 'Turn'],
    ['#4de8ff', 'Model call'],
    ['#ffb547', 'Tool'],
    ['#ff4fd8', 'Subagent'],
    ['#ff5a6e', 'Error'],
    ['#43f0a3', 'Answer'],
  ]
    .map(([c, l]) => `<span style="--c:${c}"><i></i>${l}</span>`)
    .join('');
  return `<div class="tr-wrap"><div class="holo-deck trace-app" id="tr-app">
  <section class="tr-left">
    <header class="tr-topbar">
      <button class="tr-icon-btn tr-collapse" id="tr-collapse" type="button" title="Collapse sessions" aria-label="Collapse sessions" aria-expanded="true">⟨</button>
      <div class="tr-crumb"><div class="tr-eyebrow">Trace &amp; Session Explorer</div><h1 id="tr-title">Sessions</h1></div>
      <div class="tr-seg" role="group" aria-label="Time range"><button type="button" data-trange="1">24 h</button><button type="button" data-trange="7" class="on" aria-pressed="true">7 d</button><button type="button" data-trange="30">30 d</button></div>
    </header>
    <div class="tr-body" id="tr-body">
      <aside class="tr-sessions" aria-label="Sessions">
        <div class="tr-head">
          <label class="tr-search"><span aria-hidden="true">⌕</span><input id="tr-q" type="search" placeholder="Search sessions, projects…" autocomplete="off" aria-label="Search sessions"></label>
          <div class="tr-chips" id="tr-chips" role="group" aria-label="Sources"></div>
        </div>
        <div class="tr-list" id="tr-list" role="listbox" aria-label="Sessions"><div class="tr-empty">Loading sessions…</div></div>
      </aside>
      <main class="tr-tree" aria-label="Trace tree">
        <div class="tr-thead"><b id="tr-turn">No session selected</b><span class="tr-ev ok" hidden data-sub="2">relevance</span><span class="tr-muted" id="tr-sum"></span></div>
        <div class="tr-notice tr-off" id="tr-off" role="status" hidden></div>
        <div class="tr-notice" id="tr-notice" hidden><span id="tr-notice-msg"></span><button type="button" class="tr-btn ghost" id="tr-refresh" hidden>Refresh</button></div>
        <div class="tr-cols" aria-hidden="true"><span>Span</span><span class="tr-tl">Timeline</span><span class="r">Time</span></div>
        <div class="tr-rows" id="tr-rows" role="tree" tabindex="0" aria-label="Spans · j and k move, Enter opens the detail"></div>
      </main>
    </div>
    <section class="tr-detail" id="tr-detail" aria-label="Span detail">
      <div class="tr-dhead">
        <h3 id="tr-dname">Select a span</h3><span class="tr-dbadges" id="tr-dbadges"></span><span class="tr-muted" id="tr-dmeta"></span>
        <div class="tr-tabs" role="tablist" aria-label="Span text"><button type="button" role="tab" data-ttab="output" class="on" aria-selected="true">Output</button><button type="button" role="tab" data-ttab="input" aria-selected="false">Input</button><button type="button" role="tab" data-ttab="evals" hidden data-sub="2">Evals</button><button type="button" role="tab" data-ttab="notes" hidden data-sub="2">Notes</button></div>
      </div>
      <div class="tr-txt" id="tr-txt" tabindex="0" aria-label="Span text"></div>
      <div class="tr-acts">
        <span class="tr-grp" hidden data-sub="2"><button type="button" class="tr-btn">👍 Good</button><button type="button" class="tr-btn">👎 Bad</button><button type="button" class="tr-btn ghost">✎ Add note</button></span>
        <span class="tr-muted tr-dinfo" id="tr-dinfo"></span>
        <button type="button" class="tr-btn ghost" id="tr-more" hidden>Load next 64 KB</button>
        <span class="tr-spacer"></span>
        <button type="button" class="tr-btn ghost" hidden data-sub="4">⤓ Add to dataset</button><button type="button" class="tr-btn ghost" hidden data-sub="4">↻ Replay turn</button><button type="button" class="tr-btn warn" hidden data-sub="3">⏸ Pause agent</button>
      </div>
    </section>
  </section>
  <div class="tr-split" id="tr-split" role="separator" aria-orientation="vertical" aria-label="Resize the halves" tabindex="0" title="Drag to resize"></div>
  <section class="tr-right" id="tr-right" aria-label="Session map">
    <div class="tr-rhead">
      <div class="tr-rtitle"><div class="tr-eyebrow">Session map</div><h2 id="tr-mtitle">From Prompt to Answer</h2></div>
      <div class="tr-stepper"><button type="button" class="tr-icon-btn" id="tr-prev" aria-label="Previous turn">◀</button><span class="tr-muted" id="tr-step">– / –</span><button type="button" class="tr-icon-btn" id="tr-next" aria-label="Next turn">▶</button></div>
    </div>
    <div class="tr-legend">${legend}</div>
    <div class="tr-map" id="tr-map"><svg class="tr-wires" id="tr-wires" aria-hidden="true"></svg></div>
  </section>
</div></div>`;
}

// api() with the server's { error } and status kept apart, so the page can tell a 403 from a 404.
async function trApi(path, opts) {
  try {
    return await api(path, opts);
  } catch (e) {
    const m = /^(\d{3}) ([\s\S]*)$/.exec(String((e && e.message) || ''));
    if (!m) throw e;
    let msg = m[2];
    try {
      const j = JSON.parse(m[2]);
      if (j && typeof j.error === 'string') msg = j.error;
    } catch {
      /* not JSON */
    }
    throw Object.assign(new Error(msg), { status: Number(m[1]) });
  }
}

const trReduce = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const trTime = (ts) =>
  Number.isFinite(ts) ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
function trDay(ts) {
  if (!Number.isFinite(ts)) return 'Earlier';
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
}
const trBadgeHtml = (badges) =>
  (badges || []).map((b) => `<span class="tr-ev ${esc(b.tone)}">${esc(b.label)}</span>`).join('');
// In a tree row a long badge word gives way to the span name; the full word is its tooltip.
const TR_SHORT = { 'command failed': 'failed', hallucination: 'halluc.', 'process slip': 'slip', environment: 'env' };
const trRowBadges = (badges) =>
  (badges || [])
    .map((b) => `<span class="tr-ev ${esc(b.tone)}" title="${esc(b.label)}">${esc(trOwn(TR_SHORT, b.label, b.label))}</span>`)
    .join('');

function mountTrace() {
  const app = $('#tr-app');
  if (!app) return;
  const S = {
    alive: true,
    range: '7',
    q: '',
    source: 'all',
    errorsOnly: false,
    sessions: [],
    sources: [],
    titles: new Map(), // key -> title read on demand (null: none)
    key: null,
    sk: null,
    turn: 0,
    sel: null,
    tab: 'output',
    collapsed: new Set(),
    rows: [],
    nodes: [],
    nodeOf: new Map(),
    spans: new Map(),
    cursor: undefined,
    preview: '',
    req: 0,
    creq: 0,
    poll: 0,
    frame: 0,
    listReq: 0,
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (S.alive) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const wrap = app.parentElement;
  const rowsBox = $('#tr-rows');
  const list = $('#tr-list');
  const txt = $('#tr-txt');
  const body = $('#tr-body');

  // The deck fills the window under the dashboard's own top bar.
  const fit = () => {
    const top = document.querySelector('.main > .topbar');
    wrap.style.setProperty('--tr-top', `${top ? top.offsetHeight : 0}px`);
  };
  fit();

  // Convenience only: the splitter position and the collapsed list (S2: nothing else is stored).
  const split = Number(store.get('trace.split', ''));
  if (split >= 38 && split <= 70) app.style.setProperty('--split', `${split}%`);
  const setCollapsed = (on) => {
    body.classList.toggle('collapsed', on);
    const b = $('#tr-collapse');
    b.textContent = on ? '⟩' : '⟨';
    b.setAttribute('aria-expanded', String(!on));
    b.title = on ? 'Show the session list' : 'Collapse sessions';
  };
  setCollapsed(store.get('trace.collapsed', '') === '1');

  const notice = (msg, refresh) => {
    const n = $('#tr-notice');
    n.hidden = !msg;
    $('#tr-notice-msg').textContent = msg || '';
    $('#tr-refresh').hidden = !refresh;
  };

  /* ---- sessions ---- */
  const titleOf = (r) => r.title || S.titles.get(r.key) || null;
  const fallback = (r) => `${r.project || trSrc(r.source)[2]} · ${trTime(r.start)}`;
  const shownSessions = () =>
    S.sessions.filter(
      (r) =>
        (S.source === 'all' || r.source === S.source) && (!S.errorsOnly || r.errors > 0 || (r.flags && r.flags.errors)),
    );

  function paintChips() {
    const counts = new Map();
    for (const r of S.sessions) counts.set(r.source, (counts.get(r.source) || 0) + 1);
    const chips = [`<button type="button" class="tr-chip${S.source === 'all' ? ' on' : ''}" data-tsrc="all" aria-pressed="${S.source === 'all'}" style="--c:#8f98cc"><i></i>All ${S.sessions.length}</button>`];
    for (const s of S.sources) {
      const n = counts.get(s.id) || 0;
      const failed = !s.ok && !['not configured', 'unavailable'].includes(s.reason);
      if (!n && !failed && S.source !== s.id) continue;
      const [, color, , short] = trSrc(s.id);
      const on = S.source === s.id;
      chips.push(
        `<button type="button" class="tr-chip${on ? ' on' : ''}${failed ? ' failed' : ''}" data-tsrc="${esc(s.id)}" aria-pressed="${on}" style="--c:${color}"${failed ? ` title="${esc(`${short}: ${s.reason}`)}"` : ''}><i></i>${esc(short)} ${failed ? '⚠' : n}</button>`,
      );
    }
    chips.push(
      `<button type="button" class="tr-chip${S.errorsOnly ? ' on' : ''}" data-terr aria-pressed="${S.errorsOnly}" style="--c:#ff5a6e"><i></i>With errors</button>`,
    );
    $('#tr-chips').innerHTML = chips.join('');
  }

  let io = null;
  function paintList() {
    if (io) io.disconnect();
    const rows = shownSessions();
    if (!rows.length) {
      const why = S.sessions.length ? 'No session matches these filters.' : 'No sessions in this range.';
      list.innerHTML = `<div class="tr-empty">${why}</div>`;
      return;
    }
    let html = '';
    let day = null;
    for (const r of rows) {
      const d = trDay(r.end ?? r.start);
      if (d !== day) {
        html += `<div class="tr-group">${esc(d)}</div>`;
        day = d;
      }
      const [abbr, color] = trSrc(r.source);
      const t = titleOf(r);
      const cost = Number.isFinite(r.cost) && r.cost > 0 ? trUsd(r.cost) : `${r.tools || 0} tools`;
      const meta = [r.project, cost, fmtDur(TR_NUM(r.end) - TR_NUM(r.start))].filter(Boolean).join(' · ');
      const flags = [];
      if (r.errors > 0 || (r.flags && r.flags.errors)) {
        const n = r.errors > 0 ? `${r.errors} error${r.errors === 1 ? '' : 's'}` : 'errors';
        flags.push(`<span class="tr-flag bad">${n}</span>`);
      }
      if (r.flags && r.flags.loop) flags.push('<span class="tr-flag warn">loop detected</span>');
      if (r.flags && r.flags.injection) flags.push('<span class="tr-flag bad">injection</span>');
      const on = r.key === S.key;
      html += `<div class="tr-sess${on ? ' on' : ''}" role="option" tabindex="0" aria-selected="${on}" data-tkey="${esc(r.key)}"${t ? '' : ' data-need'} title="${esc(t || fallback(r))}"><span class="tr-src" style="--c:${color}">${esc(abbr)}</span><div class="tr-t"><div class="tr-top1"><div class="tr-t1">${esc(t || fallback(r))}</div><span class="tr-when">${esc(trTime(r.end ?? r.start))}</span></div><div class="tr-t2">${esc(meta)}</div>${flags.length ? `<div class="tr-flags">${flags.join('')}</div>` : ''}</div></div>`;
    }
    list.innerHTML = html;
    // Titles that are not in the listing (Claude, Codex) are read for the rows that come into view.
    const need = $$('.tr-sess[data-need]', list);
    if (!need.length) return;
    if (typeof IntersectionObserver !== 'function')
      return need.slice(0, 30).forEach((el) => wantTitle(el.dataset.tkey));
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            io.unobserve(e.target);
            wantTitle(e.target.dataset.tkey);
          }
      },
      { root: list, rootMargin: '120px' },
    );
    need.forEach((el) => io.observe(el));
  }

  const titleQueue = new Set();
  let titleBusy = 0;
  function wantTitle(key) {
    if (!key || S.titles.has(key) || titleQueue.has(key)) return;
    titleQueue.add(key);
    pumpTitles();
  }
  function pumpTitles() {
    while (S.alive && titleBusy < 3 && titleQueue.size) {
      const key = titleQueue.values().next().value;
      titleQueue.delete(key);
      titleBusy++;
      trApi(`/api/trace/title?key=${encodeURIComponent(key)}`)
        .then((r) => S.titles.set(key, (r && typeof r.title === 'string' && r.title) || null))
        .catch(() => S.titles.set(key, null))
        .finally(() => {
          titleBusy--;
          if (!S.alive) return;
          paintTitle(key);
          pumpTitles();
        });
    }
  }
  function paintTitle(key) {
    const t = S.titles.get(key);
    if (!t) return;
    const el = $$('.tr-sess', list).find((x) => x.dataset.tkey === key);
    if (el) {
      $('.tr-t1', el).textContent = t;
      el.title = t;
      el.removeAttribute('data-need');
    }
    if (key === S.key) paintHeading();
  }

  async function loadSessions() {
    const qs = new URLSearchParams({ range: S.range });
    if (S.q) qs.set('q', S.q);
    const my = ++S.listReq;
    try {
      const [src, res] = await Promise.all([
        S.sources.length ? Promise.resolve(S.sources) : trApi('/api/trace/sources').catch(() => []),
        trApi(`/api/trace/sessions?${qs}`),
      ]);
      if (!S.alive || my !== S.listReq) return;
      S.sources = Array.isArray(src) ? src : [];
      S.sessions = (res && Array.isArray(res.sessions) && res.sessions) || [];
    } catch (e) {
      if (!S.alive || my !== S.listReq) return;
      S.sessions = [];
      list.replaceChildren();
      const msg = document.createElement('div');
      msg.className = 'tr-empty';
      msg.textContent = `Could not list sessions: ${e.message}`;
      list.appendChild(msg);
      return;
    }
    paintChips();
    paintList();
  }

  function paintHeading() {
    const r = S.sessions.find((x) => x.key === S.key);
    const sess = S.sk && S.sk.session;
    const project = (r && r.project) || (sess && sess.project) || '';
    const t = r && titleOf(r);
    // Without a title the fallback already names the project.
    $('#tr-title').textContent = !r ? 'Sessions' : t ? [project, t].filter(Boolean).join(' · ') : fallback(r);
  }

  function selectSession(key, turn) {
    if (!key) return;
    S.key = key;
    S.sel = null;
    S.preview = '';
    for (const el of $$('.tr-sess', list)) {
      const on = el.dataset.tkey === key;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    }
    try {
      history.replaceState(null, '', `#trace?key=${encodeURIComponent(key)}`);
    } catch {
      /* a sandboxed frame */
    }
    paintHeading();
    loadSkeleton(turn);
  }

  /* ---- one turn: tree, map and detail ---- */
  function clearTurn(msg) {
    S.sk = null;
    S.rows = [];
    S.nodes = [];
    rowsBox.replaceChildren();
    const m = document.createElement('div');
    m.className = 'tr-empty';
    m.textContent = msg;
    rowsBox.appendChild(m);
    $('#tr-map').replaceChildren($('#tr-wires') || document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    $('#tr-turn').textContent = 'No turn shown';
    $('#tr-sum').textContent = '';
    $('#tr-step').textContent = '– / –';
    paintDetail();
  }

  async function loadSkeleton(turn) {
    const key = S.key;
    const my = ++S.req;
    clearTimeout(S.poll);
    notice('');
    try {
      const sk = await trApi(
        `/api/trace/session?key=${encodeURIComponent(key)}${Number.isInteger(turn) ? `&turn=${turn}` : ''}`,
      );
      if (!S.alive || my !== S.req) return;
      const n = Array.isArray(sk.turns) ? sk.turns.length : 0;
      S.sk = sk;
      S.turn = Number.isInteger(turn) ? Math.max(0, Math.min(n - 1, turn)) : Math.max(0, n - 1);
      S.cursor = undefined;
      S.collapsed = new Set();
      S.preview = '';
      paintSkeleton();
      pickSelection();
      loadPreview();
      schedulePoll();
    } catch (e) {
      if (!S.alive || my !== S.req) return;
      const stale = e.status === 404 && /rescanning/.test(e.message);
      notice(
        stale ? 'This session file changed; the list is being rescanned.' : `Could not open the session: ${e.message}`,
        stale,
      );
      clearTurn(stale ? 'Refresh to load the session again.' : 'Nothing to show.');
    }
  }

  // The prompt of the turn, one line, for the turn's row and map node. Content off: no preview.
  async function loadPreview() {
    const turn = S.sk && S.sk.spans.find((s) => s.kind === 'turn' && s.text);
    if (!turn) return;
    const my = S.req;
    try {
      const r = await trApi(`/api/trace/content?id=${encodeURIComponent(turn.text)}`);
      if (!S.alive || my !== S.req) return;
      const line = String(r.text || '').replace(/\s+/g, ' ').trim();
      S.preview = line.length > 60 ? `“${line.slice(0, 60)}…”` : line ? `“${line}”` : '';
      fillPreviews();
    } catch {
      /* off or unreadable: the label stays as it is */
    }
  }
  const fillPreviews = () => {
    for (const el of $$('[data-tpreview]', app)) {
      el.textContent = S.preview ? `${el.dataset.tpreview === 'row' ? ' · ' : ''}${S.preview}` : '';
      if (S.preview && el.dataset.tpreview === 'node') el.classList.add('has');
    }
  };

  function buildRows() {
    const sk = S.sk;
    const rows = treeRows(sk.spans, { collapsed: S.collapsed });
    // The other turns of the session as dimmed rows around this one; choosing one loads it.
    const turns = Array.isArray(sk.turns) ? sk.turns : [];
    const ti = rows.findIndex((r) => r.kind === 'turn');
    if (ti >= 0 && turns.length > 1) {
      const depth = rows[ti].depth;
      let end = ti + 1;
      while (end < rows.length && rows[end].depth > depth) end++;
      const ph = (t, i) => ({
        id: `turn:${i}`,
        depth,
        kind: 'turn',
        name: `turn ${i + 1}`,
        start: t.ts,
        end: (turns[i + 1] && turns[i + 1].ts) ?? (sk.session && sk.session.end),
        status: 'ok',
        badges: [],
        kids: 0,
        open: false,
        placeholder: true,
        turnIndex: i,
      });
      const before = turns.slice(0, S.turn).map(ph);
      const after = turns.slice(S.turn + 1).map((t, j) => ph(t, S.turn + 1 + j));
      rows.splice(end, 0, ...after);
      rows.splice(ti, 0, ...before);
    }
    S.rows = rows;
  }

  function paintSkeleton() {
    const sk = S.sk;
    S.spans = new Map(sk.spans.map((s) => [s.id, s]));
    buildRows();
    const turns = sk.turns.length;
    $('#tr-turn').textContent = `Turn ${S.turn + 1} of ${Math.max(1, turns)}`;
    // Summary: spans, cost of the leaf spans (a parent's cost is its children's) and the cache hit rate.
    const parents = new Set(sk.spans.map((s) => s.parent).filter(Boolean));
    let cost = 0;
    let input = 0;
    let cached = 0;
    for (const s of sk.spans) {
      if (!parents.has(s.id) && Number.isFinite(s.cost)) cost += s.cost;
      if (s.usage) {
        input += TR_NUM(s.usage.input) + TR_NUM(s.usage.cacheWrite5m) + TR_NUM(s.usage.cacheWrite1h);
        cached += TR_NUM(s.usage.cacheRead);
      }
    }
    const sum = [`${sk.spans.length} spans`];
    if (cost) sum.push(trUsd(cost));
    if (input + cached) sum.push(`cache hit ${Math.round((cached / (input + cached)) * 100)}%`);
    $('#tr-sum').textContent = sum.join(' · ');
    $('#tr-mtitle').textContent = `Turn ${S.turn + 1} · From Prompt to Answer`;
    $('#tr-step').textContent = `${S.turn + 1} / ${Math.max(1, turns)}`;
    $('#tr-prev').disabled = S.turn <= 0;
    $('#tr-next').disabled = S.turn >= turns - 1;
    paintHeading();
    paintRows();
    paintMap();
  }

  // The session's time window, for the timeline bars.
  const windowOf = () => {
    const sk = S.sk;
    let a = Infinity;
    let b = -Infinity;
    for (const s of sk.spans) {
      if (Number.isFinite(s.start)) a = Math.min(a, s.start);
      if (Number.isFinite(s.end)) b = Math.max(b, s.end);
    }
    if (sk.session) {
      if (Number.isFinite(sk.session.start)) a = Math.min(a, sk.session.start);
      if (Number.isFinite(sk.session.end)) b = Math.max(b, sk.session.end);
    }
    return Number.isFinite(a) && b > a ? [a, b] : [0, 1];
  };

  function rowHtml(r, win) {
    const [a, b] = win;
    const span = b - a;
    const l = Number.isFinite(r.start) ? Math.min(100, Math.max(0, ((r.start - a) / span) * 100)) : 0;
    const w = Number.isFinite(r.start) && Number.isFinite(r.end) ? ((r.end - r.start) / span) * 100 : 0;
    const width = Math.max(1.5, Math.min(100 - l, w));
    const c = r.placeholder ? TR_COLOR.turn : trColor(r);
    const on = r.id === S.sel;
    const tw = r.kids
      ? `<button type="button" class="tr-tw" data-ttoggle="${esc(r.id)}" tabindex="-1" aria-label="${r.open ? 'Collapse' : 'Expand'}">${r.open ? '▾' : '▸'}</button>`
      : r.placeholder
        ? '<span class="tr-tw" aria-hidden="true">▸</span>'
        : '';
    const pv = r.kind === 'turn' && !r.placeholder ? '<span class="tr-pv" data-tpreview="row"></span>' : '';
    const d = Number.isFinite(r.start) && Number.isFinite(r.end) ? r.end - r.start : null;
    const attrs = r.placeholder
      ? `data-tturn="${r.turnIndex}" title="Open turn ${r.turnIndex + 1}"`
      : `data-tspan="${esc(r.id)}"${r.kids ? ` aria-expanded="${r.open}"` : ''}`;
    return `<div class="tr-row${on ? ' on' : ''}${r.placeholder ? ' dim' : ''}" role="treeitem" aria-level="${r.depth + 1}" aria-selected="${on}" ${attrs} style="--c:${c}"><span class="tr-name" style="--lvl:${r.depth};--guide:${r.depth ? 'block' : 'none'}"><span class="tr-d"></span><span class="tr-lbl">${tw}${esc(r.name)}${pv}</span>${trRowBadges(r.badges)}</span><span class="tr-track"><span style="left:${l.toFixed(2)}%;width:${width.toFixed(2)}%"></span></span><span class="tr-dur">${fmtDur(d)}</span></div>`;
  }

  // All rows, or for a long tree only the ones in view plus a margin, between two spacers (P4).
  function paintRows() {
    if (!S.sk) return;
    const rows = S.rows;
    const win = windowOf();
    let from = 0;
    let to = rows.length;
    if (rows.length > TR_WINDOW_AT) {
      const top = rowsBox.scrollTop;
      const h = rowsBox.clientHeight || 600;
      from = Math.max(0, Math.floor(top / TR_ROW_H) - 20);
      to = Math.min(rows.length, Math.ceil((top + h) / TR_ROW_H) + 20);
    }
    const slice = rows.slice(from, to).map((r) => rowHtml(r, win));
    const pad = (n) => (n > 0 ? `<div class="tr-pad" style="height:${n * TR_ROW_H}px"></div>` : '');
    rowsBox.innerHTML = pad(from) + slice.join('') + pad(rows.length - to);
    fillPreviews();
  }

  function nodeParts(n, i) {
    const sk = S.sk;
    const sess = sk.session || {};
    const [abbr, , srcName] = trSrc(sess.source);
    const d = Number.isFinite(n.start) && Number.isFinite(n.end) ? fmtDur(n.end - n.start) : '';
    const sigLabel = trOwn(TR_SIGNAL, n.signals[0], 'failed');
    const err = n.status === 'error';
    switch (n.kind) {
      case 'session':
        return {
          ring: abbr,
          title: 'Session',
          meta: [d, `${sk.turns.length} turn${sk.turns.length === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
          note: ['Session', [srcName, sess.project].filter(Boolean).join(', ')],
        };
      case 'turn':
        return {
          ring: `T${S.turn + 1}`,
          title: `Turn ${S.turn + 1} · prompt`,
          meta: d,
          preview: true,
          note: ['Turn', `${sk.spans.length} spans`],
        };
      case 'chat': {
        const u = n.usage || {};
        const tok = n.usage ? `${trTok(TR_NUM(u.input) + TR_NUM(u.cacheRead))} → ${trTok(TR_NUM(u.output))} tok` : '';
        return {
          ring: 'LLM',
          title: `chat · ${n.model || n.label.replace(/^chat · /, '')}`,
          meta: [tok, d].filter(Boolean).join(' · '),
          note: [
            'Model call',
            [n.cost != null ? trUsd(n.cost) : '', d].filter(Boolean).join(' · ') || 'no usage data',
          ],
        };
      }
      case 'tool': {
        const name = (n.tool && n.tool.name) || n.label.replace(/^execute_tool · /, '');
        return {
          ring: err ? '✗' : '⚙',
          title: `Tool · ${name}${n.count > 1 ? ` ×${n.count}` : ''}`,
          meta: [n.tool && n.tool.target, d, err ? sigLabel : ''].filter(Boolean).join(' · '),
          note: err
            ? ['Failure', sigLabel]
            : [
                'Tool',
                n.count > 1 ? `${n.count} identical calls in a row` : n.status === 'running' ? 'running' : 'resolved',
              ],
        };
      }
      case 'agent':
        return {
          ring: 'SUB',
          title: `Subagent · ${n.label}`,
          meta: [`${n.tools} tool${n.tools === 1 ? '' : 's'}`, n.cost ? trUsd(n.cost) : '', d]
            .filter(Boolean)
            .join(' · '),
          note: ['Subagent', 'own nested tree'],
        };
      case 'answer':
        return { ring: '✓', title: 'Answer', meta: 'final reply', note: ['Answer', 'what the agent replied'] };
      default:
        return { ring: '?', title: n.label, meta: d, note: [n.kind, n.status] };
    }
  }

  function paintMap() {
    const map = $('#tr-map');
    const all = mapNodes(S.sk.spans);
    const nodes = all.slice(0, TR_MAP_MAX);
    S.nodes = nodes;
    S.nodeOf = new Map();
    nodes.forEach((n, i) => n.ids.forEach((id) => S.nodeOf.set(id, i)));
    const sel = trNodeIndex(S.sel);
    let html = '<svg class="tr-wires" id="tr-wires" aria-hidden="true"></svg>';
    nodes.forEach((n, i) => {
      const p = nodeParts(n, i);
      const c = n.status === 'error' ? TR_COLOR.error : trOwn(TR_COLOR, n.kind, TR_COLOR.unknown);
      const side = i % 2 ? 'r' : 'l';
      const num = String(i + 1).padStart(2, '0');
      const noteHtml = `<div class="tr-note ${side}" style="--c:${c}"><span class="n">${num} · ${esc(p.note[0])}</span>${esc(p.note[1])}</div>`;
      const meta = p.preview
        ? `<span class="m"><span class="tr-pvn" data-tpreview="node"></span><span class="tr-pvd">${esc(p.meta)}</span></span>`
        : `<span class="m">${esc(p.meta)}</span>`;
      const nodeHtml = `<div class="tr-node${i === sel ? ' on' : ''}${n.status === 'error' ? ' err' : ''}" role="button" tabindex="0" data-tspan="${esc(n.id)}" data-ni="${i}" data-c="${c}" style="--c:${c}" aria-label="${esc(`${p.title}${p.meta ? `, ${p.meta}` : ''}`)}"><span class="tr-ring${[...p.ring].length === 1 ? ' g' : ''}">${esc(p.ring)}</span><div class="tr-ntext"><b>${esc(p.title)}</b>${meta}</div></div>`;
      html += side === 'l' ? noteHtml + nodeHtml : nodeHtml + noteHtml;
      if (i < nodes.length - 1) html += '<div class="tr-gap"></div>';
    });
    if (all.length > nodes.length)
      html += `<div class="tr-gap"></div><div class="tr-more-steps">${all.length - nodes.length} more steps · see the tree</div>`;
    map.innerHTML = html;
    fillPreviews();
    queueWires();
  }

  // The glowing S-curves between consecutive nodes and the packet that travels the chain. Built with
  // createElementNS from numbers and fixed colours only.
  function drawWires() {
    S.frame = 0;
    const map = $('#tr-map');
    const svg = $('#tr-wires');
    if (!map || !svg) return;
    svg.replaceChildren();
    const nodes = $$('.tr-node', map);
    if (nodes.length < 2 || getComputedStyle(svg).display === 'none') return;
    const box = map.getBoundingClientRect();
    if (!box.width) return;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, parent = svg) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
      parent.appendChild(el);
      return el;
    };
    const defs = mk('defs');
    const f = mk(
      'filter',
      {
        id: 'tr-glow',
        filterUnits: 'userSpaceOnUse',
        x: -60,
        y: -60,
        width: box.width + 120,
        height: box.height + 120,
      },
      defs,
    );
    mk('feGaussianBlur', { stdDeviation: 2.4, result: 'b' }, f);
    const merge = mk('feMerge', {}, f);
    mk('feMergeNode', { in: 'b' }, merge);
    mk('feMergeNode', { in: 'SourceGraphic' }, merge);
    const pt = (el, side) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2 - box.left, (side === 't' ? r.top : r.bottom) - box.top];
    };
    let chain = '';
    for (let i = 0; i < nodes.length - 1; i++) {
      const [x1, y1] = pt(nodes[i], 'b');
      const [x2, y2] = pt(nodes[i + 1], 't');
      const off = (i % 2 ? -1 : 1) * Math.min(120, box.width / 6);
      const mid = (y1 + y2) / 2;
      const d = `M${x1},${y1} C${x1},${mid} ${x1 + off},${mid} ${x1 + off / 2},${mid} S${x2},${mid} ${x2},${y2}`;
      chain += (i ? ' ' : '') + d;
      const c = nodes[i + 1].dataset.c || TR_COLOR.unknown;
      mk('path', { class: 'tr-wire', d, stroke: c, 'stroke-opacity': 0.25 });
      mk('path', { class: 'tr-wire tr-flow', d, stroke: c, filter: 'url(#tr-glow)', style: `animation-delay:${-i * 0.2}s` });
    }
    if (trReduce()) return; // no packet under reduced motion
    mk('path', { id: 'tr-chain', d: chain, fill: 'none', stroke: 'none' });
    const dot = mk('circle', { class: 'tr-packet', r: 4.5, fill: '#fff', filter: 'url(#tr-glow)' });
    const am = mk('animateMotion', { dur: `${Math.max(5, nodes.length * 0.7)}s`, repeatCount: 'indefinite' }, dot);
    mk('mpath', { href: '#tr-chain' }, am);
  }
  const queueWires = () => {
    if (!S.frame) S.frame = requestAnimationFrame(drawWires);
  };

  // The map node of a span: its own, or the nearest ancestor's (a subagent's spans live in its node).
  function trNodeIndex(id) {
    let cur = id;
    for (let i = 0; cur != null && i < 64; i++) {
      if (S.nodeOf.has(cur)) return S.nodeOf.get(cur);
      const s = S.spans.get(cur);
      cur = s ? s.parent : null;
    }
    return -1;
  }

  function pickSelection() {
    const spans = S.sk.spans;
    const keep = S.sel && S.spans.has(S.sel) ? S.sel : null;
    const first = (f) => spans.find(f);
    const auto =
      first((s) => s.status === 'error') ||
      first((s) => s.kind === 'answer') ||
      first((s) => s.kind === 'turn') ||
      spans[0];
    const pick = keep || (auto && auto.id);
    // The map opens at its top (Session, Turn), as in the mockup; the tree shows the chosen row.
    select(pick || null, { scroll: keep ? 'none' : 'tree', force: true });
  }

  function select(id, { scroll = 'both', force = false } = {}) {
    if (!S.sk) return;
    const same = id === S.sel;
    S.sel = id;
    for (const el of $$('.tr-row[data-tspan]', rowsBox)) {
      const on = el.dataset.tspan === id;
      el.classList.toggle('on', on);
      el.setAttribute('aria-selected', String(on));
    }
    const ni = trNodeIndex(id);
    for (const el of $$('.tr-node', $('#tr-map'))) el.classList.toggle('on', Number(el.dataset.ni) === ni);
    if (scroll === 'both' || scroll === 'tree') scrollRow(id);
    if (scroll === 'both' || scroll === 'map') scrollNode(ni);
    if (!same || force) paintDetail();
  }

  function scrollRow(id) {
    const i = S.rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const top = i * TR_ROW_H;
    const h = rowsBox.clientHeight;
    if (!h) return;
    let next = rowsBox.scrollTop;
    if (top < next) next = Math.max(0, top - TR_ROW_H);
    else if (top + TR_ROW_H > next + h) next = top + 2 * TR_ROW_H - h;
    if (next !== rowsBox.scrollTop) {
      rowsBox.scrollTop = next;
      if (S.rows.length > TR_WINDOW_AT) paintRows();
    }
  }
  function scrollNode(ni) {
    const right = $('#tr-right');
    const node = $(`.tr-node[data-ni="${ni}"]`, $('#tr-map'));
    const scrolls =
      right && right.scrollHeight > right.clientHeight + 1 && getComputedStyle(right).overflowY !== 'visible';
    if (!node || !scrolls) return;
    const r = node.getBoundingClientRect();
    const rr = right.getBoundingClientRect();
    if (r.top < rr.top + 110 || r.bottom > rr.bottom - 16)
      right.scrollTo({
        top: right.scrollTop + r.top - rr.top - rr.height / 3,
        behavior: trReduce() ? 'auto' : 'smooth',
      });
  }

  /* ---- detail ---- */
  // Which text a span has: a tool or subagent has its arguments (Input) and result (Output); a model call
  // and the answer have their reply (Output); a turn has its prompt (Input).
  function textsOf(s) {
    if (!s) return { input: null, output: null };
    if (s.kind === 'tool' || s.kind === 'agent') return { input: s.text || null, output: s.result || null };
    if (s.kind === 'turn') return { input: s.text || null, output: s.result || null };
    return { input: null, output: s.text || s.result || null };
  }

  function paintDetail() {
    const s = S.sel ? S.spans.get(S.sel) : null;
    const tabs = $$('[data-ttab]', app);
    if (!s) {
      $('#tr-dname').textContent = S.sk ? 'Select a span' : 'No session selected';
      $('#tr-dbadges').innerHTML = '';
      $('#tr-dmeta').textContent = '';
      $('#tr-dinfo').textContent = '';
      $('#tr-more').hidden = true;
      txt.replaceChildren();
      txt.removeAttribute('data-cid');
      return;
    }
    $('#tr-dname').textContent = trLabel(s);
    $('#tr-dbadges').innerHTML = trBadgeHtml(trBadges(s));
    const meta = [];
    if (Number.isFinite(s.start) && Number.isFinite(s.end)) meta.push(fmtDur(s.end - s.start));
    if (s.model) meta.push(s.model);
    if (s.tool && s.tool.target) meta.push(s.tool.target);
    if (s.usage) meta.push(`${trTok(TR_NUM(s.usage.input) + TR_NUM(s.usage.cacheRead))} → ${trTok(TR_NUM(s.usage.output))} tok`);
    if (Number.isFinite(s.cost) && s.cost > 0) meta.push(trUsd(s.cost));
    $('#tr-dmeta').textContent = meta.join(' · ');
    $('#tr-dmeta').title = meta.join(' · ');
    const t = textsOf(s);
    const tab = t[S.tab] ? S.tab : t.output ? 'output' : t.input ? 'input' : S.tab;
    for (const b of tabs) {
      const on = b.dataset.ttab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      if (b.dataset.ttab === 'input' || b.dataset.ttab === 'output') b.disabled = !t[b.dataset.ttab];
    }
    loadContent(t[tab] || null);
  }

  function info(msg) {
    $('#tr-dinfo').textContent = msg || '';
  }
  async function loadContent(id, offset = 0) {
    const my = ++S.creq;
    const more = $('#tr-more');
    more.hidden = true;
    if (!offset) {
      txt.replaceChildren();
      info('');
      if (!id) {
        txt.removeAttribute('data-cid');
        const m = document.createElement('span');
        m.className = 'tr-quiet';
        m.textContent = 'No text was recorded for this span.';
        txt.appendChild(m);
        return;
      }
      txt.dataset.cid = id;
      txt.classList.add('loading');
    }
    try {
      const r = await trApi(`/api/trace/content?id=${encodeURIComponent(id)}${offset ? `&offset=${offset}` : ''}`);
      if (!S.alive || my !== S.creq) return;
      txt.classList.remove('loading');
      txt.appendChild(textFragment(textNodes(r.text, r.masked), document, { offset: r.offset || 0 }));
      const notes = [];
      const n = $$('.tr-mask', txt).length;
      if (n) notes.push(`${n} secret${n === 1 ? '' : 's'} masked · “show” reveals one, never stored`);
      if (r.truncated && Number.isFinite(r.next) && Number.isFinite(r.total))
        notes.push(`${Math.round(r.next / 1024)} of ${Math.round(r.total / 1024)} KB shown`);
      if (r.saved && r.saved.error) notes.push(`saved output not shown: ${r.saved.error}`);
      info(notes.join(' · '));
      if (Number.isFinite(r.next)) {
        more.hidden = false;
        more.dataset.next = String(r.next);
      }
    } catch (e) {
      if (!S.alive || my !== S.creq) return;
      txt.classList.remove('loading');
      const m = document.createElement('span');
      m.className = 'tr-quiet';
      m.textContent =
        e.status === 403 && /content viewing is off/i.test(e.message)
          ? 'Content viewing is off (ZAAFPULSE_CONTENT)'
          : `Could not read this text: ${e.message}`;
      if (offset) txt.appendChild(document.createTextNode('\n'));
      txt.appendChild(m);
    }
  }

  // "show" asks for the one value and puts it in that mask's span only; "hide" puts the placeholder back.
  // A repaint draws the mask again: the value is not kept anywhere (S2).
  async function toggleMask(btn) {
    const box = btn.closest('.tr-mask');
    const label = box && $('.tr-mask-text', box);
    const id = txt.dataset.cid;
    if (!label || !id) return;
    if (box.classList.contains('shown')) {
      label.textContent = box.dataset.ph || '‹hidden›';
      box.classList.remove('shown');
      btn.textContent = 'show';
      return;
    }
    box.dataset.ph = label.textContent;
    btn.disabled = true;
    try {
      const r = await trApi('/api/trace/reveal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, index: Number(box.dataset.index), offset: Number(box.dataset.offset) }),
      });
      if (!S.alive || txt.dataset.cid !== id || !box.isConnected) return;
      label.textContent = String(r.value ?? '');
      box.classList.add('shown');
      btn.textContent = 'hide';
    } catch (e) {
      info(`Could not show the value: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- live tail ---- */
  function schedulePoll() {
    clearTimeout(S.poll);
    if (S.alive && S.sk && trIsLive(S.sk)) S.poll = later(pollLive, 5000);
  }
  // The text on show stays, but later reads (next page, "show") go through the id of the adopted skeleton.
  function rebindText(s) {
    const on = $('[data-ttab].on', app);
    const id = on && textsOf(s)[on.dataset.ttab];
    if (id && txt.dataset.cid) txt.dataset.cid = id;
  }
  async function pollLive() {
    const key = S.key;
    if (!S.sk || document.hidden) return schedulePoll();
    try {
      const r = await trApi(
        `/api/trace/live?key=${encodeURIComponent(key)}${S.cursor ? `&cursor=${encodeURIComponent(S.cursor)}` : ''}`,
      );
      if (!S.alive || key !== S.key || !S.sk) return;
      if (r.cursor) S.cursor = r.cursor;
      const plan = trLivePlan(S.sk, r);
      if (plan.adopt) {
        const onLast = S.turn >= S.sk.turns.length - 1;
        if (onLast) {
          const prev = S.sel && S.spans.get(S.sel);
          S.sk = r.skeleton;
          S.turn = Math.max(0, r.skeleton.turns.length - 1);
          if (plan.repaint) paintSkeleton();
          else S.spans = new Map(r.skeleton.spans.map((s) => [s.id, s]));
          const now = S.sel && S.spans.get(S.sel);
          if (!now) pickSelection();
          else {
            if (plan.repaint) select(S.sel, { scroll: 'none' });
            if (!prev || prev.end !== now.end || prev.status !== now.status) paintDetail();
            else rebindText(now);
          }
        } else if (r.skeleton.turns.length !== S.sk.turns.length) {
          // An earlier turn stays as it is (its ids live in its own cache slot); only the stepper learns of the new turn.
          S.sk = { ...S.sk, turns: r.skeleton.turns };
          $('#tr-step').textContent = `${S.turn + 1} / ${S.sk.turns.length}`;
          $('#tr-next').disabled = false;
        }
      }
    } catch (e) {
      if (!S.alive || key !== S.key) return;
      if (e.status === 404) {
        const stale = /rescanning/.test(e.message);
        notice(
          stale ? 'This session file changed; the list is being rescanned.' : 'This session is no longer listed.',
          true,
        );
        return;
      }
    }
    schedulePoll();
  }

  /* ---- events ---- */
  function toggleNode(id) {
    if (S.collapsed.has(id)) S.collapsed.delete(id);
    else S.collapsed.add(id);
    buildRows();
    paintRows();
  }
  function stepTurn(d) {
    if (!S.sk) return;
    const t = S.turn + d;
    if (t < 0 || t >= S.sk.turns.length) return;
    loadSkeleton(t);
  }
  function moveSel(d) {
    const rows = S.rows.filter((r) => !r.placeholder);
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.id === S.sel);
    const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + d))];
    select(next.id);
  }

  app.addEventListener('click', (e) => {
    const t = e.target;
    const q = (sel) => t.closest && t.closest(sel);
    let el;
    if ((el = q('.tr-show'))) return void toggleMask(el);
    if ((el = q('[data-trange]'))) {
      S.range = el.dataset.trange;
      for (const b of $$('[data-trange]', app)) {
        b.classList.toggle('on', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      }
      return void loadSessions();
    }
    if ((el = q('[data-tsrc]'))) {
      S.source = el.dataset.tsrc;
      paintChips();
      return void paintList();
    }
    if (q('[data-terr]')) {
      S.errorsOnly = !S.errorsOnly;
      paintChips();
      return void paintList();
    }
    if (q('#tr-collapse')) {
      const on = !body.classList.contains('collapsed');
      setCollapsed(on);
      store.set('trace.collapsed', on ? '1' : '0');
      return;
    }
    if ((el = q('[data-tkey]'))) return void selectSession(el.dataset.tkey);
    if ((el = q('[data-ttoggle]'))) {
      e.stopPropagation();
      return void toggleNode(el.dataset.ttoggle);
    }
    if ((el = q('[data-tturn]'))) return void loadSkeleton(Number(el.dataset.tturn));
    if ((el = q('[data-tspan]')))
      return void select(el.dataset.tspan, { scroll: el.classList.contains('tr-node') ? 'tree' : 'map' });
    if ((el = q('[data-ttab]'))) {
      if (el.disabled || el.hidden) return;
      S.tab = el.dataset.ttab;
      return void paintDetail();
    }
    if (q('#tr-more')) {
      const next = Number($('#tr-more').dataset.next);
      if (Number.isFinite(next) && txt.dataset.cid) loadContent(txt.dataset.cid, next);
      return;
    }
    if (q('#tr-prev')) return void stepTurn(-1);
    if (q('#tr-next')) return void stepTurn(1);
    if (q('#tr-refresh')) {
      notice('');
      loadSessions().then(() => S.alive && S.key && loadSkeleton(S.turn));
    }
  });

  let searchTimer = 0;
  $('#tr-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = later(() => {
      S.q = e.target.value.trim().slice(0, 200);
      loadSessions();
    }, 250);
  });

  rowsBox.addEventListener('scroll', () => {
    if (S.rows.length > TR_WINDOW_AT && !S.rowFrame)
      S.rowFrame = requestAnimationFrame(() => {
        S.rowFrame = 0;
        if (S.alive) paintRows();
      });
  });

  // j/k move between spans, ←/→ change turn, Enter opens the detail; never while typing.
  const onKey = (e) => {
    if (!S.alive || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest(TR_TYPING)) return;
    if (typeof drawer !== 'undefined' && drawer && drawer.kind) return;
    const inApp = t && t.closest && t.closest('#tr-app');
    if (t && t.id === 'tr-split' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const cur = parseFloat(getComputedStyle(app).getPropertyValue('--split')) || 58;
      setSplit(cur + (e.key === 'ArrowLeft' ? -2 : 2));
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && inApp) {
      const el = t.closest('[data-tkey], .tr-node, [data-tturn]');
      if (el) {
        e.preventDefault();
        el.click();
        if (el.classList.contains('tr-node') && e.key === 'Enter') txt.focus();
        return;
      }
      if (e.key === ' ' || t.closest('button, a')) return;
    }
    const nav = trNavKey(e, [document.body, document.documentElement]);
    if (nav) {
      e.preventDefault();
      if (nav === 'down' || nav === 'up') moveSel(nav === 'down' ? 1 : -1);
      else stepTurn(nav === 'prev' ? -1 : 1);
    } else if (e.key === 'Enter' && S.sel) {
      // Outside the explorer Enter keeps its meaning (a sidebar link, a button): only the page itself.
      if (!inApp && t !== document.body && t !== document.documentElement) return;
      e.preventDefault();
      txt.focus();
    }
  };
  document.addEventListener('keydown', onKey);

  // The splitter: 38–70% of the deck for the left half.
  function setSplit(pct) {
    const v = Math.min(70, Math.max(38, pct));
    app.style.setProperty('--split', `${v.toFixed(1)}%`);
    store.set('trace.split', v.toFixed(1));
  }
  const splitter = $('#tr-split');
  splitter.addEventListener('pointerdown', (e) => {
    if (!trPrimary(e)) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('drag');
    const move = (ev) => {
      const r = app.getBoundingClientRect();
      const v = Math.min(70, Math.max(38, ((ev.clientX - r.left) / r.width) * 100));
      app.style.setProperty('--split', `${v.toFixed(1)}%`);
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      splitter.classList.remove('drag');
      const v = parseFloat(app.style.getPropertyValue('--split'));
      if (Number.isFinite(v)) store.set('trace.split', v.toFixed(1));
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });

  // Wires follow the map's size: the splitter, the collapsed list and the window all change it.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => S.alive && queueWires()) : null;
  if (ro) ro.observe($('#tr-map'));
  const onResize = () => {
    fit();
    queueWires();
    if (S.rows.length > TR_WINDOW_AT) paintRows();
  };
  addEventListener('resize', onResize);

  onUnmount(() => {
    S.alive = false;
    clearTimeout(S.poll);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (S.frame) cancelAnimationFrame(S.frame);
    if (S.rowFrame) cancelAnimationFrame(S.rowFrame);
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
  });

  /* ---- start: the session in the link, or the newest one ---- */
  trApi('/api/trace/settings')
    .then((r) => {
      const msg = trOffNote(r);
      if (!S.alive || !msg) return;
      const off = $('#tr-off');
      off.textContent = msg;
      off.hidden = false;
    })
    .catch(() => {
      /* an older server: nothing to say up front */
    });
  (async () => {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    let key = params.get('key');
    const sid = params.get('s');
    const src = params.get('src');
    let missing = '';
    await loadSessions();
    if (!S.alive) return;
    if (!key && sid && src) {
      try {
        key = (await trApi(`/api/trace/find?source=${encodeURIComponent(src)}&sid=${encodeURIComponent(sid)}`)).key;
      } catch (e) {
        missing = e.status === 404 ? 'Session not found in the trace explorer.' : `Could not find the session: ${e.message}`;
      }
      if (!S.alive) return;
    }
    const first = shownSessions()[0];
    if (key) selectSession(key);
    else if (first) selectSession(first.key);
    else clearTurn('No sessions in this range.');
    if (missing) notice(missing); // after the selection, which clears the notice
  })();
}

if (typeof module !== 'undefined')
  module.exports = {
    treeRows,
    mapNodes,
    textNodes,
    textFragment,
    fmtDur,
    trIsLive,
    trLabel,
    trBadges,
    trShape,
    trLivePlan,
    trNavKey,
    trPrimary,
    trColor,
    trSrc,
    trOffNote,
  };
