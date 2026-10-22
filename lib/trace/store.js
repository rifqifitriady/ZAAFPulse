// Append-only trace storage, after Jaeger's Badger and memory backends: one NDJSON segment per UTC day, a trace
// index in memory (each trace's summary and the byte range it covers in each segment), and a snapshot of that
// index so a restart reads only what was appended since. Retention deletes whole segments, oldest first, never
// today's. Only the server process writes here.
const fs = require('fs');
const path = require('path');
const { blankSummary, addSpan } = require('./summary');

const SNAPSHOT = 'index.json';
const SNAPSHOT_VERSION = 1;
const SEGMENT = /^\d{4}-\d{2}-\d{2}\.ndjson$/;
const DAY_MS = 86400000;

function createTraceStore({ dir, retentionDays = 14, maxBytes = 500 * 1024 * 1024, now = Date.now }) {
  let traces = new Map(); // traceId -> summary with ref { segment: [start, end] }
  let offsets = {}; // segment -> bytes already indexed
  const runs = new Map(); // run id -> trace id
  let skipped = 0;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir sets the mode only when it creates the folder; an existing one (from an older version or another umask)
  // would keep a looser mode. chmod can fail on some file systems, so it is best effort.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* keep the mode the folder already has */
  }

  const segmentFor = (ms) => `${new Date(ms).toISOString().slice(0, 10)}.ndjson`;
  const segments = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => SEGMENT.test(f))
        .sort();
    } catch {
      return [];
    }
  };
  const sizeOf = (seg) => {
    try {
      return fs.statSync(path.join(dir, seg)).size;
    } catch {
      return 0;
    }
  };

  function index(span, segment, start, end) {
    let sum = traces.get(span.t);
    if (!sum) {
      sum = { ...blankSummary(span.t), ref: {} };
      traces.set(span.t, sum);
    }
    addSpan(sum, span);
    if (sum.runId) runs.set(sum.runId, sum.traceId);
    const r = sum.ref[segment];
    sum.ref[segment] = r ? [Math.min(r[0], start), Math.max(r[1], end)] : [start, end];
  }

  // Index the complete lines appended to a segment since `from`; returns the new offset. A last line without
  // its newline is left for later (it may still be in the middle of being written).
  function scan(segment, from) {
    const size = sizeOf(segment);
    if (size <= from) return from;
    const fd = fs.openSync(path.join(dir, segment), 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        try {
          const sp = JSON.parse(buf.toString('utf8', pos, nl));
          if (sp && typeof sp.t === 'string' && typeof sp.s === 'string') index(sp, segment, from + pos, from + nl + 1);
          else if (nl > pos) skipped++;
        } catch {
          skipped++;
        }
        pos = nl + 1;
      }
      return from + pos;
    } finally {
      fs.closeSync(fd);
    }
  }

  function forget(segment) {
    delete offsets[segment];
    for (const [id, sum] of traces) {
      if (!sum.ref[segment]) continue;
      delete sum.ref[segment];
      if (Object.keys(sum.ref).length) continue;
      traces.delete(id);
      if (sum.runId && runs.get(sum.runId) === id) runs.delete(sum.runId);
    }
  }

  function catchUp() {
    const present = new Set(segments());
    for (const seg of Object.keys(offsets)) if (!present.has(seg)) forget(seg);
    for (const seg of present) offsets[seg] = scan(seg, offsets[seg] || 0);
  }

  // A line cut short by a crash is closed, so the next append does not join it.
  function repairTails() {
    for (const seg of segments())
      if ((offsets[seg] || 0) < sizeOf(seg)) {
        fs.appendFileSync(path.join(dir, seg), '\n');
        offsets[seg] = scan(seg, offsets[seg] || 0);
      }
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT), 'utf8'));
      if (j.version !== SNAPSHOT_VERSION) return;
      traces = new Map(j.traces.map((s) => [s.traceId, s]));
      offsets = j.offsets || {};
      for (const s of traces.values()) if (s.runId) runs.set(s.runId, s.traceId);
    } catch {
      /* no snapshot yet: catchUp reads every segment */
    }
  }

  function snapshot() {
    const tmp = path.join(dir, `${SNAPSHOT}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ version: SNAPSHOT_VERSION, offsets, traces: [...traces.values()] }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, path.join(dir, SNAPSHOT));
  }

  function writeSpans(spans) {
    if (!spans.length) return 0;
    const seg = segmentFor(now());
    fs.appendFileSync(path.join(dir, seg), spans.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
    offsets[seg] = scan(seg, offsets[seg] || 0);
    return spans.length;
  }

  function getSpans(traceId) {
    const sum = traces.get(traceId);
    if (!sum) return null;
    const out = [];
    for (const [seg, [start, end]] of Object.entries(sum.ref)) {
      let fd;
      try {
        fd = fs.openSync(path.join(dir, seg), 'r');
      } catch {
        continue;
      }
      try {
        const buf = Buffer.alloc(end - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes(traceId)) continue;
          try {
            const sp = JSON.parse(line);
            if (sp.t === traceId) out.push(sp);
          } catch {
            /* counted when indexed */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    return out;
  }

  // The time the store covers, so the gateway adapter can tell which older request rows it already holds.
  // Only our own traces count, and only with believable times: a skewed or hostile remote clock must not stretch
  // the window and hide usage-log requests that were never stored. Summary times are microseconds.
  function covered() {
    const lo = (now() - (retentionDays + 1) * DAY_MS) * 1000;
    const hi = (now() + 3600000) * 1000;
    let from = Infinity;
    let to = -Infinity;
    for (const s of traces.values()) {
      if (s.src !== 'gateway' || s.start < lo || s.end > hi) continue;
      if (s.start < from) from = s.start;
      if (s.end > to) to = s.end;
    }
    return Number.isFinite(from) ? { from, to } : null;
  }

  function applyRetention() {
    const today = segmentFor(now());
    const cutoff = segmentFor(now() - retentionDays * DAY_MS);
    const list = segments();
    let total = list.reduce((n, s) => n + sizeOf(s), 0);
    const deleted = [];
    for (const seg of list) {
      if (seg === today) break;
      if (seg >= cutoff && total <= maxBytes) break;
      total -= sizeOf(seg);
      fs.unlinkSync(path.join(dir, seg));
      forget(seg);
      deleted.push(seg);
    }
    if (deleted.length) snapshot();
    return { deleted };
  }

  load();
  catchUp();
  repairTails();

  return {
    writeSpans,
    getSpans,
    getSummary: (traceId) => traces.get(traceId) || null,
    summaries: () => [...traces.values()],
    byRun: (runId) => (runs.has(runId) ? traces.get(runs.get(runId)) || null : null),
    covered,
    snapshot,
    applyRetention,
    stats: () => {
      const list = segments();
      return { traces: traces.size, segments: list.length, bytes: list.reduce((n, s) => n + sizeOf(s), 0), skipped };
    },
  };
}

module.exports = { createTraceStore };
