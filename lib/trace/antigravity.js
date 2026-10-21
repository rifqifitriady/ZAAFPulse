// Antigravity adapter for the trace explorer, at conversation level. Antigravity keeps one row per
// conversation in a SQLite database (conversation_summaries); a row with a parent_conversation_id is a
// sub-conversation (an agent the parent started). The skeleton is the root conversation with one `agent`
// span per sub-conversation, its step count in tool.target. Only metadata columns are selected: the
// preview, the raw summary and the FTS tables hold text and are never read, so spans carry no text.
//
// The database is opened read-only (S9). `readOnly` came in Node 22.12 (23.2): earlier Node ignores it and would
// open the database read-write, where closing the last connection can checkpoint and delete the app's -wal/-shm.
// `node:sqlite` loads without --experimental-sqlite from 22.13 (23.4), so that is the gate: below it nothing
// opens the database at all. Antigravity keeps it in WAL mode while it runs; if it is
// locked or cannot be opened read-only (SQLITE_BUSY, SQLITE_CANTOPEN), the file and its -wal are copied to
// a temp folder, the copy is read, then deleted.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spanId, span } = require('./model');
const L = require('./light');

const COLUMNS = 'conversation_id, title, step_count, agent_name, parent_conversation_id, nesting_depth, status, last_modified_time, last_user_input_time, workspace_uris, killed';
const MAX_ROWS = 5000;

// The first minor of each major where node:sqlite loads unflagged with `readOnly` (Node release notes: unflag
// sqlite module, #55890, in 22.13.0 and 23.4.0; readOnly, #55567, in 22.12.0 and 23.2.0).
const MIN_NODE = [22, 13];
const MIN_MINOR = { 22: 13, 23: 4 };
const NEEDS = `needs Node ${MIN_NODE.join('.')} or newer`;
const NO_READONLY = 'read-only SQLite not supported by this Node';
const PROBE_FAILED = 'read-only check failed';

// Compared as numbers: '22.9.0' is older than '22.13.0'.
function versionOk(v) {
  const [major, minor] = String(v).split('.').map((x) => parseInt(x, 10));
  if (!(major >= MIN_NODE[0])) return false;
  return major in MIN_MINOR ? minor >= MIN_MINOR[major] : true;
}

function sqliteModule(version, injected) {
  if (!versionOk(version)) return null;
  if (injected) return injected;
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

// Whether `readOnly` is honoured: opening a path that does not exist read-only must throw and create nothing.
// (A Node that ignores the option would create the file, and on a real database could write to it.)
function readOnlyHonoured(sqlite) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-agprobe-'));
  const file = path.join(dir, 'probe.db');
  try {
    try {
      new sqlite.DatabaseSync(file, { readOnly: true }).close();
      return false;
    } catch {
      return !fs.existsSync(file);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const busy = (e) => /SQLITE_(?:BUSY|LOCKED|CANTOPEN)|database is locked|unable to open database/i.test(`${e && e.code} ${e && e.message}`) || [5, 6, 14].includes(e && e.errcode);

function query(sqlite, file, opts) {
  const db = new sqlite.DatabaseSync(file, opts);
  try {
    return db.prepare(`SELECT ${COLUMNS} FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ${MAX_ROWS}`).all();
  } finally {
    db.close();
  }
}

// What a copy was made from: the database and its -wal, by time and size.
function fileSig(file) {
  const one = (f) => {
    try {
      const st = fs.statSync(f);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  };
  return `${one(file)}|${one(`${file}-wal`)}`;
}

// `copies` (file -> { sig, rows }) keeps what the last copy read: while the database stays locked and
// unchanged, a new listing reuses it instead of copying the file again.
function readRows(sqlite, file, onCopy, copies) {
  try {
    return query(sqlite, file, { readOnly: true });
  } catch (e) {
    if (!busy(e)) throw e;
  }
  const sig = fileSig(file);
  const kept = copies && copies.get(file);
  if (kept && kept.sig === sig) return kept.rows;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-agcopy-'));
  try {
    if (onCopy) onCopy(file);
    const copy = path.join(dir, 'conversation_summaries.db');
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    const rows = query(sqlite, copy, {}); // the copy is ours, so SQLite may replay its WAL there
    if (copies) copies.set(file, { sig, rows });
    return rows;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A reason shown to the client: the message without a path in it.
const scrub = (e) =>
  String((e && e.message) || e || 'failed')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g, '<path>')
    .slice(0, 100);

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

// `version`, `sqlite`, `onCopy` and `minRefresh` are for tests: the Node version to judge, a stand-in for node:sqlite, and a
// callback run when a database is read through a copy.
function createAntigravity({ files, version = process.versions.node, sqlite: injected, onCopy, minRefresh } = {}) {
  const paths = () => files || [path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'), path.join(os.homedir(), '.gemini', 'antigravity-ide', 'conversation_summaries.db')];
  // The SQLite module when it may be used, else why not. The read-only probe runs once; if it cannot run at
  // all (no temp folder, say) the source is unavailable, and nothing the probe does can throw out of here.
  let honoured;
  function gate() {
    const sqlite = sqliteModule(version, injected);
    if (!sqlite) return { reason: NEEDS };
    if (honoured === undefined) {
      try {
        honoured = readOnlyHonoured(sqlite) ? 'yes' : 'no';
      } catch {
        honoured = 'failed';
      }
    }
    return honoured === 'yes' ? { sqlite } : { reason: honoured === 'no' ? NO_READONLY : PROBE_FAILED };
  }
  const present = () => paths().filter((f) => fs.existsSync(f));

  // Every conversation of every database as { id, parent, ... }, the newest copy winning a duplicate id.
  // `failed` is why, when every database there is failed to read (one alone is skipped, P10).
  const copies = new Map();
  function conversations() {
    const { sqlite } = gate();
    const all = new Map();
    if (!sqlite) return { all, failed: null };
    const files = present();
    let failed = null;
    let bad = 0;
    for (const f of files) {
      let rows;
      try {
        rows = readRows(sqlite, f, onCopy, copies);
      } catch (e) {
        bad++;
        failed = `database unreadable: ${scrub(e)}`;
        continue; // one unreadable database must not hide the other (P10)
      }
      for (const r of rows) {
        if (typeof r.conversation_id !== 'string' || !r.conversation_id) continue;
        const c = {
          id: r.conversation_id,
          title: r.title,
          steps: Number.isFinite(Number(r.step_count)) ? Number(r.step_count) : 0,
          agent: L.maskTitle(r.agent_name),
          parent: typeof r.parent_conversation_id === 'string' && r.parent_conversation_id && r.parent_conversation_id !== r.conversation_id ? r.parent_conversation_id : null,
          modified: L.timeOf(r.last_modified_time),
          input: L.timeOf(r.last_user_input_time),
          workspace: r.workspace_uris,
          killed: truthy(r.killed),
        };
        const old = all.get(c.id);
        if (!old || (c.modified ?? 0) > (old.modified ?? 0)) all.set(c.id, c);
      }
    }
    return { all, failed: files.length && bad === files.length ? failed : null };
  }

  // A root conversation with all that descend from it (a parent that is not in the database makes it a root).
  function treeOf(all) {
    // A cycle of parents would leave all its members without a root: the oldest of them becomes the root.
    const age = (c) => c.input ?? c.modified ?? 0;
    for (const start of all.values()) {
      const chain = [];
      const on = new Set();
      for (let c = start; c && !on.has(c.id); c = c.parent && all.get(c.parent)) {
        on.add(c.id);
        chain.push(c);
      }
      const last = chain[chain.length - 1];
      const back = last && last.parent && all.get(last.parent);
      if (back && on.has(back.id)) {
        const ring = chain.slice(chain.indexOf(back));
        ring.sort((x, y) => age(x) - age(y) || (x.id < y.id ? -1 : 1))[0].parent = null;
      }
    }
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
    const { all, failed } = conversations();
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
    // The cap is on what is listed; any root of the database can still be opened.
    return { rows: L.newest(rows.slice()), byId: new Map(rows.map((r) => [r.id, r])), all, tree: (id) => (all.has(id) ? tree(all.get(id)) : null), failed };
  }
  const listing = L.cache(list, { minRefresh });

  function available() {
    const g = gate();
    if (!g.sqlite) return { ok: false, reason: g.reason };
    return present().length ? { ok: true, reason: null } : { ok: false, reason: 'not installed' };
  }

  // The registry lists a source that throws as not ok, with the reason.
  function sessions() {
    const l = listing();
    if (l.failed) throw new Error(l.failed);
    return l.rows;
  }

  async function skeleton(_entry, id) {
    let l = listing();
    if (!l.byId.has(id)) l = listing(true);
    const row = l.byId.get(id);
    if (!row) throw L.unknown();
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
