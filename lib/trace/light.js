// Helpers the light sources (Kiro, Gemini CLI, Antigravity) share. Their folders are small, so they list
// their own files instead of going through the indexer; the listing is cached briefly and capped.
const fs = require('fs');
const path = require('path');
const sig = require('../signals');

const TTL = 30000;
const LIMIT = 500;
const MAX_TITLE = 80;

// A title is text, so it is masked with the same patterns as span text, folded to one line and cut.
function maskTitle(text) {
  if (typeof text !== 'string' || !text) return null;
  let out = '';
  let last = 0;
  for (const sp of sig.secretSpans(text)) {
    out += text.slice(last, sp.start) + `\u2039${sp.label} hidden\u203a`;
    last = sp.end;
  }
  out = (out + text.slice(last)).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1); // do not end on half a surrogate pair
  return out.trim() || null;
}

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

// The listing is built once per `ttl`; `force` rebuilds it (a skeleton asked for an id the cache lacks).
function cache(build, ttl = TTL) {
  let at = 0;
  let value = null;
  return (force) => {
    const now = Date.now();
    if (force || !value || now - at >= ttl || now < at) {
      value = build();
      at = now;
    }
    return value;
  };
}

// Newest first, then the cap.
const newest = (rows) => rows.sort((a, b) => (b.end ?? b.start ?? 0) - (a.end ?? a.start ?? 0)).slice(0, LIMIT);

const unknown = () => Object.assign(new Error('unknown session'), { status: 404 });

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

// A short label for what a tool touches: a file name or a command's first word, never more.
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
  const cmd = Array.isArray(a.command) ? a.command[0] : a.command || a.cmd;
  return typeof cmd === 'string' ? cmd.trim().split(/\s+/)[0].slice(0, 80) || null : null;
}

// A folder name for a path from any platform.
const baseName = (p) => (typeof p === 'string' && p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop().slice(0, 80) || null : null);

module.exports = {
  targetOf,
  baseName, TTL, LIMIT, maskTitle, timeOf, maxTs, minTs, cache, newest, unknown, uniqueId, inside, linesSync };
