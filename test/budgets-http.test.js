// test/budgets-http.test.js: a spawned server.js, the demo and a real data folder. No real provider, no network: the
// upstream is a fake server on 127.0.0.1; pricing sync is off; notifications are off (NO_JUDGE_PORTS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor, fakeServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const JSON_HEADERS = { 'content-type': 'application/json' };
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const PRICE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-http-'));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // A range of its own: no other test uses 8400-8799.
    const port = 8400 + Math.floor(Math.random() * 400);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env, { data = tmp() } = {}) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: '',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
        // The demo makes a throwaway folder in the temp folder: this test's own, so stop() removes it.
        TMPDIR: data,
        TEMP: data,
        TMP: data,
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
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop, data };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}
function client(base, headers = {}) {
  const bodies = [];
  const call = async (p, { method = 'GET', body, extra = {} } = {}) => {
    const r = await fetch(base + p, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...headers, ...extra },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    bodies.push(text);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: r.status, json, text };
  };
  return { call, post: (p, body) => call(p, { method: 'POST', body, extra: JSON_HEADERS }), bodies };
}

test('budgets over HTTP: the demo budgets and budget alerts, the retired rules, path-free', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const c = client(s.base);
  try {
    // The demo's throwaway folder is made in the test's own folder, so stop() removes it with the rest.
    assert.equal(fs.readdirSync(s.data).filter((f) => f.startsWith('zp-demo-')).length, 1);
    const r = await c.call('/api/cost/budgets');
    assert.equal(r.status, 200);
    const v = Object.fromEntries(r.json.budgets.map((b) => [b.id, b]));
    assert.deepEqual([v['acme-gateway'].state, v['acme-gateway'].enforce], ['exceeded', 'block']);
    assert.equal(v['research-week'].state, 'no_data');
    assert.equal(v['legacy-monthly'].legacy, 'monthlyBudgetUSD');
    const alerts = (await c.call('/api/alerts')).json.alerts.filter((a) => a.rule === 'budget');
    // The team budget's period follows the demo clock (month, week or day): its alert carries the same one.
    assert.deepEqual(
      alerts.map((a) => [a.title, a.period, a.ruleTitle]),
      [
        ['Whole team', v.team.period, 'Budget'],
        ['Acme gateway key', 'month', 'Budget'],
      ],
      'newest first',
    );
    const ids = (await c.call('/api/monitors')).json.rules.map((x) => x.id);
    assert.equal(ids.includes('daily_cost') || ids.includes('month_projection'), false);
    const cfg = (await c.call('/api/config')).json;
    assert.deepEqual([cfg.monthlyBudgetUSD, cfg.monthlyBudgetManaged], [1000, false]);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});

test('budgets over HTTP: sign-in only; a key budget answers 402 at once; a legacy edit moves the old setting', async () => {
  const upstream = await fakeServer({
    'POST /chat/completions': {
      body: {
        id: 'c1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }, // 0.002 at PRICE
      },
    },
    'GET /models': { body: { data: [{ id: 'llama-9' }] } },
  });
  const data = tmp();
  const gw = createGateway({
    dataDir: path.join(data, '.data'),
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const { key, secret } = gw.keys.create({ name: 'app', scopes: ['llm'], budgetUSD: 0.002, rpm: 600 });
  gw.flush();
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      pricingSync: { enabled: false },
      pricing: { 'llama-9': PRICE },
      monthlyBudgetUSD: 50,
      cost: { centers: [{ id: 'acme', name: 'Acme' }] },
      gateway: { providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, models: [], enabled: true }] },
    }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const bearer = client(s.base, { authorization: `Bearer ${secret}`, 'x-api-key': secret });
    for (const who of [client(s.base), bearer]) {
      assert.equal((await who.call('/api/cost/budgets')).status, 401);
      assert.equal((await who.post('/api/cost/budgets', {})).status, 401);
      assert.equal((await who.post('/api/cost/budgets/legacy-monthly/delete', {})).status, 401);
    }
    const chat = () =>
      bearer.post('/v1/chat/completions', { model: 'fake/llama-9', messages: [{ role: 'user', content: 'x' }] });
    assert.equal((await chat()).status, 200);
    const refused = await chat();
    assert.equal(refused.status, 402, 'blocked before any ledger pass read the call');
    assert.match(refused.text, /budget \\?"Key app\\?" is used up for this month/);
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const c = client(s.base, { cookie });
    const list = Object.fromEntries((await c.call('/api/cost/budgets')).json.budgets.map((b) => [b.id, b]));
    assert.equal(list[`legacy-key-${key.id}`].state, 'exceeded');
    assert.deepEqual([list['legacy-monthly'].amount, list['legacy-monthly'].legacy], [50, 'monthlyBudgetUSD']);
    assert.equal((await c.call('/api/cost/budgets', { method: 'POST', body: {} })).status, 415);
    assert.equal((await c.post('/api/cost/budgets', { id: 'x' })).status, 400);
    const edit = await c.post('/api/cost/budgets', {
      id: 'legacy-monthly',
      name: 'Team month',
      scope: 'global',
      period: 'month',
      amount: 60,
    });
    assert.equal(edit.status, 200);
    const file = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    assert.equal(file.monthlyBudgetUSD, 0, 'the old setting is cleared in the same write');
    assert.deepEqual(
      file.cost.budgets.map((b) => b.id),
      ['legacy-monthly'],
    );
    assert.deepEqual(file.cost.centers, [{ id: 'acme', name: 'Acme' }], 'the cost settings are kept');
    assert.equal(file.pricingSync.enabled, false, 'every other section is kept');
    const cfg = (await c.call('/api/config')).json;
    assert.deepEqual([cfg.monthlyBudgetUSD, cfg.monthlyBudgetManaged], [60, true]);
    // The settings save checks the saved budgets: removing the center a budget is on is refused until it is gone.
    const onAcme = {
      id: 'acme-month',
      name: 'Acme',
      scope: { dim: 'center', value: 'acme' },
      period: 'month',
      amount: 5,
    };
    assert.equal((await c.post('/api/cost/budgets', onAcme)).status, 200);
    const noCenter = await c.post('/api/cost/settings', { centers: [] });
    assert.equal(noCenter.status, 409);
    assert.deepEqual(noCenter.json.reasons, ['budget acme-month: scope.value: unknown cost center']);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).cost.centers.length,
      1,
      'nothing is written on a refusal',
    );
    assert.equal((await c.post('/api/cost/budgets/acme-month/delete', {})).status, 200);
    assert.equal((await c.post(`/api/cost/budgets/legacy-key-${key.id}/delete`, {})).status, 200);
    assert.equal((await chat()).status, 200, 'the key budget is gone with its budgetUSD');
    assert.equal(
      (await c.call('/api/monitors')).json.rules.some((r) => r.id === 'daily_cost'),
      false,
    );
    const kept = JSON.parse(fs.readFileSync(path.join(data, '.data', 'cost', 'budgets.last.json'), 'utf8'));
    assert.deepEqual(
      kept.budgets.map((b) => b.id),
      ['legacy-monthly'],
      'the last valid list is on disk',
    );
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(path.join(data, '.data', 'cost', 'budgets.last.json')).mode & 0o777, 0o600);
    for (const b of [...c.bodies, ...bearer.bodies]) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
    await upstream.close();
  }
});

test('budgets over HTTP: a hand-broken config.json is never overwritten by a Settings or a price save', async () => {
  const data = tmp();
  const blk = { id: 'blk', name: 'Everything', scope: 'global', period: 'month', amount: 5, enforce: 'block' };
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      pricingSync: { enabled: false },
      cost: { centers: [{ id: 'acme', name: 'Acme' }], budgets: [blk] },
    }),
  );
  const s = await startServer({ ZAAFPULSE_AUTH: 'none' }, { data });
  const c = client(s.base);
  try {
    const ids = async () => (await c.call('/api/cost/budgets')).json.budgets.map((b) => b.id);
    assert.ok((await ids()).includes('blk'));
    const configFile = path.join(data, 'config.json');
    const keptFile = path.join(data, '.data', 'cost', 'budgets.last.json');
    fs.writeFileSync(configFile, '{ "userName": "a hand edit gone wrong", ');
    const before = { config: fs.readFileSync(configFile), kept: fs.readFileSync(keptFile) };
    assert.ok((await ids()).includes('blk'), 'the last valid list is in force');
    const saves = [
      ['/api/config', { userName: 'x', monthlyBudgetUSD: 5 }],
      ['/api/prices', { action: 'set', key: 'llama-9', price: { input: 1 } }],
      ['/api/prices', { action: 'toggle', enabled: true }],
    ];
    for (const [route, body] of saves) {
      const r = await c.post(route, body);
      assert.equal(r.status, 409, route);
      assert.deepEqual(r.json, { error: 'config.json could not be read; fix it first' });
    }
    assert.deepEqual(fs.readFileSync(configFile), before.config, 'config.json is left as it is');
    assert.deepEqual(fs.readFileSync(keptFile), before.kept, 'the kept list is left as it is');
    const after = await c.call('/api/cost/budgets');
    assert.deepEqual(
      after.json.budgets.filter((b) => !b.legacy).map((b) => [b.id, b.enforce]),
      [['blk', 'block']],
    );
    assert.match(after.json.error, /config\.json could not be read/);
    for (const b of c.bodies) assert.doesNotMatch(b, PATHS, 'a response body holds a file path');
  } finally {
    await s.stop();
  }
});
