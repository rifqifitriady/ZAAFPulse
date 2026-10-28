// Cost Control 3b, the server side of the previews: ledger.restateRows computes what a restate records without
// writing it, prices.peek names the price version a restate would use without recording one, and (Task 2)
// cost.restatePreview and cost.corrections answer the Restate panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../lib/cost/ledger');
const { compile } = require('../lib/cost/rules');
const { createPriceVersions, hashOf } = require('../lib/cost/prices');
const { makePricer } = require('../lib/pricing');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-restate-preview-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const ACME = {
  centers: [{ id: 'acme', name: 'Acme' }],
  keyCenters: {},
  folderRules: [{ glob: '~/work/**', center: 'acme' }],
  billing: {},
  currency: null,
};
// Every file under a folder with its bytes: what "nothing written" is checked against.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name);
      if (fs.statSync(f).isDirectory()) walk(f);
      else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
// A stored Sonnet row of one day: 1,000 in and 100 out per request (0.003 at PRICE_A).
const row = (day, project, extra = {}) => ({
  ...L.newRow({ day, source: 'claude', kind: 'chat', project, center: 'unassigned' }),
  model: 'claude-sonnet-5-5',
  requests: 1,
  tokens: { in: 1000, out: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 0.003,
  billedUSD: 0.003,
  priceVersion: 1,
  ...extra,
});

test('restateRows: the rows restate() records, computed without a correction', () => {
  const make = () => {
    const store = L.createLedgerStore();
    store.put(row('2026-10-20', '~/work/acme'));
    store.put(row('2026-10-21', '~/play'));
    store.put({ ...row('2026-10-21', '~/work/acme'), model: 'qwen3:8b', free: true, listUSD: 0, billedUSD: 0 });
    return store;
  };
  const args = {
    from: '2026-10-20',
    to: '2026-10-21',
    version: { id: 2 },
    pricer: makePricer(PRICE_B),
    rules: compile(ACME, { nocase: false }),
  };
  const a = make();
  const rows = L.restateRows(a, args);
  assert.deepEqual(a.corrections(), [], 'nothing recorded');
  const b = make();
  const c = L.restate(b, { ...args, reason: 'check', ts: 1 });
  assert.deepEqual(rows, c.rows);
  assert.equal(b.corrections().length, 1, 'restate() still records its correction');
  const byProject = Object.fromEntries(rows.map((x) => [JSON.parse(x.key)[4] + ':' + JSON.parse(x.key)[3], x]));
  const acme = byProject['~/work/acme:claude-sonnet-5-5'];
  near(acme.after.listUSD, 0.006);
  assert.deepEqual([acme.before.center, acme.after.center, acme.after.priceVersion], ['unassigned', 'acme', 2]);
  assert.equal(byProject['~/work/acme:qwen3:8b'].after.listUSD, 0, 'a free row stays free');
  assert.equal(byProject['~/play:claude-sonnet-5-5'].after.center, 'unassigned');
});

test('restateRows: throws, like restate(), while the corrections of the store did not read', () => {
  const dir = tmp();
  const first = L.createLedgerStore({ dir });
  first.load();
  first.put(row('2026-10-20', '~/work/acme'));
  first.flush();
  const file = path.join(dir, 'corrections.jsonl');
  fs.writeFileSync(file, '');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  try {
    const store = L.createLedgerStore({ dir });
    assert.throws(() => store.load(), { code: L.CORRECTIONS_UNREAD });
    assert.throws(
      () =>
        L.restateRows(store, {
          from: '2026-10-20',
          to: '2026-10-20',
          version: { id: 1 },
          pricer: makePricer(PRICE_A),
          rules: compile(ACME, { nocase: false }),
        }),
      { code: L.CORRECTIONS_UNREAD },
    );
  } finally {
    if (byMode) fs.chmodSync(file, 0o600);
    else fs.rmSync(file, { recursive: true });
  }
});

test('peek: the latest version while the prices hash the same, else null with a fresh pricer; nothing written', () => {
  const dir = path.join(tmp(), 'prices');
  const p = createPriceVersions({ dir, now: () => 1000 });
  const v1 = p.observe(PRICE_A, '2026-10-20');
  const before = snapshot(dir);
  const same = p.peek(JSON.parse(JSON.stringify(PRICE_A)));
  assert.equal(same.version, v1);
  assert.equal(same.next, 1);
  near(
    same.pricer.parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0).reduce((a, b) => a + b, 0),
    0.003,
  );
  const changed = p.peek(PRICE_B);
  assert.equal(changed.version, null);
  assert.equal(changed.next, 2, 'the id observe() would give it');
  near(
    changed.pricer.parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0).reduce((a, b) => a + b, 0),
    0.006,
  );
  assert.deepEqual(snapshot(dir), before, 'no version file and no index change');
  assert.equal(p.list().length, 1);
  assert.equal(p.current().hash, hashOf(PRICE_A));
  assert.equal(p.observe(PRICE_B, '2026-10-22').id, changed.next);
  const none = createPriceVersions().peek(PRICE_A);
  assert.deepEqual([none.version, none.next], [null, 1], 'before the first version');
});
