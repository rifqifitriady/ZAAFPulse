// Cost Control 4a: the Overview with the forecast and the anomalies (lib/cost/views.js overview) and what
// GET /api/cost/view and GET /api/cost/budgets answer with them (lib/cost/api.js), in-process with fake readers.
// Thursday 22 October 2026: the 21st is a Wednesday, the weekend days are Saturdays and Sundays.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');
const A = require('../lib/cost/anomaly');
const F = require('../lib/cost/forecast');
const { createCostApi } = require('../lib/cost/api');
const { createBudgetService } = require('../lib/cost/budget-service');
const { daysBetween } = require('../lib/cost/days');

const NOW = new Date(2026, 9, 22, 15).getTime();
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'client',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const weekly = (d) => (F.weekday(d) >= 5 ? 10 : 1);
// Weekdays 1 and weekend days 10 from 2 September (29 days before the 1st) to yesterday; 0.5 today so far.
const PATTERN = [
  ...daysBetween('2026-09-02', '2026-10-21').map((d) => row(d, { listUSD: weekly(d), billedUSD: weekly(d) })),
  row('2026-10-22', { listUSD: 0.5, billedUSD: 0.5 }),
];
const split = (rows) => ({
  history: rows.filter((r) => r.day < '2026-10-01'),
  rows: rows.filter((r) => r.day >= '2026-10-01'),
});

test('overview: the burn-down follows the weekday model; the method is named; currency converts day by day', () => {
  const o = V.overview({ ...split(PATTERN), today: '2026-10-22' });
  assert.equal(o.forecastMethod, 'weekday');
  assert.equal(o.total, 75.5);
  // Today is forecast at 1, then 3 weekend days and 6 weekdays: 76 + 36. Every day was as expected: no spread.
  assert.deepEqual(o.forecast.line[0], { day: '2026-10-22', cum: 76, low: 76, high: 76 });
  assert.deepEqual(o.forecast.line[2], { day: '2026-10-24', cum: 87, low: 87, high: 87 }, 'a Saturday');
  assert.deepEqual(
    [o.forecast.projected, o.forecast.low, o.forecast.high, o.forecast.early, o.forecast.perDay],
    [112, 112, 112, false, 4],
  );
  const idr = V.overview({ ...split(PATTERN), today: '2026-10-22', rateOf: () => 10, currency: 'IDR' });
  assert.equal(idr.forecast.projected, 1120);
  // A month of the history that did not read is unknown: the model rests on October, the same weekday means here.
  const unread = V.overview({ ...split(PATTERN), today: '2026-10-22', unread: ['2026-09'] });
  assert.deepEqual([unread.forecastMethod, unread.forecast.projected], ['weekday', 112]);
});

test('overview: the plain mean with little history, the old line without a model, nothing without a history', () => {
  const five = [1, 2, 3, 4, 10].map((v, i) => row(`2026-10-0${i + 1}`, { listUSD: v, billedUSD: v / 2 }));
  const m = V.overview({ rows: five, today: '2026-10-05' });
  // Four known days, mean 2.5, day ratios 0.4 to 1.6 (band 0.7 to 1.3); today's 10 is past its 2.5 already.
  assert.equal(m.forecastMethod, 'mean');
  assert.deepEqual([m.forecast.perDay, m.forecast.projected, m.forecast.low, m.forecast.high], [2.5, 85, 65.5, 104.5]);
  const young = V.overview({ rows: five.slice(0, 2), today: '2026-10-02' });
  assert.deepEqual([young.forecastMethod, young.forecast.early, young.forecast.projected], [null, true, 46.5]);
  assert.ok(young.forecast.line.every((p) => p.low === null && p.high === null));
  const lost = V.overview({ rows: split(PATTERN).rows, history: null, today: '2026-10-22' });
  assert.deepEqual([lost.forecastMethod, lost.anomalies, lost.forecast.early], [null, null, true]);
  assert.ok(lost.spikes.every((s) => s.baseline === null && !s.spike));
});

test('overview: under Paid each day to come adds the plan fees; today’s is in the spend already', () => {
  const rows = [
    ...daysBetween('2026-10-01', '2026-10-05').map((d) => row(d, { listUSD: 2, billedUSD: 1 })),
    ...daysBetween('2026-10-01', '2026-10-05').map((d) => ({
      ...row(d, { source: 'claude', provider: null, model: null, center: null, keyId: null, kind: 'plan' }),
      listUSD: 0,
      billedUSD: 3,
    })),
  ];
  const asked = new Set();
  const planFee = (source, day) => {
    asked.add(day);
    return source === 'claude' ? 3 : 0;
  };
  const o = V.overview({ rows, today: '2026-10-05', measure: 'billed', planFee });
  // Paid 5 × 4 = 20; today's usage (1) is as expected; 26 days × (1 + 3).
  assert.deepEqual([o.total, o.forecast.projected], [20, 124]);
  assert.ok(!asked.has('2026-10-05') && asked.has('2026-10-31'));
  assert.equal(V.overview({ rows, today: '2026-10-05', planFee }).forecast.projected, 62, 'usage value: no fee');
});

test('overview: a spike is isAnomaly with the passed parameters, against its weekday in the 4 weeks before it', () => {
  const history = daysBetween('2026-09-02', '2026-09-30').map((d) => row(d, { listUSD: 0.2 }));
  const rows = [
    row('2026-10-01', { listUSD: 0.5 }), // 2.5 × its usual 0.2, but only $0.30 over it
    row('2026-10-02', { listUSD: 1, model: 'claude-opus-5-5' }),
    row('2026-10-02', { listUSD: 2, model: 'claude-sonnet-5-5' }),
    row('2026-10-03', { listUSD: 1 }),
  ];
  const at = (anomalyParams) =>
    V.overview({ rows, history, today: '2026-10-03', rateOf: () => 10, currency: 'XYZ', anomalyParams });
  const o = at(null);
  assert.deepEqual(
    o.spikes.map((s) => [s.day, s.spike, s.baseline]),
    [
      ['2026-10-01', false, 2],
      ['2026-10-02', true, 2],
      ['2026-10-03', false, 2],
    ],
    'the baseline is the usual amount, in the chosen currency',
  );
  assert.deepEqual([o.spikes[1].spend, o.spikes[1].topModel], [30, 'claude-sonnet-5-5']);
  assert.deepEqual(o.anomalyParams, { ratio: 2, minUSD: 1 });
  const keen = at({ ratio: 2, minUSD: 0.25 });
  assert.deepEqual(
    keen.spikes.map((s) => s.spike),
    [true, true, true],
  );
  assert.deepEqual(keen.anomalyParams, { ratio: 2, minUSD: 0.25 });
  assert.deepEqual(
    at({ ratio: 20 }).spikes.map((s) => s.spike),
    [false, false, false],
  );
  assert.deepEqual(at({ ratio: -1, minUSD: 'x' }).anomalyParams, { ratio: 2, minUSD: 1 });
  for (const p of [null, { ratio: 2, minUSD: 0.25 }, { ratio: 20 }])
    for (const s of at(p).spikes)
      assert.equal(s.spike, A.isAnomaly({ spentUSD: s.spend / 10, expectedUSD: s.baseline / 10 }, p), s.day);
});

test('overview: anomalies for today and yesterday, drivers labelled with the key name', () => {
  // Every day Sonnet on ~/a (1) and DeepSeek through key_a (1); on Wednesday the 21st a new key spends 6 more.
  const base = daysBetween('2026-09-02', '2026-10-21').flatMap((d) => [
    row(d, { source: 'claude', model: 'claude-sonnet-5-5', project: '~/a', center: 'platform', keyId: null }),
    row(d),
  ]);
  const all = [
    ...base,
    row('2026-10-21', { keyId: 'key_b', listUSD: 6 }),
    row('2026-10-22', {
      source: 'claude',
      model: 'claude-sonnet-5-5',
      project: '~/a',
      center: 'platform',
      keyId: null,
    }),
  ];
  const keyNames = new Map([['key_b', 'Acme client']]);
  const o = V.overview({ ...split(all), today: '2026-10-22', keyNames });
  const y = o.anomalies.yesterday;
  assert.deepEqual([y.day, y.partial, y.spentUSD, y.expectedUSD, y.anomaly], ['2026-10-21', false, 8, 2, true]);
  assert.deepEqual(
    y.drivers.map((d) => [d.dim, d.value, d.label, d.extraUSD, d.share]),
    [
      ['model', 'deepseek-chat', 'deepseek-chat', 6, 1],
      ['center', 'client', 'client', 6, 1],
      ['keyId', 'key_b', 'Acme client', 6, 1],
    ],
  );
  const t = o.anomalies.today;
  assert.deepEqual(
    [t.day, t.partial, t.spentUSD, t.expectedUSD, t.anomaly, t.drivers],
    ['2026-10-22', true, 1, 2, false, []],
  );
  const unnamed = V.overview({ ...split(all), today: '2026-10-22' }).anomalies.yesterday.drivers;
  assert.equal(unnamed[2].label, 'key_b', 'a key without a name shows its id');
  assert.equal(
    V.overview({ ...split(all), today: '2026-10-22', anomalyParams: { ratio: 5 } }).anomalies.yesterday.anomaly,
    false,
  );
});

// The API with a fake ledger: the month and the history are cut from one list of rows.
function api({ rows = PATTERN, failHistory = false, anomalyParams, historyUnread = [], fee = () => 0 } = {}) {
  const asked = [];
  const cost = {
    budgetRows: ({ from, to }) => {
      asked.push(`${from}|${to}`);
      if (failHistory && to < '2026-10-01') throw new Error('unreadable');
      const out = rows.filter((r) => r.day >= from && r.day <= to);
      return { rows: out, unread: to < '2026-10-01' ? historyUnread : [], billingError: null, historyLost: false };
    },
    planFeeFor: fee,
  };
  const budgets = createBudgetService({
    getSettings: () => ({
      budgets: [{ id: 'team', name: 'Team', scope: 'global', period: 'month', amount: 110 }],
    }),
    cost,
    now: () => NOW,
    nocase: false,
  });
  const a = createCostApi({
    cost,
    settings: { get: () => ({}), save: () => {} },
    listKeys: () => [{ id: 'key_b', name: 'Acme client' }],
    now: () => NOW,
    budgets,
    anomalyParams,
  });
  const get = (path, query = '') => a.route({ method: 'GET', path, query: new URLSearchParams(query) });
  return { get, asked };
}

test('GET /api/cost/view: the Overview gains forecastMethod, anomalies and anomalyParams from the history', async () => {
  const s = api({ anomalyParams: () => ({ ratio: 3 }) });
  const r = await s.get('/api/cost/view', 'page=overview');
  assert.equal(r.status, 200);
  assert.ok(s.asked.includes('2026-09-02|2026-09-30'), 'the 29 days before the 1st');
  assert.equal(r.body.forecastMethod, 'weekday');
  assert.equal(r.body.forecast.projected, 112);
  assert.deepEqual(r.body.anomalyParams, { ratio: 3, minUSD: 1 });
  assert.equal(r.body.anomalies.yesterday.day, '2026-10-21');
  assert.equal(r.body.anomalies.today.partial, true);
  assert.equal(r.body.rings[0].runsOut, '2026-10-31', 'a ring carries its budget’s runs-out date');
  const thrown = api({
    anomalyParams: () => {
      throw new Error('no state');
    },
  });
  assert.deepEqual((await thrown.get('/api/cost/view', 'page=overview')).body.anomalyParams, { ratio: 2, minUSD: 1 });
});

test('GET /api/cost/view: a history that does not read leaves the forecast and the anomalies out, not the page', async () => {
  const r = await api({ failHistory: true }).get('/api/cost/view', 'page=overview');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.forecastMethod, r.body.anomalies, r.body.forecast.early], [null, null, true]);
  assert.deepEqual(r.body.unread, []);
  assert.equal(r.body.total, 75.5);
});

test('GET /api/cost/budgets: each view gains forecastUSD and runsOut', async () => {
  const r = await api().get('/api/cost/budgets');
  assert.equal(r.status, 200);
  const team = r.body.budgets.find((b) => b.id === 'team');
  assert.deepEqual([team.forecastUSD, team.runsOut, team.projected], [112, '2026-10-31', true]);
});

test('overview: a month that did not read is unknown, never a run of zero days', () => {
  const history = PATTERN.filter((r) => r.day < '2026-10-01');
  const o = V.overview({ rows: [], history, today: '2026-10-22', unread: ['2026-10'] });
  // Thursday the 22nd to Saturday the 31st at the weekday pattern: 1 + 1 + 10 + 10 + 5 + 10 = 37.
  assert.equal(o.forecastMethod, 'weekday');
  assert.equal(o.forecast.projected, 37, 'zero days from the unread month would make it 9.25');
  assert.equal(o.anomalies.yesterday, null, 'a day of an unread month has no figure');
});

test('overview: the currency converts day by day, the forecast too', () => {
  const rateOf = (d) => (d < '2026-10-25' ? 10 : 20);
  const o = V.overview({ ...split(PATTERN), today: '2026-10-22', rateOf, currency: 'XYZ' });
  // 75.5 spent at 10 = 755; the 22nd to the 24th add 0.5 + 1 + 10 USD at 10; the 25th to the 31st add 25 USD at 20.
  assert.equal(o.forecast.projected, 1370, 'not 1120, the whole month at the first rate');
});

test('overview: spikes and the top model use the usage value whatever the measure', () => {
  const history = daysBetween('2026-09-02', '2026-09-30').map((d) => row(d, { listUSD: 0.2, billedUSD: 7 }));
  const rows = [
    row('2026-10-01', { listUSD: 0.5, billedUSD: 9 }),
    row('2026-10-02', { listUSD: 1, billedUSD: 0.1, model: 'claude-opus-5-5' }),
    row('2026-10-02', { listUSD: 2, billedUSD: 0, model: 'claude-sonnet-5-5' }),
    row('2026-10-03', { listUSD: 1, billedUSD: 5 }),
  ];
  const at = (measure) => V.overview({ rows, history, today: '2026-10-03', measure }).spikes;
  assert.deepEqual(at('billed'), at('list'));
  assert.deepEqual(
    at('billed').map((s) => [s.day, s.spend, s.baseline, s.spike, s.topModel]),
    [
      ['2026-10-01', 0.5, 0.2, false, 'deepseek-chat'],
      ['2026-10-02', 3, 0.2, true, 'claude-sonnet-5-5'],
      ['2026-10-03', 1, 0.2, false, 'deepseek-chat'],
    ],
  );
});

test('overview: a day whose 4 weeks before it did not read has no baseline and is no spike', () => {
  const rows = [row('2026-10-01', { listUSD: 50 }), row('2026-10-02', { listUSD: 50 })];
  const history = daysBetween('2026-09-02', '2026-09-30').map((d) => row(d, { listUSD: 0.2 }));
  const o = V.overview({ rows, history, today: '2026-10-02', unread: ['2026-09'] });
  assert.ok(o.spikes.every((s) => s.baseline === null && s.spike === false));
});

test('GET /api/cost/view: the history’s unread months, the plan fees and the key names reach the Overview', async () => {
  const unread = await api({ historyUnread: ['2026-09'] }).get('/api/cost/view', 'page=overview');
  assert.deepEqual(unread.body.unread, ['2026-09']);
  const fee = (source, day) => (source === 'claude' && day > '2026-10-22' ? 3 : 0);
  const paid = await api({ fee }).get('/api/cost/view', 'page=overview&measure=billed');
  // 75.5 + today's missing 0.5 + 9 more days at 1 or 10 (36) = 112, and 9 days × 3 for the plan.
  assert.equal(paid.body.forecast.projected, 139);
  const rows = [...PATTERN, row('2026-10-21', { keyId: 'key_b', listUSD: 6, billedUSD: 6 })];
  const r = await api({ rows }).get('/api/cost/view', 'page=overview');
  assert.equal(r.body.anomalies.yesterday.drivers.find((d) => d.dim === 'keyId').label, 'Acme client');
});
