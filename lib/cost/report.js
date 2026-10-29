// Cost Control 5: the figures that leave the dashboard. showback() is one cost center's month for a client (the
// Reports page, GET /api/cost/report). Pure: ledger rows in (cost.budgetRows, plan rows included), numbers and names
// out; no I/O and no clock (`today` is an argument).
const { addDays, daysBetween, daysInMonth, monthOf } = require('./days');
const { UNASSIGNED } = require('./rules');

const TOP = 20; // rows per table, then "Other"
const MAX_MONTHS = 120; // the month picker reaches back at most ten years
const ALL = '__all'; // every center: not a center id (ids start with a letter or digit)
const OTHER = '__other';
const PLAN = '__plan';
const NONE = '__none';
const TABLES = { source: 'source', model: 'model', key: 'keyId', project: 'project' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const round4 = (v) => (v === null ? null : Math.round(v * 1e4) / 1e4);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const tokenSum = (t) =>
  num(t && t.in) + num(t && t.out) + num(t && t.cacheRead) + num(t && t.cacheWrite5m) + num(t && t.cacheWrite1h);

// 'YYYY-MM' of the month before.
const prevMonth = (month) => monthOf(addDays(`${month}-01`, -1));

/** The days a month's report covers: the whole month, or up to today in the current one. */
function monthRange(month, today) {
  const from = `${month}-01`;
  const end = `${month}-${String(daysInMonth(from)).padStart(2, '0')}`;
  return { from, to: month === monthOf(today) && today < end ? today : end };
}

/** The months the picker offers: this month back to the ledger's first month (this month alone without one). */
function reportMonths(today, firstDay, max = MAX_MONTHS) {
  const out = [monthOf(today)];
  const stop = typeof firstDay === 'string' ? monthOf(firstDay) : out[0];
  while (out.length < max && out[out.length - 1] > stop) out.push(prevMonth(out[out.length - 1]));
  return out;
}

/** Last month, or this month while the ledger does not hold all of last month (its first day is later than the 1st). */
function defaultMonth(today, firstDay) {
  const last = prevMonth(monthOf(today));
  return typeof firstDay === 'string' && firstDay <= `${last}-01` ? last : monthOf(today);
}

// Sums of usage value and paid (and the display currency, with `rateOf`; null once a day has no rate).
function sums(rateOf) {
  return { requests: 0, tokens: 0, listUSD: 0, billedUSD: 0, ...(rateOf ? { list: 0, billed: 0 } : {}) };
}
function addTo(s, r, rateOf) {
  s.requests += num(r.requests);
  s.tokens += tokenSum(r.tokens);
  s.listUSD += num(r.listUSD);
  s.billedUSD += num(r.billedUSD);
  if (!rateOf) return;
  const rate = rateOf(r.day);
  if (rate == null) s.list = s.billed = null;
  else if (s.list !== null) {
    s.list += num(r.listUSD) * rate;
    s.billed += num(r.billedUSD) * rate;
  }
}
const money = (s) => ({
  ...s,
  listUSD: round8(s.listUSD),
  billedUSD: round8(s.billedUSD),
  ...('list' in s ? { list: round4(s.list), billed: round4(s.billed) } : {}),
});

// A row's key in a table: a plan fee has no model, key or project; a usage row without one is "Unknown".
const keyOf = (r, field) =>
  field !== 'source' && r.kind === 'plan' ? PLAN : r[field] == null ? NONE : String(r[field]);

// One table: the top 20 by usage value (then paid, then key), the rest summed as Other with how many it holds.
function tableOf(rows, field, rateOf, nameOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r, field);
    if (!groups.has(k)) groups.set(k, sums(rateOf));
    addTo(groups.get(k), r, rateOf);
  }
  const all = [...groups.entries()]
    .map(([key, s]) => ({ key, ...(nameOf ? { name: nameOf(key) } : {}), ...money(s) }))
    .sort((a, b) => b.listUSD - a.listUSD || b.billedUSD - a.billedUSD || cmp(a.key, b.key));
  if (all.length <= TOP) return all;
  const rest = sums(rateOf);
  for (const x of all.slice(TOP)) {
    rest.requests += x.requests;
    rest.tokens += x.tokens;
    rest.listUSD += x.listUSD;
    rest.billedUSD += x.billedUSD;
    if (rateOf) {
      rest.list = rest.list === null || x.list === null ? null : rest.list + x.list;
      rest.billed = rest.billed === null || x.billed === null ? null : rest.billed + x.billed;
    }
  }
  return [...all.slice(0, TOP), { key: OTHER, count: all.length - TOP, ...money(rest) }];
}

/**
 * One cost center's month: `center` is a center id, '__all' or 'unassigned'. `rows` are cost.budgetRows of the month
 * (plan rows included: they belong to All centers only, as a plan fee has no center). `budgets` are the evaluated
 * views (null for a past month: their state is the current period's), `corrections` the restates (null when they did
 * not read), `unread` and `billingError` what the read left out. `keyNames` maps a key id to its name.
 */
function showback({
  rows = [],
  month,
  today,
  center = ALL,
  centers = [],
  keyNames = new Map(),
  budgets = null,
  corrections = [],
  unread = [],
  billingError = null,
  rateOf = null,
  currency = 'USD',
  generatedAt = null,
}) {
  const { from, to } = monthRange(month, today);
  const named = centers.find((c) => c.id === center);
  const name = center === ALL ? 'All centers' : center === UNASSIGNED ? 'Unassigned' : named ? named.name : center;
  const mine = (rows || []).filter(
    (r) =>
      r &&
      r.day >= from &&
      r.day <= to &&
      (center === ALL || (r.kind !== 'plan' && (r.center || UNASSIGNED) === center)),
  );
  const totals = sums(rateOf);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const perDay = new Map(daysBetween(from, to).map((d) => [d, sums(rateOf)]));
  const assumed = new Set();
  for (const r of mine) {
    addTo(totals, r, rateOf);
    const t = r.tokens || {};
    tokens.input += num(t.in);
    tokens.output += num(t.out);
    tokens.cacheRead += num(t.cacheRead);
    tokens.cacheWrite += num(t.cacheWrite5m) + num(t.cacheWrite1h);
    if (perDay.has(r.day)) addTo(perDay.get(r.day), r, rateOf);
    if (r.billingAssumed) assumed.add(r.day);
  }
  const keyName = (k) => (k === PLAN || k === NONE ? null : keyNames.get(k) || k);
  const inScope = (b) =>
    center === ALL || (b.scope && b.scope !== 'global' && b.scope.dim === 'center' && b.scope.value === center);
  return {
    month,
    from,
    to,
    center: { id: center, name },
    currency,
    generatedAt,
    totals: { ...money(totals), tokens },
    tables: Object.fromEntries(
      Object.entries(TABLES).map(([t, field]) => [t, tableOf(mine, field, rateOf, t === 'key' ? keyName : null)]),
    ),
    daily: [...perDay.entries()].map(([day, s]) => {
      const m = money(s);
      return {
        day,
        listUSD: m.listUSD,
        billedUSD: m.billedUSD,
        ...('list' in m ? { list: m.list, billed: m.billed } : {}),
      };
    }),
    budgets: Array.isArray(budgets)
      ? budgets.filter(inScope).map((b) => ({
          id: b.id,
          name: b.name,
          scope: b.scope,
          period: b.period,
          from: b.from,
          to: b.to,
          amount: b.amount,
          currency: b.currency,
          measure: b.measure,
          state: b.state,
          projected: b.projected,
          percent: b.percent,
          spent: b.spent,
          reason: b.reason,
        }))
      : null,
    notes: {
      unread: [...(unread || [])],
      assumed: [...assumed].sort(),
      billingError: billingError || null,
      corrections: Array.isArray(corrections)
        ? corrections
            .filter((c) => c && c.from <= to && c.to >= from)
            .map((c) => ({ ts: c.ts, from: c.from, to: c.to, reason: c.reason }))
        : null,
    },
  };
}

module.exports = { ALL, TOP, OTHER, PLAN, NONE, monthRange, reportMonths, defaultMonth, showback };
