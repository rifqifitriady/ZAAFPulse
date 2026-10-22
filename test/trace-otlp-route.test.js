// POST /v1/traces on a spawned server.js: the return channel's own guards. Sign-in is on, so the no-sign-in proxy
// check does not answer first: a request that reached us through a reverse proxy on this host (remoteAddress
// 127.0.0.1) must still be refused by the route. HOME and ZAAFPULSE_DATA are temp folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    // Above the other server tests' ranges (4800-6900), so parallel files rarely meet.
    const port = 7000 + Math.floor(Math.random() * 800);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

async function startServer() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-otlp-route-'));
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ZAAFPULSE_AUTH: '1',
        ZAAFPULSE_ADMIN_PASSWORD: 'correct-horse-battery',
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const kill = async () => {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
    };
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
        await new Promise((r) => setTimeout(r, 200));
        if (!exited)
          return {
            port,
            stop: async () => {
              await kill();
              fs.rmSync(data, { recursive: true, force: true });
            },
          };
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    await kill();
  }
  fs.rmSync(data, { recursive: true, force: true });
  throw new Error('could not start server.js on a free port');
}

// http.request, not fetch: fetch will not send a Host header of our choosing.
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/traces', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const UNKNOWN = JSON.stringify({
  resourceSpans: [
    { scopeSpans: [{ spans: [{ traceId: 'f'.repeat(32), spanId: '1'.repeat(16), name: 'x', startTimeUnixNano: '1000', endTimeUnixNano: '2000' }] }] },
  ],
});

test('route /v1/traces: proxied or misaddressed calls are refused; JSON only; unknown traces rejected', async () => {
  const s = await startServer();
  try {
    const local = await post(s.port, UNKNOWN);
    assert.equal(local.status, 200);
    assert.equal(local.body.partialSuccess.rejectedSpans, 1);
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'forwarded', 'x-real-ip', 'via']) {
      const r = await post(s.port, UNKNOWN, { [h]: '203.0.113.7' });
      assert.equal(r.status, 403, h);
      assert.match(r.body.error, /this machine only/);
    }
    const named = await post(s.port, UNKNOWN, { host: 'zaafpulse.example.com' });
    assert.equal(named.status, 403);
    assert.match(named.body.error, /this machine only/);
    assert.equal((await post(s.port, UNKNOWN, { host: `localhost:${s.port}` })).status, 200);
    assert.equal((await post(s.port, UNKNOWN, { host: `[::1]:${s.port}` })).status, 200);
    assert.equal((await post(s.port, 'x', { 'content-type': 'application/x-protobuf' })).status, 415);
    assert.equal((await post(s.port, UNKNOWN, { 'content-type': 'application/jsonx' })).status, 415);
    assert.equal((await post(s.port, UNKNOWN, { 'content-type': 'Application/JSON; charset=utf-8' })).status, 200);
    const bad = await post(s.port, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid JSON');
  } finally {
    await s.stop();
  }
});
