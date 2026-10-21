// Helpers the light sources (Kiro, Gemini CLI, Antigravity) share. Their folders are small, so they list
// their own files instead of going through the indexer; the listing is cached briefly and capped.
const fs = require('fs');
const path = require('path');
const { commandName, maskTitle } = require('./model');

const TTL = 30000;
const MIN_REFRESH = 5000;
const LIMIT = 500;
const MAX_FILE = 50 * 1024 * 1024; // a session file larger than this is skipped, not loaded

// A time as epoch ms, or null (never NaN). Numbers under 1e11 are seconds.
function timeOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return timeOf(Number(s));
  let t = Date.parse(s);
  if (!Number.isFinite(t)) {
    // "2026-10-19 10:00:00.123456789 +0000 UTC": the shape a Go program writes a time in
    const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?\s*(Z|[+-]\d\d:?\d\d)?/.exec(s);
    if (m) {
      const zone = m[4] ? (m[4] === 'Z' || m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`) : 'Z';
      t = Date.parse(`${m[1]}T${m[2]}.${((m[3] || '0') + '000').slice(0, 3)}${zone}`);
    }
  }
  return Number.isFinite(t) ? t : null;
}

const maxTs = (a, b) => (Number.isFinite(a) ? (Number.isFinite(b) ? Math.max(a, b) : a) : Number.isFinite(b) ? b : null);
const minTs = (a, b) => (Number.isFinite(a) ? (Number.isFinite(b) ? Math.min(a, b) : a) : Number.isFinite(b) ? b : null);

// The listing is built once per `ttl`. `force` (a skeleton asked for an id the cache lacks) rebuilds it, but
// never more than once per `minRefresh`, so a stream of unknown ids cannot make every call a full scan.
function cache(build, { ttl = TTL, minRefresh = MIN_REFRESH } = {}) {
  let at = 0;
  let value = null;
  return (force) => {
    const now = Date.now();
    const stale = !value || now - at >= ttl || now < at;
    if (stale || (force && now - at >= minRefresh)) {
      value = build();
      at = now;
    }
    return value;
  };
}

// The newest `LIMIT` of { file, mtime, size } candidates, files over MAX_FILE dropped. Only a stat is spent
// on the rest, so a folder of thousands of sessions is not parsed in full to show 500 of them.
function newestFiles(files) {
  const out = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size <= MAX_FILE) out.push({ file, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* gone since it was listed */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? 1 : -1)).slice(0, LIMIT);
}

// Newest first, then the cap.
const newest = (rows) => rows.sort((a, b) => (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0)).slice(0, LIMIT);

const unknown = () => Object.assign(new Error('unknown session'), { status: 404 });

// The turn a caller asked for: an integer within range, else the last. -1 when there are no turns.
const turnIndex = (turn, n) => (n ? (Number.isInteger(turn) ? Math.max(0, Math.min(n - 1, turn)) : n - 1) : -1);

// A count from a log: a finite number above zero, else 0.
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

// The id a session is shown under: its own when it has one and no other session took it, else a stable
// hash of the file (ids are opaque and must be unique; nothing here is a path).
function uniqueId(taken, wanted, spanId, file) {
  const base = typeof wanted === 'string' && wanted.trim() ? wanted.trim().slice(0, 80) : spanId(file);
  const id = taken.has(base) ? spanId(file) : base;
  taken.add(id);
  return id;
}

// A file resolves inside the root, so a link planted in a session folder cannot point the reader elsewhere.
function inside(realRoot, file) {
  try {
    const rel = path.relative(realRoot, fs.realpathSync(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// Reads a file in chunks, yielding each line. Meant for small files; one line over `maxLine` is skipped.
function* linesSync(file, { chunk = 1 << 16, maxLine = 1 << 22 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunk);
    let pending = [];
    let len = 0;
    let skipping = false;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, null);
      if (!n) break;
      const view = buf.subarray(0, n);
      let from = 0;
      for (let i = view.indexOf(10); i !== -1; i = view.indexOf(10, i + 1)) {
        if (!skipping) {
          pending.push(Buffer.from(view.subarray(from, i)));
          len += i - from;
          if (len <= maxLine) yield Buffer.concat(pending, len).toString('utf8').replace(/\r$/, '');
        }
        pending = [];
        len = 0;
        skipping = false;
        from = i + 1;
      }
      if (from < n && !skipping) {
        pending.push(Buffer.from(view.subarray(from, n)));
        len += n - from;
        if (len > maxLine) {
          skipping = true;
          pending = [];
          len = 0;
        }
      }
    }
    if (len && !skipping) yield Buffer.concat(pending, len).toString('utf8').replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

// A short label for what a tool touches: a file name or the program a command runs, never more.
function targetOf(args) {
  let a = args;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  if (!a || typeof a !== 'object') return null;
  const file = a.path || a.file_path || a.filePath || a.absolute_path || a.target_file;
  if (typeof file === 'string' && file) return path.basename(file.replace(/\\/g, '/')).slice(0, 80) || null;
  return commandName(Array.isArray(a.command) ? a.command[0] : a.command || a.cmd);
}

// A folder name for a path from any platform.
const baseName = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop().slice(0, 80) || null : null);

module.exports = {
  TTL,
  LIMIT,
  MAX_FILE,
  maskTitle,
  timeOf,
  maxTs,
  minTs,
  cache,
  newestFiles,
  newest,
  unknown,
  turnIndex,
  count,
  uniqueId,
  inside,
  linesSync,
  targetOf,
  baseName,
};
