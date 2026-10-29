// Cost Control 5 over HTTP: a spawned server.js sends the export as a download (its type, name and no-store, beside the
// security headers) and the report, on the dashboard sign-in only: never without it, never with a gateway API key.
// Demo mode reads no logs and makes no calls. Ports 9900-9999 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createGateway } = require('../lib/gateway');
const { NO_JUDGE_PORTS, secretsFor } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const PASSWORD = 'correct-horse-battery';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-reports-http-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9900 + Math.floor(Math.random() * 100);
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
        CLAUDE_CONFIG_DIR: '',
        ZAAFPULSE_CLAUDE_DIRS: '',
        XDG_CONFIG_HOME: '',
        CODEX_HOME: '',
        ...NO_JUDGE_PORTS,
        ...env,
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
    const stop = async () => {
      await kill();
      fs.rmSync(data, { recursive: true, force: true });
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        // Trust the answer only once this child is seen still running (another server may hold the port).
        await new Promise((r) => setTimeout(r, 200));
        if (!exited) return { base, stop };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}
const get = (base, p, headers = {}) => fetch(base + p, { signal: AbortSignal.timeout(10000), headers });

test('demo over HTTP: the export downloads as CSV and as JSON, no-store, with the security headers', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  try {
    const r = await get(s.base, '/api/cost/export?from=2026-10-01&to=2026-10-02&groupBy=model');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      r.headers.get('content-disposition'),
      'attachment; filename="zaafpulse-cost-2026-10-01-2026-10-02.csv"',
    );
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const text = await r.text();
    assert.match(text, /^model,requests,inputTokens,/);
    const j = await get(s.base, '/api/cost/export?format=json&groupBy=center');
    assert.equal(j.status, 200);
    assert.match(j.headers.get('content-disposition'), /\.json"$/);
    const body = await j.json();
    assert.ok(body.rows.length > 0, 'the demo ledger');
    assert.doesNotMatch(JSON.stringify(body), PATHS);
    const bad = await get(s.base, '/api/cost/export?format=xlsx');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('content-disposition'), null, 'an error is not a download');
    const rep = await get(s.base, '/api/cost/report?center=client-acme');
    assert.equal(rep.status, 200);
    assert.equal(rep.headers.get('content-type'), 'application/json');
    const report = await rep.json();
    assert.deepEqual(report.center, { id: 'client-acme', name: 'Client: Acme' });
    assert.ok(report.totals.listUSD > 0 && report.tables.model.length > 0);
    assert.doesNotMatch(JSON.stringify(report), PATHS);
    assert.equal((await get(s.base, '/api/cost/report?center=nobody')).status, 400);
  } finally {
    await s.stop();
  }
});

test('over HTTP: the export and the report answer the dashboard sign-in only, never a gateway key', async () => {
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
  const { secret } = gw.keys.create({ name: 'app', scopes: ['llm', 'agents', 'rag', 'mcp'], rpm: 60 });
  gw.flush();
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ pricingSync: { enabled: false } }));
  const s = await startServer({ ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: PASSWORD }, { data });
  try {
    const routes = ['/api/cost/export', '/api/cost/export?format=json', '/api/cost/report'];
    for (const p of routes) {
      assert.equal((await get(s.base, p)).status, 401, p);
      const bearer = { authorization: `Bearer ${secret}`, 'x-api-key': secret };
      assert.equal((await get(s.base, p, bearer)).status, 401, `${p} with a key`);
    }
    const login = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; ');
    const r = await get(s.base, '/api/cost/export', { cookie });
    assert.equal(r.status, 200);
    assert.equal(
      await r.text(),
      'day,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD\r\n',
      'an empty ledger: the header row only',
    );
    const rep = await get(s.base, '/api/cost/report', { cookie });
    assert.equal(rep.status, 200);
    assert.equal((await rep.json()).totals.listUSD, 0);
  } finally {
    await s.stop();
  }
});
