// Cost Control follow-ups, the server side of the Settings page: a restate refuses when the settings or prices changed
// since its preview (the preview's `basis`), and the settings preview says whether a key or a rule decided each move.
// In process with a real cost object; never the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { validate } = require('../lib/cost/rules');
const P = require('../lib/cost/preview');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const ACME = { centers: [{ id: 'acme', name: 'Acme' }], keyCenters: { key_a: 'acme' } };
const STALE = 'the settings or prices changed since the preview; preview again';
const line = (ts) =>
  JSON.stringify({
    ts,
    keyId: 'key_a',
    provider: 'p',
    model: 'claude-sonnet-5-5',
    kind: 'chat',
    input: 1000,
    output: 100,
  }) + '\n';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-followups-api-'));
  const st = { saved: ACME, t: at(22), pricing: PRICE_A };
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const cost = createCost({
    dir: path.join(dir, 'cost'),
    gatewayLog,
    getPricing: () => st.pricing,
    getSettings: () => st.saved,
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const api = createCostApi({
    cost,
    settings: { get: () => st.saved, save: (v) => (st.saved = v) },
    listKeys: () => [{ id: 'key_a', name: 'Acme app' }],
    home: HOME,
    now: () => st.t,
    nocase: false,
  });
  const post = (p, body) =>
    api.route({
      method: 'POST',
      path: p,
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
    });
  fs.writeFileSync(gatewayLog, line(at(20)) + line(at(21)));
  cost.update();
  return { st, cost, post };
}
const RANGE = { from: '2026-10-20', to: '2026-10-21' };
const run = (s, extra = {}) => s.post('/api/cost/restate', { ...RANGE, reason: 'check', confirm: true, ...extra });
const corrections = (s) => s.cost.status().ledger.corrections;

test('restate preview: answers a basis, the same for the same settings and prices, and from the cost object', async () => {
  const s = setup();
  const a = await s.post('/api/cost/restate/preview', RANGE);
  assert.equal(a.status, 200);
  assert.match(a.body.basis, /^[0-9a-f]{16}$/);
  assert.equal(s.cost.restatePreview(RANGE).basis, a.body.basis);
  assert.equal((await s.post('/api/cost/restate/preview', RANGE)).body.basis, a.body.basis);
  // Budgets and the digest do not change how a restate reads.
  s.st.saved = { ...ACME, digest: { enabled: true }, budgets: [] };
  assert.equal((await s.post('/api/cost/restate/preview', RANGE)).body.basis, a.body.basis);
  s.st.saved = { ...ACME, keyCenters: {} };
  assert.notEqual((await s.post('/api/cost/restate/preview', RANGE)).body.basis, a.body.basis);
  s.st.saved = ACME;
  s.st.pricing = PRICE_B; // new prices, not yet a version
  const b = (await s.post('/api/cost/restate/preview', RANGE)).body;
  assert.equal(b.newPrices, true);
  assert.notEqual(b.basis, a.body.basis);
});

test('restate: a matching basis runs; no basis runs as before', async () => {
  const s = setup();
  const { basis } = (await s.post('/api/cost/restate/preview', RANGE)).body;
  const ok = await run(s, { basis });
  assert.equal(ok.status, 200);
  assert.equal(corrections(s), 1);
  const bare = await run(s);
  assert.equal(bare.status, 200);
  assert.equal(corrections(s), 2);
});

test('restate: settings or prices changed since the preview are a 409, and nothing is written', async () => {
  const s = setup();
  const { basis } = (await s.post('/api/cost/restate/preview', RANGE)).body;
  const overrides = () => (s.cost.billingHistory().overrides || []).length;
  const was = overrides();
  s.st.saved = { ...ACME, keyCenters: {} };
  const moved = await run(s, { basis });
  assert.deepEqual([moved.status, moved.body], [409, { error: STALE }]);
  assert.equal(corrections(s), 0, 'no correction');
  assert.equal(overrides(), was, 'no billing override');
  s.st.saved = ACME;
  s.st.pricing = PRICE_B;
  const repriced = await run(s, { basis });
  assert.equal(repriced.status, 409);
  assert.equal(corrections(s), 0);
  assert.equal(s.cost.versions().versions.length, 1, 'no price version recorded');
  assert.equal((await run(s, { basis: 'nope' })).status, 409, 'any basis that is not the current one');
});

test('settings preview: a move a key decides is by key, one the folder rules decide is by rule', () => {
  const S = (v) => validate(v).value;
  const centers = [
    { id: 'acme', name: 'Acme' },
    { id: 'lab', name: 'Lab' },
  ];
  const saved = S({ centers, keyCenters: { key_old: 'lab' }, folderRules: [{ glob: '~/work/**', center: 'lab' }] });
  const draft = S({
    centers,
    keyCenters: { key_new: 'acme' },
    folderRules: [{ glob: '~/work/**', center: 'acme' }],
  });
  const rows = [
    { project: '~/work/a', keyId: 'key_new', listUSD: 3 }, // the draft maps the key
    { project: '~/work/b', keyId: 'key_old', listUSD: 2 }, // the saved settings mapped the key; the draft no longer
    { project: '~/work/c', keyId: null, listUSD: 1 }, // the rules
  ];
  const p = P.settingsPreview({ saved, draft, rows, compileOpts: { nocase: false } });
  assert.deepEqual(
    p.moves.map((m) => [m.project, m.from, m.to, m.by]),
    [
      ['~/work/a', 'lab', 'acme', 'key'],
      ['~/work/b', 'lab', 'acme', 'key'],
      ['~/work/c', 'lab', 'acme', 'rule'],
    ],
  );
});
