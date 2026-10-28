// Cost Control, sub-project 4a: cost anomalies. A day's usage value (list, plan fees left out: a fee is not usage)
// against what the same weekday usually costs (lib/cost/forecast.js), and the model, project, cost center and key that
// rose the most. Pure: no I/O and no clock. The Monitors rule `cost_anomaly` (lib/monitors/rules.js) and the Overview's
// Anomalies card and spike line (lib/cost/views.js) read the same figures, from recentDays().
const F = require('./forecast');
const { addDays, monthOf } = require('./days');

const RATIO = 2; // the rule's defaults: a day over twice its usual amount...
const MIN_USD = 1; // ...and at least $1 over it, so a quiet week does not make every small day an anomaly
const HISTORY_DAYS = 29; // the 4 weeks before yesterday, and yesterday: what today and yesterday are measured against
const DIMS = ['model', 'project', 'center', 'keyId'];
const TOP = 3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const usage = (rows) => (rows || []).filter((r) => r && r.kind !== 'plan');
// A row's value on a dimension: a center the rules did not set is Unassigned; a row with no model, project or key
// (a gateway call has no project, a local one no key) is not a value of that dimension.
const valueOf = (r, dim) => (dim === 'center' ? r.center || 'unassigned' : r[dim] == null ? null : String(r[dim]));

// The rule's parameters as the figures use them: a value that is not a positive number takes the default.
function anomalyParams(p) {
  const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return { ratio: pos(p && p.ratio, RATIO), minUSD: pos(p && p.minUSD, MIN_USD) };
}

/**
 * One day against its model: { day, partial, spentUSD, expectedUSD, drivers: [{ dim, value, extraUSD, share }] }, or
 * null without a model (no_data). `rows` are ledger rows (only `day`'s usage rows count); `history` the usage rows the
 * model was built from. `partial` (today): the spend so far against a whole expected day.
 * A driver is a value whose spend on `day` passed its own mean over the model's known days of the same weekday (all of
 * its known days under the plain mean, or when that weekday has none, as the model does); 0 for a value not seen then.
 * The top 3 across the four dimensions by `extraUSD`, ties by dimension order and then value; none when the day is not
 * over its expected amount. `share` is extraUSD / (spentUSD − expectedUSD), at most 1.
 */
function measureDay(rows, { model, day, partial = false, history = [] } = {}) {
  if (!model) return null;
  const w = F.weekday(day);
  const expected = num(model.byWeekday[w]);
  const own = usage(rows).filter((r) => r.day === day);
  const spent = own.reduce((a, r) => a + num(r.listUSD), 0);
  const over = spent - expected;
  let drivers = [];
  if (over > 0) {
    const known = Array.isArray(model.days) ? model.days : [];
    const same = model.method === 'weekday' ? known.filter((d) => F.weekday(d) === w) : [];
    const base = new Set(same.length ? same : known);
    const past = usage(history).filter((r) => base.has(r.day));
    const found = [];
    for (const dim of DIMS) {
      const now = new Map();
      const before = new Map();
      for (const r of own) {
        const v = valueOf(r, dim);
        if (v !== null) now.set(v, (now.get(v) || 0) + num(r.listUSD));
      }
      for (const r of past) {
        const v = valueOf(r, dim);
        if (v !== null && now.has(v)) before.set(v, (before.get(v) || 0) + num(r.listUSD));
      }
      for (const [value, spend] of now) {
        const extra = spend - (base.size ? (before.get(value) || 0) / base.size : 0);
        if (round8(extra) > 0)
          found.push({ dim, value, extraUSD: round8(extra), share: Math.round(Math.min(1, extra / over) * 1e4) / 1e4 });
      }
    }
    found.sort((a, b) => b.extraUSD - a.extraUSD || DIMS.indexOf(a.dim) - DIMS.indexOf(b.dim) || cmp(a.value, b.value));
    drivers = found.slice(0, TOP);
  }
  return { day, partial: !!partial, spentUSD: round8(spent), expectedUSD: round8(expected), drivers };
}

// Over `ratio` times its expected amount and at least `minUSD` over it. A day expected to cost nothing is an anomaly
// once it spends `minUSD`.
function isAnomaly(m, params) {
  if (!m) return false;
  const { ratio, minUSD } = anomalyParams(params);
  const spent = num(m.spentUSD);
  const expected = num(m.expectedUSD);
  if (!(expected > 0)) return spent >= minUSD;
  return spent > round8(ratio * expected) && round8(spent - expected) >= minUSD;
}

/**
 * Today so far and the whole of yesterday, each against the model of the 4 weeks before it (so a day never raises its
 * own expectation): { today, yesterday }, each a measureDay result or null. `rows` are the ledger rows of
 * [today − 29, today] (plan rows are left out here), `unread` what that read skipped: a day of a month that did not
 * read is null.
 */
function recentDays(rows, { today, unread = [] } = {}) {
  const use = usage(rows);
  const series = use.map((r) => ({ day: r.day, usd: num(r.listUSD) }));
  const skip = new Set(unread || []);
  const one = (day, partial) => {
    if (skip.has(monthOf(day))) return null;
    const model = F.dailyModel(series, { today: day, unread });
    return measureDay(use, { model, day, partial, history: use });
  };
  return { today: one(today, true), yesterday: one(addDays(today, -1), false) };
}

module.exports = { RATIO, MIN_USD, HISTORY_DAYS, DIMS, anomalyParams, measureDay, isAnomaly, recentDays };
