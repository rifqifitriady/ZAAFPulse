// lib/cost/preview.js (Cost Control 3b): what a draft of the cost settings moves, which rules match nothing or are
// never reached, which projects stay Unassigned, where a test path goes; and a restate preview summed for the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, globToRegExp } = require('../lib/cost/rules');
const P = require('../lib/cost/preview');

// Settings as the server keeps them: validated, with the defaults filled in.
const S = (over) => {
  const r = validate(over);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
};
const CENTERS = [
  { id: 'acme', name: 'Acme' },
  { id: 'lab', name: 'Lab' },
  { id: 'ops', name: 'Ops' },
];
const SAVED = S({
  centers: CENTERS,
  keyCenters: { key_ci: 'ops' },
  folderRules: [
    { glob: '~/work/acme/**', center: 'acme' },
    { glob: '~/work/**', center: 'lab' },
  ],
});
const ROWS = [
  { project: '~/work/acme', keyId: null, listUSD: 12 },
  { project: '~/work/acme/api', keyId: null, listUSD: 3 },
  { project: '~/work/tools', keyId: null, listUSD: 5 },
  { project: '~/play', keyId: null, listUSD: 2 },
  { project: '~/Notes', keyId: null, listUSD: 1 },
  { project: null, keyId: 'key_ci', listUSD: 7 },
  { project: null, keyId: 'key_bot', listUSD: 4 },
  { project: null, keyId: null, listUSD: 0.5 }, // the judge: no project, no key
];
const KEYS = [
  { id: 'key_ci', name: 'ci-bot' },
  { id: 'key_bot', name: 'chat bot' },
];
const run = (draft, extra = {}) =>
  P.settingsPreview({ saved: SAVED, draft, rows: ROWS, keys: KEYS, compileOpts: { nocase: false }, ...extra });

test('settingsPreview: a draft equal to the saved settings moves nothing, whatever old rows were tagged', () => {
  const tagged = ROWS.map((r) => ({ ...r, center: 'ops' })); // centers stored on the rows are not used
  const p = P.settingsPreview({ saved: SAVED, draft: SAVED, rows: tagged, keys: KEYS, compileOpts: { nocase: false } });
  assert.deepEqual(p.moves, []);
  assert.equal(p.more, 0);
  assert.deepEqual(
    p.rules.map((r) => r.status),
    ['ok', 'ok'],
  );
  assert.deepEqual(p.unassigned, [
    { project: '~/play', listUSD: 2 },
    { project: '~/Notes', listUSD: 1 },
  ]);
  assert.equal(p.test, null, 'no test path');
});

test('settingsPreview: a key mapping wins over a rule, and the first matching rule wins', () => {
  const draft = S({
    centers: CENTERS,
    keyCenters: { key_ci: 'ops', key_bot: 'lab' },
    folderRules: [
      { glob: '~/**', center: 'ops' },
      { glob: '~/work/acme/**', center: 'acme' },
    ],
  });
  const p = run(draft);
  assert.deepEqual(
    p.moves.map((m) => [m.project ?? `Key: ${m.keyName}`, m.listUSD, m.from, m.to]),
    [
      ['~/work/acme', 12, 'acme', 'ops'],
      ['~/work/tools', 5, 'lab', 'ops'],
      ['Key: chat bot', 4, 'unassigned', 'lab'],
      ['~/work/acme/api', 3, 'acme', 'ops'],
      ['~/play', 2, 'unassigned', 'ops'],
      ['~/Notes', 1, 'unassigned', 'ops'],
    ],
  );
  assert.equal(p.moves[2].keyId, 'key_bot');
  assert.deepEqual(p.rules, [
    { index: 0, status: 'ok', by: null },
    { index: 1, status: 'shadowed', by: 0 },
  ]);
  assert.deepEqual(p.unassigned, []);
});

test('settingsPreview: a rule that matches nothing is none; a rule an earlier one always takes is shadowed by it', () => {
  const draft = S({
    centers: CENTERS,
    folderRules: [
      { glob: '~/clients/**', center: 'acme' },
      { glob: '~/work/**', center: 'lab' },
      { glob: '~/work/acme/**', center: 'acme' },
      { glob: '~/play/**', center: 'ops' },
    ],
  });
  assert.deepEqual(run(draft).rules, [
    { index: 0, status: 'none', by: null },
    { index: 1, status: 'ok', by: null },
    { index: 2, status: 'shadowed', by: 1 },
    { index: 3, status: 'ok', by: null },
  ]);
  // A project only a mapped key reaches is not one the rules decide.
  const keyed = P.settingsPreview({
    saved: SAVED,
    draft: S({ centers: CENTERS, keyCenters: { key_x: 'ops' }, folderRules: [{ glob: '~/x/**', center: 'lab' }] }),
    rows: [{ project: '~/x', keyId: 'key_x', listUSD: 1 }],
    compileOpts: { nocase: false },
  });
  assert.deepEqual(keyed.rules, [{ index: 0, status: 'none', by: null }]);
});

test('settingsPreview: moves by cost, at most 50 with "more"; Unassigned by cost, at most 20', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ project: `~/p${i}`, keyId: null, listUSD: i + 1 }));
  const p = P.settingsPreview({
    saved: S({}),
    draft: S({ centers: CENTERS, folderRules: [{ glob: '~/p1*/**', center: 'lab' }] }),
    rows,
    compileOpts: { nocase: false },
  });
  assert.deepEqual(
    p.moves.map((m) => m.project),
    ['~/p19', '~/p18', '~/p17', '~/p16', '~/p15', '~/p14', '~/p13', '~/p12', '~/p11', '~/p10', '~/p1'],
  );
  assert.equal(p.more, 0);
  assert.equal(p.unassigned.length, P.MAX_UNASSIGNED);
  assert.deepEqual(p.unassigned[0], { project: '~/p59', listUSD: 60 });
  const all = P.settingsPreview({
    saved: S({}),
    draft: S({ centers: CENTERS, folderRules: [{ glob: '~/**', center: 'lab' }] }),
    rows,
    compileOpts: { nocase: false },
  });
  assert.equal(all.moves.length, P.MAX_MOVES);
  assert.equal(all.more, 10);
  assert.equal(all.moves[0].listUSD, 60);
  assert.deepEqual(all.unassigned, []);
});

test('settingsPreview: while the settings do not read, saved is the defaults: every mapped row moves from Unassigned', () => {
  const p = P.settingsPreview({ saved: S({}), draft: SAVED, rows: ROWS, keys: KEYS, compileOpts: { nocase: false } });
  assert.deepEqual(
    p.moves.map((m) => [m.project || m.keyId, m.from, m.to]),
    [
      ['~/work/acme', 'unassigned', 'acme'],
      ['key_ci', 'unassigned', 'ops'],
      ['~/work/tools', 'unassigned', 'lab'],
      ['~/work/acme/api', 'unassigned', 'acme'],
    ],
  );
});

test('settingsPreview: the test path goes through the rules only', () => {
  const at = (testPath, draft = SAVED) => run(draft, { testPath }).test;
  assert.deepEqual(at('~/work/acme/web'), { center: 'acme', rule: 0 });
  assert.deepEqual(at('~/work/zed'), { center: 'lab', rule: 1 });
  assert.deepEqual(at('~/elsewhere'), { center: 'unassigned', rule: null });
  assert.deepEqual(at('key_ci'), { center: 'unassigned', rule: null }, 'a key id is not a path');
  assert.equal(at(''), null);
});

test('settingsPreview: "<project>/**" matches the project it was made from, and only below it', () => {
  for (const project of ['~/work/acme', '~/odd [dir]/x', '/srv/app', 'C:/code/app', '~/a?b']) {
    const re = globToRegExp(`${project}/**`);
    assert.ok(re.test(project), project);
    assert.ok(re.test(`${project}/sub`), `${project}/sub`);
    assert.ok(!re.test(`${project}-other`), `${project}-other`);
    const draft = S({ centers: CENTERS, folderRules: [{ glob: `${project}/**`, center: 'lab' }] });
    const p = P.settingsPreview({ saved: S({}), draft, rows: [{ project, listUSD: 1 }], compileOpts: { nocase: false } });
    assert.deepEqual(p.unassigned, [], project);
    assert.equal(p.rules[0].status, 'ok', project);
  }
});

test('settingsPreview: the case rule is the platform one unless compileOpts names it', () => {
  const draft = S({ centers: CENTERS, folderRules: [{ glob: '~/notes/**', center: 'lab' }] });
  const rows = [{ project: '~/Notes', listUSD: 1 }];
  const loose = P.settingsPreview({ saved: S({}), draft, rows, compileOpts: { nocase: true } });
  assert.deepEqual([loose.moves.length, loose.rules[0].status], [1, 'ok']);
  const strict = P.settingsPreview({ saved: S({}), draft, rows, compileOpts: { nocase: false } });
  assert.deepEqual([strict.moves.length, strict.rules[0].status], [0, 'none']);
  const platform = P.settingsPreview({ saved: S({}), draft, rows });
  const folds = process.platform === 'darwin' || process.platform === 'win32';
  assert.equal(platform.moves.length, folds ? 1 : 0);
});

test('restateSummary: sums before and after, center moves by pair and amount; no change is a plain answer', () => {
  const x = (bUSD, aUSD, from, to) => ({
    key: 'k',
    before: { listUSD: bUSD, priceVersion: 1, center: from, unpriced: false },
    after: { listUSD: aUSD, priceVersion: 2, center: to, unpriced: false },
  });
  const billing = [{ source: 'claude', mode: 'plan', plan: 'Max', feeUSD: 200, period: 'month' }];
  const s = P.restateSummary({
    rows: [
      x(1, 2, 'unassigned', 'acme'),
      x(0.5, 0.75, 'unassigned', 'acme'),
      x(3, 4, 'lab', 'ops'),
      x(0.1, 0.3, 'lab', 'lab'),
      x(1, 1, null, 'acme'),
    ],
    total: 9,
    billing,
    versionsBefore: [1],
    version: null,
    newPrices: true,
  });
  assert.deepEqual(s, {
    changed: 5,
    total: 9,
    beforeUSD: 5.6,
    afterUSD: 8.05,
    moves: [
      { from: 'lab', to: 'ops', listUSD: 4 },
      { from: 'unassigned', to: 'acme', listUSD: 3.75 },
    ],
    versionsBefore: [1],
    version: null,
    newPrices: true,
    billing,
  });
  assert.deepEqual(P.restateSummary({ rows: [], total: 3, billing, versionsBefore: [], version: 2 }), {
    changed: 0,
    total: 3,
    beforeUSD: 0,
    afterUSD: 0,
    moves: [],
    versionsBefore: [],
    version: 2,
    newPrices: false,
    billing,
  });
  const many = Array.from({ length: 25 }, (_, i) => x(0, i + 1, 'unassigned', `c${i}`));
  const capped = P.restateSummary({ rows: many, billing: [] });
  assert.equal(capped.moves.length, P.MAX_CENTER_MOVES);
  assert.equal(capped.moves[0].to, 'c24');
});
