// test/cost-pass.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCost } = require('../lib/cost');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const at = (d, h = 12, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026, local time
const PRICE_A = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 } };
const PRICE_B = { 'claude-sonnet-5-5': { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5, cacheWrite1h: 8 } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-pass-'));
// One Claude Code API response of Sonnet: 1,000 in and 100 out (0.003 at PRICE_A, 0.006 at PRICE_B).
const ev = (ts, key, sid = 's1') => [ts, 'claude', sid, 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, key, null];
const session = (sid, folder, tool = 'claude') => ({
  [sid]: { tool, project: path.join(HOME, ...folder.split('/')), tools: {}, skills: {}, agents: {}, prompts: 0, subagentFiles: 0 },
});
const file = (name, events, sessions = session('s1', 'work/acme')) => ({
  file: `/logs/${name}.jsonl`,
  source: 'claude',
  size: events.length,
  mtimeMs: 1,
  result: { events, sessions },
});
const gwLine = (ts, extra = {}) =>
  JSON.stringify({
    ts,
    keyId: 'key_a',
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    kind: 'chat',
    status: 200,
    input: 1000,
    output: 100,
    cached: 0,
    ...extra,
  }) + '\n';

function rig({ settings, pricing = PRICE_A, day = 22 } = {}) {
  const dir = tmp();
  const st = { entries: [], pricing, settings, t: at(day) };
  const costDir = path.join(dir, 'cost');
  const gatewayLog = path.join(dir, 'gateway-usage.jsonl');
  const make = () =>
    createCost({
      dir: costDir,
      gatewayLog,
      entries: () => st.entries,
      getPricing: () => st.pricing,
      getSettings: () => st.settings,
      isPrivate: (id) => id === 'ollama',
      home: HOME,
      now: () => st.t,
      nocase: false,
    });
  return { st, costDir, gatewayLog, make, cost: make() };
}
const rowsOf = (cost, from, to, groupBy) => cost.ledger({ from, to, groupBy }).rows;
const stored = (costDir) =>
  fs
    .readFileSync(path.join(costDir, 'ledger-2026-10.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test("first pass: history is filled with today's prices and marked backfilled; today is not", () => {
  const r = rig();
  r.st.entries.push(file('a', [ev(at(20), 'm1'), ev(at(22), 'm2')]));
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-01', '2026-10-31', ['day', 'project', 'center']);
  assert.deepEqual(
    rows.map((x) => [x.day, x.project, x.center, x.backfilled]),
    [
      ['2026-10-20', '~/work/acme', 'unassigned', true],
      ['2026-10-22', '~/work/acme', 'unassigned', false],
    ],
  );
  near(rows[0].listUSD, 0.003);
  near(rows[0].billedUSD, 0.003);
  const st = r.cost.status();
  assert.deepEqual(st.backfill, { firstDay: '2026-10-22', rows: 1 });
  assert.equal(st.priceVersion.id, 1);
  assert.equal(st.collectors.local.error, null);
});

test('freezing: after a price change yesterday keeps its price and today uses the new one', () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21), 'm1')]));
  r.cost.update();
  r.st.t = at(22);
  r.st.pricing = PRICE_B;
  r.st.entries.push(file('b', [ev(at(22), 'm2')]));
  r.cost.update();
  const [d21, d22] = rowsOf(r.cost, '2026-10-21', '2026-10-22', ['day']);
  near(d21.listUSD, 0.003);
  near(d22.listUSD, 0.006);
  assert.deepEqual(
    stored(r.costDir)
      .map((x) => [x.day, x.priceVersion])
      .sort(),
    [
      ['2026-10-21', 1],
      ['2026-10-22', 2],
    ],
  );
  const v = r.cost.versions();
  assert.equal(v.current, 2);
  assert.deepEqual(
    v.versions.map((x) => [x.id, x.from, x.changed]),
    [
      [1, '2026-10-21', []],
      [2, '2026-10-22', ['claude-sonnet-5-5']],
    ],
  );
});

test("late events land on their own day with that day's price version", () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21, 9), 'm1')]));
  fs.writeFileSync(r.gatewayLog, gwLine(at(21, 9)));
  r.cost.update();
  r.st.t = at(22, 0, 5);
  r.st.pricing = PRICE_B;
  r.cost.update();
  r.st.entries.push(file('late', [ev(at(21, 23), 'm9')])); // a log indexed after its day ended
  fs.appendFileSync(r.gatewayLog, gwLine(at(21, 23, 59)));
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-21', '2026-10-21', ['source']);
  const claude = rows.find((x) => x.source === 'claude');
  const gw = rows.find((x) => x.source === 'gateway');
  assert.equal(claude.requests, 2);
  near(claude.listUSD, 0.006); // 2 × 0.003, at version 1
  assert.equal(gw.requests, 2);
  near(gw.listUSD, 0.006);
  for (const x of stored(r.costDir).filter((y) => y.day === '2026-10-21')) {
    assert.equal(x.priceVersion, 1);
    assert.equal(x.backfilled, false);
  }
});

test('a resumed or forked session counts once, and a closed day never shrinks when its log is gone', () => {
  const r = rig({ day: 21 });
  r.st.entries.push(file('a', [ev(at(21), 'm1')]), file('resumed', [ev(at(21), 'm1', 's2')], session('s2', 'work/acme')));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-21', '2026-10-21', ['day'])[0].requests, 1);
  r.st.t = at(22);
  r.st.entries = []; // Claude Code removed the old transcripts
  r.cost.update();
  const [d21] = rowsOf(r.cost, '2026-10-21', '2026-10-21', ['day']);
  assert.equal(d21.requests, 1);
  near(d21.listUSD, 0.003);
});

test('gateway log: each line is read once across passes, a rotation and a restart; a torn last line waits', () => {
  const r = rig();
  fs.writeFileSync(r.gatewayLog, gwLine(at(22, 1)) + gwLine(at(22, 2)));
  r.cost.update();
  fs.appendFileSync(r.gatewayLog, gwLine(at(22, 3)));
  fs.renameSync(r.gatewayLog, `${r.gatewayLog}.1`);
  const fifth = gwLine(at(22, 5));
  fs.writeFileSync(r.gatewayLog, gwLine(at(22, 4)) + fifth.slice(0, 20));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source'])[0].requests, 4);
  fs.appendFileSync(r.gatewayLog, fifth.slice(20));
  r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source'])[0].requests, 5);
  const again = r.make(); // cursors.json carries the place
  again.update();
  assert.equal(rowsOf(again, '2026-10-22', '2026-10-22', ['source'])[0].requests, 5);
});

test('gateway lines: replay, judge and collaboration calls are told apart; failed attempts and private models cost nothing', () => {
  const r = rig();
  fs.writeFileSync(
    r.gatewayLog,
    [
      gwLine(at(22), { keyId: 'dashboard', agent: 'replay', kind: 'agent' }),
      gwLine(at(22), { keyId: 'dashboard', agent: 'judge', kind: 'agent' }),
      gwLine(at(22), { keyId: 'dashboard', agent: 'planner', kind: 'agent', runId: 'run_1' }),
      gwLine(at(22), { kind: 'embeddings', output: 0 }),
      gwLine(at(22), { status: 599, input: 0, output: 0, error: 'down' }),
      gwLine(at(22), { provider: 'ollama', model: 'ollama/qwen3:8b' }),
    ].join(''),
  );
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source', 'kind', 'agent', 'keyId', 'provider']);
  assert.deepEqual(rows.map((x) => `${x.source}|${x.kind}|${x.agent}|${x.keyId}|${x.provider}`).sort(), [
    'collab|run|planner|null|openrouter',
    'gateway|chat|null|key_a|ollama',
    'gateway|embed|null|key_a|openrouter',
    'judge|judge|null|null|openrouter',
    'replay|replay|null|null|openrouter',
  ]);
  const local = rows.find((x) => x.provider === 'ollama');
  assert.deepEqual([local.listUSD, local.unpriced], [0, false]);
  near(rows.find((x) => x.kind === 'embed').listUSD, 0.002);
});

test('judge calls outside the gateway are recorded once; external ones are left to the gateway log', () => {
  const r = rig();
  const usage = { input: 1600, output: 40, cost: 0.01, cacheRead: 100, cacheWrite: 1500 };
  r.cost.recordJudge({ kind: 'claude-cli', provider: 'claude-code', model: 'claude-sonnet-5-5', usage });
  r.cost.recordJudge({ kind: 'external', provider: 'openrouter', model: 'x/y', usage: { input: 10, output: 5, cost: 0 } });
  r.cost.recordJudge({ kind: 'ollama', provider: 'ollama', model: 'qwen3:8b', usage: { input: 900, output: 30, cost: 0 } });
  r.cost.update();
  r.cost.update();
  const rows = rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source', 'provider', 'model']);
  assert.equal(rows.length, 2);
  const cc = rows.find((x) => x.provider === 'claude-code');
  assert.equal(cc.requests, 1);
  assert.deepEqual(cc.tokens, { in: 0, out: 40, cacheRead: 100, cacheWrite5m: 1500, cacheWrite1h: 0 });
  near(cc.listUSD, (40 * 10 + 100 * 0.2 + 1500 * 2.5) / 1e6);
  assert.equal(rows.find((x) => x.provider === 'ollama').listUSD, 0);
  const lines = fs.readFileSync(path.join(r.costDir, 'judge-calls.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('plans: the fee is spread per day, usage shows value received, and nothing is counted twice', () => {
  const r = rig({ settings: { billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 310, period: 'month' } } } });
  r.st.entries.push(file('a', [ev(at(21), 'm1'), ev(at(22), 'm2')]));
  r.st.entries.push({
    file: '/logs/codex.jsonl',
    source: 'codex',
    size: 1,
    mtimeMs: 1,
    result: { events: [[at(22), 'codex', 'c1', 'claude-sonnet-5-5', 1000, 100, 0, 0, 0, 0, null, null]], sessions: session('c1', 'm', 'codex') },
  });
  r.cost.update();
  r.cost.update(); // a second pass adds nothing
  const rows = rowsOf(r.cost, '2026-10-21', '2026-10-22', ['source', 'kind']);
  const use = rows.find((x) => x.source === 'claude' && x.kind === 'chat');
  const plan = rows.find((x) => x.source === 'claude' && x.kind === 'plan');
  const codex = rows.find((x) => x.source === 'codex');
  near(use.listUSD, 0.006);
  assert.equal(use.billedUSD, 0);
  near(plan.billedUSD, 20); // 310 / 31 for each of the 21st and the 22nd
  assert.deepEqual([plan.listUSD, plan.requests], [0, 0]);
  near(codex.listUSD, 0.003);
  near(codex.billedUSD, 0.003);
  const t = r.cost.ledger({ from: '2026-10-21', to: '2026-10-22', groupBy: ['day'] }).totals;
  near(t.listUSD, 0.009);
  near(t.billedUSD, 20.003);
  r.st.settings = { billing: { claude: { mode: 'plan', plan: 'Max', feeUSD: 365, period: 'year' } } };
  r.cost.update();
  near(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['kind']).find((x) => x.kind === 'plan').billedUSD, 1);
  near(rowsOf(r.cost, '2026-10-21', '2026-10-21', ['kind']).find((x) => x.kind === 'plan').billedUSD, 10);
});

test("attribution: the key's center, then the first matching folder rule, then Unassigned; only today follows a change", () => {
  const settings = {
    centers: [
      { id: 'acme', name: 'Acme' },
      { id: 'lab', name: 'Lab' },
      { id: 'work', name: 'Work' },
    ],
    keyCenters: { key_a: 'lab' },
    folderRules: [
      { glob: '~/work/acme/**', center: 'acme' },
      { glob: '~/work/**', center: 'work' },
    ],
  };
  const r = rig({ settings, day: 21 });
  r.st.entries.push(
    file('a', [ev(at(21), 'm1')], session('s1', 'work/acme/api')),
    file('b', [ev(at(21), 'm2', 's2')], session('s2', 'work/other')),
    file('c', [ev(at(21), 'm3', 's3')], session('s3', 'play')),
  );
  fs.writeFileSync(r.gatewayLog, gwLine(at(21)));
  r.cost.update();
  const centers = (d) =>
    Object.fromEntries(rowsOf(r.cost, d, d, ['source', 'project', 'center']).map((x) => [`${x.source} ${x.project}`, x.center]));
  assert.deepEqual(centers('2026-10-21'), {
    'claude ~/work/acme/api': 'acme',
    'claude ~/work/other': 'work',
    'claude ~/play': 'unassigned',
    'gateway null': 'lab',
  });
  r.st.t = at(22);
  r.st.settings = { ...settings, folderRules: [{ glob: '~/**', center: 'work' }] };
  r.st.entries.push(file('d', [ev(at(22), 'm4', 's4')], session('s4', 'play')));
  r.cost.update();
  assert.equal(centers('2026-10-21')['claude ~/play'], 'unassigned', 'a closed day keeps its center');
  assert.equal(centers('2026-10-22')['claude ~/play'], 'work');
});

test('an invalid cost section means the defaults and the status says so; a failing collector stops nothing else', () => {
  const r = rig({ settings: { centers: 'nope' } });
  fs.mkdirSync(r.gatewayLog); // a folder where the log should be: reading it fails
  r.st.entries.push(file('a', [ev(at(22), 'm1')]));
  const st = r.cost.update();
  assert.match(st.settings.error, /invalid/);
  assert.match(st.collectors.gateway.error, /^the gateway log could not be read \(E[A-Z]+\)$/);
  assert.equal(st.collectors.local.error, null);
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source']).length, 1);
  assert.doesNotMatch(JSON.stringify(st), /Users|zp-cost-pass/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(r.costDir).mode & 0o777, 0o700);
    for (const f of ['ledger-2026-10.jsonl', 'cursors.json']) assert.equal(fs.statSync(path.join(r.costDir, f)).mode & 0o777, 0o600, f);
  }
});

// A month file the store cannot read: no read permission where that holds (not on Windows, not as root), else a folder
// in its place. `restore` puts the readable file back.
function makeUnreadable(file) {
  const text = fs.readFileSync(file, 'utf8');
  const byMode = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);
  if (byMode) fs.chmodSync(file, 0o000);
  else {
    fs.rmSync(file);
    fs.mkdirSync(file);
  }
  return {
    restore() {
      if (byMode) fs.chmodSync(file, 0o600);
      else {
        fs.rmSync(file, { recursive: true });
        fs.writeFileSync(file, text);
      }
    },
  };
}
const cursorsOf = (costDir) => JSON.parse(fs.readFileSync(path.join(costDir, 'cursors.json'), 'utf8'));
const requestsBy = (cost, day, dim) =>
  Object.fromEntries(rowsOf(cost, day, day, [dim]).map((x) => [x[dim], x.requests]));

test('an unreadable month stops every pass that needs it: no cursor moves, the file is untouched, and the next pass counts each line once', () => {
  const r = rig({ settings: { billing: { codex: { mode: 'plan', plan: 'Pro', feeUSD: 31, period: 'month' } } } });
  const oct = path.join(r.costDir, 'ledger-2026-10.jsonl');
  r.st.entries.push(file('a', [ev(at(22, 1), 'm1')]));
  fs.writeFileSync(r.gatewayLog, gwLine(at(22, 1)) + gwLine(at(22, 2)));
  r.cost.update();
  const before = cursorsOf(r.costDir);
  const octBytes = fs.readFileSync(oct);

  r.st.entries.push(file('b', [ev(at(22, 3), 'm2')]));
  fs.appendFileSync(r.gatewayLog, gwLine(at(22, 3)));
  const u = makeUnreadable(oct);
  let again;
  try {
    again = r.make(); // a restart: October does not load
    const st = again.update();
    for (const k of ['local', 'gateway'])
      assert.match(st.collectors[k].error, /^ledger month 2026-10 could not be read \(E[A-Z]+\)$/, k);
    assert.match(st.ledger.error, /^ledger month 2026-10 could not be read \(E[A-Z]+\)$/);
    assert.deepEqual(st.ledger.unread, ['2026-10']);
    assert.doesNotMatch(JSON.stringify(st), /Users|zp-cost-pass/);
    const after = cursorsOf(r.costDir);
    assert.deepEqual(after.gateway, before.gateway, 'the gateway cursor stays before the lines that were not stored');
    assert.deepEqual(after.plans, before.plans);
    assert.deepEqual(again.ledger({ from: '2026-10-01', to: '2026-10-31' }).unread, ['2026-10']);
  } finally {
    u.restore();
  }
  assert.deepEqual(fs.readFileSync(oct), octBytes, 'the month file is untouched');

  const st = again.update(); // readable again: this pass catches up
  assert.equal(st.collectors.gateway.error, null);
  assert.equal(st.collectors.local.error, null);
  assert.equal(st.ledger.error, null);
  assert.deepEqual(st.ledger.unread, []);
  const want = { claude: 2, gateway: 3, codex: 0 };
  assert.deepEqual(requestsBy(again, '2026-10-22', 'source'), want);
  again.update();
  assert.deepEqual(requestsBy(again, '2026-10-22', 'source'), want);
  const fresh = r.make();
  fresh.update();
  assert.deepEqual(requestsBy(fresh, '2026-10-22', 'source'), want);
  assert.equal(stored(r.costDir).filter((x) => x.kind === 'plan').length, 1);
});

test('an unreadable past month stops only the collector that needs it, and all of its lines wait together', () => {
  const r = rig();
  const sep = path.join(r.costDir, 'ledger-2026-09.jsonl');
  const sepAt = new Date(2026, 8, 30, 12).getTime();
  fs.writeFileSync(r.gatewayLog, gwLine(sepAt) + gwLine(at(22, 1)));
  r.cost.update();
  const before = cursorsOf(r.costDir);
  const sepBytes = fs.readFileSync(sep);

  fs.appendFileSync(r.gatewayLog, gwLine(sepAt) + gwLine(at(22, 2))); // a late September line, then a new one
  r.st.entries.push(file('a', [ev(at(22, 3), 'm1')]));
  const u = makeUnreadable(sep);
  let again;
  try {
    again = r.make();
    const st = again.update();
    assert.match(st.collectors.gateway.error, /^ledger month 2026-09 could not be read \(E[A-Z]+\)$/);
    assert.equal(st.collectors.local.error, null, 'the local collector does not need September');
    assert.match(st.ledger.error, /^ledger month 2026-09 could not be read/);
    assert.deepEqual(requestsBy(again, '2026-10-22', 'source'), { claude: 1, gateway: 1 }, 'none of the batch is stored');
    assert.deepEqual(cursorsOf(r.costDir).gateway, before.gateway);
    assert.ok(stored(r.costDir).some((x) => x.source === 'claude'), 'the rows that could be written were written');
  } finally {
    u.restore();
  }
  assert.deepEqual(fs.readFileSync(sep), sepBytes);
  again.update();
  const check = (c) => {
    assert.deepEqual(requestsBy(c, '2026-10-22', 'source'), { claude: 1, gateway: 2 });
    assert.deepEqual(requestsBy(c, '2026-09-30', 'source'), { gateway: 2 });
  };
  check(again);
  const fresh = r.make();
  fresh.update();
  check(fresh);
});

test("gateway lines from Claude Code or Codex on this machine are left to their logs and counted in the gateway's status", () => {
  const r = rig();
  fs.writeFileSync(
    r.gatewayLog,
    [
      gwLine(at(22), { client: 'claude-code', local: true }),
      gwLine(at(22), { client: 'codex', local: true }),
      gwLine(at(22), { client: 'claude-code' }), // another machine
      gwLine(at(22)),
    ].join(''),
  );
  let st = r.cost.update();
  assert.equal(rowsOf(r.cost, '2026-10-22', '2026-10-22', ['source'])[0].requests, 2);
  assert.equal(st.collectors.gateway.skippedLocalClients, 2);
  assert.equal(st.collectors.local.skippedLocalClients, 0);
  st = r.cost.update(); // the lines are read once, and so counted once
  assert.equal(st.collectors.gateway.skippedLocalClients, 2);
});

test('price version problems found at load are named in the status', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.costDir, 'prices'), { recursive: true });
  fs.writeFileSync(path.join(r.costDir, 'prices', 'versions.json'), '{ not json');
  const c = r.make();
  const st = c.update();
  assert.ok(st.prices.problems.some((p) => /version index was unreadable/.test(p)));
  assert.doesNotMatch(JSON.stringify(st.prices), /Users|zp-cost-pass/);
});

test('a step that does not need the unreadable month is saved with its cursor, and a log the ledger could not take is read again', () => {
  const r = rig();
  const sep = path.join(r.costDir, 'ledger-2026-09.jsonl');
  const sepAt = new Date(2026, 8, 30, 12).getTime();
  r.st.entries.push(file('a', [ev(at(22, 1), 'm1')]));
  fs.writeFileSync(r.gatewayLog, gwLine(sepAt) + gwLine(at(22, 1)));
  r.cost.update();
  const u = makeUnreadable(sep);
  let again;
  try {
    again = r.make();
    again.update();
    fs.appendFileSync(r.gatewayLog, gwLine(at(22, 2)));
    r.st.entries.push(file('late', [ev(sepAt, 'm9', 's9')], session('s9', 'work/acme')));
    const st = again.update();
    assert.equal(st.collectors.gateway.error, null);
    assert.match(st.collectors.local.error, /^ledger month 2026-09 could not be read/);
    assert.equal(cursorsOf(r.costDir).gateway.offset, fs.statSync(r.gatewayLog).size, 'stored lines move the cursor');
    const restarted = r.make(); // still unreadable: the October lines are not read a second time
    restarted.update();
    assert.equal(requestsBy(restarted, '2026-10-22', 'source').gateway, 2);
  } finally {
    u.restore();
  }
  again.update();
  const check = (c) => {
    assert.deepEqual(requestsBy(c, '2026-09-30', 'source'), { claude: 1, gateway: 1 });
    assert.deepEqual(requestsBy(c, '2026-10-22', 'source'), { claude: 1, gateway: 2 });
  };
  check(again);
  const fresh = r.make();
  fresh.update();
  check(fresh);
});
