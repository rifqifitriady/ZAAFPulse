// Append-only JSONL stores for eval results and the owner's feedback (.data/, mode 0600). Loaded lazily on the
// first call; writes are small and synchronous. Compaction and feedback rewrites go through a temp file + rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { targetKey, resultKey } = require('./registry');

const MAX_EXPLANATION = 300;
const MAX_NOTE = 2000;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const newId = () => crypto.randomBytes(8).toString('hex');

// One JSONL file: parsed on read (bad lines skipped and counted), appended to, or rewritten whole through a temp
// file + rename. It tracks the byte size so callers never stat the file, and whether the last line was torn.
function openJsonl(file, { readOnly = false } = {}) {
  let size = 0;
  let torn = false;
  let tuned = false;
  const ensureDir = () => {
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A restrictive umask only narrows the mode, but be explicit for the folder this store created.
    chmodQuiet(dir, 0o700);
  };
  // Files made by an older build may be looser than 0600; fix once, best effort.
  const tune = () => {
    if (tuned || readOnly) return;
    tuned = true;
    chmodQuiet(file, 0o600);
  };
  return {
    size: () => size,
    read() {
      tune();
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        size = 0;
        torn = false;
        return { rows: [], bad: 0 };
      }
      size = Buffer.byteLength(text);
      torn = text.length > 0 && !text.endsWith('\n');
      const rows = [];
      let bad = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
          else bad++;
        } catch {
          bad++;
        }
      }
      return { rows, bad };
    },
    append(row) {
      ensureDir();
      tune();
      // A crash mid-write can leave a fragment without a newline; start the next row on its own line.
      const data = (torn ? '\n' : '') + JSON.stringify(row) + '\n';
      fs.appendFileSync(file, data, { mode: 0o600 });
      size += Buffer.byteLength(data);
      torn = false;
    },
    // A crash mid-write leaves the old file intact; renameSync also replaces an existing target on Windows.
    rewrite(rows) {
      ensureDir();
      tune();
      const tmp = `${file}.tmp`;
      const data = rows.map((r) => JSON.stringify(r) + '\n').join('');
      // Remove a stale temp first: writeFileSync keeps the mode of a file that already exists.
      rmQuiet(tmp);
      try {
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) {
        rmQuiet(tmp);
        throw e;
      }
      size = Buffer.byteLength(data);
      torn = false;
    },
  };
}

function chmodQuiet(target, mode) {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(target, mode);
  } catch {
    /* missing file or not ours: best effort */
  }
}

function rmQuiet(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    /* nothing there */
  }
}

const inSession = (r, source, session) => !!r.target && r.target.source === source && r.target.session === session;

// `readOnly` is for a reader that is not the dashboard (the MCP tool): it never writes, compacts or changes a mode.
// A result key without the model: what the scheduler asks to know whether any model judged a target already.
const verdictKey = (t, evaluator, version) => `${targetKey(t)}|${evaluator}|${version}`;

function createEvalStore({ file, maxBytes = 10e6, readOnly = false }) {
  const io = openJsonl(file, { readOnly });
  let byKey = null; // resultKey -> latest result
  let byVerdict = new Map(); // verdictKey -> the newest result of any model
  const note = (r) => {
    if (!r.target) return;
    const k = verdictKey(r.target, r.evaluator, r.version);
    const have = byVerdict.get(k);
    if (!have || (r.ts || 0) >= (have.ts || 0)) byVerdict.set(k, r);
  };
  const reindex = () => {
    byVerdict = new Map();
    for (const r of byKey.values()) note(r);
  };
  let bad = 0; // lines skipped when the file was loaded
  let warned = false;
  // Rewrite the file with the latest result per key. If that is still over the cap, drop the oldest results by ts
  // down to ~80% of it, so rewrites stay rare and the in-memory map is bounded too. Another writer (the CLI next to
  // a running dashboard) may have appended since the load, so the file is read again and merged first, the newer
  // result per key winning.
  const compact = () => {
    const map = load();
    const merged = new Map(map);
    for (const r of io.read().rows) {
      if (!r.key) continue;
      const have = merged.get(r.key);
      if (!have || (r.ts || 0) > (have.ts || 0)) merged.set(r.key, r);
    }
    let rows = [...merged.values()];
    const sizes = rows.map((r) => Buffer.byteLength(JSON.stringify(r)) + 1);
    let total = sizes.reduce((a, b) => a + b, 0);
    if (total > maxBytes) {
      const byAge = rows.map((r, i) => i).sort((x, y) => (rows[x].ts || 0) - (rows[y].ts || 0));
      const drop = new Set();
      for (const i of byAge) {
        if (total <= maxBytes * 0.8 || drop.size >= rows.length - 1) break;
        drop.add(i);
        total -= sizes[i];
      }
      rows = rows.filter((r, i) => !drop.has(i));
    }
    io.rewrite(rows);
    // Disk first, memory second: a failed rewrite leaves both as they were.
    map.clear();
    for (const r of rows) map.set(r.key, r);
    reindex();
  };
  function load() {
    if (byKey) return byKey;
    const map = new Map();
    const read = io.read();
    bad = read.bad;
    // Later lines win, so a re-judged target replaces its older result.
    for (const r of read.rows) if (r.key) map.set(r.key, r);
    byKey = map;
    reindex();
    // Drop the unreadable lines once so the count does not repeat on every start.
    if (bad > 0 && !readOnly) tryCompact();
    return byKey;
  }
  function tryCompact() {
    try {
      compact();
    } catch (e) {
      // Compaction is only an optimisation; the append already succeeded.
      if (!warned) {
        warned = true;
        console.warn(`evals: could not compact ${file}: ${e.message}`);
      }
    }
  }
  return {
    put(result) {
      if (readOnly) throw new Error('this store is read-only');
      const map = load();
      const judge = result.judge || {};
      const r = {
        ...result,
        id: result.id || newId(),
        key: resultKey(result.target, result.evaluator, result.version, judge.model),
        ts: result.ts || Date.now(),
      };
      // Explanations come from a model, so cap them here as well as in the judge.
      if (typeof r.explanation === 'string' && r.explanation.length > MAX_EXPLANATION) {
        r.explanation = r.explanation.slice(0, MAX_EXPLANATION);
      }
      io.append(r);
      map.set(r.key, r);
      note(r);
      if (io.size() > maxBytes) tryCompact();
      return r;
    },
    get: (key) => load().get(key) || null,
    // The newest result for a target and evaluator version, whichever model gave it.
    latest: (target, evaluator, version) => (load(), byVerdict.get(verdictKey(target, evaluator, version)) || null),
    forTarget: (tk) => [...load().values()].filter((r) => targetKey(r.target) === tk),
    forSession: (source, session) => [...load().values()].filter((r) => inSession(r, source, session)),
    all: () => [...load().values()],
    compact: () => {
      if (readOnly) throw new Error('this store is read-only');
      compact();
    },
    stats: () => (load(), { bad, keys: byKey.size, bytes: io.size() }),
  };
}

function createFeedbackStore({ file }) {
  const io = openJsonl(file);
  let byTarget = null; // targetKey -> record
  let bad = 0;
  const save = () => io.rewrite([...byTarget.values()]);
  const load = () => {
    if (byTarget) return byTarget;
    const map = new Map();
    const read = io.read();
    bad = read.bad;
    for (const r of read.rows) if (r.target) map.set(targetKey(r.target), { ...r, key: targetKey(r.target) });
    byTarget = map;
    if (bad > 0) {
      try {
        save();
      } catch {
        /* the records are loaded; the bad lines just stay for now */
      }
    }
    return byTarget;
  };
  return {
    // An omitted rating or note keeps the stored value; only an explicit null rating or '' note clears it.
    set({ target, rating, note } = {}) {
      if (!target || typeof target.source !== 'string' || typeof target.session !== 'string') {
        throw badRequest('target needs a source and a session');
      }
      const map = load();
      const clean = { source: target.source, session: target.session, turn: target.turn, span: target.span };
      const key = targetKey(clean);
      const old = map.get(key);
      if (rating === undefined) rating = old ? old.rating : null;
      if (note === undefined) note = old ? old.note : '';
      if (rating !== null && rating !== 'good' && rating !== 'bad') throw badRequest('rating must be good, bad or null');
      if (typeof note !== 'string') throw badRequest('note must be text');
      if (note.length > MAX_NOTE) throw badRequest('note is too long');
      if (rating === null && !note.trim()) {
        if (old) {
          map.delete(key);
          try {
            save();
          } catch (e) {
            map.set(key, old);
            throw e;
          }
        }
        return null;
      }
      const now = Date.now();
      const rec = {
        id: old ? old.id : newId(),
        target: clean,
        key,
        rating,
        note,
        annotator: 'human',
        ts: old ? old.ts : now,
        updatedAt: now,
      };
      // New record appends; an update rewrites so the file keeps one line per target. Disk first, then memory.
      if (old) {
        map.set(key, rec);
        try {
          save();
        } catch (e) {
          map.set(key, old);
          throw e;
        }
      } else {
        io.append(rec);
        map.set(key, rec);
      }
      return rec;
    },
    get: (tk) => load().get(tk) || null,
    forSession: (source, session) => [...load().values()].filter((r) => inSession(r, source, session)),
    all: () => [...load().values()],
    stats: () => (load(), { bad }),
  };
}

module.exports = { createEvalStore, createFeedbackStore };
