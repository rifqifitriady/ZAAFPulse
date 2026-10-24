// test/cost-restate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');
const L = require('../lib/cost/ledger');
const { makePricer } = require('../lib/pricing');
const { priceEvent } = require('../lib/cost/collect');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const MAX = { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
// One Sonnet response: 1,000 in and 100 out (0.003 at PRICE_A, 0.006 at PRICE_B).
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
const file = (name, events) => ({
  file: `/logs/${name}.jsonl`,
  source: 'claude',
  size: events.length,
  mtimeMs: 1,
  result: { events, sessions },
});
const ACME = { centers: [{ id: 'acme', name: 'Acme' }], folderRules: [{ glob: '~/work/**', center: 'acme' }] };

function rig({ settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-restate-'));
  const st = { entries: [], pricing: PRICE_A, settings, t: at(21) };
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
const day = (cost, d, groupBy = ['day']) => cost.ledger({ from: d, to: d, groupBy }).rows;
const monthFile = (r) => path.join(r.costDir, 'ledger-2026-10.jsonl');
const stored = (r) =>
  fs
    .readFileSync(monthFile(r), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const correctionLines = (r) => {
  const f = path.join(r.costDir, 'corrections.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
// Per day: claude usage billed, and the plan rows' sources and amounts.
const billingOf = (cost, from, to) => {
  const out = {};
  for (const x of cost.ledger({ from, to, groupBy: ['day', 'source', 'kind'] }).rows) {
    const d = (out[x.day] = out[x.day] || { usageBilled: 0, usageList: 0, plans: [] });
    if (x.kind === 'plan') d.plans.push([x.source, Math.round(x.billedUSD * 1e6) / 1e6]);
    else if (x.source === 'claude') {
      d.usageBilled += x.billedUSD;
      d.usageList += x.listUSD;
    }
  }
  return out;
};

// A month file the store cannot read: no read permission where that holds (not on Windows, not as root), else a folder
// in its place. `restore` puts the readable file back.
function makeUnreadable(f) {
  const text = fs.readFileSync(f, 'utf8');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(f, 0o000);
  else {
    fs.rmSync(f);
    fs.mkdirSync(f);
  }
  return {
    restore() {
      if (byMode) fs.chmodSync(f, 0o600);
      else {
        fs.rmSync(f, { recursive: true });
        fs.writeFileSync(f, text);
      }
    },
  };
}

test('repriceRow: a daily row is priced as its average request times its requests', () => {
  const pricer = makePricer({ ...PRICE_B, 'claude-sonnet-5-5': { ...PRICE_B['claude-sonnet-5-5'], webSearch: 0.01 } });
  const one = {
    model: 'claude-sonnet-5-5',
    tokens: { in: 1000, out: 100, cacheRead: 50, cacheWrite5m: 20, cacheWrite1h: 10 },
    webSearches: 1,
    geo: 'us',
  };
  const each = priceEvent(pricer, one).listUSD;
  const row = {
    ...L.newRow({ day: '2026-10-20', source: 'claude', kind: 'chat', geo: 'us' }),
    model: 'claude-sonnet-5-5',
    requests: 3,
    tokens: { in: 3000, out: 300, cacheRead: 150, cacheWrite5m: 60, cacheWrite1h: 30 },
    webSearches: 3,
  };
  near(L.repriceRow(row, pricer), 3 * each);
  near(L.repriceRow({ ...row, requests: 0, tokens: { in: 1000, out: 100 }, webSearches: 0, geo: null }, pricer), 0.006);
});

test('restate: one correction with before and after; the stored rows stay; readers see the new amounts', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(21), 'm1'), ev(at(21, 13), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.st.settings = ACME;
  r.cost.update();
  const c = r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'Sonnet was priced wrong' });
  assert.deepEqual(
    [c.from, c.to, c.reason, c.priceVersion, c.rows.length],
    ['2026-10-21', '2026-10-21', 'Sonnet was priced wrong', 2, 1],
  );
  const [x] = c.rows;
  near(x.before.listUSD, 0.006);
  near(x.after.listUSD, 0.012);
  assert.deepEqual(
    [x.before.priceVersion, x.after.priceVersion, x.before.center, x.after.center],
    [1, 2, 'unassigned', 'acme'],
  );
  assert.equal('billedUSD' in x.before || 'billedUSD' in x.after, false, 'billing is not in a correction');
  assert.equal(x.row, undefined, 'a correction adds no rows');
  const raw = stored(r).filter((y) => y.day === '2026-10-21');
  near(raw[0].listUSD, 0.006);
  assert.equal(raw[0].center, 'unassigned', 'the stored row is not rewritten');
  assert.equal(correctionLines(r).length, 1);
  const [seen] = day(r.cost, '2026-10-21', ['center']);
  assert.equal(seen.center, 'acme');
  near(seen.listUSD, 0.012);
  assert.equal(r.cost.ledger({ from: '2026-10-21', to: '2026-10-21' }).corrections, 1);
  // A late event still counts on top of the restated amount (at the day's version: +0.003).
  r.st.entries.push(file('late', [ev(at(21, 20), 'm3')]));
  r.cost.update();
  near(day(r.cost, '2026-10-21')[0].listUSD, 0.015);
  near(day(r.make(), '2026-10-21')[0].listUSD, 0.015, 'read back after a restart');
});

test('restate onto a plan: claude usage is billed 0 and each day has exactly one plan row; list cost stays', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update(); // the 20th is backfilled, the 21st is today
  r.st.t = at(22);
  r.st.settings = { billing: { claude: MAX } };
  r.cost.update(); // the plan applies from today only
  const switched = billingOf(r.cost, '2026-10-20', '2026-10-21');
  for (const d of ['2026-10-20', '2026-10-21']) {
    near(switched[d].usageBilled, 0.003);
    assert.deepEqual(switched[d].plans, [], `${d}: the switch alone changes no closed day`);
  }

  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'we were on Max already' });
  assert.deepEqual(c.rows, [], 'prices and centers did not change');
  assert.deepEqual(
    c.billing.find((b) => b.source === 'claude'),
    { source: 'claude', mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' },
  );
  assert.deepEqual(
    c.billing.map((b) => b.source),
    ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'],
  );
  for (const cost of [r.cost, r.make()]) {
    const b = billingOf(cost, '2026-10-20', '2026-10-21');
    for (const d of ['2026-10-20', '2026-10-21']) {
      near(b[d].usageBilled, 0);
      near(b[d].usageList, 0.003);
      assert.deepEqual(b[d].plans, [['claude', 10]], `${d}: one plan row, the day's share of 310`);
    }
    const t = cost.ledger({ from: '2026-10-20', to: '2026-10-21' });
    near(t.totals.billedUSD, 20);
    near(t.totals.listUSD, 0.006);
  }
  assert.equal(stored(r).filter((x) => x.kind === 'plan').length, 0, 'no plan row is stored');
  assert.equal(r.cost.billingHistory().overrides.length, 6);
});

test('restate off a plan: usage is billed at list price and the range has no plan rows', () => {
  const r = rig({ settings: { billing: { claude: MAX } } });
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update(); // the first run: claude is on Max from its first day of use
  r.st.t = at(22);
  r.st.settings = undefined;
  r.cost.update(); // metered from today only
  const before = billingOf(r.cost, '2026-10-20', '2026-10-21');
  for (const d of ['2026-10-20', '2026-10-21']) assert.deepEqual(before[d].plans, [['claude', 10]]);

  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-21', reason: 'the plan started later' });
  assert.deepEqual(
    c.billing.find((b) => b.source === 'claude'),
    { source: 'claude', mode: 'metered' },
  );
  for (const cost of [r.cost, r.make()]) {
    const b = billingOf(cost, '2026-10-20', '2026-10-21');
    for (const d of ['2026-10-20', '2026-10-21']) {
      near(b[d].usageBilled, 0.003);
      assert.deepEqual(b[d].plans, []);
    }
    near(cost.ledger({ from: '2026-10-20', to: '2026-10-21' }).totals.billedUSD, 0.006);
    // Outside the range the history still holds: today is metered by the settings, and no other day moved.
    assert.deepEqual(billingOf(cost, '2026-10-22', '2026-10-22'), {});
  }
});

test('restate re-prices: list cost follows the current prices, the version is the current one, the files keep the originals', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.cost.update();
  near(day(r.cost, '2026-10-20')[0].listUSD, 0.003, 'a closed day keeps its prices');
  const bytes = fs.readFileSync(monthFile(r));

  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'repriced' });
  assert.equal(c.priceVersion, r.cost.versions().current);
  assert.equal(c.rows.length, 1);
  for (const cost of [r.cost, r.make()]) {
    const [d20] = cost.ledger({ from: '2026-10-20', to: '2026-10-20', groupBy: ['day', 'priceVersion'] }).rows;
    near(d20.listUSD, 0.006);
    assert.equal(d20.priceVersion, 2);
    near(day(cost, '2026-10-21')[0].listUSD, 0.003, 'a day outside the range keeps its prices');
  }
  assert.deepEqual(fs.readFileSync(monthFile(r)), bytes, 'the month file is untouched');
});

test('restate re-attributes: the center follows the current folder rules', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.settings = ACME;
  r.cost.update();
  assert.equal(day(r.cost, '2026-10-20', ['center'])[0].center, 'unassigned', 'a closed day keeps its center');
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'acme started on the 20th' });
  assert.deepEqual(
    c.rows.map((x) => [x.before.center, x.after.center, x.before.listUSD === x.after.listUSD]),
    [['unassigned', 'acme', true]],
  );
  for (const cost of [r.cost, r.make()]) {
    const rows = day(cost, '2026-10-20', ['center']);
    assert.deepEqual(
      rows.map((x) => x.center),
      ['acme'],
    );
    near(rows[0].listUSD, 0.003);
  }
});

test('restate is idempotent: a second identical restate changes no total', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(21), 'm2')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.st.settings = { ...ACME, billing: { claude: MAX } };
  r.cost.update();
  const q = { from: '2026-10-20', to: '2026-10-21', groupBy: ['day', 'center', 'kind'] };
  const req = { from: '2026-10-20', to: '2026-10-21', reason: 'all of it' };
  assert.equal(r.cost.restate(req).rows.length, 2);
  const once = r.cost.ledger(q);
  near(once.totals.listUSD, 0.012);
  near(once.totals.billedUSD, 20);
  const second = r.cost.restate(req);
  assert.deepEqual(second.rows, [], 'the view already shows the restated amounts');
  assert.equal(r.cost.billingHistory().overrides.length, 6, "the second restate replaces the first one's overrides");
  for (const cost of [r.cost, r.make()]) {
    const twice = cost.ledger(q);
    assert.deepEqual(twice.rows, once.rows);
    assert.deepEqual(twice.totals, once.totals);
    assert.equal(twice.corrections, 2);
  }
});

test('restate checks its range and reason; an unchanged range still records the correction', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1')]));
  r.cost.update();
  assert.throws(() => r.cost.restate({ from: '2026-10-21', to: '2026-10-21', reason: 'x' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-22', reason: 'x' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-19', reason: 'x' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-32', to: '2026-10-20', reason: 'x' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: ' ' }), { status: 400 });
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-20' }), { status: 400 });
  r.st.settings = { billing: { claude: { mode: 'plan' } } }; // a hand edit that does not validate
  assert.throws(() => r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'x' }), {
    status: 409,
    message: /invalid/,
  });
  r.st.settings = undefined;
  assert.equal(r.cost.billingHistory().overrides.length, 0, 'a refused restate writes nothing');
  assert.equal(r.cost.status().ledger.corrections, 0);
  const c = r.cost.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'check' });
  assert.deepEqual(c.rows, []);
  assert.equal(r.cost.status().ledger.corrections, 1);
});

test('restate over a month or corrections that did not read throws, and writes neither a correction nor an override', () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1')]));
  r.cost.update();
  r.st.t = at(22);
  r.cost.update();
  const req = { from: '2026-10-20', to: '2026-10-20', reason: 'x' };

  const month = makeUnreadable(monthFile(r));
  let c;
  try {
    c = r.make(); // a restart: October does not load
    assert.throws(() => c.restate(req), {
      code: 'LEDGER_MONTH_UNREAD',
      message: /^ledger month 2026-10 could not be read$/,
    });
    assert.throws(() => c.restate({ ...req, from: '2026-09-30' }), { code: 'LEDGER_MONTH_UNREAD' });
  } finally {
    month.restore();
  }
  assert.equal(c.billingHistory().overrides.length, 0);
  assert.equal(correctionLines(r).length, 0);

  fs.writeFileSync(path.join(r.costDir, 'corrections.jsonl'), '');
  const corr = makeUnreadable(path.join(r.costDir, 'corrections.jsonl'));
  try {
    c = r.make();
    assert.throws(() => c.restate(req), { code: 'LEDGER_CORRECTIONS_UNREAD' });
  } finally {
    corr.restore();
  }
  assert.equal(c.billingHistory().overrides.length, 0);
  assert.equal(correctionLines(r).length, 0);

  // Readable again: the restate reads what it needs and goes through without waiting for a pass.
  assert.equal(c.restate(req).to, '2026-10-20');
  assert.equal(correctionLines(r).length, 1);
  assert.equal(c.billingHistory().overrides.length, 6);
});

test('a restate after the billing history was lost keeps the loss: days outside the range stay assumed', () => {
  const r = rig();
  r.st.t = at(20);
  r.st.entries.push(file('a', [ev(at(19), 'm1'), ev(at(20), 'm2')]));
  r.cost.update();
  r.st.t = at(21);
  r.cost.update();
  for (const f of ['billing.json', 'billing.json.bak']) fs.rmSync(path.join(r.costDir, f));
  r.st.t = at(22);
  r.st.settings = { billing: { claude: MAX } };
  const c = r.make(); // a restart: the history is lost, and no pass has run yet
  assert.equal(c.status().billing.historyLost, true);
  assert.equal(c.restate({ from: '2026-10-20', to: '2026-10-20', reason: 'Max on the 20th' }).billing.length, 6);

  const again = r.make();
  again.update(); // claude is on Max now: the loss keeps it from being backfilled over closed days
  assert.equal(again.status().billing.historyLost, true);
  assert.equal(again.billingHistory().lostBefore, '2026-10-22');
  const rows = again.ledger({ from: '2026-10-19', to: '2026-10-21', groupBy: ['day', 'source', 'kind'] }).rows;
  const of = (d) => rows.filter((x) => x.day === d);
  assert.deepEqual(
    of('2026-10-19').map((x) => [x.kind, x.billingAssumed, x.billedUSD]),
    [['chat', true, 0.003]],
  );
  assert.deepEqual(
    of('2026-10-20').map((x) => [x.kind, x.billingAssumed]),
    [
      ['plan', false],
      ['chat', false],
    ],
  );
  assert.equal(of('2026-10-21').length, 0, 'no plan row outside the range');
});
