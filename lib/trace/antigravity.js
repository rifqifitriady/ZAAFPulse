// Antigravity adapter for the trace explorer, at conversation level. Antigravity keeps one row per
// conversation in a SQLite database (conversation_summaries); a row with a parent_conversation_id is a
// sub-conversation (an agent the parent started). The skeleton is the root conversation with one `agent`
// span per sub-conversation, its step count in tool.target. Only metadata columns are selected: the
// preview, the raw summary and the FTS tables hold text and are never read, so spans carry no text.
//
// The database is opened read-only (S9). Antigravity keeps it in WAL mode while it runs; if it is locked
// anyway (SQLITE_BUSY), the file and its -wal are copied to a temp folder, the copy is read, then deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spanId, span } = require('./model');
const L = require('./light');

const COLUMNS = 'conversation_id, title, step_count, agent_name, parent_conversation_id, nesting_depth, status, last_modified_time, last_user_input_time, workspace_uris, killed';
const MAX_ROWS = 5000;

function sqliteModule() {
  try {
    return require('node:sqlite');
  } catch {
    return null; // Node older than 22.5
  }
}

const busy = (e) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(`${e && e.code} ${e && e.message}`);

function query(sqlite, file, opts) {
  const db = new sqlite.DatabaseSync(file, opts);
  try {
    db.exec('PRAGMA query_only = 1'); // belt and braces on a Node that predates the readOnly option
    return db.prepare(`SELECT ${COLUMNS} FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ${MAX_ROWS}`).all();
  } finally {
    db.close();
  }
}

function readRows(sqlite, file) {
  try {
    return query(sqlite, file, { readOnly: true });
  } catch (e) {
    if (!busy(e)) throw e;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-agcopy-'));
  try {
    const copy = path.join(dir, 'conversation_summaries.db');
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    return query(sqlite, copy, {}); // the copy is ours, so SQLite may replay its WAL there
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// workspace_uris is a JSON list or a plain list of file:// URIs; the project is the first one's folder name.
function projectOf(v) {
  let list = null;
  try {
    list = JSON.parse(v);
  } catch {
    /* not JSON */
  }
  const first = Array.isArray(list) ? list[0] : String(v || '').split(/[\s,]+/)[0];
  if (typeof first !== 'string' || !first) return null;
  let p = first.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep it as written */
  }
  return L.baseName(p);
}

const truthy = (v) => v === true || v === 'true' || Number(v) > 0;

function createAntigravity({ files } = {}) {
  const paths = () => files || [path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'), path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversation_summaries.db')];
  const present = () => paths().filter((f) => fs.existsSync(f));

  // Every conversation of every database as { id, parent, ... }, the newest copy winning a duplicate id.
  function conversations() {
    const sqlite = sqliteModule();
    const all = new Map();
    if (!sqlite) return all;
    for (const f of present()) {
      let rows;
      try {
        rows = readRows(sqlite, f);
      } catch {
        continue; // one unreadable database must not hide the other (P10)
      }
      for (const r of rows) {
        if (typeof r.conversation_id !== 'string' || !r.conversation_id) continue;
        const c = {
          id: r.conversation_id,
          title: r.title,
          steps: Number.isFinite(Number(r.step_count)) ? Number(r.step_count) : 0,
          agent: typeof r.agent_name === 'string' && r.agent_name ? r.agent_name : null,
          parent: typeof r.parent_conversation_id === 'string' && r.parent_conversation_id ? r.parent_conversation_id : null,
          modified: L.timeOf(r.last_modified_time),
          input: L.timeOf(r.last_user_input_time),
          workspace: r.workspace_uris,
          killed: truthy(r.killed),
        };
        const old = all.get(c.id);
        if (!old || (c.modified ?? 0) > (old.modified ?? 0)) all.set(c.id, c);
      }
    }
    return all;
  }

  // A root conversation with all that descend from it (a parent that is not in the database makes it a root).
  function treeOf(all) {
    const kids = new Map();
    for (const c of all.values()) if (c.parent && all.has(c.parent)) (kids.get(c.parent) || kids.set(c.parent, []).get(c.parent)).push(c);
    const roots = [...all.values()].filter((c) => !c.parent || !all.has(c.parent));
    const tree = (root) => {
      const seen = new Set([root.id]);
      const out = [];
      const walk = (c) => {
        for (const k of (kids.get(c.id) || []).sort((a, b) => (a.input ?? a.modified ?? 0) - (b.input ?? b.modified ?? 0))) {
          if (seen.has(k.id)) continue;
          seen.add(k.id);
          out.push(k);
          walk(k);
        }
      };
      walk(root);
      return out;
    };
    return { roots, tree };
  }

  function list() {
    const all = conversations();
    const { roots, tree } = treeOf(all);
    const rows = roots.map((r) => {
      const members = [r, ...tree(r)];
      const errors = members.filter((c) => c.killed).length;
      const start = members.reduce((a, c) => L.minTs(a, c.input ?? c.modified), null);
      return {
        id: r.id,
        source: 'antigravity',
        title: L.maskTitle(r.title),
        project: projectOf(r.workspace),
        branch: null,
        start,
        end: members.reduce((a, c) => L.maxTs(a, c.modified), start),
        turns: 1,
        tools: 0,
        steps: members.reduce((a, c) => a + c.steps, 0),
        errors,
        cost: null,
        flags: { errors: errors > 0, loop: false, injection: false },
      };
    });
    return { rows: L.newest(rows), all, tree: (id) => (all.has(id) ? tree(all.get(id)) : null), roots: new Set(roots.map((r) => r.id)) };
  }
  const listing = L.cache(list);

  function available() {
    if (!sqliteModule()) return { ok: false, reason: 'needs Node 22.5 or newer' };
    return present().length ? { ok: true, reason: null } : { ok: false, reason: 'not installed' };
  }

  const sessions = () => listing().rows;

  async function skeleton(_entry, id) {
    let l = listing();
    if (!l.roots.has(id)) l = listing(true);
    if (!l.roots.has(id)) throw L.unknown();
    const row = l.rows.find((r) => r.id === id);
    const head = l.all.get(id);
    const spans = [
      span({ id: spanId('antigravity', id), kind: 'session', op: 'invoke_agent', name: `invoke_agent ${head.agent || 'antigravity'}`, start: row.start, end: row.end, status: head.killed ? 'error' : 'ok' }),
    ];
    const at = new Map([[id, spans[0]]]);
    for (const c of l.tree(id)) {
      const up = at.get(c.parent) || spans[0];
      const start = L.maxTs(up.start, c.input ?? c.modified);
      const name = c.agent || 'agent';
      const s = span({ id: spanId('antigravity', id, c.id), parent: up.id, kind: 'agent', op: 'invoke_agent', name: `invoke_agent ${name}`, start, end: L.maxTs(c.modified, start), tool: { name, target: `${c.steps} steps` }, status: c.killed ? 'error' : 'ok' });
      at.set(c.id, s);
      spans.push(s);
    }
    return { session: { id, source: 'antigravity', project: row.project, branch: null, start: row.start, end: row.end, steps: row.steps }, turns: [{ index: 0, start: 0, ts: row.start }], spans };
  }

  return { id: 'antigravity', available, sessions, skeleton };
}

let shared = null;
const inst = () => shared || (shared = createAntigravity());

module.exports = { id: 'antigravity', available: () => inst().available(), sessions: () => inst().sessions(), skeleton: (...a) => inst().skeleton(...a), createAntigravity };
