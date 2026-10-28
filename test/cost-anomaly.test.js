// Cost Control 4a: lib/cost/anomaly.js, a day's usage value against its weekday and the values that rose the most.
// Pure: rows in, figures out, no clock. 28 October 2026 is a Wednesday, the 27th a Tuesday.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/cost/anomaly');
const F = require('../lib/cost/forecast');
const { daysBetween } = require('../lib/cost/days');

const row = (day, over = {}) => ({
  day,
  source: 'claude',
  model: 'claude-sonnet-5-5',
  project: '~/a',
  center: 'platform',
  keyId: null,
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const gw = (day, over = {}) =>
  row(day, { source: 'gateway', model: 'deepseek-chat', project: null, center: 'client', keyId: 'key_a', ...over });
const plan = (day) => row(day, { kind: 'plan', model: null, project: null, center: null, listUSD: 0, billedUSD: 7 });
// Every day of [from, to]: Sonnet on ~/a (1) and DeepSeek through key_a (1), and a plan fee that is not usage.
const usual = (from, to) => daysBetween(from, to).flatMap((d) => [row(d), gw(d), plan(d)]);
const series = (rows) => rows.filter((r) => r.kind !== 'plan').map((r) => ({ day: r.day, usd: r.listUSD }));
const modelFor = (rows, today) => F.dailyModel(series(rows), { today });
const brief = (m) => m.drivers.map((d) => [d.dim, d.value, d.extraUSD, d.share]);

test('measureDay: spent against the weekday, drivers ranked by their rise with the share capped at 1', () => {
  const history = usual('2026-09-30', '2026-10-27');
  const model = modelFor(history, '2026-10-28');
  // Sonnet is quiet today; Opus on ~/acme-web (client) and a new key bring 8 more.
  const today = [
    gw('2026-10-28'),
    row('2026-10-28', { model: 'claude-opus-5-5', project: '~/acme-web', center: 'client', listUSD: 6 }),
    gw('2026-10-28', { keyId: 'key_b', listUSD: 2 }),
    plan('2026-10-28'),
  ];
  const m = A.measureDay(today, { model, day: '2026-10-28', partial: true, history });
  assert.deepEqual([m.day, m.partial, m.spentUSD, m.expectedUSD], ['2026-10-28', true, 9, 2]);
  // client 9 − 1 = 8 (over the 7 the day rose: capped), Opus 6 and ~/acme-web 6 (a tie: model before project).
  assert.deepEqual(brief(m), [
    ['center', 'client', 8, 1],
    ['model', 'claude-opus-5-5', 6, 0.8571],
    ['project', '~/acme-web', 6, 0.8571],
  ]);
  assert.equal(A.measureDay(today, { model: null, day: '2026-10-28', history }), null, 'no model: no_data');
});

test('measureDay: a key value, ties broken by value, no drivers when the day is not over its amount', () => {
  const history = usual('2026-09-30', '2026-10-27');
  const model = modelFor(history, '2026-10-28');
  const keyed = A.measureDay([gw('2026-10-28', { keyId: 'key_b', listUSD: 5 })], { model, day: '2026-10-28', history });
  assert.equal(keyed.partial, false);
  assert.deepEqual(brief(keyed), [
    ['keyId', 'key_b', 5, 1],
    ['model', 'deepseek-chat', 4, 1],
    ['center', 'client', 4, 1],
  ]);
  const calm = A.measureDay([row('2026-10-28'), gw('2026-10-28')], { model, day: '2026-10-28', history });
  assert.deepEqual([calm.spentUSD, calm.expectedUSD, calm.drivers], [2, 2, []]);
  // Under the plain mean (3 known days of 0.5), two new models tie at 3: by value.
  const young = ['2026-10-25', '2026-10-26', '2026-10-27'].map((d) => row(d, { model: 'old', listUSD: 0.5 }));
  const tie = A.measureDay(
    [
      row('2026-10-28', { model: 'b-model', project: null, center: null, keyId: 'key_z', listUSD: 3 }),
      row('2026-10-28', { model: 'a-model', project: null, center: null, keyId: 'key_y', listUSD: 3 }),
    ],
    { model: modelFor(young, '2026-10-28'), day: '2026-10-28', history: young },
  );
  assert.deepEqual(brief(tie), [
    ['center', 'unassigned', 6, 1],
    ['model', 'a-model', 3, 0.5455],
    ['model', 'b-model', 3, 0.5455],
  ]);
});

test('isAnomaly: over ratio × expected and at least minUSD over it; an expected 0 needs minUSD', () => {
  const m = (spentUSD, expectedUSD) => ({ spentUSD, expectedUSD });
  assert.equal(A.isAnomaly(m(4, 2)), false, 'exactly twice is not over');
  assert.equal(A.isAnomaly(m(4.01, 2)), true);
  assert.equal(A.isAnomaly(m(1.5, 0.5)), true, 'exactly $1 over');
  assert.equal(A.isAnomaly(m(1.49, 0.5)), false, 'three times, but not $1 over');
  assert.equal(A.isAnomaly(m(1, 0)), true);
  assert.equal(A.isAnomaly(m(0.99, 0)), false);
  assert.equal(A.isAnomaly(m(6, 2), { ratio: 3, minUSD: 0.5 }), false);
  assert.equal(A.isAnomaly(m(6.5, 2), { ratio: 3, minUSD: 0.5 }), true);
  assert.equal(A.isAnomaly(m(4.01, 2), { ratio: 0, minUSD: -1 }), true, 'bad parameters take the defaults');
  assert.equal(A.isAnomaly(null), false);
  assert.deepEqual(A.anomalyParams({ ratio: 3 }), { ratio: 3, minUSD: 1 });
  assert.deepEqual(A.anomalyParams({ ratio: '3', minUSD: 0 }), { ratio: 2, minUSD: 1 });
  assert.deepEqual(A.anomalyParams(null), { ratio: 2, minUSD: 1 });
});

test('recentDays: yesterday whole and today so far, each against the 4 weeks before it; plan fees left out', () => {
  const rows = [
    ...usual('2026-09-29', '2026-10-27'),
    row('2026-10-27', { model: 'claude-opus-5-5', project: '~/acme-web', center: 'client', listUSD: 9 }),
    row('2026-10-28'),
    plan('2026-10-28'),
  ];
  const r = A.recentDays(rows, { today: '2026-10-28' });
  assert.deepEqual(
    [r.yesterday.day, r.yesterday.partial, r.yesterday.spentUSD, r.yesterday.expectedUSD],
    ['2026-10-27', false, 11, 2],
  );
  assert.equal(A.isAnomaly(r.yesterday), true);
  assert.deepEqual(brief(r.yesterday), [
    ['model', 'claude-opus-5-5', 9, 1],
    ['project', '~/acme-web', 9, 1],
    ['center', 'client', 9, 1],
  ]);
  // Today's Wednesday model holds the spike of Tuesday the 27th, which is not a Wednesday.
  assert.deepEqual([r.today.day, r.today.partial, r.today.spentUSD, r.today.expectedUSD], ['2026-10-28', true, 1, 2]);
  assert.equal(A.isAnomaly(r.today), false);
  assert.deepEqual(A.recentDays(rows, { today: '2026-10-28', unread: ['2026-10'] }), { today: null, yesterday: null });
  const young = [row('2026-10-27'), row('2026-10-28')];
  assert.deepEqual(A.recentDays(young, { today: '2026-10-28' }), { today: null, yesterday: null });
  assert.equal(A.HISTORY_DAYS, 29);
});

test('measureDay: no drivers when spent and expected are equal once rounded', () => {
  const history = daysBetween('2026-09-30', '2026-10-27').map((d) => row(d, { model: 'a', listUSD: 0.3 }));
  const model = modelFor(history, '2026-10-28');
  const m = A.measureDay(
    [row('2026-10-28', { model: 'a', listUSD: 0.1 }), row('2026-10-28', { model: 'b', listUSD: 0.2 })],
    { model, day: '2026-10-28', history },
  );
  assert.deepEqual([m.spentUSD, m.expectedUSD, m.drivers], [0.3, 0.3, []]);
});

test('measureDay: a weekday with no known day uses all known days; days outside the model stay out of the baseline', () => {
  // A weekday model (as an unread month can leave) whose known days hold no Wednesday; the 50 on Wednesday the 21st
  // is not a known day, so it must not enter the baseline.
  const days = ['2026-10-19', '2026-10-20', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
  const history = [
    ...days.map((d) => row(d, { model: 'a', listUSD: 1 })),
    row('2026-10-21', { model: 'a', listUSD: 50 }),
  ];
  const model = { method: 'weekday', known: 6, byWeekday: Array(7).fill(1), mean: 1, low: 1, high: 1, days };
  const m = A.measureDay(
    [row('2026-10-28', { model: 'a', listUSD: 3 }), row('2026-10-28', { model: 'z', listUSD: 2 })],
    { model, day: '2026-10-28', history },
  );
  assert.deepEqual(brief(m), [
    ['project', '~/a', 4, 1],
    ['center', 'platform', 4, 1],
    ['model', 'a', 2, 0.5],
  ]);
});
