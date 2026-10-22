// Auto-add: a failing judge verdict on a turn, or a 👎 on a turn, copies that turn into the dataset chosen in the
// settings (config.json under datasets.autoAdd), tagged `auto`. It runs beside judging and feedback, not inside them:
// a bounded queue, one turn at a time, so a slow trace read or a full dataset never holds them up, and nothing here
// throws back into them. With content viewing off it does nothing (R7): the copy is transcript text.
const R = require('../evals/registry');
const { sourceKey } = require('./shape');

const QUEUE_MAX = 200;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function createAutoAdd({ datasets, trace, settings, contentOff = false, log = () => {}, max = QUEUE_MAX }) {
  const queue = [];
  const queued = new Map(); // sourceKey -> queued item, so the same turn is copied once
  const counts = { added: 0, skipped: 0 };
  const logged = new Set();
  let busy = false;
  let pumping = null;

  // One line per reason: a missing dataset would otherwise log on every verdict.
  function logOnce(reason, message) {
    if (logged.has(reason)) return;
    logged.add(reason);
    try {
      log(message);
    } catch {
      /* a logger must not break auto-add */
    }
  }
  function config() {
    try {
      const c = settings();
      return isObject(c) ? c : {};
    } catch {
      return {};
    }
  }
  const on = (flag) => {
    if (contentOff) return false;
    const c = config();
    return c.enabled === true && c[flag] !== false && typeof c.dataset === 'string' && !!c.dataset;
  };

  function enqueue(target, { evaluator, label, feedback }) {
    const source = { source: target.source, session: target.session, turn: target.turn };
    const key = sourceKey(source);
    const known = queued.get(key);
    // A second reason for a turn already waiting is merged into it, not queued again.
    if (known) {
      if (evaluator) known.evals[evaluator] = label;
      if (feedback) known.feedback = feedback;
      return;
    }
    if (queue.length >= max) {
      counts.skipped++;
      logOnce('full', 'datasets: the auto-add queue is full, so some turns were not added');
      return;
    }
    const item = { key, ...source, evals: evaluator ? { [evaluator]: label } : {}, feedback: feedback || null };
    queue.push(item);
    queued.set(key, item);
    kick();
  }

  async function handle(item) {
    const c = config();
    if (contentOff || c.enabled !== true) return void counts.skipped++;
    const slug = c.dataset;
    try {
      if (!datasets.get(slug)) {
        counts.skipped++;
        logOnce('dataset', 'datasets: auto-add is on, but its dataset does not exist');
        return;
      }
      const source = { source: item.source, session: item.session, turn: item.turn };
      // Already saved: no need to read the turn's text again.
      if (datasets.hasSource(slug, source)) return void counts.skipped++;
      const ex = await trace.example(trace.keyFor(item.source, item.session), item.turn);
      if (!ex) return void counts.skipped++; // a source without text
      const raw = { ...ex, tags: ['auto'] };
      if (Object.keys(item.evals).length) raw.evals = item.evals;
      if (item.feedback) raw.feedback = item.feedback;
      const r = datasets.add(slug, [raw]);
      counts.added += r.added.length;
      counts.skipped += r.skipped.length;
      for (const s of r.skipped) {
        if (s.reason !== 'already in this dataset')
          logOnce(`skip:${s.reason}`, `datasets: auto-add skipped a turn: ${s.reason}`);
      }
    } catch (e) {
      counts.skipped++;
      const status = e && Number.isInteger(e.status) ? e.status : 'unknown';
      logOnce(`error:${status}`, `datasets: auto-add could not copy a turn (status ${status})`);
    }
  }

  // The pump starts on the next microtask, so the verdicts of one judging pass are merged first. `busy` is cleared
  // in the same synchronous step that sees the queue empty, so an item queued right after is never left waiting.
  // An item stays known until it is handled, so a reason arriving meanwhile does not queue the turn again.
  function kick() {
    if (busy) return;
    busy = true;
    pumping = Promise.resolve().then(async () => {
      try {
        while (queue.length) {
          const item = queue[0];
          await handle(item);
          queue.shift();
          queued.delete(item.key);
        }
      } finally {
        busy = false;
      }
    });
  }

  return {
    onResult(result) {
      if (!isObject(result) || !on('onFail')) return;
      const e = R.get(result.evaluator);
      const t = result.target;
      if (!e || e.kind !== 'judge' || e.scope !== 'turn' || !isObject(t) || !Number.isInteger(t.turn)) return;
      if (typeof result.label !== 'string' || result.label === e.pass) return;
      enqueue(t, { evaluator: e.id, label: result.label });
    },
    onFeedback(record) {
      if (!isObject(record) || record.rating !== 'bad' || !on('onBad')) return;
      const t = record.target;
      if (!isObject(t) || !Number.isInteger(t.turn)) return;
      enqueue(t, { feedback: 'bad' });
    },
    async drain() {
      while (busy) await pumping;
    },
    stats: () => ({ added: counts.added, skipped: counts.skipped, queued: queue.length }),
  };
}

module.exports = { createAutoAdd };
