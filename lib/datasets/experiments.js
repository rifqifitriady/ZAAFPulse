// The experiment records (.data/experiments.jsonl, mode 0600): one line per finished run, newest last, at most `max`
// lines of at most `maxBytes` each. A record holds its masked, capped outputs (perExample); the list leaves them out.
// The file is parsed once per change: the list rows and each line's byte range are kept, so get() reads one line.
const fs = require('fs');
const { openJsonl } = require('../evals/store');
const { capField } = require('./shape');

const RECORD_BYTES = 2 * 1024 * 1024;
const TEXT_STEPS = [1000, 250, 0]; // shorter stored texts, tried in turn, for a record over the byte budget

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const shorten = (t, n) => (typeof t !== 'string' ? t : n > 0 ? capField(t, n) : null);
const withTexts = (row, n) => {
  if (!row || !row.output) return row;
  const { output } = row;
  const proposal = output.proposal ? { ...output.proposal, arguments: shorten(output.proposal.arguments, n) } : null;
  return { ...row, output: { ...output, text: shorten(output.text, n), proposal } };
};

// A record that fits the budget, unchanged when it already does. Otherwise the stored texts get shorter (head and
// tail), then go; as a last resort results are dropped from the end. The summary was computed before, so it stays.
function boundRecord(record, maxBytes = RECORD_BYTES) {
  if (bytes(record) <= maxBytes) return record;
  const per = Array.isArray(record.perExample) ? record.perExample : [];
  for (const n of TEXT_STEPS) {
    const next = { ...record, perExample: per.map((r) => withTexts(r, n)), trimmed: { textChars: n } };
    if (bytes(next) <= maxBytes) return next;
  }
  const bare = per.map((r) => withTexts(r, 0));
  const fit = (k) => ({
    ...record,
    perExample: bare.slice(0, k),
    trimmed: { textChars: 0, droppedResults: per.length - k },
  });
  let lo = 0;
  let hi = bare.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(fit(mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return fit(lo);
}

function createExperimentStore({ file, max = 100, maxBytes = RECORD_BYTES }) {
  const io = openJsonl(file);
  // { stamp, lines: [{ id, start, end, row }] (file order), torn }: rebuilt when the file changes, which includes
  // the CLI (zaafpulse eval --dataset) appending while the dashboard runs.
  let cache = null;

  const stampOf = () => {
    try {
      const st = fs.statSync(file);
      return `${st.size}|${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  const rowOf = (r) => {
    const { perExample, ...rest } = r;
    const per = Array.isArray(perExample) ? perExample : [];
    return { ...rest, examples: new Set(per.map((x) => x && x.exampleId).filter(Boolean)).size };
  };
  // Each whole line's byte range in `buf`, with its list row. A torn or bad line is skipped.
  function parseLines(buf) {
    const lines = [];
    for (let start = 0; start < buf.length;) {
      let end = buf.indexOf(10, start);
      if (end < 0) end = buf.length;
      try {
        const r = JSON.parse(buf.toString('utf8', start, end));
        if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string') {
          lines.push({ id: r.id, start, end, row: rowOf(r) });
        }
      } catch {
        /* a torn or bad line is skipped */
      }
      start = end + 1;
    }
    return lines;
  }
  function load() {
    const stamp = stampOf();
    if (cache && cache.stamp === stamp) return cache;
    let buf = Buffer.alloc(0);
    try {
      buf = fs.readFileSync(file);
    } catch {
      /* no file yet */
    }
    cache = { stamp, lines: parseLines(buf), torn: buf.length > 0 && buf[buf.length - 1] !== 10 };
    return cache;
  }

  return {
    // Returns the record as stored (bounded).
    append(record) {
      const stored = boundRecord(record, maxBytes);
      const c = load();
      // A run is written once and never edited, so the oldest records go first when there are more than `max`.
      if (c.lines.length + 1 > max) {
        // Ranges from this read only: another writer may have changed the file since the cached parse, and old
        // offsets into a new buffer would keep fragments of records.
        const buf = fs.readFileSync(file);
        const lines = parseLines(buf);
        const kept = lines
          .slice(Math.max(0, lines.length + 1 - max))
          .map((l) => buf.toString('utf8', l.start, l.end) + '\n')
          .join('');
        // Kept lines are copied as they are, not re-encoded.
        io.rewriteText(kept + JSON.stringify(stored) + '\n');
      } else {
        if (c.torn) io.read(); // lets the store start the new line on a line of its own
        io.append(stored);
      }
      cache = null;
      return stored;
    },
    // Newest first; copies, so a caller (the API applying content-off) cannot change the cache.
    list() {
      return structuredClone(
        load()
          .lines.map((l) => l.row)
          .reverse(),
      );
    },
    get(id) {
      if (typeof id !== 'string' || !id) return null;
      const c = load();
      // The newest line wins, should an id ever repeat.
      let hit = null;
      for (let i = c.lines.length - 1; i >= 0 && !hit; i--) if (c.lines[i].id === id) hit = c.lines[i];
      if (!hit) return null;
      try {
        const len = hit.end - hit.start;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, 'r');
        try {
          fs.readSync(fd, buf, 0, len, hit.start);
        } finally {
          fs.closeSync(fd);
        }
        const r = JSON.parse(buf.toString('utf8'));
        return r && r.id === id ? r : null; // a fresh parse: the caller's own copy
      } catch {
        return null; // the file changed under us; the next call reads it again
      }
    },
  };
}

module.exports = { createExperimentStore, boundRecord, RECORD_BYTES };
