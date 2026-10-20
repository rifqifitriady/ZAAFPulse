// Kiro adapter for the trace explorer. Kiro keeps each session in ~/.kiro/sessions/<workspace>/<sess_id>/
// as a session.json (title, workspace, times) next to a messages.jsonl, so the folder is listed here
// directly instead of going through the indexer. No usage and no cost are stored, and spans carry no text.
//
// Shape checked on a real machine (keys and types only): a line is { id, timestamp, payload } and the only
// payload types seen are
//   tool_call   { toolCallId, toolName, args, status, kind, executionId, actionType }
//   tool_result { toolCallId, content, success, durationMs, executionId }
// No user message is stored. A turn therefore starts at a user payload when a log has one, and is otherwise
// one turn per executionId in first-seen order.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spanId, span } = require('./model');
const L = require('./light');

const USER = new Set(['user_message', 'user', 'prompt']);
const FAILED = /^(?:fail|error)/i;

function readJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// One pass over messages.jsonl: the turns and the tool calls paired with their results.
function scan(file) {
  const recs = [];
  for (const text of L.linesSync(file)) {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      continue;
    }
    const p = o && o.payload;
    if (!p || typeof p !== 'object') continue;
    recs.push({ ts: L.timeOf(o.timestamp), p });
  }
  const hasUser = recs.some((r) => USER.has(r.p.type) || r.p.role === 'user');
  const turns = []; // { ts, line, user }
  const byExec = new Map();
  const calls = new Map(); // toolCallId -> call
  let cur = -1;
  recs.forEach((r, line) => {
    const p = r.p;
    if (hasUser) {
      if (USER.has(p.type) || p.role === 'user') {
        if (turns.length === 1 && !turns[0].user) turns[0].user = true; // lines before the first prompt belong to it
        else turns.push({ ts: r.ts, line, user: true });
        cur = turns.length - 1;
      } else if (cur < 0) {
        turns.push({ ts: r.ts, line, user: false });
        cur = 0;
      }
    } else if (p.executionId != null && p.executionId !== '') {
      if (!byExec.has(p.executionId)) {
        byExec.set(p.executionId, turns.length);
        turns.push({ ts: r.ts, line });
      }
      cur = byExec.get(p.executionId);
    } else if (cur < 0) {
      turns.push({ ts: r.ts, line });
      cur = 0;
    }
    if (!Number.isFinite(turns[cur].ts) && Number.isFinite(r.ts)) turns[cur].ts = r.ts;
    if (p.type === 'tool_call') {
      const key = p.toolCallId != null ? String(p.toolCallId) : `@${line}`;
      const c = calls.get(key);
      if (c) c.status = p.status ?? c.status; // a repeated line updates the call
      else calls.set(key, { key, turn: cur, ts: r.ts, name: typeof p.toolName === 'string' && p.toolName ? p.toolName : 'tool', target: L.targetOf(p.args), status: p.status, result: null });
    } else if (p.type === 'tool_result') {
      const c = calls.get(String(p.toolCallId));
      if (c) c.result = { ts: r.ts, success: p.success, ms: Number.isFinite(p.durationMs) ? p.durationMs : null };
    }
  });
  const last = recs.length ? recs[recs.length - 1].ts : null;
  return { turns, calls, first: recs.length ? recs[0].ts : null, last };
}

// error when the result or the call says it failed, ok when it succeeded, else unknown.
function statusOf(c) {
  if ((c.result && c.result.success === false) || FAILED.test(String(c.status || ''))) return 'error';
  if ((c.result && c.result.success === true) || c.status === 'completed') return 'ok';
  return 'unknown';
}

function createKiro({ root = path.join(os.homedir(), '.kiro', 'sessions'), ttl } = {}) {
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
    const dirs = (d) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory());
      } catch {
        return [];
      }
    };
    for (const ws of dirs(real)) {
      for (const sd of dirs(path.join(real, ws.name))) {
        try {
          const dir = path.join(real, ws.name, sd.name);
          const msgs = path.join(dir, 'messages.jsonl');
          const metaFile = path.join(dir, 'session.json');
          if (!fs.existsSync(msgs) || !L.inside(real, msgs)) continue;
          const meta = (L.inside(real, metaFile) && readJson(metaFile)) || {};
          const sc = scan(msgs);
          const mtime = fs.statSync(msgs).mtimeMs;
          const id = L.uniqueId(taken, meta.id || sd.name, (f) => spanId('kiro', f), dir);
          const calls = [...sc.calls.values()];
          const errors = calls.filter((c) => statusOf(c) === 'error').length;
          const start = L.timeOf(meta.createdAt) ?? sc.first ?? mtime;
          const end = L.maxTs(L.timeOf(meta.lastModifiedAt), sc.last) ?? mtime;
          byId.set(id, { msgs, meta });
          rows.push({
            id,
            source: 'kiro',
            title: L.maskTitle(meta.title),
            project: L.baseName(Array.isArray(meta.workspacePaths) ? meta.workspacePaths[0] : null),
            branch: null,
            start,
            end,
            turns: sc.turns.length,
            tools: calls.length,
            errors,
            cost: null,
            flags: { errors: errors > 0, loop: false, injection: false },
          });
        } catch {
          /* one unreadable session must not hide the rest (P10) */
        }
      }
    }
    return { rows: L.newest(rows), byId };
  }
  const listing = L.cache(list, ttl);

  function available() {
    try {
      return fs.statSync(root).isDirectory() ? { ok: true, reason: null } : { ok: false, reason: 'not installed' };
    } catch {
      return { ok: false, reason: 'not installed' };
    }
  }

  const sessions = () => listing().rows;

  async function skeleton(_entry, id, { turn } = {}) {
    const found = listing().byId.get(id) || listing(true).byId.get(id);
    if (!found) throw L.unknown();
    const row = listing().rows.find((r) => r.id === id);
    const sc = scan(found.msgs);
    const turns = sc.turns.map((t, index) => ({ index, start: t.line, ts: t.ts }));
    const n = turns.length ? (turn == null ? turns.length - 1 : Math.max(0, Math.min(turns.length - 1, turn))) : -1;
    const rootStart = L.minTs(row ? row.start : sc.first, n >= 0 ? turns[n].ts : null);
    const rootSpan = span({ id: spanId('kiro', id, 'session'), kind: 'session', op: 'invoke_agent', name: 'invoke_agent kiro', start: rootStart, end: row ? row.end : sc.last });
    const spans = [rootSpan];
    if (n >= 0) {
      const turnSpan = span({ id: spanId('kiro', id, 'turn', n), parent: rootSpan.id, kind: 'turn', op: 'invoke_agent', name: `turn ${n + 1}`, start: turns[n].ts });
      spans.push(turnSpan);
      for (const c of sc.calls.values()) {
        if (c.turn !== n) continue;
        const r = c.result;
        const end = r && r.ms != null && Number.isFinite(c.ts) ? c.ts + r.ms : r ? r.ts : null;
        spans.push(span({ id: spanId('kiro', id, 'tool', c.key), parent: turnSpan.id, kind: 'tool', op: 'execute_tool', name: `execute_tool ${c.name}`, start: c.ts, end, tool: { name: c.name, target: c.target }, status: statusOf(c) }));
        turnSpan.end = L.maxTs(turnSpan.end, end);
      }
    }
    return { session: { id, source: 'kiro', project: row ? row.project : null, branch: null, start: rootStart, end: rootSpan.end }, turns, spans };
  }

  return { id: 'kiro', available, sessions, skeleton };
}

let shared = null;
const inst = () => shared || (shared = createKiro());

module.exports = { id: 'kiro', available: () => inst().available(), sessions: () => inst().sessions(), skeleton: (...a) => inst().skeleton(...a), createKiro };
