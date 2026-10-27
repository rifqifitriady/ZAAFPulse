// Cost Control 3a: lib/cost/views.js (what the Cost Control pages draw) and the ledger's cacheSaved. Pure: rows in,
// numbers out, no clock and no files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('../lib/cost/views');
const { createCost } = require('../lib/cost');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: '~/acme-web',
  center: 'platform',
  keyId: null,
  agent: null,
  kind: 'chat',
  requests: 1,
  tokens: { in: 100, out: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  priceVersion: 1,
  unpriced: false,
  free: false,
  ...over,
});
const planRow = (day, billedUSD, source = 'claude') => ({
  ...row({ day, source, provider: null, model: null, project: null, center: null, kind: 'plan', requests: 0 }),
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  plan: 'Claude Max',
  listUSD: 0,
  billedUSD,
});
const budget = (over = {}) => ({
  id: 'b',
  name: 'B',
  scope: 'global',
  period: 'month',
  amount: 100,
  currency: 'USD',
  state: 'ok',
  projected: false,
  percent: 10,
  amountUSD: 100,
  ...over,
});
// Five days of October: 1, 2, 3, 4 and 10 USD of usage value, each billed at half, and a plan fee of 3 on the 1st.
const FIVE = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v, billedUSD: v / 2 }));

test('overview: month to date in both measures, the forecast at the mean day and the band from the quartiles', () => {
  const o = V.overview({ rows: [...FIVE, planRow('2026-10-01', 3)], today: '2026-10-05' });
  assert.deepEqual(o.month, { from: '2026-10-01', to: '2026-10-31', today: '2026-10-05', day: 5, days: 31 });
  assert.deepEqual(o.spent, { list: 20, billed: 13 }, 'a plan fee is paid, never usage value');
  assert.equal(o.total, 20);
  assert.deepEqual(
    o.daily.map((d) => [d.day, d.spend, d.cum]),
    [
      ['2026-10-01', 1, 1],
      ['2026-10-02', 2, 3],
      ['2026-10-03', 3, 6],
      ['2026-10-04', 4, 10],
      ['2026-10-05', 10, 20],
    ],
  );
  // Mean 4 a day for the 26 days left; the 25th and 75th percentile days are 2 and 4.
  assert.deepEqual([o.forecast.perDay, o.forecast.projected, o.forecast.low, o.forecast.high], [4, 124, 72, 124]);
  assert.equal(o.forecast.early, false);
  assert.equal(o.forecast.line.length, 27, 'today and each day left');
  assert.deepEqual(o.forecast.line[0], { day: '2026-10-05', cum: 20, low: 20, high: 20 });
  assert.deepEqual(o.forecast.line[26], { day: '2026-10-31', cum: 124, low: 72, high: 124 });
  const paid = V.overview({ rows: [...FIVE, planRow('2026-10-01', 3)], today: '2026-10-05', measure: 'billed' });
  assert.equal(paid.total, 13);
  assert.equal(paid.daily[0].spend, 3.5, 'the plan fee is on its day');
});

test('overview: fewer than 3 days has no band, only the forecast line, marked early', () => {
  const o = V.overview({ rows: FIVE.slice(0, 2), today: '2026-10-02' });
  assert.deepEqual([o.forecast.early, o.forecast.low, o.forecast.high], [true, null, null]);
  assert.equal(o.forecast.projected, 1.5 * 31);
  assert.ok(o.forecast.line.every((p) => p.low === null && p.high === null));
});

test('overview: converted per day; a day without a rate counts in USD and is named', () => {
  const rateOf = (day) => (day <= '2026-10-03' ? 16000 : day === '2026-10-04' ? null : 16500);
  const o = V.overview({ rows: FIVE, today: '2026-10-05', rateOf, currency: 'IDR' });
  assert.equal(o.total, 6 * 16000 + 4 + 10 * 16500);
  assert.deepEqual(o.missingRate, ['2026-10-04']);
  assert.deepEqual(V.overview({ rows: FIVE, today: '2026-10-05' }).missingRate, []);
});

test('overview: budget lines are the global monthly budgets in the chosen currency; one without a rate is skipped', () => {
  const budgets = [
    budget({ id: 'usd', name: 'Team USD', amount: 100 }),
    budget({ id: 'idr', name: 'Team IDR', amount: 1650000, currency: 'IDR' }),
    budget({ id: 'week', period: 'week' }),
    budget({ id: 'center', scope: { dim: 'center', value: 'platform' } }),
    budget({ id: 'eur', amount: 90, currency: 'EUR' }),
  ];
  const display = { code: 'IDR', rate: 16500 };
  const usd = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display });
  assert.deepEqual(usd.budgetLines, [
    { id: 'usd', name: 'Team USD', amount: 100 },
    { id: 'idr', name: 'Team IDR', amount: 100 },
  ]);
  assert.equal(usd.budgetsSkipped, 1);
  const idr = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display, currency: 'IDR', rateOf: () => 16500 });
  assert.deepEqual(
    idr.budgetLines.map((l) => l.amount),
    [1650000, 1650000],
  );
  const noRate = V.overview({ rows: FIVE, today: '2026-10-05', budgets, display: { code: 'IDR', rate: null } });
  assert.deepEqual(
    noRate.budgetLines.map((l) => l.id),
    ['usd'],
  );
  assert.deepEqual(V.overview({ rows: FIVE, today: '2026-10-05' }).budgetLines, []);
});

test('overview: a spike is over twice its 7-day baseline and at least $1 over it, the days before the 1st included', () => {
  const before = ['24', '25', '26', '27', '28', '29', '30'].map((d) => row({ day: `2026-09-${d}`, listUSD: 0.2 }));
  const rows = [
    row({ day: '2026-10-01', listUSD: 0.5 }), // 2.5 × its baseline, but only $0.30 over it
    row({ day: '2026-10-02', listUSD: 1, model: 'claude-opus-5-5' }),
    row({ day: '2026-10-02', listUSD: 2, model: 'claude-sonnet-5-5' }),
    row({ day: '2026-10-03', listUSD: 1 }),
  ];
  const o = V.overview({ rows, before, today: '2026-10-03', rateOf: () => 10, currency: 'XYZ' });
  assert.deepEqual(
    o.spikes.map((s) => [s.day, s.spike]),
    [
      ['2026-10-01', false],
      ['2026-10-02', true],
      ['2026-10-03', false],
    ],
  );
  const s = o.spikes[1];
  assert.equal(s.topModel, 'claude-sonnet-5-5');
  assert.equal(s.spend, 30, 'shown in the chosen currency');
  assert.equal(s.baseline, 2.4286, 'the mean of the 7 days before, rounded once');
  assert.equal(o.spikes[0].baseline, 2);
});

test('overview: a ledger that starts mid-month has no baseline before 3 known days; unknown days are not zeros', () => {
  const rows = [
    row({ day: '2026-10-10', listUSD: 1 }),
    row({ day: '2026-10-11', listUSD: 1 }),
    row({ day: '2026-10-12', listUSD: 10 }), // ten times its two known days, but two days are not a baseline
    row({ day: '2026-10-13', listUSD: 1 }),
    row({ day: '2026-10-14', listUSD: 20 }),
  ];
  const o = V.overview({ rows, today: '2026-10-15' });
  const by = Object.fromEntries(o.spikes.map((s) => [s.day, s]));
  for (const d of ['2026-10-01', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'])
    assert.deepEqual([by[d].baseline, by[d].spike], [null, false], d);
  assert.deepEqual([by['2026-10-13'].baseline, by['2026-10-13'].spike], [4, false], 'the mean of 3 known days');
  assert.deepEqual([by['2026-10-14'].baseline, by['2026-10-14'].spike], [3.25, true]);
  assert.equal(by['2026-10-15'].baseline, 6.6, 'five known days, the days before the first row left out');
  assert.equal(V.BASELINE_MIN, 3);
  assert.ok(V.overview({ rows: [], today: '2026-10-15' }).spikes.every((s) => s.baseline === null && !s.spike));
});

test('overview: rings riskiest first, at most 8; at-risk count and the top cost center', () => {
  const states = [
    ['ok', 10, false],
    ['warn_80', 85, false],
    ['exceeded', 120, false],
    ['ok', 40, true],
    ['no_data', null, false],
    ['warn_50', 55, false],
    ['ok', 5, false],
    ['ok', 1, false],
    ['ok', 2, false],
    ['exceeded', 101, false],
  ];
  const budgets = states.map(([state, percent, projected], i) =>
    budget({ id: `b${i}`, name: `B${i}`, state, percent, projected, period: 'week' }),
  );
  const rows = [
    row({ center: 'platform', listUSD: 3 }),
    row({ center: 'research', listUSD: 5, day: '2026-10-02' }),
    row({ center: null, source: 'gateway', listUSD: 2, day: '2026-10-02' }),
  ];
  const o = V.overview({ rows, today: '2026-10-02', budgets });
  assert.deepEqual(
    o.rings.map((r) => [r.id, r.tone]),
    [
      ['b2', 'exceeded'],
      ['b9', 'exceeded'],
      ['b3', 'ok'],
      ['b1', 'warn'],
      ['b5', 'warn'],
      ['b0', 'ok'],
      ['b6', 'ok'],
      ['b8', 'ok'],
    ],
  );
  assert.equal(o.moreBudgets, 2);
  assert.deepEqual(o.atRisk, { count: 5, total: 10 });
  assert.deepEqual(o.topCenter, { center: 'research', spend: 5, share: 0.5 });
  assert.equal(V.budgetOrder(budgets).pop().state, 'no_data', 'without data last');
  assert.equal(V.overview({ rows: [], today: '2026-10-02' }).topCenter, null);
});

test('cacheSaved: cache reads at the input price minus the cache read price of the row’s own version', () => {
  const cost = createCost({
    demo: {
      firstDay: '2026-10-01',
      rows: [],
      settings: {},
      versions: [
        {
          from: '2026-10-01',
          at: 0,
          pricing: { m: { input: 3, output: 15, cacheRead: 0.3 }, odd: { input: 1, cacheRead: 2 } },
        },
        { from: '2026-10-11', at: 0, pricing: { m: { input: 2, output: 10, cacheRead: 0.2 } } },
      ],
    },
    home: '/home/owner',
    now: () => new Date(2026, 9, 20, 12).getTime(),
  });
  const cached = (over) =>
    row({ model: 'm', tokens: { in: 0, out: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }, ...over });
  near(cost.cacheSaved(cached({ priceVersion: 1 })), 2.7);
  near(cost.cacheSaved(cached({ priceVersion: 2 })), 1.8);
  for (const [why, r] of [
    ['no version', cached({ priceVersion: null })],
    ['unpriced', cached({ priceVersion: 1, unpriced: true })],
    ['free', cached({ priceVersion: 1, free: true })],
    ['plan', cached({ priceVersion: 1, kind: 'plan' })],
    ['a model the version does not price', cached({ priceVersion: 2, model: 'odd' })],
    ['cache read dearer than input', cached({ priceVersion: 1, model: 'odd' })],
    ['no cache reads', row({ model: 'm', priceVersion: 1 })],
    ['an unknown version', cached({ priceVersion: 9 })],
  ])
    assert.equal(cost.cacheSaved(r), 0, why);
  assert.equal(cost.cacheSaved(null), 0);
  assert.equal(cost.budgetRows({ from: '2026-10-01', to: '2026-10-20' }).historyLost, false, 'the view names a loss');
});

test('overview: names that are Object.prototype keys neither crash nor pollute', () => {
  const rows = [
    row({ day: '2026-10-01', listUSD: 3, model: '__proto__', center: 'constructor' }),
    row({ day: '2026-10-02', listUSD: 2, model: 'toString', center: '__proto__' }),
  ];
  const o = V.overview({ rows, today: '2026-10-02' });
  assert.equal(o.spikes[0].topModel, '__proto__');
  assert.equal(o.spikes[1].topModel, 'toString');
  assert.equal(o.topCenter.center, 'constructor');
  assert.equal({}.spend, undefined, 'Object.prototype is untouched');
});

test('overview: missingRate lists only days with spend in the chosen measure and no rate', () => {
  const rateOf = (day) => (day >= '2026-10-04' ? 10 : null);
  const rows = [row({ day: '2026-10-05', listUSD: 2 }), row({ day: '2026-10-06', listUSD: 0, billedUSD: 4 })];
  const o = V.overview({ rows, today: '2026-10-06', rateOf, currency: 'IDR' });
  assert.deepEqual(o.missingRate, [], 'days 1-3 and 6 have no list spend; day 6 billed is the other measure');
  const o2 = V.overview({ rows: [row({ day: '2026-10-02', listUSD: 2 }), ...rows], today: '2026-10-06', rateOf });
  assert.deepEqual(o2.missingRate, ['2026-10-02']);
});

test('overview: a plan fee never makes a spike or lifts a baseline, in either measure', () => {
  const usage = [1, 2, 3, 4].map((d) => row({ day: `2026-10-0${d}`, listUSD: 1, billedUSD: 1 }));
  const o = V.overview({ rows: [...usage, planRow('2026-10-05', 200)], today: '2026-10-05', measure: 'billed' });
  assert.ok(o.spikes.every((s) => !s.spike));
  assert.equal(o.spikes[4].spend, 0, 'the spike series is usage only');
  assert.equal(o.daily[4].spend, 200, 'the burn-down still holds the fee');
  const next = V.overview({
    rows: [...usage, planRow('2026-10-05', 200), row({ day: '2026-10-06', billedUSD: 1 })],
    today: '2026-10-06',
    measure: 'billed',
  });
  assert.equal(next.spikes[5].baseline, 0.8, 'the fee is not in the baseline');
});

test('overview: the month total is the daily series sum, the share is rounded once, ties are not locale-dependent', () => {
  const rows = [
    row({ day: '2026-10-01', listUSD: 0.1 }),
    row({ day: '2026-10-02', listUSD: 0.2, center: 'b' }),
    row({ day: '2026-10-03', listUSD: 0.4, center: 'c' }),
  ];
  const o = V.overview({ rows, today: '2026-10-03', rateOf: () => 3 });
  assert.equal(o.total, o.daily[2].cum);
  assert.equal(o.topCenter.share, 0.5714);
  const b = (id, name) => budget({ id, name, percent: 10 });
  assert.deepEqual(
    V.budgetOrder([b('1', 'b'), b('2', 'B'), b('3', 'a')]).map((x) => x.name),
    ['B', 'a', 'b'],
  );
});

test('budgetRows: a lost billing history is named', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-views-'));
  const make = () =>
    createCost({
      dir: path.join(dir, 'cost'),
      gatewayLog: path.join(dir, 'gw.jsonl'),
      home: '/home/owner',
      now: () => new Date(2026, 9, 20, 12).getTime(),
    });
  const first = make();
  first.update();
  fs.writeFileSync(path.join(dir, 'cost', 'ledger-2026-10.jsonl'), `${JSON.stringify(row())}\n`);
  const file = path.join(dir, 'cost', 'billing.json');
  fs.writeFileSync(file, '{ nope');
  fs.writeFileSync(`${file}.bak`, '[]');
  assert.equal(make().budgetRows({ from: '2026-10-01', to: '2026-10-20' }).historyLost, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
