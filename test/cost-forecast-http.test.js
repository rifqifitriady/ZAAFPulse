// Cost Control 4a over HTTP: a spawned demo server.js answers the forecast and the anomalies on the Overview, the
// budgets' forecast fields, the cost_anomaly rule card and its alert, path-free. Demo mode reads no logs, makes no
// calls and sends no notification. Ports 9400-9599 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-forecast-http-'));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 9400 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });
async function startServer(env) {
  const data = tmp();
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

// The engine's own store in demo mode (server.js keeps it in the demo folder, under TMPDIR), where the aggregate pass
// writes the states the cost_anomaly rule computed from the provider: it reads the demo ledger, not the real one.
test('demo over HTTP: the cost_anomaly provider reads the demo ledger', async () => {
  const scratch = tmp();
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none', TMPDIR: scratch });
  try {
    let states = [];
    for (let i = 0; i < 100 && !states.length; i++) {
      for (const d of fs.readdirSync(scratch).filter((x) => x.startsWith('zp-demo-'))) {
        try {
          const f = JSON.parse(fs.readFileSync(path.join(scratch, d, 'monitors.json'), 'utf8'));
          states = (f.states || []).filter((x) => x.rule === 'cost_anomaly');
        } catch {
          /* not written yet */
        }
      }
      if (!states.length) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(states.length, 2, 'one instance per day');
    assert.equal(states.filter((x) => x.state === 'triggered').length, 1, "yesterday's spike, from the demo ledger");
    assert.ok(states.every((x) => x.state !== 'no_data'));
  } finally {
    await s.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('demo over HTTP: the forecast, yesterday’s anomaly with a named key, the budgets’ forecast and the rule', async () => {
  const s = await startServer({ DEMO: '1', ZAAFPULSE_AUTH: 'none' });
  const bodies = [];
  const call = async (p) => {
    const r = await fetch(s.base + p, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: JSON.parse(text) };
  };
  try {
    const o = await call('/api/cost/view?page=overview');
    assert.equal(o.status, 200);
    assert.equal(o.json.forecastMethod, 'weekday', 'the demo ledger holds 30 days');
    assert.deepEqual(o.json.anomalyParams, { ratio: 2, minUSD: 1 });
    const y = o.json.anomalies.yesterday;
    assert.equal(y.anomaly, true, "yesterday's spike");
    assert.ok(y.spentUSD > 2 * y.expectedUSD);
    assert.ok(
      y.drivers.some((d) => d.dim === 'keyId' && d.label === 'Acme client'),
      'the key by its name',
    );
    assert.equal(o.json.anomalies.today.anomaly, false);
    assert.ok(
      o.json.spikes.some((x) => x.spike),
      'the spike line marks it',
    );
    assert.ok(o.json.rings.every((r) => 'runsOut' in r));
    const b = await call('/api/cost/budgets');
    assert.ok(b.json.budgets.every((v) => 'forecastUSD' in v && 'runsOut' in v));
    const rules = (await call('/api/monitors')).json.rules;
    const rule = rules.find((r) => r.id === 'cost_anomaly');
    assert.deepEqual([rule.title, rule.params, rule.state], ['Cost anomaly', { ratio: 2, minUSD: 1 }, 'triggered']);
    assert.equal(rule.instances.length, 2);
    const alert = (await call('/api/alerts')).json.alerts.find((a) => a.rule === 'cost_anomaly');
    assert.equal(alert.title, rule.instances.find((i) => i.state === 'triggered').title);
    assert.equal(alert.usual, Math.round(y.expectedUSD * 100) / 100);
    for (const body of bodies) assert.doesNotMatch(body, PATHS);
    assert.doesNotMatch(JSON.stringify(alert), /drivers|acme-web/);
  } finally {
    await s.stop();
  }
});
