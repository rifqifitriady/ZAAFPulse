// Governance inventory and compliance (AI Governance 3) through a spawned server.js: a temp data folder that is also
// HOME (so the MCP scan reads fixture client files there, never this machine's), no network, no sign-in unless sign-in
// is under test. Ports 10000-10199 are this file's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { NO_JUDGE_PORTS } = require('./helpers');
const { STATUSES } = require('../lib/governance/controls');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    const port = 10000 + Math.floor(Math.random() * 200);
    s.once('error', () => resolve(freePort()));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
  });

// Starts server.js on a free port of the range (again when another test took the port first); stopped and its data
// folder removed when the test ends. Every folder an AI client's config may be read from points into the data folder.
// prepare(data) runs on the empty data folder before the server starts.
async function startServer(t, env = {}, prepare = null) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-inv-'));
    if (prepare) prepare(data);
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: 'none',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
        CLAUDE_CONFIG_DIR: data,
        CODEX_HOME: path.join(data, '.codex'),
        XDG_CONFIG_HOME: path.join(data, '.config'),
        APPDATA: path.join(data, 'AppData', 'Roaming'),
      },
      stdio: 'ignore',
    });
    let exited = false;
    const gone = new Promise((r) => child.on('exit', () => r((exited = true))));
    const stop = async () => {
      if (!exited) child.kill();
      await gone;
      fs.rmSync(data, { recursive: true, force: true });
    };
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80 && !exited; i++) {
      try {
        await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
        await sleep(200);
        if (!exited) {
          t.after(stop);
          return { base, data, alive: () => !exited };
        }
      } catch {
        await sleep(150);
      }
    }
    await stop();
  }
  throw new Error('could not start server.js on a free port');
}
// One request: JSON in and out (text when the answer is not JSON).
async function call(s, p, { method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(s.base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json === null ? text : json, text, headers: r.headers };
}
// Every governance audit entry the server wrote, oldest first.
function entries(s) {
  const dir = path.join(s.data, '.data', 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^governance-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}
const SECRETS = ['ghp_SECRET1abcdefghijklmnopqrstu', 'SECRET-HEADER-2', 'SECRET-QUERY-3', 'SECRET-ENV-4'];
// A Claude Code file with a user-scope server (a token in its env), a remote server (a header and a query token) and a
// project server; a gateway provider and an integration in config.json.
function prepare(data) {
  fs.writeFileSync(
    path.join(data, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_SECRET1abcdefghijklmnopqrstu' },
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp?token=SECRET-QUERY-3',
          headers: { Authorization: 'Bearer SECRET-HEADER-2' },
        },
      },
      projects: { [path.join(data, 'code', 'shop')]: { mcpServers: { db: { command: 'uvx', args: ['pg-mcp'] } } } },
    }),
  );
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({
      gateway: {
        providers: [{ id: 'openai', preset: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: { env: 'X_KEY' } }],
      },
      integrations: {
        dt: { type: 'dynatrace', url: 'https://abc.live.dynatrace.com', apiToken: { env: 'SECRET-ENV-4' } },
      },
    }),
  );
}

test('inventory: the MCP servers of the client files, the gateway and the integrations, with no secret', async (t) => {
  const s = await startServer(t, {}, prepare);
  // The summary counts as failed until the first scan of the logs is done.
  let r = await call(s, '/api/governance/inventory');
  for (let i = 0; i < 100 && r.status === 200 && r.body.failed.includes('summary'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    r = await call(s, '/api/governance/inventory');
  }
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.items.map((i) => [i.id, i]));
  assert.deepEqual(
    [by['mcp:github'].where, by['mcp:github'].command, by['mcp:github'].package, by['mcp:github'].state],
    [['Claude Code config'], 'npx', '@modelcontextprotocol/server-github', 'configured'],
  );
  assert.deepEqual([by['mcp:remote'].transport, by['mcp:remote'].origin], ['http', 'https://mcp.example.com']);
  assert.deepEqual(by['mcp:db'].projects, [`~${path.sep}code${path.sep}shop`]);
  assert.equal(by['provider:openai'].vendor, 'OpenAI');
  assert.equal(by['integration:dt'].origin, 'https://abc.live.dynatrace.com');
  assert.ok(
    r.body.items.some((i) => i.kind === 'agent'),
    'the gateway agents',
  );
  assert.ok(
    r.body.items.some((i) => i.kind === 'skill'),
    'the ZAAFPulse skills',
  );
  assert.ok(
    r.body.clients.some((c) => c.client === 'claude' && c.state === 'ok' && c.file === `~${path.sep}.claude.json`),
  );
  assert.deepEqual(r.body.failed, []);
  for (const x of SECRETS) assert.ok(!r.text.includes(x), `${x} must not leave the server`);
  assert.ok(!r.text.includes('systemPrompt'), 'an agent is read for its id, name and state only');
  const seen = JSON.parse(fs.readFileSync(path.join(s.data, '.data', 'governance', 'seen.json'), 'utf8'));
  assert.match(seen.items['mcp:github'].first, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(entries(s), [], 'a read writes no audit entry');
  assert.ok(s.alive());
});

test('reviews: saved in config.json, recorded as config.change and as the request; a bad one is a 400', async (t) => {
  const s = await startServer(t, {}, prepare);
  const review = { id: 'mcp:github', owner: 'Ana', purpose: 'Issues', risk: 'limited', decision: 'approved' };
  const ok = await call(s, '/api/governance/inventory', { method: 'POST', body: review });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.review.owner, 'Ana');
  const cfg = JSON.parse(fs.readFileSync(path.join(s.data, 'config.json'), 'utf8'));
  assert.equal(cfg.governance.inventory['mcp:github'].decision, 'approved');
  assert.equal(cfg.gateway.providers[0].id, 'openai', 'the other sections stay');
  const item = (await call(s, '/api/governance/inventory')).body.items.find((i) => i.id === 'mcp:github');
  assert.equal(item.status, 'reviewed');
  const all = entries(s);
  const change = all.find((e) => e.action === 'config.change');
  assert.deepEqual(change.target, { type: 'config', id: 'governance' });
  assert.ok(change.changes.some((c) => c.path === 'governance.inventory.mcp:github.owner' && c.to === 'Ana'));
  const req = all.find((e) => e.action === 'POST /api/governance/inventory');
  assert.deepEqual([req.outcome, req.status, req.target], ['ok', 200, { type: 'governance', id: 'mcp:github' }]);
  const bad = await call(s, '/api/governance/inventory', { method: 'POST', body: { id: 'mcp:github', risk: 'huge' } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'risk: minimal, limited, high, unacceptable or empty']);
  assert.equal(entries(s).filter((e) => e.action === 'config.change').length, 1, 'nothing written');
  assert.ok(s.alive());
});

test('inventory, controls and evidence: for a dashboard session only; no sign-in or an API key is a 401', async (t) => {
  const s = await startServer(t, { ZAAFPULSE_AUTH: '1', ZAAFPULSE_ADMIN_PASSWORD: 'correct horse battery' });
  for (const headers of [{}, { authorization: 'Bearer zp_not_a_session' }]) {
    for (const p of ['/api/governance/inventory', '/api/governance/controls', '/api/governance/evidence?format=md'])
      assert.equal((await call(s, p, { headers })).status, 401, p);
    const post = { method: 'POST', body: { id: 'mcp:x', owner: 'x' }, headers };
    assert.equal((await call(s, '/api/governance/inventory', post)).status, 401);
  }
  const ok = await call(s, '/api/login', { method: 'POST', body: { password: 'correct horse battery' } });
  const cookie = ok.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.equal((await call(s, '/api/governance/inventory', { headers: { cookie } })).status, 200);
  assert.equal((await call(s, '/api/governance/controls', { headers: { cookie } })).status, 200);
  assert.ok(s.alive());
});

test('controls: eighteen controls from the live settings, OpenTelemetry and trace retention included', async (t) => {
  const s = await startServer(t, {}, prepare);
  const r = await call(s, '/api/governance/controls');
  assert.equal(r.status, 200);
  assert.match(r.body.notice, /^Evidence for your assessment, not a certification\./);
  assert.equal(r.body.controls.length, 18);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  for (const c of r.body.controls) assert.ok(STATUSES.includes(c.status), c.id);
  assert.deepEqual(by.guardrails.evidence, [
    'secrets: redact',
    'personal data: off',
    'prompt injection: log',
    'scope: external',
  ]);
  assert.equal(by.guardrails.status, 'partial');
  assert.deepEqual([by.sign_in.status, by.sign_in.evidence[0]], ['off', 'sign-in: no sign-in']);
  assert.deepEqual(
    [by.access_roles.status, by.access_roles.evidence],
    ['off', ['sign-in: no sign-in, so no accounts or roles']],
  );
  assert.deepEqual([by.otel_export.status, by.otel_export.evidence], ['off', ['not set up (see docs/otel.md)']]);
  assert.deepEqual(
    [by.trace_retention.status, by.trace_retention.evidence[0]],
    ['partial', 'kept 14 days, up to 500 MB'],
  );
  assert.deepEqual(
    [by.secret_store.status, by.secret_store.evidence],
    ['partial', ['secrets saved from the dashboard are kept in the encrypted secret file']],
  );
  assert.deepEqual(
    [by.agent_control.status, by.agent_control.evidence],
    ['off', ['agent control is off without a dashboard sign-in']],
  );
  assert.equal(by.provider_approval.status, 'partial', 'the provider in config.json has no recorded approval');
  assert.equal(by.inventory_coverage.status, 'off');
  assert.ok(!r.text.includes('X_KEY') && !r.text.includes(s.data), 'no secret reference, no path');
  assert.ok(s.alive());
});

test('evidence: a Markdown and a JSON download, each a governance.export entry by the dashboard', async (t) => {
  const s = await startServer(t, {}, prepare);
  const md = await call(s, '/api/governance/evidence?format=md');
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(
    md.headers.get('content-disposition'),
    /^attachment; filename="zaafpulse-evidence-\d{4}-\d{2}-\d{2}\.md"$/,
  );
  assert.match(md.text, /^# ZAAFPulse governance evidence\n\nGenerated .* by ZAAFPulse \d+\.\d+\.\d+\./);
  assert.match(md.text, /\| github \(mcp:github\) \| mcp \|/);
  const json = await call(s, '/api/governance/evidence?format=json');
  assert.equal(json.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(json.body.version, require('../package.json').version);
  assert.equal(json.body.controls.length, 18);
  assert.ok(json.body.inventory.items.some((i) => i.id === 'mcp:db' && !('projects' in i)));
  for (const text of [md.text, json.text]) {
    assert.ok(!text.includes(s.data), 'no path');
    assert.ok(
      !text.includes(`~${path.sep}.claude.json`) && !text.includes(path.join('code', 'shop')),
      'no client file, no project folder',
    );
    for (const x of SECRETS) assert.ok(!text.includes(x), x);
  }
  assert.equal((await call(s, '/api/governance/evidence?format=pdf')).status, 400);
  const exports = entries(s).filter((e) => e.action === 'governance.export');
  assert.deepEqual(
    exports.map((e) => [e.target, e.actor.via, e.outcome]),
    [
      [{ type: 'evidence', id: 'md' }, 'dashboard', 'ok'],
      [{ type: 'evidence', id: 'json' }, 'dashboard', 'ok'],
    ],
  );
  assert.ok(s.alive());
});

test('inventory: an oversize client file is unreadable; an agent prompt and a key never leave', async (t) => {
  const s = await startServer(t, {}, (data) => {
    prepare(data);
    fs.writeFileSync(path.join(data, '.claude.json'), Buffer.alloc(21 * 1024 * 1024, 32));
  });
  const post = (route, body) => call(s, `/api/gateway/${route}`, { method: 'POST', body });
  const PROMPT = 'PROMPT-TEXT-UNIQUE-91';
  await post('agents', { action: 'save', id: 'secret-agent', name: 'Secret agent', systemPrompt: PROMPT });
  const k = await post('keys', { action: 'create', name: 'inv-key' });
  const r = await call(s, '/api/governance/inventory');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((i) => i.id === 'agent:secret-agent'));
  assert.ok(!r.text.includes(PROMPT), 'the system prompt must not leave the server');
  const secrets = [k.body && k.body.secret, k.body && k.body.key, k.body && k.body.hash].filter(
    (x) => typeof x === 'string' && x.length > 8,
  );
  assert.ok(secrets.length > 0, 'the key answer carries a secret to look for');
  for (const x of secrets) assert.ok(!r.text.includes(x), 'a key secret must not leave the server');
  const c = r.body.clients.find((x) => x.client === 'claude');
  assert.ok(!c || c.state === 'unreadable' || c.servers === 0);
  assert.ok(s.alive());
});

test(
  'inventory: a FIFO where a client file should be is unreadable and never waited on',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { execFileSync } = require('child_process');
    const s = await startServer(t, {}, (data) => {
      prepare(data);
      fs.mkdirSync(path.join(data, '.cursor'));
      execFileSync('mkfifo', [path.join(data, '.cursor', 'mcp.json')]);
    });
    const t0 = Date.now();
    const r = await call(s, '/api/governance/inventory');
    assert.ok(Date.now() - t0 < 1000, 'answered within a second');
    assert.equal(r.status, 200);
    const c = r.body.clients.find((x) => x.client === 'cursor');
    assert.deepEqual([c.state, c.servers], ['unreadable', 0]);
    assert.ok(
      r.body.clients.some((x) => x.client === 'claude'),
      'the other clients are still read',
    );
  },
);
