const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/cost/budgets');
const { validate } = require('../lib/cost/rules');

const HOME = '/Users/owner';
const at = (m, d, h = 12, min = 0) => new Date(2026, m - 1, d, h, min).getTime();
const CTX = { currency: 'IDR', centers: ['acme', 'lab'], home: HOME };
const CUR = {
  code: 'IDR',
  rates: [
    { from: '2026-10-01', perUSD: 16000 },
    { from: '2026-10-21', perUSD: 16500 },
  ],
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const good = (over = {}) => ({ id: 'team', name: 'Team', scope: 'global', period: 'month', amount: 100, ...over });
const ok = (over) => {
  const r = B.validateBudget(good(over), CTX);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
};
const row = (over = {}) => ({
  day: '2026-10-20',
  source: 'gateway',
  provider: 'openrouter',
  model: 'claude-sonnet-5-5',
  project: null,
  center: 'acme',
  keyId: 'key_a',
  kind: 'chat',
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const pick = (b) => ({ from: b.from, to: b.to, key: b.key });

test('validateBudget: defaults and normalized scope values', () => {
  assert.deepEqual(B.validateBudget(good(), CTX), {
    ok: true,
    value: {
      id: 'team',
      name: 'Team',
      scope: 'global',
      period: 'month',
      amount: 100,
      currency: 'USD',
      measure: 'list',
      thresholds: [50, 80],
      projection: true,
      enforce: 'none',
      legacy: null,
    },
  });
  assert.deepEqual(ok({ scope: { dim: 'model', value: 'anthropic/Claude-Sonnet-5.5' } }).scope, {
    dim: 'model',
    value: 'claude-sonnet-5-5',
  });
  assert.deepEqual(ok({ scope: { dim: 'project', value: '/Users/owner/work/acme/' } }).scope, {
    dim: 'project',
    value: '~/work/acme',
  });
  assert.deepEqual(ok({ scope: { dim: 'project', value: '~\\work\\acme' } }).scope, {
    dim: 'project',
    value: '~/work/acme',
  });
  assert.equal(ok({ currency: 'IDR', amount: 1500000 }).currency, 'IDR');
  assert.equal(ok({ scope: { dim: 'center', value: 'unassigned' } }).scope.value, 'unassigned');
  assert.equal(ok({ id: 'legacy-key-key_a1' }).id, 'legacy-key-key_a1', 'a key id holds an underscore');
  assert.deepEqual(ok({ thresholds: [] }).thresholds, []);
  assert.equal(ok({ enforce: 'block', scope: { dim: 'source', value: 'gateway' } }).enforce, 'block');
  assert.equal(ok({ enforce: 'pause', scope: { dim: 'source', value: 'codex' } }).enforce, 'pause');
});

test('validateBudget: every refusal has a reason', () => {
  const why = (over, ctx = CTX) => B.validateBudget(good(over), ctx).errors.join(' | ');
  assert.match(why({ scope: { dim: 'team', value: 'x' } }), /scope\.dim/);
  assert.match(why({ scope: { dim: 'model', value: ' ' } }), /scope\.value/);
  assert.match(why({ scope: 'everything' }), /scope: 'global' or \{ dim, value \}/);
  assert.match(why({ scope: { dim: 'center', value: 'gone' } }), /unknown cost center/);
  assert.match(why({ scope: { dim: 'source', value: 'cursor' } }), /scope\.value/);
  assert.match(why({ scope: { dim: 'key', value: 'has space' } }), /scope\.value/);
  assert.match(why({ amount: 0 }), /amount/);
  assert.match(why({ amount: -5 }), /amount/);
  assert.match(why({ amount: '5' }), /amount/);
  assert.match(why({ currency: 'EUR' }), /currency: USD or IDR/);
  assert.match(why({ currency: 'IDR' }, { ...CTX, currency: null }), /currency: USD$/);
  assert.match(why({ enforce: 'block', scope: { dim: 'project', value: '~/x' } }), /enforce: block/);
  assert.match(why({ enforce: 'block', scope: { dim: 'source', value: 'claude' } }), /enforce: block/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'key', value: 'key_a' } }), /enforce: pause/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'provider', value: 'groq' } }), /enforce: pause/);
  assert.match(why({ enforce: 'pause', scope: { dim: 'source', value: 'gateway' } }), /enforce: pause/);
  assert.match(why({ enforce: 'stop' }), /enforce/);
  assert.match(why({ thresholds: [80, 50] }), /thresholds/);
  assert.match(why({ thresholds: [50, 80, 90] }), /thresholds/);
  assert.match(why({ thresholds: [100] }), /thresholds/);
  assert.match(why({ thresholds: [0] }), /thresholds/);
  assert.match(why({ thresholds: [50.5] }), /thresholds/);
  assert.match(why({ legacy: 'keyBudget' }), /legacy/);
  assert.match(why({ extra: 1 }), /unknown field: extra/);
  assert.match(why({ id: 'Bad id!' }), /id:/);
  assert.match(why({ id: 'constructor' }), /id:/);
  assert.match(why({ name: '' }), /name/);
  assert.match(why({ name: 'a\nb' }), /name/);
  assert.match(why({ period: 'year' }), /period/);
  assert.match(why({ measure: 'paid' }), /measure/);
  assert.match(why({ projection: 'yes' }), /projection/);
  assert.match(B.validateBudget('x', CTX).errors[0], /a budget must be an object/);
});

test('validateList: duplicate ids, the size limit, prefixed reasons; the cost settings ignore the field', () => {
  const dup = B.validateList([good(), good({ name: 'Again' })], CTX);
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(), /budgets\[1\]\.id: team is used twice/);
  assert.match(B.validateList('x', CTX).errors.join(), /budgets must be a list/);
  const many = Array.from({ length: 101 }, (_, i) => good({ id: `b${i}` }));
  assert.match(B.validateList(many, CTX).errors.join(), /at most 100 budgets/);
  assert.match(B.validateList([good({ amount: 0 })], CTX).errors.join(), /budgets\[0\]\.amount/);
  assert.deepEqual(B.validateList([], CTX), { ok: true, value: [] });
  const s = validate({ budgets: [{ junk: true }] });
  assert.equal(s.ok, true, 'a budget list never makes the cost settings invalid');
  assert.equal('budgets' in s.value, false);
});

test('periodBounds: local day, Monday week, month; roll-over at local midnight', () => {
  const t = at(10, 22, 18); // Thursday 22 October 2026, 18:00
  assert.deepEqual(pick(B.periodBounds('day', t)), { from: '2026-10-22', to: '2026-10-22', key: 'day:2026-10-22' });
  assert.deepEqual(pick(B.periodBounds('week', t)), { from: '2026-10-19', to: '2026-10-25', key: 'week:2026-10-19' });
  assert.deepEqual(pick(B.periodBounds('month', t)), {
    from: '2026-10-01',
    to: '2026-10-31',
    key: 'month:2026-10-01',
  });
  near(B.periodBounds('day', t).fraction, 0.75);
  assert.equal(B.periodBounds('week', at(10, 25, 23)).from, '2026-10-19', 'Sunday ends the week');
  assert.equal(B.periodBounds('week', at(10, 26, 0, 1)).from, '2026-10-26', 'Monday starts one');
  assert.deepEqual(pick(B.periodBounds('week', at(12, 31))), {
    from: '2026-12-28',
    to: '2027-01-03',
    key: 'week:2026-12-28',
  });
  assert.equal(B.periodBounds('day', at(10, 31, 23, 59)).key, 'day:2026-10-31');
  assert.equal(B.periodBounds('month', new Date(2026, 10, 1, 0, 1).getTime()).key, 'month:2026-11-01');
  assert.equal(B.periodBounds('month', at(2, 10)).to, '2026-02-28');
});

test('spent per scope for both measures; plan rows only for billed in global and source scopes', () => {
  const rows = [
    row({ listUSD: 2, billedUSD: 2 }),
    // Claude Code on a plan: worth 5, billed 0.
    row({ source: 'claude', provider: 'anthropic', keyId: null, project: '~/work/acme', listUSD: 5, billedUSD: 0 }),
    row({
      source: 'claude',
      kind: 'plan',
      provider: null,
      model: null,
      center: null,
      keyId: null,
      listUSD: 0,
      billedUSD: 6.45,
    }),
    row({ day: '2026-09-30', listUSD: 100, billedUSD: 100 }), // before the period
    row({ keyId: 'key_b', center: 'lab', model: 'deepseek-chat', provider: 'groq', listUSD: 1, billedUSD: 1 }),
  ];
  const spent = (over, extra = []) =>
    B.evaluateBudget(ok(over), { rows, extra, currency: CUR, now: at(10, 22) }).spentUSD;
  near(spent({}), 8);
  near(spent({ measure: 'billed' }), 2 + 0 + 6.45 + 1);
  near(spent({ scope: { dim: 'source', value: 'claude' }, measure: 'billed' }), 6.45);
  near(spent({ scope: { dim: 'source', value: 'claude' } }), 5);
  near(spent({ scope: { dim: 'center', value: 'acme' }, measure: 'billed' }), 2, 'the plan row has no center');
  near(spent({ scope: { dim: 'key', value: 'key_a' } }), 2);
  near(spent({ scope: { dim: 'model', value: 'deepseek-chat' } }), 1);
  near(spent({ scope: { dim: 'model', value: 'claude-sonnet-5-5' }, measure: 'billed' }), 2);
  near(spent({ scope: { dim: 'provider', value: 'groq' } }), 1);
  near(spent({ scope: { dim: 'project', value: '~/work/acme' } }), 5);
  near(spent({}, [row({ listUSD: 3 })]), 11, 'gateway increments count beside the ledger rows');
  assert.equal(B.inScope({ dim: 'source', value: 'claude' }, rows[2]), true);
  assert.equal(B.inScope({ dim: 'center', value: 'acme' }, { ...rows[2], center: 'acme' }), false);
});

test('a budget in the display currency: converted at the latest rate on or before today; no rate is no_data', () => {
  const b = ok({ currency: 'IDR', amount: 165000 }); // $10 at today's rate
  const v = B.evaluateBudget(b, { rows: [row({ listUSD: 5 })], currency: CUR, now: at(10, 22) });
  near(v.amountUSD, 10);
  assert.equal(v.percent, 50);
  assert.equal(v.state, 'warn_50');
  near(v.spent, 82500);
  near(
    B.evaluateBudget(b, { rows: [], currency: CUR, now: at(10, 20) }).amountUSD,
    165000 / 16000,
    'on the 20th the rate of the 1st applies',
  );
  const late = { code: 'IDR', rates: [{ from: '2026-11-01', perUSD: 16000 }] };
  const none = B.evaluateBudget(b, { rows: [], currency: late, now: at(10, 22) });
  assert.equal(none.state, 'no_data');
  assert.match(none.reason, /no IDR rate on or before today/);
  assert.equal(none.percent, null);
  assert.match(B.evaluateBudget(b, { rows: [], currency: null, now: at(10, 22) }).reason, /no rates for IDR/);
});

test('states: warning levels in order, 100 % always exceeded, projection from a quarter of the period', () => {
  const at22 = at(10, 22, 12); // about 69 % of October
  const st = (usd, over = {}) =>
    B.evaluateBudget(ok({ amount: 100, ...over }), { rows: [row({ listUSD: usd })], currency: null, now: at22 });
  assert.equal(st(10).state, 'ok');
  assert.equal(st(50).state, 'warn_50');
  assert.equal(st(79.99).state, 'warn_50');
  assert.equal(st(80).state, 'warn_80');
  assert.equal(st(99.99).state, 'warn_80');
  assert.equal(st(100).state, 'exceeded');
  assert.equal(st(250).state, 'exceeded');
  assert.equal(st(100, { thresholds: [] }).state, 'exceeded', '100 % is always exceeded');
  assert.equal(st(99, { thresholds: [] }).state, 'ok');
  assert.equal(st(60, { thresholds: [90] }).state, 'ok');
  assert.equal(st(60).projected, false, '60 at 69 % projects to about 87');
  assert.equal(st(70).projected, true, '70 at 69 % projects to about 101');
  assert.equal(st(70, { projection: false }).projected, false);
  assert.equal(st(120).projected, false, 'exceeded is not also projected');
  const day = ok({ period: 'day', amount: 10 });
  const r3 = [row({ day: '2026-10-22', listUSD: 3 })];
  assert.equal(B.evaluateBudget(day, { rows: r3, now: at(10, 22, 5) }).projected, false, 'before a quarter');
  assert.equal(B.evaluateBudget(day, { rows: r3, now: at(10, 22, 7) }).projected, true);
});

test('100 % is reached by whole micro-dollars, not by float sums', () => {
  const ev = (amount, usds, over = {}) =>
    B.evaluateBudget(ok({ amount, ...over }), {
      rows: usds.map((u) => row({ listUSD: u })),
      now: at(10, 22),
    });
  const ten = ev(1, Array(10).fill(0.1));
  assert.equal(ten.state, 'exceeded');
  assert.equal(ten.percent, 100);
  assert.equal(ev(0.3, [0.1, 0.2]).state, 'exceeded');
  assert.equal(ev(0.8, [0.7, 0.1]).state, 'exceeded');
  assert.equal(ev(1, [0.999998]).state, 'warn_80', 'more than a micro-dollar below stays below');
  assert.equal(ev(1, [0.8]).state, 'warn_80');
  assert.equal(ev(1, [0.1 * 3 + 0.1 * 5]).state, 'warn_80', 'a sum of 0.8 fires the 80 % level');
  assert.equal(ev(10, [4.9999996]).state, 'warn_50', 'a level reached within a micro-dollar fires');
  assert.equal(ev(1, [0.7999994]).state, 'warn_50', 'while one micro-dollar below does not');
});

test('no_data: an unread month of the period, the folder, the corrections; billing lost or unread for billed', () => {
  const at22 = at(10, 22);
  const b = ok();
  assert.match(B.evaluateBudget(b, { rows: [], unread: ['2026-10'], now: at22 }).reason, /could not read 2026-10/);
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['2026-09'], now: at22 }).state, 'ok', 'outside the period');
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['folder'], now: at22 }).state, 'no_data');
  assert.equal(B.evaluateBudget(b, { rows: [], unread: ['corrections'], now: at22 }).state, 'no_data');
  // Thursday 1 October: the week started on Monday 28 September, so September matters.
  assert.equal(
    B.evaluateBudget(ok({ period: 'week' }), { rows: [], unread: ['2026-09'], now: at(10, 1) }).state,
    'no_data',
  );
  const billed = ok({ measure: 'billed' });
  assert.match(
    B.evaluateBudget(billed, { rows: [], billingError: 'x', now: at22 }).reason,
    /billing history could not be read/,
  );
  assert.match(
    B.evaluateBudget(billed, { rows: [row({ billingAssumed: true })], now: at22 }).reason,
    /billing history was lost/,
  );
  assert.equal(B.evaluateBudget(b, { rows: [row({ billingAssumed: true })], now: at22 }).state, 'ok');
  const v = B.evaluateBudget(b, { rows: [], unread: ['2026-10'], now: at22 });
  assert.deepEqual([v.spent, v.spentUSD, v.amountUSD, v.percent, v.projected], [null, null, null, null, false]);
});

test('legacy budgets: monthlyBudgetUSD and key budgets; a saved budget of the same id wins; the monthly figure', () => {
  const legacy = B.legacyBudgets({
    monthlyBudgetUSD: 300,
    keys: [
      { id: 'key_a', name: 'Acme app', budgetUSD: 5 },
      { id: 'key_b', name: 'Lab', budgetUSD: null },
      { id: 'key_c', name: 'Old', budgetUSD: 9, revokedAt: 1 },
      { id: 'key_z', name: 'Zero', budgetUSD: 0 },
    ],
  });
  const brief = (b) => [
    b.id,
    b.scope === 'global' ? 'global' : `${b.scope.dim}:${b.scope.value}`,
    b.period,
    b.amount,
    b.enforce,
    b.legacy,
  ];
  assert.deepEqual(legacy.map(brief), [
    ['legacy-monthly', 'global', 'month', 300, 'none', 'monthlyBudgetUSD'],
    ['legacy-key-key_a', 'key:key_a', 'month', 5, 'block', 'keyBudget'],
    ['legacy-key-key_z', 'key:key_z', 'month', 0, 'block', 'keyBudget'],
  ]);
  assert.equal(legacy[1].name, 'Key Acme app');
  assert.deepEqual(B.legacyBudgets({ monthlyBudgetUSD: 0 }), []);
  assert.equal(B.evaluateBudget(legacy[2], { rows: [], now: at(10, 22) }).state, 'exceeded', 'a budget of 0 blocks');
  const saved = [ok({ id: 'legacy-monthly', name: 'Team month', amount: 400 })];
  assert.deepEqual(
    B.effectiveBudgets(saved, legacy).map((b) => [b.id, b.amount, b.legacy]),
    [
      ['legacy-monthly', 400, null],
      ['legacy-key-key_a', 5, 'keyBudget'],
      ['legacy-key-key_z', 0, 'keyBudget'],
    ],
  );
  const now = at(10, 22);
  assert.deepEqual(B.monthlyFigure({ saved, monthlyBudgetUSD: 0, currency: null, now }), {
    monthlyBudgetUSD: 400,
    monthlyBudgetManaged: true,
  });
  assert.deepEqual(B.monthlyFigure({ saved: [], monthlyBudgetUSD: 300, currency: null, now }), {
    monthlyBudgetUSD: 300,
    monthlyBudgetManaged: false,
  });
  const idr = [ok({ id: 'legacy-monthly', currency: 'IDR', amount: 1650000 })];
  assert.deepEqual(B.monthlyFigure({ saved: idr, monthlyBudgetUSD: 0, currency: CUR, now }), {
    monthlyBudgetUSD: 100,
    monthlyBudgetManaged: true,
  });
});
