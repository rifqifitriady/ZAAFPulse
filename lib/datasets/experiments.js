// The experiment records (.data/experiments.jsonl, mode 0600): one line per finished run, newest last, at most `max`
// lines. A record holds its masked, capped outputs (perExample); the list leaves them out.
const fs = require('fs');
const { openJsonl } = require('../evals/store');

function createExperimentStore({ file, max = 100 }) {
  const io = openJsonl(file);
  let cache = null; // { stamp, rows } for list(), until the next append or a change made by another process

  // The CLI (zaafpulse eval --dataset) appends to the same file while the dashboard may be running.
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

  return {
    append(record) {
      cache = null;
      // A run is written once and never edited, so the oldest records go first when there are more than `max`.
      const rows = io.read().rows;
      if (rows.length + 1 > max) io.rewrite([...rows.slice(Math.max(0, rows.length + 1 - max)), record]);
      else io.append(record);
    },
    // Newest first.
    list() {
      const stamp = stampOf();
      if (!cache || cache.stamp !== stamp) {
        const rows = io.read().rows.filter((r) => typeof r.id === 'string');
        cache = { stamp, rows: rows.map(rowOf).reverse() };
      }
      return cache.rows.slice();
    },
    get(id) {
      if (typeof id !== 'string' || !id) return null;
      const all = io.read().rows;
      // The newest line wins, should an id ever repeat.
      for (let i = all.length - 1; i >= 0; i--) if (all[i].id === id) return all[i];
      return null;
    },
  };
}

module.exports = { createExperimentStore };
