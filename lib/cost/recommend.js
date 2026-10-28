// Cost Control, sub-project 4b: cheaper-model recommendations. Each names a model the owner pays for, a cheaper model
// that did about as well on the owner's own Datasets experiments (the same examples, scored by the same evaluators),
// and what switching would save a month at the last 30 days' use. The experiments are the only evidence. Nothing is
// switched: routing stays a manual gateway setting. Pure: no I/O and no clock (`now` is an argument).
const { normalizeModel } = require('../pricing');

const DAY_MS = 86400000;
const DEFAULTS = Object.freeze({
  maxDropPoints: 5, // the candidate's pass rate at most this many points below the current model's
  minRows: 20, // scored rows each model needs, over the evaluators both have
  maxCostRatio: 0.8, // the candidate's cost per example at most this share of the current model's
  maxAgeDays: 90, // experiments that ended longer ago do not count
  maxItems: 5,
  maxGaps: 3,
});
const EPS = 1e-9; // the edges (exactly 5 points, exactly 0.8) qualify despite floating point

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (typeof v === 'string' ? v : null);

// One counted experiment's models by normalized name: { requests, cost, evaluators: Map(id → { pass, total }) }. Two
// raw names that normalize to one are added together. Null for a record that does not count: not a finished run
// ('done'; a stopped or errored run is 'stopped'), ended over `maxAgeDays` ago, or with no usable summary.
function modelsOf(x, { now, maxAgeDays }) {
  if (!Number.isFinite(now) || !isObject(x) || x.status !== 'done' || !Number.isFinite(x.endedAt)) return null;
  if (now - x.endedAt > maxAgeDays * DAY_MS) return null;
  const models = isObject(x.summary) && isObject(x.summary.models) ? x.summary.models : null;
  if (!models) return null;
  const out = new Map();
  for (const [name, m] of Object.entries(models)) {
    const model = normalizeModel(name);
    if (!model || !isObject(m) || !isObject(m.evaluators)) continue;
    if (!out.has(model)) out.set(model, { requests: 0, cost: 0, evaluators: new Map() });
    const o = out.get(model);
    o.requests += num(m.requests);
    o.cost += num(m.cost);
    for (const [id, e] of Object.entries(m.evaluators)) {
      if (!isObject(e) || !Number.isFinite(e.pass) || !Number.isFinite(e.total)) continue;
      const v = o.evaluators.get(id) || { pass: 0, total: 0 };
      v.pass += e.pass;
      v.total += e.total;
      o.evaluators.set(id, v);
    }
  }
  return out.size ? out : null;
}

// Two models of one experiment over the evaluators both have: each one's pass rate and rows (the summed totals). Null
// without a common evaluator or a row.
function compare(a, b) {
  let passA = 0;
  let passB = 0;
  let rowsA = 0;
  let rowsB = 0;
  for (const [id, ea] of a.evaluators) {
    const eb = b.evaluators.get(id);
    if (!eb) continue;
    passA += ea.pass;
    rowsA += ea.total;
    passB += eb.pass;
    rowsB += eb.total;
  }
  if (!(rowsA > 0) || !(rowsB > 0)) return null;
  return { rateA: passA / rowsA, rateB: passB / rowsB, rowsA, rowsB };
}

/**
 * The ledger rows of a window as `spend` for recommend(): usage value (list) per normalized model, plan rows left out,
 * and `onPlan`, the models with usage on a day their source was on a plan (a switch there saves usage value, not money
 * paid). Rows are the cost object's budgetRows (plan rows included).
 */
function spendByModel(rows) {
  const planDays = new Set();
  const list = Array.isArray(rows) ? rows : [];
  for (const r of list) if (r && r.kind === 'plan') planDays.add(`${r.source}|${r.day}`);
  const spend = new Map();
  const onPlan = new Set();
  for (const r of list) {
    if (!r || r.kind === 'plan') continue;
    const model = normalizeModel(r.model);
    if (!model) continue;
    spend.set(model, (spend.get(model) || 0) + num(r.listUSD));
    if (num(r.listUSD) > 0 && planDays.has(`${r.source}|${r.day}`)) onPlan.add(model);
  }
  return {
    spend: Object.fromEntries([...spend].map(([m, v]) => [m, round8(v)])),
    onPlan: [...onPlan].sort(cmp),
  };
}

/**
 * Cheaper models backed by the experiments. `experiments` is the experiment store's list (lib/datasets/experiments.js),
 * `spend` { model: listUSD } over [from, to] (spendByModel), `onPlan` the models that ran under a plan there.
 * Returns { items: [Rec], gaps: [Gap], basis: { experiments, from, to } }, where `basis.experiments` counts the
 * experiments that counted.
 */
function recommend({ experiments = [], spend = {}, onPlan = [], from = null, to = null, now, limits = {} } = {}) {
  const L = { ...DEFAULTS };
  if (isObject(limits)) for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(limits[k])) L[k] = limits[k];
  const spent = new Map();
  for (const [name, v] of Object.entries(isObject(spend) ? spend : {})) {
    const model = normalizeModel(name);
    if (model) spent.set(model, (spent.get(model) || 0) + num(v));
  }
  const plan = new Set((Array.isArray(onPlan) ? onPlan : []).map(normalizeModel));
  const spendOf = (m) => spent.get(m) || 0;

  const pairs = new Map(); // current model → its qualifying pairs
  const compared = new Set(); // models that met another model with enough rows in a counted experiment
  let counted = 0;
  for (const x of Array.isArray(experiments) ? experiments : []) {
    const models = modelsOf(x, { now, maxAgeDays: L.maxAgeDays });
    if (!models) continue;
    counted++;
    for (const [A, a] of models) {
      if (!(spendOf(A) > 0) || !(a.requests > 0)) continue;
      const costA = a.cost / a.requests;
      for (const [B, b] of models) {
        if (B === A || !(b.requests > 0)) continue;
        const c = compare(a, b);
        if (!c || c.rowsA < L.minRows || c.rowsB < L.minRows) continue;
        compared.add(A);
        if (!(costA > 0)) continue; // a model that cost nothing here has nothing to save on
        const costB = Math.max(0, b.cost / b.requests);
        const ratio = costB / costA;
        if (ratio > L.maxCostRatio + EPS) continue;
        if (c.rateB < c.rateA - L.maxDropPoints / 100 - EPS) continue;
        if (!pairs.has(A)) pairs.set(A, []);
        pairs.get(A).push({ B, costB, ratio, c, x });
      }
    }
  }

  // Per current model: the largest saving first (the same spend, so the lowest cost ratio), then the best pass rate,
  // then the newest experiment; the rest back it.
  const recs = [];
  for (const [A, list] of pairs) {
    list.sort(
      (p, q) =>
        round8(p.ratio) - round8(q.ratio) ||
        q.c.rateB - p.c.rateB ||
        q.x.endedAt - p.x.endedAt ||
        cmp(p.B, q.B) ||
        cmp(p.x.id, q.x.id),
    );
    const best = list[0];
    const s = spendOf(A);
    recs.push({
      model: A,
      candidate: best.B,
      local: best.costB === 0,
      spendUSD: round8(s),
      savingUSD: round8(s * (1 - best.ratio)),
      costRatio: round4(best.ratio),
      rateA: round4(best.c.rateA),
      rateB: round4(best.c.rateB),
      rowsA: best.c.rowsA,
      rowsB: best.c.rowsB,
      experiment: {
        id: text(best.x.id),
        dataset: text(best.x.dataset),
        datasetName: text(best.x.datasetName),
        endedAt: best.x.endedAt,
      },
      alsoBackedBy: list.length - 1,
      onPlan: plan.has(A),
    });
  }
  recs.sort((p, q) => q.savingUSD - p.savingUSD || cmp(p.model, q.model));

  // The models the owner pays for most that no experiment backs a switch for, whether or not they were recommended
  // past the cap.
  const gaps = [...spent]
    .filter(([m, s]) => s > 0 && !pairs.has(m))
    .sort((p, q) => q[1] - p[1] || cmp(p[0], q[0]))
    .slice(0, Math.max(0, L.maxGaps))
    .map(([model, s]) => ({
      model,
      spendUSD: round8(s),
      reason: compared.has(model) ? 'no_cheaper_match' : 'no_experiment',
    }));

  return { items: recs.slice(0, Math.max(0, L.maxItems)), gaps, basis: { experiments: counted, from, to } };
}

module.exports = { DEFAULTS, spendByModel, recommend };
