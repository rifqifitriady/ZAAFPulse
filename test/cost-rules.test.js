// test/cost-rules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const D = require('../lib/cost/days');
const R = require('../lib/cost/rules');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('days: local calendar days, real dates only, month and year lengths', () => {
  assert.equal(D.dayOf(new Date(2026, 9, 22, 23, 59).getTime()), '2026-10-22');
  assert.equal(D.isDay('2026-02-28'), true);
  assert.equal(D.isDay('2026-02-30'), false);
  assert.equal(D.isDay('2026-2-01'), false);
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(D.monthOf('2026-10-22'), '2026-10');
  assert.equal(D.daysInMonth('2026-02-10'), 28);
  assert.equal(D.daysInMonth('2026-10-10'), 31);
  assert.equal(D.daysInYear('2026-06-01'), 365);
  assert.equal(D.daysInYear('2028-06-01'), 366);
  assert.deepEqual(D.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(D.daysBetween('2026-10-02', '2026-10-01'), []);
});

test('globs: * stays in one folder, ** crosses folders, a trailing /** includes the folder, the rest is literal', () => {
  const m = (glob, p, nocase = false) => R.globToRegExp(glob, { nocase }).test(p);
  assert.equal(m('~/work/**', '~/work'), true);
  assert.equal(m('~/work/**', '~/work/acme/api'), true);
  assert.equal(m('~/work/**', '~/workshop'), false);
  assert.equal(m('~/work/*', '~/work/acme'), true);
  assert.equal(m('~/work/*', '~/work/acme/api'), false);
  assert.equal(m('~/work/*', '~/work'), false);
  assert.equal(m('~/work/**/api', '~/work/api'), true);
  assert.equal(m('~/work/**/api', '~/work/a/b/api'), true);
  assert.equal(m('~/work/**/api', '~/work/apix'), false);
  assert.equal(m('~/w?rk', '~/work'), true);
  assert.equal(m('~/w?rk', '~/w/rk'), false);
  assert.equal(m('~/a.b', '~/axb'), false, 'a dot is literal');
  assert.equal(m('~/x[1]', '~/x[1]'), true, 'brackets are literal');
  assert.equal(m('~/Work/**', '~/work/a'), false);
  assert.equal(m('~/Work/**', '~/work/a', true), true);
  assert.equal(R.globProblem('~/work/**'), null);
  assert.equal(R.globProblem('C:/src/**'), null);
  assert.equal(R.globProblem('**/api'), null);
  assert.match(R.globProblem(''), /empty/);
  assert.match(R.globProblem('work/**'), /starts with/);
  assert.match(R.globProblem('~/a/***'), /three stars/);
  assert.match(R.globProblem('~/a\u0001'), /control character/);
  assert.match(R.globProblem('~/' + 'a'.repeat(300)), /longer than 300/);
  assert.equal(R.normalizeGlob(`${HOME}${path.sep}work${path.sep}**`, HOME), '~/work/**');
});

test('validate: a full valid section is normalized', () => {
  const r = R.validate(
    {
      centers: [{ id: 'acme', name: '  Acme  ' }, { id: 'lab', name: 'Lab' }],
      keyCenters: { key_0123456789ab: 'acme' },
      folderRules: [{ glob: `${HOME}/work/acme/**`, center: 'acme' }, { glob: '~\\lab\\**', center: 'lab' }],
      billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }, codex: { mode: 'metered' } },
      currency: { code: 'IDR', rates: [{ from: '2026-10-22', perUSD: 16500 }, { from: '2026-10-01', perUSD: 16000 }] },
    },
    { home: HOME },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    centers: [{ id: 'acme', name: 'Acme' }, { id: 'lab', name: 'Lab' }],
    keyCenters: { key_0123456789ab: 'acme' },
    folderRules: [{ glob: '~/work/acme/**', center: 'acme' }, { glob: '~/lab/**', center: 'lab' }],
    billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }, codex: { mode: 'metered' } },
    currency: { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }, { from: '2026-10-22', perUSD: 16500 }] },
    digest: { enabled: false },
  });
  assert.deepEqual(R.validate({}).value, R.defaults());
});

test('validate: every bad field is named', () => {
  const r = R.validate({
    extra: 1,
    centers: [{ id: 'Bad Id', name: 'x' }, { id: 'unassigned', name: 'x' }, { id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { id: 'b', name: '' }],
    keyCenters: { key_x: 'nope', 'bad key!': 'a' },
    folderRules: [{ glob: 'work/**', center: 'a' }, { glob: '~/x/**', center: 'nope' }],
    billing: { omniroute: { mode: 'metered' }, claude: { mode: 'plan', plan: 'Max', period: 'month' }, codex: { mode: 'plan', plan: 'P', feeUSD: 1, period: 'week' } },
    currency: { code: 'IDR', rates: [{ from: '2026-13-01', perUSD: 1 }, { from: '2026-10-01', perUSD: 0 }] },
  });
  assert.equal(r.ok, false);
  for (const want of [
    'unknown field: extra',
    'centers[0].id: lower-case letters, digits and dashes, up to 40',
    'centers[1].id: "unassigned" is reserved',
    'centers[3].id: a is used twice',
    'centers[4].name: 1 to 60 characters',
    'keyCenters.key_x: unknown cost center',
    'keyCenters: bad key id bad key!',
    'folderRules[0].glob: starts with ~, /, * or a drive letter like C:/',
    'folderRules[1].center: unknown cost center',
    'billing: unknown source omniroute',
    'billing.claude.feeUSD: a number from 0 to 1,000,000',
    'billing.codex.period: month or year',
    'currency.rates[0].from: a date YYYY-MM-DD',
    'currency.rates[1].perUSD: a number above 0',
  ])
    assert.ok(r.errors.includes(want), `missing: ${want}\n${r.errors.join('\n')}`);
  assert.match(R.validate({ currency: { code: 'idr', rates: [] } }).errors[0], /three capital letters/);
  assert.match(R.validate({ currency: { code: 'USD', rates: [] } }).errors[0], /kept in USD/);
  assert.match(R.validate([]).errors[0], /must be an object/);
});

test('settingsOf: nothing saved is the defaults; an invalid saved section is the defaults with an error', () => {
  assert.deepEqual(R.settingsOf(undefined), { value: R.defaults(), error: null });
  const bad = R.settingsOf({ centers: 'nope' });
  assert.deepEqual(bad.value, R.defaults());
  assert.match(bad.error, /invalid, so the ledger pass waits/);
});

test('attribution: the key first, then the first matching folder rule, then Unassigned', () => {
  const centers = [{ id: 'acme', name: 'A' }, { id: 'work', name: 'W' }, { id: 'lab', name: 'L' }];
  const first = R.compile(
    {
      ...R.defaults(),
      centers,
      keyCenters: { key_a: 'lab' },
      folderRules: [{ glob: '~/work/acme/**', center: 'acme' }, { glob: '~/work/**', center: 'work' }],
    },
    { nocase: false },
  );
  assert.equal(first.centerOf({ keyId: 'key_a', project: '~/work/acme' }), 'lab', 'the key wins over a folder');
  assert.equal(first.centerOf({ keyId: 'key_other', project: '~/work/acme/api' }), 'acme');
  assert.equal(first.centerOf({ keyId: null, project: '~/work/blog' }), 'work');
  assert.equal(first.centerOf({ keyId: null, project: '~/play' }), 'unassigned');
  assert.equal(first.centerOf({ keyId: null, project: null }), 'unassigned');
  const swapped = R.compile(
    { ...R.defaults(), centers, folderRules: [{ glob: '~/work/**', center: 'work' }, { glob: '~/work/acme/**', center: 'acme' }] },
    { nocase: false },
  );
  assert.equal(swapped.centerOf({ keyId: null, project: '~/work/acme/api' }), 'work', 'first match wins');
  assert.deepEqual(first.billingOf('claude'), { mode: 'metered' });
});

test('plan fee per day, and the rate of a day', () => {
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 310, period: 'month' }, '2026-10-05'), 10);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 280, period: 'month' }, '2026-02-05'), 10);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 365, period: 'year' }, '2026-02-05'), 1);
  near(R.planFee({ mode: 'plan', plan: 'P', feeUSD: 366, period: 'year' }, '2028-02-05'), 1);
  const cur = { code: 'IDR', rates: [{ from: '2026-10-01', perUSD: 16000 }, { from: '2026-10-22', perUSD: 16500 }] };
  assert.equal(R.rateFor(cur, '2026-10-21'), 16000);
  assert.equal(R.rateFor(cur, '2026-10-22'), 16500);
  assert.equal(R.rateFor(cur, '2026-09-30'), null);
  assert.equal(R.rateFor(null, '2026-10-22'), null);
});

test('globs: a pathological glob is matched in linear time', () => {
  const long = '~/' + 'a/'.repeat(200) + 'b';
  for (const glob of ['~/' + '**/'.repeat(20) + 'x', '~/' + '*a'.repeat(30), '~/' + '*a'.repeat(30) + '/**']) {
    const re = R.globToRegExp(glob, { nocase: false });
    const t0 = Date.now();
    assert.equal(re.test(long), false);
    assert.ok(Date.now() - t0 < 50, `${glob.slice(0, 20)} took ${Date.now() - t0} ms`);
  }
});

test('validate: names that clash with object internals are rejected', () => {
  const r = R.validate({
    centers: [
      { id: 'constructor', name: 'x' },
      { id: 'a', name: 'A' },
    ],
    keyCenters: { ['__proto__']: 'a' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('centers[0].id: constructor is reserved'), r.errors.join('\n'));
  const k = R.validate(JSON.parse('{"centers":[{"id":"a","name":"A"}],"keyCenters":{"__proto__":"a"}}'));
  assert.equal(k.ok, false);
  assert.ok(k.errors.includes('keyCenters: bad key id __proto__'), k.errors.join('\n'));
});

test('a cost center may be called all: the report spells every center __all, which no id can be', () => {
  assert.ok(R.validate({ centers: [{ id: 'all', name: 'Everything' }] }).ok);
  assert.equal(R.validate({ centers: [{ id: '__all', name: 'x' }] }).ok, false);
});
