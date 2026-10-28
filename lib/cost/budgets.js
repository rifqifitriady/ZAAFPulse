// Cost Control, sub-project 2: budgets. Pure functions: a budget's validation, the old settings read as budgets, the
// bounds of its period in local time, what it spent from ledger rows, and its state. No I/O and no clock: `now` is an
// argument. The budgets in force and the gateway calls not yet in the ledger live in lib/cost/budget-service.js, the
// gateway's check in lib/cost/guard.js, and the alerts in the Monitors engine (rule `budget`).
const { normalizeModel } = require('../pricing');
const { dayOf, addDays, monthOf } = require('./days');
const { SOURCES, UNASSIGNED, normalizeGlob, rateFor } = require('./rules');
const F = require('./forecast');

const DIMS = ['center', 'key', 'project', 'model', 'provider', 'source'];
const PERIODS = ['day', 'week', 'month'];
const MEASURES = ['list', 'billed'];
const ENFORCE = ['none', 'block', 'pause'];
const FIELDS = [
  'id',
  'name',
  'scope',
  'period',
  'amount',
  'currency',
  'measure',
  'thresholds',
  'projection',
  'enforce',
  'legacy',
];
const DEFAULT_THRESHOLDS = [50, 80];
const PROJECTION_FROM = 0.25; // a projection from the first quarter of a period is noise
const LIMITS = { budgets: 100, name: 60, value: 300, amount: 1e12 };
const BUDGET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const CONTROL = /[\u0000-\u001f\u007f]/;
const LEGACY_MONTHLY = 'legacy-monthly';
const legacyKeyId = (keyId) => `legacy-key-${keyId}`;
// The ledger row field each scope dimension reads.
const ROW_FIELD = {
  center: 'center',
  key: 'keyId',
  project: 'project',
  model: 'model',
  provider: 'provider',
  source: 'source',
};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clip = (s) => String(s).slice(0, 40);
const usd = (v) => Math.round(v * 1e8) / 1e8;
const shown = (v) => Math.round(v * 1e4) / 1e4;
// Spent and amount are compared as whole micro-dollars: a float sum such as ten times 0.1 must reach 100 %.
const micro = (v) => Math.round(v * 1e6);
const pct = (v) => Math.round(v * 10) / 10;
const copyBudget = (b) => ({
  ...b,
  scope: b.scope === 'global' ? 'global' : { ...b.scope },
  thresholds: [...b.thresholds],
});

// Block reaches gateway requests only: a project or a local source never goes through the gateway.
function mayBlock(scope) {
  if (scope === 'global') return true;
  if (scope.dim === 'source') return scope.value === 'gateway';
  return ['key', 'center', 'model', 'provider'].includes(scope.dim);
}
// Pause reaches a local agent only: a key or a provider has no local session behind it.
function mayPause(scope) {
  if (scope === 'global') return true;
  if (scope.dim === 'source') return scope.value === 'claude' || scope.value === 'codex';
  return ['project', 'center', 'model'].includes(scope.dim);
}

function scopeOf(s, ctx, errors) {
  if (s === 'global') return 'global';
  if (!isObject(s) || Object.keys(s).some((k) => k !== 'dim' && k !== 'value')) {
    errors.push("scope: 'global' or { dim, value }");
    return null;
  }
  if (!DIMS.includes(s.dim)) {
    errors.push(`scope.dim: one of ${DIMS.join(', ')}`);
    return null;
  }
  let v = typeof s.value === 'string' ? s.value.trim() : '';
  if (!v || v.length > LIMITS.value || CONTROL.test(v)) {
    errors.push(`scope.value: 1 to ${LIMITS.value} characters`);
    return null;
  }
  if (s.dim === 'key' && !KEY_ID.test(v)) errors.push('scope.value: a gateway key id');
  else if (s.dim === 'center' && v !== UNASSIGNED && !(ctx.centers || []).includes(v))
    errors.push('scope.value: unknown cost center');
  else if (s.dim === 'source' && !SOURCES.includes(v)) errors.push(`scope.value: one of ${SOURCES.join(', ')}`);
  else if (s.dim === 'model') {
    v = normalizeModel(v);
    if (!v) errors.push('scope.value: a model name');
  } else if (s.dim === 'project') {
    // As the ledger stores projects: forward slashes, the home folder as ~, no trailing slash.
    v = normalizeGlob(v, ctx.home || '').replace(/(.)\/+$/, '$1');
  }
  return { dim: s.dim, value: v };
}

function validateBudget(input, ctx = {}) {
  if (!isObject(input)) return { ok: false, errors: ['a budget must be an object'] };
  const errors = [];
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) errors.push(`unknown field: ${clip(k)}`);
  const id = typeof input.id === 'string' ? input.id : '';
  if (!BUDGET_ID.test(id) || RESERVED.includes(id))
    errors.push('id: letters, digits, dashes and underscores, up to 80, starting with a letter or digit');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > LIMITS.name || CONTROL.test(name))
    errors.push(`name: 1 to ${LIMITS.name} characters, no control characters`);
  const scope = scopeOf(input.scope, ctx, errors);
  if (!PERIODS.includes(input.period)) errors.push('period: day, week or month');
  if (!isNum(input.amount) || input.amount <= 0 || input.amount > LIMITS.amount)
    errors.push('amount: a number above 0, up to 1e12');
  const currency = input.currency ?? 'USD';
  if (currency !== 'USD' && !(ctx.currency && currency === ctx.currency))
    errors.push(`currency: USD${ctx.currency ? ` or ${ctx.currency}` : ''}`);
  const measure = input.measure ?? 'list';
  if (!MEASURES.includes(measure)) errors.push('measure: list or billed');
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const rising =
    Array.isArray(thresholds) &&
    thresholds.length <= 2 &&
    thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 99) &&
    thresholds.every((t, i) => i === 0 || t > thresholds[i - 1]);
  if (!rising) errors.push('thresholds: up to 2 whole numbers from 1 to 99, rising (100 % is always exceeded)');
  const projection = input.projection ?? true;
  if (typeof projection !== 'boolean') errors.push('projection: true or false');
  const enforce = input.enforce ?? 'none';
  if (!ENFORCE.includes(enforce)) errors.push('enforce: none, block or pause');
  else if (scope && enforce === 'block' && !mayBlock(scope))
    errors.push('enforce: block works on global, key, center, model, provider or source gateway budgets');
  else if (scope && enforce === 'pause' && !mayPause(scope))
    errors.push('enforce: pause works on global, project, center, model or source claude or codex budgets');
  if (input.legacy !== undefined && input.legacy !== null)
    errors.push('legacy: set only for budgets read from the old settings');
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return {
    ok: true,
    value: {
      id,
      name,
      scope,
      period: input.period,
      amount: input.amount,
      currency,
      measure,
      thresholds: [...thresholds],
      projection,
      enforce,
      legacy: null,
    },
  };
}

function validateList(list, ctx = {}) {
  if (!Array.isArray(list)) return { ok: false, errors: ['budgets must be a list'] };
  if (list.length > LIMITS.budgets) return { ok: false, errors: [`at most ${LIMITS.budgets} budgets`] };
  const errors = [];
  const out = [];
  list.forEach((b, i) => {
    const r = validateBudget(b, ctx);
    if (!r.ok) for (const e of r.errors) errors.push(`budgets[${i}].${e}`);
    else if (out.some((x) => x.id === r.value.id)) errors.push(`budgets[${i}].id: ${r.value.id} is used twice`);
    else out.push(r.value);
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true, value: out };
}

// The current period in local time: a day from midnight, a week from Monday, a month from the 1st. `fraction` is how
// much of it has passed at `t`; `key` changes when a new period starts.
function periodBounds(period, t) {
  const d = new Date(t);
  let start;
  let end;
  if (period === 'day') {
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  } else if (period === 'week') {
    const back = (d.getDay() + 6) % 7; // Monday is 0
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 7);
  } else {
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  const from = dayOf(start.getTime());
  const to = addDays(dayOf(end.getTime()), -1);
  const fraction = Math.min(1, Math.max(0, (t - start.getTime()) / (end.getTime() - start.getTime())));
  return { period, from, to, start: start.getTime(), end: end.getTime(), fraction, key: `${period}:${from}` };
}

// Plan rows carry no center, model, key or project: they count only in global and source budgets.
function inScope(scope, row) {
  if (scope === 'global') return true;
  if (row.kind === 'plan') return scope.dim === 'source' && row.source === scope.value;
  return row[ROW_FIELD[scope.dim]] === scope.value;
}

function stateOf(percent, thresholds) {
  if (percent >= 100) return 'exceeded';
  let s = 'ok';
  for (const t of thresholds) if (percent >= t) s = `warn_${t}`;
  return s;
}

const viewBase = (b, p) => ({
  ...copyBudget(b),
  from: p.from,
  to: p.to,
  periodKey: p.key,
  fraction: Math.round(p.fraction * 1e4) / 1e4,
});
function noDataView(b, p, reason) {
  return {
    ...viewBase(b, p),
    state: 'no_data',
    projected: false,
    spent: null,
    spentUSD: null,
    amountUSD: null,
    percent: null,
    forecastUSD: null,
    runsOut: null,
    reason,
  };
}

// The names in a range read's `unread` that touch [from, to]: its months, the folder, the corrections.
const missingFor = (unread, from, to) =>
  (unread || []).filter(
    (u) => u === 'folder' || u === 'corrections' || (/^\d{4}-\d{2}$/.test(u) && u >= monthOf(from) && u <= monthOf(to)),
  );

// `rows` are the ledger rows (cost.budgetRows), `extra` the gateway calls the ledger has not read yet; both are
// filtered to the period here. `currency` is the display currency with its rates. The forecast (lib/cost/forecast.js)
// is built from `history`, the ledger rows of the 28 days before today (null when they did not read), in this budget's
// scope and measure with plan rows left out, and the days of `historyUnread` months unknown; under "Paid", each day to
// come adds `planFee(source, day)` for the sources in scope. It sets `projected` (from a quarter of the period, the
// forecast at the period's end above the amount; without a model, the linear pace spent / fraction), `forecastUSD`
// and `runsOut`, the day it passes the amount (null once exceeded, or when it stays under within the period).
function evaluateBudget(
  b,
  {
    rows = [],
    extra = [],
    unread = [],
    billingError = null,
    currency = null,
    now,
    history = null,
    historyUnread = [],
    planFee = null,
    forecast = true,
  } = {},
) {
  const p = periodBounds(b.period, now);
  let rate = 1;
  if (b.currency !== 'USD') {
    if (!currency || currency.code !== b.currency)
      return noDataView(b, p, `no rates for ${b.currency}; set them in the cost settings`);
    rate = rateFor(currency, dayOf(now));
    if (rate == null) return noDataView(b, p, `no ${b.currency} rate on or before today`);
  }
  const missing = missingFor(unread, p.from, p.to);
  if (missing.length) return noDataView(b, p, `the ledger could not read ${missing.join(', ')}`);
  if (b.measure === 'billed' && billingError) return noDataView(b, p, 'the billing history could not be read');
  const field = b.measure === 'billed' ? 'billedUSD' : 'listUSD';
  const today = dayOf(now);
  let spentUSD = 0;
  let todayUSD = 0; // today's usage so far, plan fee left out: what today's forecast must not fall under
  for (const list of [rows, extra])
    for (const r of list) {
      if (!r || r.day < p.from || r.day > p.to || !inScope(b.scope, r)) continue;
      if (b.measure === 'list' && r.kind === 'plan') continue;
      // What was paid on such a day is not known: billed as metered until a restate says otherwise.
      if (b.measure === 'billed' && r.billingAssumed)
        return noDataView(b, p, 'the billing history was lost for part of this period');
      const v = isNum(r[field]) ? r[field] : 0;
      spentUSD += v;
      if (r.day === today && r.kind !== 'plan') todayUSD += v;
    }
  const amountUSD = b.amount / rate;
  const spentMicro = micro(spentUSD);
  const amountMicro = micro(amountUSD);
  // One division of whole numbers, so the percent the view shows and the state always agree.
  const percent = amountMicro > 0 ? (spentMicro * 100) / amountMicro : Infinity;
  const state = stateOf(percent, b.thresholds);
  // Under "Paid" a day whose billing was lost is billed as metered, which says nothing of what the plan charged. The
  // model has no unknown single days, so the history starts after the last such day instead (the lost history is a
  // run from the start); a model may then not form, and the linear pace decides.
  const assumedTo =
    b.measure === 'billed'
      ? (history || []).reduce((m, r) => (r && r.billingAssumed && r.day > m ? r.day : m), '')
      : '';
  const series = (forecast ? history || [] : [])
    .filter((r) => r && r.kind !== 'plan' && r.day > assumedTo && inScope(b.scope, r))
    .map((r) => ({ day: r.day, usd: isNum(r[field]) ? r[field] : 0 }));
  const model = forecast && history ? F.dailyModel(series, { today, unread: historyUnread }) : null;
  // The plan fees of a day to come, for the sources this budget counts plan rows of (global, or a source scope).
  const fees =
    b.measure === 'billed' && typeof planFee === 'function'
      ? SOURCES.filter((s) => inScope(b.scope, { kind: 'plan', source: s }))
      : [];
  const planPerDay = (day) =>
    fees.reduce((a, s) => {
      const fee = planFee(s, day);
      return a + (isNum(fee) ? fee : 0);
    }, 0);
  const line = F.project(model, { today, spentSoFar: spentUSD, todaySoFar: todayUSD, to: p.to, planPerDay });
  const forecastUSD = line.length ? line[line.length - 1].cum : null;
  const passes = forecastUSD != null ? micro(forecastUSD) > amountMicro : spentMicro / p.fraction > amountMicro;
  const projected = b.projection && state !== 'exceeded' && p.fraction >= PROJECTION_FROM && passes;
  return {
    ...viewBase(b, p),
    state,
    projected,
    spent: shown(spentUSD * rate),
    spentUSD: usd(spentUSD),
    amountUSD: usd(amountUSD),
    percent: Number.isFinite(percent) ? pct(percent) : null,
    forecastUSD: forecastUSD == null ? null : usd(forecastUSD),
    runsOut: state === 'exceeded' ? null : F.runsOut(line, amountUSD),
    reason: null,
  };
}

// The old settings as budgets. Never written: they are read on every call, and a saved budget of the same id wins.
function legacyBudgets({ monthlyBudgetUSD, keys = [] } = {}) {
  const out = [];
  const base = {
    period: 'month',
    currency: 'USD',
    measure: 'list',
    thresholds: [...DEFAULT_THRESHOLDS],
    projection: true,
  };
  if (isNum(monthlyBudgetUSD) && monthlyBudgetUSD > 0)
    out.push({
      id: LEGACY_MONTHLY,
      name: 'Monthly budget',
      scope: 'global',
      amount: monthlyBudgetUSD,
      ...base,
      enforce: 'none',
      legacy: 'monthlyBudgetUSD',
    });
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!k || !KEY_ID.test(String(k.id)) || k.revokedAt || !isNum(k.budgetUSD) || k.budgetUSD < 0) continue;
    const name = `Key ${String(k.name || k.id)}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LIMITS.name);
    out.push({
      id: legacyKeyId(k.id),
      name,
      scope: { dim: 'key', value: String(k.id) },
      amount: k.budgetUSD,
      ...base,
      enforce: 'block',
      legacy: 'keyBudget',
    });
  }
  return out;
}

const effectiveBudgets = (saved, legacy) => [
  ...saved.map(copyBudget),
  ...legacy.filter((l) => !saved.some((s) => s.id === l.id)).map(copyBudget),
];

// The monthly budget the Overview draws: the saved `legacy-monthly` budget once it was edited there (in USD at
// today's rate; 0 when it is no longer a monthly budget or has no rate), else the old setting.
function monthlyFigure({ saved = [], monthlyBudgetUSD, currency = null, now }) {
  const b = saved.find((x) => x.id === LEGACY_MONTHLY);
  if (!b)
    return {
      monthlyBudgetUSD: isNum(monthlyBudgetUSD) && monthlyBudgetUSD > 0 ? monthlyBudgetUSD : 0,
      monthlyBudgetManaged: false,
    };
  let amount = 0;
  if (b.period === 'month') {
    const rate =
      b.currency === 'USD' ? 1 : currency && currency.code === b.currency ? rateFor(currency, dayOf(now)) : null;
    amount = rate ? b.amount / rate : 0;
  }
  return { monthlyBudgetUSD: Math.round(amount * 100) / 100, monthlyBudgetManaged: true };
}

module.exports = {
  DIMS,
  PERIODS,
  LIMITS,
  DEFAULT_THRESHOLDS,
  PROJECTION_FROM,
  LEGACY_MONTHLY,
  legacyKeyId,
  validateBudget,
  validateList,
  mayBlock,
  mayPause,
  inScope,
  stateOf,
  periodBounds,
  evaluateBudget,
  noDataView,
  legacyBudgets,
  effectiveBudgets,
  copyBudget,
  monthlyFigure,
};
