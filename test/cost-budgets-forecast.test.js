// Cost Control 4a: a budget's forecast (lib/cost/budgets.js evaluateBudget) and the history the budget service reads
// for it (lib/cost/budget-service.js). Thursday 22 October 2026, 15:00: about 70 % of the month has passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/cost/budgets');
const { createBudgetService } = require('../lib/cost/budget-service');
const { daysBetween } = require('../lib/cost/days');
const F = require('../lib/cost/forecast');

const NOW = new Date(2026, 9, 22, 15).getTime();
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  model: 'deepseek-chat',
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// Weekdays cost 1 and weekends 10, from 24 September (the 4 weeks before today) to yesterday; today 0.5 so far.
const weekly = (d) => (F.weekday(d) >= 5 ? 10 : 1);
const ROWS = [
  ...daysBetween('2026-09-24', '2026-10-21').map((d) => row(d, { listUSD: weekly(d), billedUSD: weekly(d) })),
  row('2026-10-22', { listUSD: 0.5, billedUSD: 0.5 }),
];
const budget = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 110,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  ...over,
});
const evalAt = (b, extra = {}) => B.evaluateBudget(b, { rows: ROWS, history: ROWS, now: NOW, ...extra });

test('projected follows the forecast: the weekends to come pass the amount the linear pace does not', () => {
  // October so far: 6 weekend days (60) and 15 weekdays (15), then 0.5 today = 75.5. Today is forecast at 1, and the
  // 9 days left hold 3 weekend days and 6 weekdays: 76 + 36 = 112. The linear pace says 75.5 / 0.7 ≈ 108.
  const v = evalAt(budget());
  assert.deepEqual(
    [v.state, v.spentUSD, v.forecastUSD, v.projected, v.runsOut],
    ['warn_50', 75.5, 112, true, '2026-10-31'],
  );
  assert.equal(evalAt(budget({ projection: false })).projected, false, 'projection off');
  const under = evalAt(budget({ amount: 120 }));
  assert.deepEqual([under.forecastUSD, under.projected, under.runsOut], [112, false, null], 'stays under');
  // 28 October ends at 100, which is not past 100; the 29th is.
  assert.equal(evalAt(budget({ amount: 100 })).runsOut, '2026-10-29');
  const used = evalAt(budget({ amount: 70 }));
  assert.deepEqual([used.state, used.forecastUSD, used.runsOut, used.projected], ['exceeded', 112, null, false]);
});

test('without a model the linear pace decides, and neither forecast field is set', () => {
  for (const history of [null, [row('2026-10-20'), row('2026-10-21')]]) {
    const v = B.evaluateBudget(budget(), { rows: ROWS, history, now: NOW });
    assert.deepEqual([v.projected, v.forecastUSD, v.runsOut], [false, null, null]);
    assert.equal(B.evaluateBudget(budget({ amount: 105 }), { rows: ROWS, history, now: NOW }).projected, true);
  }
});

test('a week forecasts to its Sunday: a date after the period is no runs-out date', () => {
  // Monday 19 to Thursday 22: 3.5 so far, then 4 today, 5 on Friday, 15 and 25 over the weekend.
  const v = evalAt(budget({ period: 'week', amount: 30 }));
  assert.deepEqual([v.from, v.to, v.spentUSD, v.forecastUSD, v.runsOut], ['2026-10-19', '2026-10-25', 3.5, 25, null]);
  assert.equal(evalAt(budget({ period: 'week', amount: 14 })).runsOut, '2026-10-24');
});

test('a day budget forecasts today only', () => {
  const v = evalAt(budget({ period: 'day', amount: 0.8 }));
  assert.deepEqual(
    [v.state, v.spentUSD, v.forecastUSD, v.runsOut, v.projected],
    ['warn_50', 0.5, 1, '2026-10-22', true],
  );
});

test('scope and measure: the history in scope only; under Paid each day to come adds the plan fees in scope', () => {
  // Every day: Claude Code on a plan (a plan row of 3, its usage billed 0) and 1 of gateway usage.
  const days = daysBetween('2026-09-24', '2026-10-22');
  const rows = days.flatMap((d) => [
    row(d),
    row(d, { source: 'claude', model: 'claude-opus-5-5', keyId: null, listUSD: 5, billedUSD: 0 }),
    { ...row(d, { source: 'claude', model: null, center: null, keyId: null, kind: 'plan' }), listUSD: 0, billedUSD: 3 },
  ]);
  const asked = [];
  const planFee = (source, day) => {
    asked.push(`${source} ${day}`);
    return source === 'claude' ? 3 : 0;
  };
  const paid = (over) =>
    B.evaluateBudget(budget({ measure: 'billed', amount: 1000, ...over }), { rows, history: rows, now: NOW, planFee });
  // Paid so far 22 × (3 + 1) = 88; today's usage (1) is as expected; 9 days to come × (1 + 3).
  assert.deepEqual([paid().spentUSD, paid().forecastUSD], [88, 124]);
  assert.ok(asked.includes('claude 2026-10-23') && asked.includes('claude 2026-10-31'));
  assert.ok(!asked.some((a) => a.endsWith('2026-10-22')), "today's fee is in what was paid already");
  assert.equal(paid({ scope: { dim: 'source', value: 'gateway' } }).forecastUSD, 31, 'another source: no fee');
  assert.equal(paid({ scope: { dim: 'key', value: 'key_a' } }).forecastUSD, 31, 'a key has no plan rows');
  const list = B.evaluateBudget(budget({ amount: 1000 }), { rows, history: rows, now: NOW, planFee });
  assert.equal(list.forecastUSD, 22 * 6 + 9 * 6, 'usage value: every usage row, no fee');
  // A month of the history that did not read is unknown: the forecast rests on October alone.
  const v = B.evaluateBudget(budget(), { rows: ROWS, history: ROWS, historyUnread: ['2026-09'], now: NOW });
  assert.equal(v.forecastUSD, 112, 'the same weekday means from 1-21 October');
});

test('a view without data has both forecast fields, null', () => {
  const v = evalAt(budget({ currency: 'IDR' }));
  assert.equal(v.state, 'no_data');
  assert.deepEqual([v.forecastUSD, v.runsOut], [null, null]);
});

test('the budget service reads the history window once a day, cached as a period; a failed read leaves no forecast', () => {
  const calls = [];
  let failHistory = false;
  const cost = {
    budgetRows: ({ from, to }) => {
      calls.push(`${from}|${to}`);
      if (failHistory && to === '2026-10-21') throw new Error('unreadable');
      return { rows: ROWS, unread: [], billingError: null };
    },
    planFeeFor: () => 0,
  };
  const make = () =>
    createBudgetService({
      getSettings: () => ({ budgets: [budget()] }),
      cost,
      now: () => NOW,
      nocase: false,
    });
  const s = make();
  const v = s.evaluate().find((x) => x.id === 'team');
  assert.deepEqual([v.forecastUSD, v.runsOut, v.projected], [112, '2026-10-31', true]);
  assert.deepEqual(calls.sort(), ['2026-09-24|2026-10-21', '2026-10-01|2026-10-31']);
  s.evaluate();
  assert.equal(calls.length, 2, 'both windows cached until a pass or a change');
  s.invalidate();
  failHistory = true;
  const w = s.evaluate().find((x) => x.id === 'team');
  assert.deepEqual([w.spentUSD, w.forecastUSD, w.runsOut, w.projected], [75.5, null, null, false]);
});

test('forecast: false skips the model and the history; the linear pace decides', () => {
  const v = B.evaluateBudget(budget({ amount: 105 }), { rows: ROWS, history: ROWS, now: NOW, forecast: false });
  assert.deepEqual([v.forecastUSD, v.runsOut, v.projected], [null, null, true]);
});

test('the gateway guard never reads the history window nor asks for a plan fee', () => {
  const { createGuard } = require('../lib/cost/guard');
  const calls = [];
  let fees = 0;
  const cost = {
    budgetRows: ({ from, to }) => {
      calls.push(`${from}|${to}`);
      return { rows: ROWS, unread: [], billingError: null };
    },
    planFeeFor: () => {
      fees++;
      return 0;
    },
  };
  const service = createBudgetService({
    getSettings: () => ({ budgets: [budget({ amount: 70, enforce: 'block' })] }),
    cost,
    now: () => NOW,
    nocase: false,
  });
  const r = createGuard({ service }).check({ keyId: 'key_a' });
  assert.ok(r && r.budget === 'team', 'the exceeded budget still blocks');
  assert.deepEqual(calls, ['2026-10-01|2026-10-31'], 'the period only');
  assert.equal(fees, 0);
});

test('under Paid, days billed as assumed are left out of the model', () => {
  // Every history day up to 3 October lost its billing: metered 50 a day, which the plan did not charge.
  const rows = ROWS.map((r) => (r.day <= '2026-10-03' ? { ...r, billedUSD: 50, billingAssumed: true } : r));
  const paid = (history) =>
    B.evaluateBudget(budget({ measure: 'billed', amount: 1000 }), { rows: ROWS, history, now: NOW });
  assert.equal(paid(rows).forecastUSD, paid(ROWS).forecastUSD, 'the model rests on 4 October onward');
  const list = B.evaluateBudget(budget({ amount: 1000 }), { rows: ROWS, history: rows, now: NOW });
  assert.equal(list.forecastUSD, 112, 'usage value does not depend on billing');
});

test('a display-currency budget: forecastUSD and runsOut against amount / rate', () => {
  const currency = { code: 'IDR', rates: [{ from: '2026-01-01', perUSD: 16000 }] };
  const v = evalAt(budget({ currency: 'IDR', amount: 110 * 16000 }), { currency });
  assert.deepEqual([v.amountUSD, v.forecastUSD, v.runsOut, v.projected], [110, 112, '2026-10-31', true]);
  const under = evalAt(budget({ currency: 'IDR', amount: 120 * 16000 }), { currency });
  assert.deepEqual([under.forecastUSD, under.runsOut, under.projected], [112, null, false]);
});

test('cost.planFeeFor: 0 while metered, the plan fee spread over the month or the year', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createCost } = require('../lib/cost');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-planfee-'));
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog: path.join(dir, 'gateway-usage.jsonl'),
    getPricing: () => ({}),
    getSettings: () => ({}),
    home: path.join(path.parse(process.cwd()).root, 'Users', 'owner'),
    now: () => NOW,
    nocase: false,
  });
  try {
    cost.update();
    const over = (source, billing) =>
      cost.addBillingOverride({ source, from: '2026-10-01', to: '2026-10-31', billing });
    over('claude', { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' });
    over('codex', { mode: 'plan', plan: 'Pro', feeUSD: 3650, period: 'year' });
    assert.equal(cost.planFeeFor('claude', '2026-10-23'), 10, '310 over 31 days');
    assert.ok(Math.abs(cost.planFeeFor('codex', '2026-10-23') - 10) < 1e-9, '3650 over 365 days');
    assert.equal(cost.planFeeFor('gateway', '2026-10-23'), 0, 'metered');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
