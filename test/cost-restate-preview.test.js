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

/* ---------- Task 2: cost.restatePreview and cost.corrections ---------- */

const { createCost } = require('../lib/cost');
const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const MAX = { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' };
// One Sonnet response in ~/work/acme: 1,000 in and 100 out (0.003 at PRICE_A, 0.006 at PRICE_B).
const ev = (ts, key) => [ts, 'claude', 's1', 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, key, null];
const sessions = {
  s1: {
    tool: 'claude',
    project: path.join(HOME, 'work', 'acme'),
    tools: {},
    skills: {},
    agents: {},
    prompts: 0,
    subagentFiles: 0,
  },
};
const logFile = (name, events) => ({
  file: `/logs/${name}.jsonl`,
  source: 'claude',
  size: events.length,
  mtimeMs: 1,
  result: { events, sessions },
});
function rig() {
  const dir = tmp();
  const st = { entries: [], pricing: PRICE_A, settings: undefined, t: at(21) };
  const costDir = path.join(dir, 'cost');
  const make = () =>
    createCost({
      dir: costDir,
      entries: () => st.entries,
      getPricing: () => st.pricing,
      getSettings: () => st.settings,
      home: HOME,
      now: () => st.t,
      nocase: false,
    });
  return { st, costDir, make, cost: make() };
}
// Two closed days of usage, then new prices, the Acme rule and a plan saved without a pass since.
function changedSince() {
  const r = rig();
  r.st.entries.push(logFile('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.cost.update();
  r.st.pricing = PRICE_B;
  r.st.settings = { ...ACME, billing: { claude: MAX } };
  return r;
}

test('restatePreview: what the following restate records, with nothing written meanwhile', () => {
  const r = changedSince();
  const disk = snapshot(r.costDir);
  const p = r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-21' });
  assert.deepEqual(snapshot(r.costDir), disk, 'no billing set-up, no price version, no correction');
  assert.equal(r.cost.status().ledger.corrections, 0);
  assert.equal(r.cost.versions().versions.length, 1);
  assert.deepEqual([p.from, p.to, p.total, p.rows.length], ['2026-10-20', '2026-10-21', 2, 2]);
  assert.deepEqual(p.versionsBefore, [1]);
  assert.deepEqual([p.version, p.newPrices], [null, true], 'the new prices are not a version yet');
  assert.ok(p.rows.every((x) => x.after.priceVersion === 2 && x.after.center === 'acme'));
  assert.deepEqual(
    p.billing.find((b) => b.source === 'claude'),
    { source: 'claude', ...MAX },
  );
  assert.deepEqual(
    p.billing.map((b) => b.source),
    ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'],
  );
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'Acme and new prices' });
  assert.deepEqual(c.rows, p.rows, 'the preview rows are the rows the restate records');
  assert.deepEqual(c.billing, p.billing);
  const again = r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-21' });
  assert.deepEqual([again.rows, again.version, again.newPrices, again.total], [[], 2, false, 2]);
});

test('restatePreview: the refusals of restate(), without a reason', () => {
  const r = changedSince();
  for (const [from, to] of [
    ['2026-10-21', '2026-10-22'], // today
    ['2026-10-21', '2026-10-20'], // reversed
    ['2026-10-32', '2026-10-20'], // not a day
    [undefined, '2026-10-20'],
  ])
    assert.throws(() => r.cost.restatePreview({ from, to }), { status: 400 }, `${from} ${to}`);
  r.st.settings = { billing: { claude: { mode: 'plan' } } }; // a hand edit that does not validate
  assert.throws(() => r.cost.restatePreview({ from: '2026-10-20', to: '2026-10-20' }), {
    status: 409,
    message: /invalid.*fix them before a restate/,
  });
  r.st.settings = ACME;
  const month = path.join(r.costDir, 'ledger-2026-10.jsonl');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  const text = fs.readFileSync(month, 'utf8');
  if (byMode) fs.chmodSync(month, 0o000);
  else {
    fs.rmSync(month);
    fs.mkdirSync(month);
  }
  try {
    const c = r.make(); // a restart: October does not read
    assert.throws(() => c.restatePreview({ from: '2026-10-20', to: '2026-10-20' }), { code: 'LEDGER_MONTH_UNREAD' });
  } finally {
    if (byMode) fs.chmodSync(month, 0o600);
    else {
      fs.rmSync(month, { recursive: true });
      fs.writeFileSync(month, text);
    }
  }
  assert.equal(r.make().restatePreview({ from: '2026-10-20', to: '2026-10-20' }).rows.length, 1, 'readable again');
});

test('corrections: newest first without their rows, at most 100; unread is LEDGER_CORRECTIONS_UNREAD', () => {
  const r = changedSince();
  r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'first' });
  r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'second' });
  const list = r.cost.corrections();
  assert.deepEqual(
    list.map((c) => [c.reason, c.from, c.to, c.rows, c.priceVersion]),
    [
      ['second', '2026-10-20', '2026-10-21', 1, 2],
      ['first', '2026-10-20', '2026-10-20', 1, 2],
    ],
  );
  assert.equal(list[0].ts, at(22));
  assert.deepEqual(
    list[0].billing.find((b) => b.source === 'claude'),
    { source: 'claude', ...MAX },
  );

  const mem = createCost({ getPricing: () => PRICE_A, now: () => at(22) });
  for (let i = 0; i < 101; i++) mem.restate({ from: '2026-10-20', to: '2026-10-20', reason: `r${i}` });
  const capped = mem.corrections();
  assert.equal(capped.length, 100);
  assert.deepEqual([capped[0].reason, capped[99].reason], ['r100', 'r1']);

  const file = path.join(r.costDir, 'corrections.jsonl');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  const text = fs.readFileSync(file, 'utf8');
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  try {
    assert.throws(() => r.make().corrections(), {
      code: 'LEDGER_CORRECTIONS_UNREAD',
      message: 'the ledger corrections could not be read',
    });
  } finally {
    if (byMode) fs.chmodSync(file, 0o600);
    else {
      fs.rmSync(file, { recursive: true });
      fs.writeFileSync(file, text);
    }
  }
  assert.equal(r.make().corrections().length, 2, 'readable again');
});
