// Gemini CLI adapter for the trace explorer. The CLI saves each chat as ~/.gemini/tmp/<project>/chats/*.json,
// a document with a `messages` array of { type: 'user' | 'gemini', content, toolCalls?, tokens? }. A turn
// starts at each user message; a gemini message is one chat span (usage from `tokens`) and its toolCalls
// are tool spans. Spans carry no text. Only the first user message is read, for the (masked) title.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spanId, span } = require('./model');
const L = require('./light');

const FAILED = /^(?:error|fail)/i;
const OK = /^(?:success|completed|ok)/i;

// Chat files under root/<project>/chats, a few levels deep at most.
function chatFiles(real) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.json') && path.basename(dir) === 'chats') out.push(p);
    }
  };
  walk(real, 0);
  return out;
}

// The text of a message, read only as far as a title needs.
function textOf(c) {
  if (typeof c === 'string') return c.trim().slice(0, 4096);
  const parts = Array.isArray(c) ? c : c ? [c] : [];
  let out = '';
  for (const x of parts) {
    out += ` ${typeof x === 'string' ? x : (x && typeof x.text === 'string' && x.text) || ''}`;
    if (out.length >= 4096) break;
  }
  return out.trim().slice(0, 4096);
}

function parse(file) {
  const o = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = o && Array.isArray(o.messages) ? o.messages.filter((m) => m && typeof m === 'object') : null;
  if (!msgs) return null;
  const turns = []; // { ts, msgs }
  let tools = 0;
  let errors = 0;
  let title = null;
  let first = null;
  let last = null;
  for (const m of msgs) {
    const ts = L.timeOf(m.timestamp);
    first = first ?? ts;
    last = L.maxTs(last, ts);
    if (m.type === 'user') {
      if (title == null) title = textOf(m.content) || null; // the first prompt that has text
      if (turns.length === 1 && !turns[0].user) turns[0].user = true; // anything before the first prompt joins it
      else turns.push({ ts, msgs: [], user: true });
    } else if (!turns.length) turns.push({ ts, msgs: [], user: false });
    const t = turns[turns.length - 1];
    if (!Number.isFinite(t.ts) && Number.isFinite(ts)) t.ts = ts;
    if (m.type !== 'user') t.msgs.push({ m, ts });
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      tools++;
      if (FAILED.test(String(c && c.status))) errors++;
    }
  }
  return { o, turns, tools, errors, title, first, last };
}

function createGemini({ root = path.join(os.homedir(), '.gemini', 'tmp'), ttl, minRefresh } = {}) {
  function list() {
    const rows = [];
    const byId = new Map();
    const taken = new Set();
    let real;
    try {
      real = fs.realpathSync(root);
    } catch {
      return { rows, byId };
    }
    // Stat first, then parse only the newest chats.
    for (const { file, mtime } of L.newestFiles(chatFiles(real))) {
      try {
        if (!L.inside(real, file)) continue;
        const sc = parse(file);
        if (!sc) continue;
        const o = sc.o;
        const id = L.uniqueId(taken, o.sessionId || path.basename(file, '.json'), (f) => spanId('gemini', f), file);
        byId.set(id, file);
        rows.push({
          id,
          source: 'gemini',
          title: L.maskTitle(sc.title),
          project: L.baseName(String(o.projectHash || path.basename(path.dirname(path.dirname(file)))).slice(0, 12)),
          branch: null,
          start: L.timeOf(o.startTime) ?? sc.first ?? mtime,
          end: L.maxTs(L.timeOf(o.lastUpdated), sc.last) ?? mtime,
          turns: sc.turns.length,
          tools: sc.tools,
          errors: sc.errors,
          cost: null,
          flags: { errors: sc.errors > 0, loop: false, injection: false },
        });
      } catch {
        /* an unreadable or malformed chat is skipped (P10) */
      }
    }
    return { rows: L.newest(rows), byId };
  }
  const listing = L.cache(list, { ttl, minRefresh });

  function available() {
    try {
      return fs.statSync(root).isDirectory() ? { ok: true, reason: null } : { ok: false, reason: 'not installed' };
    } catch {
      return { ok: false, reason: 'not installed' };
    }
  }

  const sessions = () => listing().rows;

  async function skeleton(_entry, id, opts) {
    const file = listing().byId.get(id) || listing(true).byId.get(id);
    if (!file) throw L.unknown();
    const row = listing().rows.find((r) => r.id === id);
    let sc;
    try {
      sc = parse(file);
    } catch {
      sc = null;
    }
    if (!sc) throw L.unknown();
    const turns = sc.turns.map((t, index) => ({ index, start: index, ts: t.ts }));
    const n = L.turnIndex(opts && opts.turn, turns.length);
    const rootSpan = span({ id: spanId('gemini', id, 'session'), kind: 'session', op: 'invoke_agent', name: 'invoke_agent gemini', start: L.minTs(row ? row.start : sc.first, n >= 0 ? turns[n].ts : null), end: row ? row.end : sc.last });
    const spans = [rootSpan];
    if (n >= 0) {
      const t = sc.turns[n];
      const turnSpan = span({ id: spanId('gemini', id, 'turn', n), parent: rootSpan.id, kind: 'turn', op: 'invoke_agent', name: `turn ${n + 1}`, start: t.ts });
      spans.push(turnSpan);
      // A time inside the turn: never before the turn began (a clock that went backwards would break the tree).
      const within = (ts) => (Number.isFinite(ts) && Number.isFinite(t.ts) ? Math.max(ts, t.ts) : ts);
      let edge = t.ts; // where the next chat began: the prompt, then each reply
      t.msgs.forEach(({ m, ts }, i) => {
        if (m.type === 'gemini') {
          const tk = m.tokens && typeof m.tokens === 'object' ? m.tokens : null;
          const end = within(ts);
          const model = L.maskTitle(m.model) || 'gemini';
          spans.push(span({ id: spanId('gemini', id, 'chat', n, i), parent: turnSpan.id, kind: 'chat', op: 'chat', name: `chat ${model}`, start: Number.isFinite(edge) && Number.isFinite(end) && edge <= end ? edge : end, end, model, provider: 'google', usage: tk && { input: L.count(tk.input), output: L.count(tk.output), cacheRead: L.count(tk.cached) } }));
          edge = L.maxTs(edge, end);
          turnSpan.end = L.maxTs(turnSpan.end, end);
        }
        (Array.isArray(m.toolCalls) ? m.toolCalls : []).forEach((c, j) => {
          if (!c || typeof c !== 'object') return;
          const name = L.maskTitle(c.name) || 'tool';
          const start = within(L.timeOf(c.timestamp) ?? ts);
          const status = FAILED.test(String(c.status)) ? 'error' : OK.test(String(c.status)) ? 'ok' : 'unknown';
          spans.push(span({ id: spanId('gemini', id, 'tool', n, i, j), parent: turnSpan.id, kind: 'tool', op: 'execute_tool', name: `execute_tool ${name}`, start, tool: { name, target: L.targetOf(c.args) }, status }));
          turnSpan.end = L.maxTs(turnSpan.end, start);
        });
      });
    }
    return { session: { id, source: 'gemini', project: row ? row.project : null, branch: null, start: rootSpan.start, end: rootSpan.end }, turns, spans };
  }

  return { id: 'gemini', available, sessions, skeleton };
}

let shared = null;
const inst = () => shared || (shared = createGemini());

module.exports = { id: 'gemini', available: () => inst().available(), sessions: () => inst().sessions(), skeleton: (...a) => inst().skeleton(...a), createGemini };
