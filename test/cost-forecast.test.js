// Cost Control 4a: lib/cost/forecast.js, the forecast every cost figure uses. Pure: rows in, numbers out, no clock.
// October 2026 starts on a Thursday: the 26th is a Monday and the 29th a Thursday.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/cost/forecast');
const { addDays, daysBetween } = require('../lib/cost/days');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} is not ${b}`);
const at = (day, usd) => ({ day, usd });
// Values from `from` on, one row a day.
const series = (from, values) => values.map((v, i) => at(addDays(from, i), v));

test('weekday: Monday is 0 and Sunday 6, whatever the time zone', () => {
  assert.deepEqual(['2026-10-26', '2026-10-28', '2026-11-01', '2026-03-29'].map(F.weekday), [0, 2, 6, 6]);
});

test('dailyModel: a mean per weekday over the 4 weeks of finished days before today', () => {
  // 1-28 October, 4 of each weekday: the Mondays 8, 12, 10 and 10, every other day 1; an older row makes them known.
  const rows = [at('2026-09-01', 50)];
  for (const day of daysBetween('2026-10-01', '2026-10-28'))
    rows.push(at(day, F.weekday(day) === 0 ? { '2026-10-05': 8, '2026-10-12': 12 }[day] || 10 : 1));
  rows.push(at('2026-10-29', 500)); // today is not a finished day
  const m = F.dailyModel(rows, { today: '2026-10-29' });
  assert.equal(m.method, 'weekday');
  assert.equal(m.known, 28);
  assert.deepEqual(m.byWeekday, [10, 1, 1, 1, 1, 1, 1]);
  near(m.mean, 64 / 28);
  assert.deepEqual([m.low, m.high], [1, 1], 'the 25th and 75th percentile day is as expected');
  assert.equal(m.days.length, 28);
  assert.deepEqual([m.days[0], m.days[27]], ['2026-10-01', '2026-10-28']);
  assert.equal(F.dailyModel(rows, { today: '2026-10-29', weeks: 1 }).known, 7, 'weeks sets the window');
});

test('dailyModel: 3 to 6 known days give the plain mean, fewer give no model', () => {
  const m = F.dailyModel(series('2026-10-24', [1, 2, 3, 4, 10]), { today: '2026-10-29' });
  assert.equal(m.method, 'mean');
  assert.equal(m.known, 5);
  assert.equal(m.mean, 4);
  assert.deepEqual(m.byWeekday, [4, 4, 4, 4, 4, 4, 4]);
  // Ratios 0.25, 0.5, 0.75, 1 and 2.5.
  assert.deepEqual([m.low, m.high], [0.5, 1]);
  assert.equal(F.dailyModel(series('2026-10-26', [1, 1, 1]), { today: '2026-10-29' }).method, 'mean');
  assert.equal(F.dailyModel(series('2026-10-27', [5, 5]), { today: '2026-10-29' }), null, 'two known days');
  assert.equal(F.dailyModel([], { today: '2026-10-29' }), null);
  assert.equal(F.dailyModel([at('2026-10-29', 9)], { today: '2026-10-29' }), null, 'a ledger that began today');
});

test('dailyModel: days before the first row are unknown, an empty day inside the span is a zero', () => {
  // Rows on Tuesday the 20th and Sunday the 25th only: 20-28 October are 9 known days, 7 of them zeros.
  const m = F.dailyModel([at('2026-10-20', 5), at('2026-10-25', 3)], { today: '2026-10-29' });
  assert.equal(m.method, 'weekday');
  assert.equal(m.known, 9);
  assert.deepEqual(m.days, daysBetween('2026-10-20', '2026-10-28'));
  near(m.mean, 8 / 9);
  // Tuesdays 20 (5) and 27 (0); Sunday 25 (3); every other weekday has only zeros.
  assert.deepEqual(m.byWeekday, [0, 2.5, 0, 0, 0, 0, 3]);
});

test('dailyModel: a month that did not read is unknown, not zero; a folder or corrections problem gives none', () => {
  const rows = series('2026-09-01', Array(34).fill(1)); // 1 September to 4 October
  const m = F.dailyModel(rows, { today: '2026-10-05', unread: ['2026-09'] });
  assert.equal(m.known, 4, 'only 1-4 October count');
  assert.equal(m.method, 'mean');
  assert.equal(F.dailyModel(rows, { today: '2026-10-05' }).known, 28);
  assert.equal(F.dailyModel(rows, { today: '2026-10-05', unread: ['folder'] }), null);
  assert.equal(F.dailyModel(rows, { today: '2026-10-05', unread: ['corrections'] }), null);
});

test('dailyModel: the band is clamped to 0 and 10, and is 1 with fewer than 3 ratios', () => {
  // Credits can make a day negative. Mean 2: ratios -50, -50, 0.5, 25.5 and 79.
  const wide = F.dailyModel(series('2026-10-24', [-100, -100, 1, 51, 158]), { today: '2026-10-29' });
  assert.deepEqual([wide.low, wide.high], [0, 10]);
  // Nothing expected on any day: no ratio at all.
  const zero = F.dailyModel(series('2026-10-26', [0, 0, 0]), { today: '2026-10-29' });
  assert.deepEqual([zero.mean, zero.low, zero.high], [0, 1, 1]);
});

test('project: today never below what it spent, each later day at its weekday, plan fees exact, band on usage', () => {
  const m = F.dailyModel(series('2026-10-24', [1, 2, 3, 4, 10]), { today: '2026-10-29' }); // 4 a day, band 0.5-1
  const line = F.project(m, { today: '2026-10-29', spentSoFar: 50, todaySoFar: 1, to: '2026-10-31' });
  assert.deepEqual(line, [
    { day: '2026-10-29', cum: 53, low: 51, high: 53 },
    { day: '2026-10-30', cum: 57, low: 53, high: 57 },
    { day: '2026-10-31', cum: 61, low: 55, high: 61 },
  ]);
  const over = F.project(m, { today: '2026-10-29', spentSoFar: 50, todaySoFar: 6, to: '2026-10-29' });
  assert.deepEqual(over, [{ day: '2026-10-29', cum: 50, low: 50, high: 50 }], 'today already passed its forecast');
  const fees = F.project(m, {
    today: '2026-10-29',
    spentSoFar: 50,
    todaySoFar: 1,
    to: '2026-10-31',
    planPerDay: (day) => (day === '2026-10-31' ? 2.5 : 1),
  });
  assert.deepEqual(
    fees.map((p) => [p.cum, p.low, p.high]),
    [
      [53, 51, 53],
      [58, 54, 58],
      [64.5, 58.5, 64.5],
    ],
    "today's fee is in spentSoFar already; each later day adds its own, unscaled",
  );
  assert.deepEqual(F.project(null, { today: '2026-10-29', to: '2026-10-31' }), []);
  assert.deepEqual(F.project(m, { today: '2026-10-29', to: '2026-10-28' }), []);
  const tenths = { byWeekday: Array(7).fill(0.2), low: 1, high: 1 };
  assert.deepEqual(
    F.project(tenths, { today: '2026-10-29', spentSoFar: 0.1, to: '2026-10-31' }).map((p) => p.cum),
    [0.3, 0.5, 0.7],
    'rounded to 8 decimals',
  );
});

test('runsOut: the first day past the amount; equal is not past; amounts that are not positive numbers', () => {
  const line = [
    { day: '2026-10-29', cum: 10 },
    { day: '2026-10-30', cum: 20 },
    { day: '2026-10-31', cum: 30 },
  ];
  assert.equal(F.runsOut(line, 5), '2026-10-29');
  assert.equal(F.runsOut(line, 19.99), '2026-10-30');
  assert.equal(F.runsOut(line, 20), '2026-10-31', 'exactly the amount is not passed');
  assert.equal(F.runsOut(line, 30), null);
  for (const bad of [0, -1, NaN, Infinity, '20', null, undefined])
    assert.equal(F.runsOut(line, bad), null, String(bad));
  assert.equal(F.runsOut([], 5), null);
  assert.equal(F.runsOut(null, 5), null);
});

test('dailyModel: the band always contains the forecast line, even for spiky usage', () => {
  // Mean 2: ratios 0, 0, 0, 0 and 5, so the 75th percentile alone would be 0.
  const m = F.dailyModel(series('2026-10-25', [0, 0, 0, 0, 10]), { today: '2026-10-30' });
  assert.equal(m.method, 'mean');
  assert.ok(m.low <= 1 && 1 <= m.high, `${m.low}-${m.high}`);
  for (const p of F.project(m, { today: '2026-10-30', spentSoFar: 5, to: '2026-11-05' }))
    assert.ok(p.low <= p.cum && p.cum <= p.high, p.day);
});

test('project: a negative weekday expectation counts as 0, so the band never flips', () => {
  const m = { byWeekday: Array(7).fill(-2), low: 0.5, high: 2 };
  const line = F.project(m, { today: '2026-10-29', spentSoFar: 10, to: '2026-10-31' });
  assert.deepEqual(
    line.map((p) => [p.cum, p.low, p.high]),
    [
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
    ],
  );
});

test('dailyModel: the thresholds are exactly 7 known days for weekday, 3 for mean, and 3 ratios for a band', () => {
  assert.equal(F.dailyModel(series('2026-10-22', [1, 2, 3, 4, 5, 6, 7]), { today: '2026-10-29' }).method, 'weekday');
  assert.equal(F.dailyModel(series('2026-10-23', [1, 2, 3, 4, 5, 6]), { today: '2026-10-29' }).method, 'mean');
  // Seven known days, only two with an expectation above 0: two ratios, so the band is the line itself.
  const two = F.dailyModel(series('2026-10-22', [0, 0, 0, 0, 0, 5, 5]), { today: '2026-10-29' });
  assert.deepEqual([two.low, two.high], [1, 1]);
});
