// Cost Control, sub-project 3a: what the Cost Control pages draw, computed from ledger rows. Pure: no I/O and no clock
// (`today` is an argument), so the browser only draws. One function per page: overview (the current month), breakdown
// (where the money went in a range) and value (what the money bought). Served by GET /api/cost/view (lib/cost/api.js).
//
// Amounts are summed in USD, converted per day with `rateOf(day)` (the display currency's rate, or null for USD) and
// rounded once, at the end. A day with no rate is counted in USD and named in `missingRate`, as the ledger answer does.
const { addDays, daysBetween, daysInMonth } = require('./days');

const SPIKE_RATIO = 2; // a day over twice its baseline...
const SPIKE_MIN_USD = 1; // ...and at least $1 over it, so a quiet week does not make every small day a spike
const BASELINE_DAYS = 7;
const BASELINE_MIN = 3; // known days a baseline needs
const BAND_MIN_DAYS = 3; // fewer elapsed days than this: a forecast line only, no band
const RINGS = 8;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const fieldOf = (measure) => (measure === 'billed' ? 'billedUSD' : 'listUSD');
// A plan row is what was paid for a plan: no usage value, so it counts only for "Paid".
const counted = (r, measure) => !!r && (measure === 'billed' || r.kind !== 'plan');

// USD → the chosen currency, per day. `missing()` lists the days that had no rate (counted in USD).
function converter(rateOf) {
  const missing = new Set();
  return {
    // `note` false: the amount is not part of the chosen measure, so a missing rate is not reported for it. A day
    // without spend is not reported either (nothing to convert), as the ledger answer does.
    conv(day, usd, note = true) {
      if (!rateOf) return usd;
      const rate = rateOf(day);
      if (rate == null) {
        if (note && usd !== 0) missing.add(day);
        return usd;
      }
      return usd * rate;
    },
    missing: () => [...missing].sort(),
  };
}

// The q-quantile with linear interpolation between the two nearest values (the spreadsheet PERCENTILE).
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// Sums a measure per day in USD: Map(day -> USD).
function dailyUSD(rows, measure) {
  const out = new Map();
  for (const r of rows || []) {
    if (!counted(r, measure)) continue;
    out.set(r.day, (out.get(r.day) || 0) + num(r[fieldOf(measure)]));
  }
  return out;
}

// The model that spent most per day on a measure (plan rows have no model): Map(day -> model).
function topModels(rows, measure) {
  const per = new Map();
  for (const r of rows || []) {
    if (!counted(r, measure) || !r.model) continue;
    if (!per.has(r.day)) per.set(r.day, new Map());
    const m = per.get(r.day);
    m.set(r.model, (m.get(r.model) || 0) + num(r[fieldOf(measure)]));
  }
  const out = new Map();
  for (const [day, m] of per) {
    let best = null;
    for (const [model, v] of m) if (v > 0 && (!best || v > best[1])) best = [model, v];
    if (best) out.set(day, best[0]);
  }
  return out;
}

// Budgets riskiest first: used up, then projected over, then by percent; without data last.
// Plain code-unit order, so the tie-break does not depend on the machine's locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RANK = (b) => (b.state === 'exceeded' ? 0 : b.projected ? 1 : b.state === 'no_data' ? 3 : 2);
function budgetOrder(views) {
  return [...(views || [])].sort(
    (a, b) => RANK(a) - RANK(b) || num(b.percent) - num(a.percent) || cmp(String(a.name), String(b.name)),
  );
}
const toneOf = (state) =>
  state === 'exceeded' ? 'exceeded' : state === 'no_data' ? 'none' : /^warn_/.test(String(state)) ? 'warn' : 'ok';
const atRisk = (b) => b.state === 'exceeded' || b.projected === true || /^warn_/.test(String(b.state));

// A global monthly budget's amount in the chosen currency: its own, or converted at the display currency's latest
// rate (`display`: { code, rate }). null when it cannot be converted (the line is skipped).
function lineAmount(b, currency, display) {
  if (b.currency === currency) return num(b.amount);
  const rate = display && display.rate;
  if (!rate) return null;
  if (currency === 'USD' && b.currency === display.code) return num(b.amount) / rate;
  if (currency === display.code && b.currency === 'USD') return num(b.amount) * rate;
  return null;
}

/**
 * The current month, day 1 to today. `rows` are the month's ledger rows as billed (cost.budgetRows), `before` the
 * rows of the 7 days before the 1st (the spike baseline), `budgets` the evaluated budgets, `currency` the chosen code
 * and `display` the display currency with its latest rate ({ code, rate } or null) for the budget lines.
 */
function overview({
  rows = [],
  before = [],
  today,
  budgets = [],
  rateOf = null,
  measure = 'list',
  currency = 'USD',
  display = null,
}) {
  const c = converter(rateOf);
  const from = `${today.slice(0, 8)}01`;
  const days = daysInMonth(today);
  const last = `${today.slice(0, 8)}${String(days).padStart(2, '0')}`;
  const month = daysBetween(from, today);
  const elapsed = month.length;
  const remaining = days - elapsed;
  const inMonth = (rows || []).filter((r) => r && r.day >= from && r.day <= today);
  const usd = dailyUSD(inMonth, measure);
  // The chosen measure's month total is the daily series' own running sum (below); only the other measure is summed here.
  const other = measure === 'billed' ? 'list' : 'billed';
  let otherSum = 0;
  for (const [day, v] of [...dailyUSD(inMonth, other)].sort((a, b) => cmp(a[0], b[0])))
    otherSum += c.conv(day, v, false);

  let cum = 0;
  const daily = month.map((day) => {
    const spend = c.conv(day, usd.get(day) || 0);
    cum += spend;
    return { day, spend, cum };
  });
  // Forecast at the mean daily spend of the elapsed days (today a whole day); the band from the 25th and 75th
  // percentile of those days, each times the days left.
  const spent = measure === 'billed' ? { list: otherSum, billed: cum } : { list: cum, billed: otherSum };
  const perDay = elapsed ? cum / elapsed : 0;
  const sorted = daily.map((d) => d.spend).sort((a, b) => a - b);
  const early = elapsed < BAND_MIN_DAYS;
  const p25 = early ? null : quantile(sorted, 0.25);
  const p75 = early ? null : quantile(sorted, 0.75);
  const line = [];
  for (let k = 0; k <= remaining; k++)
    line.push({
      day: addDays(today, k),
      cum: round(cum + perDay * k),
      low: early ? null : round(cum + p25 * k),
      high: early ? null : round(cum + p75 * k),
    });

  // Spikes: each day against the mean of the known days among the 7 before it, in USD (the $1 floor is in USD). A day
  // before the ledger's first row is unknown, not zero; with fewer than 3 known days there is no baseline, so a young
  // ledger does not mark its first days as spikes.
  // Usage rows only: a plan fee is not usage, so it never makes a spike or lifts a baseline.
  const known = [...(before || []), ...inMonth].filter((r) => r && r.kind !== 'plan');
  const firstDay = known.reduce((a, r) => (!a || r.day < a ? r.day : a), null);
  const allUSD = dailyUSD(known, measure);
  const top = topModels(inMonth, measure);
  const spikes = month.map((day) => {
    let sum = 0;
    let n = 0;
    for (let k = 1; k <= BASELINE_DAYS; k++) {
      const d = addDays(day, -k);
      if (!firstDay || d < firstDay) continue;
      sum += allUSD.get(d) || 0;
      n++;
    }
    const base = n >= BASELINE_MIN ? sum / n : null;
    const v = allUSD.get(day) || 0;
    return {
      day,
      spend: round(c.conv(day, v)),
      baseline: base == null ? null : round(c.conv(day, base)),
      spike: base != null && v > SPIKE_RATIO * base && v - base >= SPIKE_MIN_USD,
      topModel: top.get(day) || null,
    };
  });

  const monthly = (budgets || []).filter((b) => b && b.scope === 'global' && b.period === 'month');
  const budgetLines = [];
  for (const b of monthly) {
    const amount = lineAmount(b, currency, display);
    if (amount != null) budgetLines.push({ id: b.id, name: b.name, amount: round(amount) });
  }
  const ordered = budgetOrder(budgets);
  const centers = new Map();
  for (const r of inMonth) {
    if (!counted(r, measure) || r.kind === 'plan') continue;
    const k = r.center || 'unassigned';
    centers.set(k, (centers.get(k) || 0) + c.conv(r.day, num(r[fieldOf(measure)])));
  }
  let topCenter = null;
  for (const [center, v] of centers) if (v > 0 && (!topCenter || v > topCenter.spend)) topCenter = { center, spend: v };
  const total = cum;

  return {
    month: { from, to: last, today, day: elapsed, days },
    spent: { list: round(spent.list), billed: round(spent.billed) },
    total: round(total),
    daily: daily.map((d) => ({ day: d.day, spend: round(d.spend), cum: round(d.cum) })),
    forecast: {
      perDay: round(perDay),
      projected: round(cum + perDay * remaining),
      low: early ? null : round(cum + p25 * remaining),
      high: early ? null : round(cum + p75 * remaining),
      early,
      line,
    },
    budgetLines,
    budgetsSkipped: monthly.length - budgetLines.length,
    spikes,
    rings: ordered.slice(0, RINGS).map((b) => ({
      id: b.id,
      name: b.name,
      state: b.state,
      tone: toneOf(b.state),
      percent: b.percent == null ? null : b.percent,
      projected: b.projected === true,
    })),
    moreBudgets: Math.max(0, ordered.length - RINGS),
    atRisk: { count: (budgets || []).filter(atRisk).length, total: (budgets || []).length },
    topCenter: topCenter && {
      ...topCenter,
      spend: round(topCenter.spend),
      share: total > 0 ? round(topCenter.spend / total) : null,
    },
    missingRate: c.missing(),
  };
}

module.exports = { SPIKE_RATIO, SPIKE_MIN_USD, BASELINE_MIN, RINGS, quantile, budgetOrder, overview };
