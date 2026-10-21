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

// Lines that do not parse (or are not objects) are skipped and counted, never fatal.
function readRows(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], bad: 0 };
  }
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
}

function appendRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

// A crash mid-write leaves the old file intact; renameSync also replaces an existing target on Windows.
function rewrite(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }
}

const inSession = (r, source, session) => !!r.target && r.target.source === source && r.target.session === session;

function createEvalStore({ file, maxBytes = 10e6 }) {
  let byKey = null; // resultKey -> latest result
  let lines = 0; // lines currently in the file
  let bad = 0;
  const load = () => {
    if (byKey) return byKey;
    byKey = new Map();
    const read = readRows(file);
    bad = read.bad;
    lines = read.rows.length;
    // Later lines win, so a re-judged target replaces its older result.
    for (const r of read.rows) if (r.key) byKey.set(r.key, r);
    return byKey;
  };
  const compact = () => {
    const map = load();
    rewrite(file, [...map.values()]);
    lines = map.size;
    bad = 0;
  };
  return {
    put(result) {
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
      appendRow(file, r);
      lines++;
      map.set(r.key, r);
      // Only compact when it can drop something, otherwise a file of unique keys would rewrite on every put.
      if (lines > map.size) {
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          /* just written */
        }
        if (size > maxBytes) compact();
      }
      return r;
    },
    get: (key) => load().get(key) || null,
    forTarget: (tk) => [...load().values()].filter((r) => targetKey(r.target) === tk),
    forSession: (source, session) => [...load().values()].filter((r) => inSession(r, source, session)),
    all: () => [...load().values()],
    compact,
    stats: () => (load(), { bad, lines, keys: byKey.size }),
  };
}

function createFeedbackStore({ file }) {
  let byTarget = null; // targetKey -> record
  let bad = 0;
  const load = () => {
    if (byTarget) return byTarget;
    byTarget = new Map();
    const read = readRows(file);
    bad = read.bad;
    for (const r of read.rows) if (r.target) byTarget.set(targetKey(r.target), { ...r, key: targetKey(r.target) });
    return byTarget;
  };
  const save = () => rewrite(file, [...byTarget.values()]);
  return {
    set({ target, rating = null, note = '' } = {}) {
      if (!target || typeof target.source !== 'string' || typeof target.session !== 'string') {
        throw badRequest('target needs a source and a session');
      }
      if (rating !== null && rating !== 'good' && rating !== 'bad') throw badRequest('rating must be good, bad or null');
      if (typeof note !== 'string') throw badRequest('note must be text');
      if (note.length > MAX_NOTE) throw badRequest('note is too long');
      const map = load();
      const clean = { source: target.source, session: target.session, turn: target.turn, span: target.span };
      const key = targetKey(clean);
      const old = map.get(key);
      if (rating === null && !note.trim()) {
        if (old) {
          map.delete(key);
          save();
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
      map.set(key, rec);
      // A new record appends; an update rewrites so the file keeps one line per target.
      if (old) save();
      else appendRow(file, rec);
      return rec;
    },
    get: (tk) => load().get(tk) || null,
    forSession: (source, session) => [...load().values()].filter((r) => inSession(r, source, session)),
    all: () => [...load().values()],
    stats: () => (load(), { bad }),
  };
}

module.exports = { createEvalStore, createFeedbackStore };
