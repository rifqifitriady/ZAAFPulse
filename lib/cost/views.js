// Cost Control, sub-project 3a: what the Cost Control pages draw, computed from ledger rows. Pure: no I/O and no clock
// (`today` is an argument), so the browser only draws. One function per page: overview (the current month), breakdown
// (where the money went in a range) and value (what the money bought). Served by GET /api/cost/view (lib/cost/api.js).
//
// Amounts are summed in USD, converted per day with `rateOf(day)` (the display currency's rate, or null for USD) and
// rounded once, at the end. A day with no rate is counted in USD and named in `missingRate`, as the ledger answer does.
const { normalizeModel } = require('../pricing');
const { addDays, daysBetween, daysInMonth, dayOf } = require('./days');
const { tokenTotal } = require('./ledger');
const { SOURCES } = require('./rules');
const F = require('./forecast');
const A = require('./anomaly');

const RINGS = 8;
const FLOW_TOP = 6;
const TREEMAP_MAX = 40;
const LITTLE_DATA = 50; // tool results below this: the accuracy is drawn hollow
const OTHER = '__other';
const PLAN = '__plan';
const NONE = '__none';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const fieldOf = (measure) => (measure === 'billed' ? 'billedUSD' : 'listUSD');
// A plan row is what was paid for a plan: no usage value, so it counts only for "Paid".
const counted = (r, measure) => !!r && (measure === 'billed' || r.kind !== 'plan');

// USD → the chosen currency, per day. `missing()` lists the days that had no rate (counted in USD).
function converter(rateOf) {
  const missing = new Set();
  return {
    // `note` false: the amount is not part of the chosen measure, so a missing rate is not reported for it. A day is
    // reported where something was counted in USD (its spend or its baseline); a day with nothing to convert is not,
    // as the ledger answer does.
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

// The q-quantile is the forecast's own (lib/cost/forecast.js); the calendar's color steps use it too.
const { quantile } = F;

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

// An anomaly figure as the Overview sends it (lib/cost/anomaly.js): the measureDay result, whether the rule's
// parameters call it an anomaly, and a label per driver (a key's name for a key id; else the value itself).
function anomalyOut(m, params, keyName) {
  if (!m) return null;
  return {
    ...m,
    anomaly: A.isAnomaly(m, params),
    drivers: m.drivers.map((d) => ({ ...d, label: d.dim === 'keyId' ? keyName(d.value) || d.value : d.value })),
  };
}

/**
 * The current month, day 1 to today. `rows` are the month's ledger rows as billed (cost.budgetRows), `history` the
 * rows of the 29 days before the 1st (null when they did not read: no forecast and no anomalies), `unread` the months
 * either read skipped, `budgets` the evaluated budgets, `currency` the chosen code and `display` the display currency
 * with its latest rate ({ code, rate } or null) for the budget lines. `planFee(source, day)` is a plan's fee for a day
 * to come (the Paid forecast), `since` the ledger's first day (cost.firstDay: no day before it is known), `anomalyParams`
 * the cost_anomaly rule's saved parameters and `keyNames` a Map of gateway key id -> name, for the Anomalies card.
 */
function overview({
  rows = [],
  history = [],
  unread = [],
  today,
  budgets = [],
  rateOf = null,
  measure = 'list',
  currency = 'USD',
  display = null,
  planFee = null,
  since = null,
  anomalyParams = null,
  keyNames = new Map(),
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
  let spentUSD = 0;
  const daily = month.map((day) => {
    spentUSD += usd.get(day) || 0;
    const spend = c.conv(day, usd.get(day) || 0);
    cum += spend;
    return { day, spend, cum };
  });
  const spent = measure === 'billed' ? { list: otherSum, billed: cum } : { list: cum, billed: otherSum };

  // The forecast (lib/cost/forecast.js): the measure's usage over the 4 weeks before today, by weekday, projected in
  // USD to the month's end and converted day by day. Plan fees are exact: today's is spent already, each later day's
  // comes from planFee. Without a model (a young ledger, or a history that did not read) the line is the mean of the
  // elapsed days, as before, without a band.
  // Under "Paid" a day whose billing was lost (billed as metered, assumed) says nothing of what the plan charged: the
  // model starts after the last such day, as a budget's does (lib/cost/budgets.js).
  const known = history ? [...history, ...inMonth].filter((r) => r && r.kind !== 'plan' && r.day <= today) : null;
  const assumedTo =
    measure === 'billed' && known ? known.reduce((m, r) => (r.billingAssumed && r.day > m ? r.day : m), '') : '';
  const start = assumedTo && !(since > assumedTo) ? addDays(assumedTo, 1) : since;
  const kept = known ? known.filter((r) => r.day > assumedTo) : null;
  const model = kept
    ? F.dailyModel(
        [...dailyUSD(kept, measure)].map(([day, v]) => ({ day, usd: v })),
        { today, unread, since: start },
      )
    : null;
  const planPerDay =
    measure === 'billed' && typeof planFee === 'function'
      ? (day) => SOURCES.reduce((a, s) => a + num(planFee(s, day)), 0)
      : () => 0;
  let line;
  if (model) {
    const todaySoFar = dailyUSD(
      inMonth.filter((r) => r.kind !== 'plan'),
      measure,
    ).get(today);
    const usdLine = F.project(model, { today, spentSoFar: spentUSD, todaySoFar, to: last, planPerDay });
    let prev = { cum: spentUSD, low: spentUSD, high: spentUSD };
    const at = { cum, low: cum, high: cum };
    line = usdLine.map((p) => {
      for (const k of ['cum', 'low', 'high']) at[k] += c.conv(p.day, p[k] - prev[k], false);
      prev = p;
      return { day: p.day, cum: round(at.cum), low: round(at.low), high: round(at.high) };
    });
  } else {
    const perDay = elapsed ? cum / elapsed : 0;
    line = [];
    for (let k = 0; k <= remaining; k++)
      line.push({ day: addDays(today, k), cum: round(cum + perDay * k), low: null, high: null });
  }
  const end = line[line.length - 1];
  const after = line[0];

  // Anomalies (lib/cost/anomaly.js): today so far and yesterday against the 4 weeks before each, with the rule's
  // parameters, as the Monitors rule checks them. The spike line marks each day of the month the same way: its usage
  // value (list, whatever the measure) against its weekday's usual amount, which is its baseline.
  const params = A.anomalyParams(anomalyParams);
  const all = history ? [...history, ...inMonth] : null;
  const keyName = (id) => (keyNames instanceof Map ? keyNames.get(id) : null);
  const recent = all ? A.recentDays(all, { today, unread, since }) : null;
  const listUSD = dailyUSD(all ? all.filter((r) => r && r.kind !== 'plan') : [], 'list');
  const listSeries = [...listUSD].map(([day, v]) => ({ day, usd: v }));
  const top = topModels(inMonth, 'list');
  const spikes = month.map((day) => {
    const m = all && !unread.includes(day.slice(0, 7)) ? F.dailyModel(listSeries, { today: day, unread, since }) : null;
    const v = listUSD.get(day) || 0;
    const base = m ? m.byWeekday[F.weekday(day)] : null;
    const fig = {
      spentUSD: Math.round(v * 1e8) / 1e8,
      expectedUSD: base == null ? null : Math.round(base * 1e8) / 1e8,
    };
    return {
      day,
      spend: round(c.conv(day, v)),
      baseline: base == null ? null : round(c.conv(day, base)),
      spike: base != null && A.isAnomaly(fig, params),
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
      // The mean spend of a day after today, in the chosen currency.
      perDay: remaining ? round((end.cum - after.cum) / remaining) : 0,
      projected: end.cum,
      low: model ? end.low : null,
      high: model ? end.high : null,
      early: !model, // no band: the line is the mean of the elapsed days
      line,
    },
    forecastMethod: model ? model.method : null,
    budgetLines,
    budgetsSkipped: monthly.length - budgetLines.length,
    spikes,
    anomalies: recent
      ? { today: anomalyOut(recent.today, params, keyName), yesterday: anomalyOut(recent.yesterday, params, keyName) }
      : null,
    anomalyParams: params,
    rings: ordered.slice(0, RINGS).map((b) => ({
      id: b.id,
      name: b.name,
      state: b.state,
      tone: toneOf(b.state),
      percent: b.percent == null ? null : b.percent,
      projected: b.projected === true,
      runsOut: typeof b.runsOut === 'string' ? b.runsOut : null,
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

// ---- Breakdown ----

const FLOW_COLS = ['source', 'provider', 'model', 'center'];
const LAST = (n) => (n.key === OTHER || n.key === PLAN ? 1 : 0);
const keyOf = (r, col) => (col === 'center' ? r.center || 'unassigned' : r[col] == null ? NONE : String(r[col]));

// The top `n` keys of a column by spend; the rest become "Other".
function topKeys(sums, n) {
  return new Set(
    [...sums]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, n)
      .map(([k]) => k),
  );
}

// Source → provider → model → cost center. Each column keeps its top 6 by spend and joins the rest into "Other";
// a plan row (Paid) flows from its source into "Plan fee", as it has no provider, model or center.
function flowOf(items) {
  const usage = items.filter((x) => x.r.kind !== 'plan');
  const keep = {};
  for (const col of FLOW_COLS) {
    const sums = new Map();
    for (const { r, v } of usage) sums.set(keyOf(r, col), (sums.get(keyOf(r, col)) || 0) + v);
    if (col === 'source')
      for (const { r, v } of items) if (r.kind === 'plan') sums.set(r.source, (sums.get(r.source) || 0) + v);
    keep[col] = topKeys(sums, FLOW_TOP);
  }
  const nodes = new Map();
  const links = new Map();
  const node = (col, key) => {
    const k = keep[col].has(key) || key === PLAN ? key : OTHER;
    const id = `${col}:${k}`;
    if (!nodes.has(id)) nodes.set(id, { id, col: FLOW_COLS.indexOf(col), key: k, value: 0 });
    return nodes.get(id);
  };
  const link = (a, b, v) => {
    const id = `${a.id}>${b.id}`;
    if (!links.has(id)) links.set(id, { source: a.id, target: b.id, value: 0 });
    links.get(id).value += v;
  };
  for (const { r, v } of items) {
    if (!(v > 0)) continue;
    const path =
      r.kind === 'plan'
        ? [node('source', r.source), node('provider', PLAN)]
        : FLOW_COLS.map((col) => node(col, keyOf(r, col)));
    for (const n of path) n.value += v;
    for (let i = 1; i < path.length; i++) link(path[i - 1], path[i], v);
  }
  // A link that rounds to 0 is not drawn, nor is a node left without links.
  const drawn = [...links.values()].map((l) => ({ ...l, value: round(l.value) })).filter((l) => l.value > 0);
  const linked = new Set(drawn.flatMap((l) => [l.source, l.target]));
  return {
    columns: FLOW_COLS,
    // Per column by spend, with Other and Plan fee last.
    nodes: [...nodes.values()]
      .filter((n) => linked.has(n.id))
      .map((n) => ({ ...n, value: round(n.value) }))
      .sort((a, b) => a.col - b.col || LAST(a) - LAST(b) || b.value - a.value || cmp(a.key, b.key)),
    links: drawn.sort((a, b) => b.value - a.value || cmp(a.source, b.source) || cmp(a.target, b.target)),
  };
}

// One block per project, grouped by cost center: footprint by spend, height by spend per request. At most 40 blocks,
// the "Other" blocks included: a center's projects beyond the cap join one "Other" block for that center, and with more
// centers than fit, the smallest centers fold first into one global "Other centers" block. Plan fees have no project
// or center: they are reported beside it.
function treemapOf(items) {
  const blocks = new Map();
  for (const { r, v } of items) {
    if (r.kind === 'plan') continue;
    const center = r.center || 'unassigned';
    const k = JSON.stringify([center, r.project || null]);
    if (!blocks.has(k)) blocks.set(k, { center, project: r.project || null, spend: 0, requests: 0 });
    const b = blocks.get(k);
    b.spend += v;
    b.requests += num(r.requests);
  }
  const sorted = [...blocks.values()]
    .filter((b) => b.spend > 0)
    .sort((a, b) => b.spend - a.spend || cmp(String(a.project), String(b.project)));
  // More than 39 centers: those beyond the top 39 by spend fold into one global Other first.
  const centerSpend = new Map();
  for (const b of sorted) centerSpend.set(b.center, (centerSpend.get(b.center) || 0) + b.spend);
  const byCenter = [...centerSpend].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  const global = { center: OTHER, project: OTHER, spend: 0, requests: 0, projects: 0 };
  let live = sorted;
  let kept = sorted;
  let rest = [];
  // Keep at most 39 centers; fewer when the per-center "Other" blocks would leave no room for a real project.
  for (let keep = Math.min(byCenter.length, TREEMAP_MAX - 1); keep >= 1; keep--) {
    const out = new Set(byCenter.slice(keep).map(([k]) => k));
    live = sorted.filter((b) => !out.has(b.center));
    Object.assign(global, { spend: 0, requests: 0, projects: 0 });
    for (const b of sorted)
      if (out.has(b.center)) {
        global.spend += b.spend;
        global.requests += b.requests;
        global.projects++;
      }
    const room = TREEMAP_MAX - (global.projects ? 1 : 0);
    kept = live;
    rest = [];
    if (live.length <= room) break;
    let n = room;
    // The per-center "Other" blocks count toward the cap too.
    while (n > 0 && n + new Set(live.slice(n).map((b) => b.center)).size > room) n--;
    kept = live.slice(0, n);
    rest = live.slice(n);
    if (n >= 1) break;
  }
  const others = new Map();
  for (const b of rest) {
    if (!others.has(b.center))
      others.set(b.center, { center: b.center, project: OTHER, spend: 0, requests: 0, projects: 0 });
    const o = others.get(b.center);
    o.spend += b.spend;
    o.requests += b.requests;
    o.projects++;
  }
  const total = sorted.reduce((a, b) => a + b.spend, 0);
  const centers = new Map();
  for (const b of [...kept, ...others.values(), ...(global.projects ? [global] : [])]) {
    if (!centers.has(b.center)) centers.set(b.center, { center: b.center, spend: 0, blocks: [] });
    const c = centers.get(b.center);
    c.spend += b.spend;
    c.blocks.push({
      ...b,
      spend: round(b.spend),
      share: total > 0 ? round(b.spend / total) : 0,
      perRequest: b.requests ? round(b.spend / b.requests) : null,
    });
  }
  return [...centers.values()]
    .map((c) => ({ ...c, spend: round(c.spend) }))
    .sort((a, b) => b.spend - a.spend || cmp(a.center, b.center));
}

// Monday 0 … Sunday 6, from the date alone.
const weekday = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

// Weeks as columns, Monday to Sunday as rows; 5 color steps at the quantiles of the range's non-zero days.
function calendarOf(dayList, spendOf, topOf) {
  const first = dayList.length ? weekday(dayList[0]) : 0;
  const nonZero = dayList
    .map(spendOf)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const steps = nonZero.length ? [0.2, 0.4, 0.6, 0.8].map((q) => quantile(nonZero, q)) : [];
  return {
    steps: steps.map(round),
    days: dayList.map((day, i) => {
      const spend = spendOf(day);
      return {
        day,
        week: Math.floor((i + first) / 7),
        weekday: weekday(day),
        spend: round(spend),
        level: spend > 0 ? 1 + steps.filter((t) => spend > t).length : 0,
        topModel: topOf(day),
      };
    }),
  };
}

/** Where the money went in [from, to]: the flow, the project blocks and the calendar, on one measure. */
function breakdown({ rows = [], from, to, rateOf = null, measure = 'list' }) {
  const c = converter(rateOf);
  const field = fieldOf(measure);
  const items = [];
  let requests = 0;
  for (const r of rows || []) {
    if (!r || r.day < from || r.day > to || !counted(r, measure)) continue;
    items.push({ r, v: c.conv(r.day, num(r[field])) });
    if (r.kind !== 'plan') requests += num(r.requests);
  }
  const perDay = new Map();
  for (const { r, v } of items) perDay.set(r.day, (perDay.get(r.day) || 0) + v);
  const top = topModels(
    items.map((x) => x.r),
    measure,
  );
  const total = items.reduce((a, x) => a + x.v, 0);
  const planFee = items.filter((x) => x.r.kind === 'plan').reduce((a, x) => a + x.v, 0);
  return {
    total: round(total),
    requests,
    planFee: round(planFee),
    flow: flowOf(items),
    treemap: treemapOf(items),
    calendar: calendarOf(
      daysBetween(from, to),
      (day) => perDay.get(day) || 0,
      (day) => top.get(day) || null,
    ),
    missingRate: c.missing(),
  };
}

// ---- Value ----

// Over the experiments that ended in [from, to] and ran a model: its passes over its totals across every evaluator.
// Model names are normalized as the ledger's are. Records are the experiment store's list (lib/datasets/experiments.js).
function passRates(records, { from, to }) {
  const out = new Map();
  for (const x of records || []) {
    if (!x || !Number.isFinite(x.endedAt)) continue;
    const day = dayOf(x.endedAt);
    if (day < from || day > to) continue;
    const models = (x.summary && x.summary.models) || {};
    for (const [name, m] of Object.entries(models)) {
      const model = normalizeModel(name);
      if (!model || !m || !m.evaluators) continue;
      if (!out.has(model)) out.set(model, { pass: 0, total: 0 });
      const o = out.get(model);
      for (const e of Object.values(m.evaluators)) {
        o.pass += num(e && e.pass);
        o.total += num(e && e.total);
      }
    }
  }
  return Object.fromEntries(
    [...out].filter(([, o]) => o.total > 0).map(([k, o]) => [k, { ...o, rate: o.pass / o.total }]),
  );
}

/**
 * What the money bought in [from, to]: plan value against plan fee, the savings waterfall, local models, cost against
 * tool-call accuracy and unit costs. Both measures by nature: usage value (list) and what was paid (billed).
 * `cacheSaved(row)` is the ledger's USD cache saving of a row, `accuracy` lib/quality.js accuracyByModel over the same
 * range, `passRates` this file's passRates. `recommendations` (lib/cost/recommend.js, over the last 30 days whatever
 * the range) is passed through as it is; null when it could not be computed.
 */
function value({
  rows = [],
  from,
  to,
  rateOf = null,
  cacheSaved = () => 0,
  accuracy = {},
  passRates: pr = {},
  recommendations = null,
}) {
  const c = converter(rateOf);
  const inRange = (rows || []).filter((r) => r && r.day >= from && r.day <= to);
  const usage = inRange.filter((r) => r.kind !== 'plan');
  const plan = inRange.filter((r) => r.kind === 'plan');

  // Plan value against plan fee, per source: the usage value of its plan days against the fee of those days.
  const plans = new Map();
  for (const r of plan) {
    if (!plans.has(r.source))
      plans.set(r.source, { source: r.source, plan: r.plan || null, days: new Set(), value: 0, fee: 0 });
    const p = plans.get(r.source);
    p.days.add(r.day);
    p.fee += c.conv(r.day, num(r.billedUSD));
    if (r.plan && (!p.planDay || r.day >= p.planDay)) {
      p.plan = r.plan;
      p.planDay = r.day;
    }
  }
  for (const r of usage) {
    const p = plans.get(r.source);
    if (p && p.days.has(r.day)) p.value += c.conv(r.day, num(r.listUSD));
  }

  // The waterfall: without cache → cache savings → plan savings → paid. The steps add up to what was paid.
  let used = 0;
  let saved = 0;
  let paid = 0;
  for (const r of usage) {
    used += c.conv(r.day, num(r.listUSD));
    saved += c.conv(r.day, num(cacheSaved(r)));
  }
  for (const r of inRange) paid += c.conv(r.day, num(r.billedUSD));

  // Local models: free rows carry tokens and requests, never money.
  const local = new Map();
  for (const r of usage) {
    if (!r.free) continue;
    const k = JSON.stringify([r.model || NONE, r.source]);
    if (!local.has(k)) local.set(k, { model: r.model || null, source: r.source, requests: 0, tokens: 0 });
    const l = local.get(k);
    l.requests += num(r.requests);
    l.tokens += tokenTotal(r);
  }

  // Cost against quality, one dot per model with a request in the range; usage value, so a plan does not hide it.
  const models = new Map();
  for (const r of usage) {
    if (!r.model || !(num(r.requests) > 0)) continue;
    if (!models.has(r.model)) models.set(r.model, { model: r.model, requests: 0, spend: 0 });
    const m = models.get(r.model);
    m.requests += num(r.requests);
    m.spend += c.conv(r.day, num(r.listUSD));
  }
  const dots = [];
  const noToolCalls = [];
  for (const m of [...models.values()].sort((a, b) => b.spend - a.spend || cmp(a.model, b.model))) {
    const q = Object.hasOwn(accuracy || {}, m.model) ? accuracy[m.model] : null;
    const base = { model: m.model, requests: m.requests, spend: round(m.spend) };
    if (!q || !(q.results > 0)) {
      noToolCalls.push(base);
      continue;
    }
    const p = Object.hasOwn(pr || {}, m.model) ? pr[m.model] : null;
    dots.push({
      ...base,
      perRequest: round(m.spend / m.requests),
      accuracy: q.accuracy,
      toolResults: q.results,
      littleData: q.results < LITTLE_DATA,
      passRate: p ? { pass: p.pass, total: p.total, rate: p.total ? p.pass / p.total : null } : null,
    });
  }

  // Unit costs per day, on usage value; a day without its denominator has no point (null), never zero.
  const ok = new Map();
  for (const q of Object.values(accuracy || {}))
    for (const [day, d] of Object.entries((q && q.daily) || {})) ok.set(day, (ok.get(day) || 0) + num(d && d.ok));
  const per = new Map();
  for (const r of usage) {
    if (!per.has(r.day)) per.set(r.day, { spend: 0, requests: 0, tokens: 0, local: 0 });
    const d = per.get(r.day);
    const v = c.conv(r.day, num(r.listUSD));
    d.spend += v;
    d.requests += num(r.requests);
    d.tokens += tokenTotal(r);
    if (r.source === 'claude' || r.source === 'codex') d.local += v;
  }
  const unit = daysBetween(from, to).map((day) => {
    const d = per.get(day) || { spend: 0, requests: 0, tokens: 0, local: 0 };
    const k = ok.get(day) || 0;
    return {
      day,
      perRequest: d.requests ? round(d.spend / d.requests) : null,
      perMillionTokens: d.tokens ? round(d.spend / (d.tokens / 1e6)) : null,
      perThousandToolCalls: k ? round(d.local / (k / 1000)) : null,
    };
  });

  return {
    plans: [...plans.values()]
      .map((p) => ({
        source: p.source,
        plan: p.plan,
        days: p.days.size,
        value: round(p.value),
        fee: round(p.fee),
        multiplier: p.fee > 0 ? Math.round((p.value / p.fee) * 100) / 100 : null,
      }))
      .sort((a, b) => b.fee - a.fee || cmp(a.source, b.source)),
    waterfall: {
      withoutCache: round(used + saved),
      cacheSaved: round(saved),
      usage: round(used),
      planSaved: round(used - paid),
      paid: round(paid),
    },
    local: {
      requests: [...local.values()].reduce((a, l) => a + l.requests, 0),
      tokens: [...local.values()].reduce((a, l) => a + l.tokens, 0),
      models: [...local.values()].sort(
        (a, b) => b.requests - a.requests || cmp(String(a.model), String(b.model)) || cmp(a.source, b.source),
      ),
    },
    scatter: { dots, noToolCalls },
    unit,
    recommendations: recommendations || null,
    missingRate: c.missing(),
  };
}
module.exports = {
  RINGS,
  FLOW_TOP,
  TREEMAP_MAX,
  LITTLE_DATA,
  quantile,
  budgetOrder,
  overview,
  breakdown,
  passRates,
  value,
};
