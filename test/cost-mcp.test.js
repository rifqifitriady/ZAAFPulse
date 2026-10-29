// Cost Control 5: acc_cost and acc_budgets. The read-only cost reader (lib/cost/reader.js) writes nothing, the tools are
// shaped and capped, they are on the stdio MCP (mcp.js) only, and neither the server's registry nor gateway /mcp (a
// spawned server.js asked with a gateway key) lists them. Ports 9800-9899 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../lib/cost/ledger');
const { createCostReader, rangeDays } = require('../lib/cost/reader');
const { createLocal } = require('../lib/local');
const { createIntegrations } = require('../lib/integrations');
const { createGateway } = require('../lib/gateway');
const { dayOf } = require('../lib/cost/days');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const NOW = new Date(2026, 9, 22, 15).getTime();
const TODAY = dayOf(NOW);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-mcp-'));
const row = (day, over = {}) => ({
  ...L.newRow({ day, source: 'gateway', provider: 'anthropic', kind: 'chat', center: 'acme', keyId: 'key_a' }),
  model: 'claude-sonnet-5-5',
  requests: 2,
  tokens: { in: 100, out: 10, cacheRead: 5, cacheWrite5m: 1, cacheWrite1h: 1 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
// A data folder as the server leaves it, with what a normal load would rewrite: a bad ledger line, a bad correction
// line, a damaged billing.json beside a good last copy, and no budgets.last.json.
function dataFolder(day = TODAY, models = 3) {
  const data = tmp();
  const dir = path.join(data, '.data', 'cost');
  fs.mkdirSync(dir, { recursive: true });
  const rows = Array.from({ length: models }, (_, i) => row(day, { model: `m-${i}`, listUSD: models - i }));
  fs.writeFileSync(
    path.join(dir, `ledger-${day.slice(0, 7)}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n{"torn": \n',
  );
  fs.writeFileSync(path.join(dir, 'corrections.jsonl'), 'not json\n');
  fs.writeFileSync(path.join(dir, 'billing.json'), '{');
  fs.writeFileSync(path.join(dir, 'billing.json.bak'), JSON.stringify({ version: 1, entries: [], overrides: [] }));
  const budget = {
    id: 'acme',
    name: 'Acme',
    scope: { dim: 'center', value: 'acme' },
    period: 'month',
    amount: 100,
    enforce: 'block',
  };
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ cost: { centers: [{ id: 'acme', name: 'Acme' }], budgets: [budget] }, monthlyBudgetUSD: 50 }),
  );
  return { data, dir };
}
// Every file under a folder, name and bytes.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}
const readerOf = (data, now = () => NOW) =>
  createCostReader({
    dir: path.join(data, '.data', 'cost'),
    configFile: path.join(data, 'config.json'),
    keysFile: path.join(data, '.data', 'keys.json'),
    now,
    nocase: false,
  });

test('reader: spend and budgets from the files, and nothing written (the folder byte for byte)', () => {
  const { data } = dataFolder();
  const before = snapshot(data);
  const r = readerOf(data);
  const s = r.spend({ range: '7', groupBy: ['model'] });
  assert.deepEqual([s.from, s.to, s.groupBy], ['2026-10-16', TODAY, ['model']]);
  assert.deepEqual(
    s.rows.map((x) => [x.model, x.listUSD]),
    [
      ['m-0', 3],
      ['m-1', 2],
      ['m-2', 1],
    ],
  );
  assert.deepEqual(s.rows[0].tokens, { input: 100, output: 10, cacheRead: 5, cacheWrite: 2 });
  assert.deepEqual(s.totals, { requests: 6, listUSD: 6, billedUSD: 6 });
  assert.deepEqual(s.unread, []);
  const b = r.budgets();
  assert.deepEqual(
    b.budgets.map((x) => [x.id, x.spentUSD, x.state]),
    [
      ['acme', 6, 'ok'],
      ['legacy-monthly', 6, 'ok'],
    ],
  );
  for (const v of b.budgets)
    for (const k of ['enforce', 'legacy', 'thresholds', 'periodKey', 'fraction']) assert.ok(!(k in v), k);
  assert.equal(b.error, null);
  for (let i = 0; i < 3; i++) {
    r.spend({ range: 'month', groupBy: ['center', 'keyId'] });
    r.budgets();
  }
  assert.deepEqual(snapshot(data), before, 'no file created, renamed or changed');
  fs.rmSync(data, { recursive: true, force: true });
});

test('reader: a lost billing history is said in acc_cost and nothing is written', () => {
  const { data, dir } = dataFolder();
  fs.rmSync(path.join(dir, 'billing.json'));
  fs.rmSync(path.join(dir, 'billing.json.bak'));
  const before = snapshot(data);
  const s = readerOf(data).spend({ range: '7' });
  assert.deepEqual(s.billing, { error: null, historyLost: true });
  const ok = dataFolder();
  fs.writeFileSync(path.join(ok.dir, 'billing.json'), JSON.stringify({ version: 1, entries: [], overrides: [] }));
  assert.deepEqual(readerOf(ok.data).spend({}).billing, { error: null, historyLost: false });
  assert.deepEqual(snapshot(data), before, 'nothing created, renamed or changed');
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(ok.data, { recursive: true, force: true });
});

test('reader: an empty or whitespace config.json reads as no settings, as in the server', () => {
  const { data } = dataFolder();
  fs.writeFileSync(path.join(data, 'config.json'), ' \n ');
  assert.equal(readerOf(data).budgets().error, null);
  fs.writeFileSync(path.join(data, 'config.json'), '{');
  assert.notEqual(readerOf(data).budgets().error, null);
  fs.rmSync(data, { recursive: true, force: true });
});

test('reader: the ranges, the top 50 then Other, the groupBy rules and a ledger folder that does not read', () => {
  assert.deepEqual(rangeDays('30', TODAY), { from: '2026-09-23', to: TODAY });
  assert.deepEqual(rangeDays('90', TODAY).from, '2026-07-25');
  assert.deepEqual(rangeDays('month', TODAY), { from: '2026-10-01', to: TODAY });
  assert.deepEqual(rangeDays('lastmonth', '2026-01-10'), { from: '2025-12-01', to: '2025-12-31' });
  const { data } = dataFolder(TODAY, 60);
  const s = readerOf(data).spend({});
  assert.equal(s.rows.length, 51);
  const other = s.rows[50];
  assert.deepEqual([other.model, other.count, other.listUSD], ['Other', 10, 55]);
  for (const bad of [[], ['model', 'center', 'source'], ['day'], ['model', 'model'], 'model'])
    assert.throws(() => readerOf(data).spend({ groupBy: bad }), /groupBy: 1 or 2 of/, JSON.stringify(bad));
  assert.throws(() => readerOf(data).spend({ range: 'all' }), /range: one of/);
  const file = tmp();
  fs.writeFileSync(path.join(file, '.data'), 'not a folder');
  assert.throws(
    () => readerOf(file).spend({}),
    (e) => e.message === 'the ledger folder could not be read',
  );
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(file, { recursive: true, force: true });
});

test('registry: the cost tools only with a cost reader, as mcp.js builds it; never as server.js builds it', async () => {
  const { data } = dataFolder();
  const cache = path.join(data, '.cache');
  const names = async (local) =>
    (await createIntegrations({ config: {}, secrets: secretsFor(), local }).listTools()).map((t) => t.name);
  const stdio = await names(createLocal({ cacheDir: cache, dataDir: data, cost: readerOf(data) }));
  assert.ok(stdio.includes('acc_cost') && stdio.includes('acc_budgets'));
  const server = await names(createLocal({ cacheDir: cache, dataDir: data, contentOff: true }));
  assert.ok(server.includes('acc_usage_summary'));
  assert.ok(!server.includes('acc_cost') && !server.includes('acc_budgets'));
  // server.js builds its registry's local data without a cost reader.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const a = src.indexOf('const local = createLocal({');
  const b = src.indexOf('const registry = createIntegrations(');
  assert.ok(a >= 0 && b > a, 'server.js anchors found, in order');
  const call = src.slice(a, b);
  assert.ok(call.length > 0 && !/\bcost\b/.test(call), call);
  const reg = createIntegrations({
    config: {},
    secrets: secretsFor(),
    local: createLocal({ cacheDir: cache, dataDir: data, cost: readerOf(data) }),
  });
  const out = await reg.callTool('acc_cost', { range: '7', groupBy: ['center'] });
  assert.deepEqual(
    JSON.parse(out.result.content[0].text).rows.map((x) => x.center),
    ['acme'],
  );
  const bad = await reg.callTool('acc_cost', { groupBy: ['day'] });
  assert.equal(bad.result.isError, true);
  fs.rmSync(data, { recursive: true, force: true });
});

test('stdio: mcp.js lists acc_cost and acc_budgets and answers them from its data folder', async () => {
  const { data } = dataFolder(dayOf(Date.now()));
  const before = snapshot(path.join(data, '.data', 'cost'));
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], {
    env: { ...process.env, ZAAFPULSE_DATA: data, ACC_CONFIG: '', ACC_CACHE_DIR: path.join(data, '.cache') },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const done = new Promise((r) => child.on('close', r));
  const msgs = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'acc_cost', arguments: { range: '7' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'acc_budgets', arguments: {} } },
  ];
  for (const m of msgs) child.stdin.write(JSON.stringify(m) + '\n');
  child.stdin.end();
  await done;
  const byId = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => [r.id, r]),
  );
  const tools = byId[2].result.tools;
  const cost = tools.find((t) => t.name === 'acc_cost');
  assert.ok(cost && tools.some((t) => t.name === 'acc_budgets'));
  assert.equal(cost.annotations.readOnlyHint, true);
  assert.equal(JSON.parse(byId[3].result.content[0].text).rows.length, 3);
  assert.deepEqual(
    JSON.parse(byId[4].result.content[0].text).budgets.map((b) => b.id),
    ['acme', 'legacy-monthly'],
  );
  assert.deepEqual(snapshot(path.join(data, '.data', 'cost')), before);
  fs.rmSync(data, { recursive: true, force: true });
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9800 + Math.floor(Math.random() * 100);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(data) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        CLAUDE_CONFIG_DIR: '',
        ZAAFPULSE_CLAUDE_DIRS: '',
        XDG_CONFIG_HOME: '',
        CODEX_HOME: '',
        ...NO_JUDGE_PORTS,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        // Trust the answer only once this child is seen still running (another server may hold the port).
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop: kill };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  throw new Error('could not start server.js on a free port');
}

test('gateway /mcp over HTTP: a gateway key lists the acc tools but never acc_cost or acc_budgets', async () => {
  const { data } = dataFolder();
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const { secret } = gw.keys.create({ name: 'client', scopes: ['mcp'], rpm: 60 });
  gw.flush();
  const s = await startServer(data);
  try {
    const rpc = (id, method, params) =>
      fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json());
    await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    });
    const list = await rpc(2, 'tools/list');
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('acc_usage_summary'), names.join(' '));
    assert.ok(!names.includes('acc_cost') && !names.includes('acc_budgets'));
    const call = await rpc(3, 'tools/call', { name: 'acc_cost', arguments: {} });
    assert.ok(call.error || (call.result && call.result.isError), 'not callable either');
  } finally {
    await s.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
