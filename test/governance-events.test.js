// Governance audit log (AI Governance 2): the actor that travels with a request (lib/governance/context.js), what a
// dashboard request and an agent or runtime control line become as entries (lib/governance/events.js), and the
// gateway's key check setting the actor for everything its request starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { runAs, setActor, actor } = require('../lib/governance/context');
const { requestEntry, controlEntry, routeOf } = require('../lib/governance/events');
const { createGateway } = require('../lib/gateway');
const { secretsFor } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('context: each runAs has its own actor, kept across awaits and timers; nothing outside it', async () => {
  setActor({ via: 'cli' }); // outside any request: ignored
  assert.equal(actor(), null);
  const one = runAs(null, async () => {
    setActor({ via: 'apikey', keyId: 'key_a' });
    await sleep(20);
    return actor();
  });
  const two = runAs({ via: 'system' }, async () => {
    await sleep(5);
    return new Promise((r) => setTimeout(() => r(actor()), 5));
  });
  assert.deepEqual(await Promise.all([one, two]), [{ via: 'apikey', keyId: 'key_a' }, { via: 'system' }]);
  assert.equal(
    runAs(null, () => actor()),
    null,
  );
});

test('requests: method and route with ids as :id, the action word, the target, the outcome', () => {
  assert.deepEqual(routeOf('/api/datasets/my-set/examples/ex_7'), {
    route: '/api/datasets/:id/examples/:id',
    ids: ['my-set', 'ex_7'],
  });
  assert.deepEqual(routeOf('/api/monitors/channels'), { route: '/api/monitors/channels', ids: [] });
  assert.deepEqual(requestEntry({ method: 'POST', path: '/api/cost/budgets/team-a/delete', status: 200, body: '{}' }), {
    action: 'POST /api/cost/budgets/:id/delete',
    target: { type: 'cost', id: 'team-a' },
    outcome: 'ok',
    status: 200,
  });
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/gateway/keys',
      status: 200,
      body: JSON.stringify({ action: 'create', name: 'ci pipeline', scopes: ['llm'], secret: 'zp_never' }),
      reply: { key: { id: 'key_1' }, secret: 'zp_x' },
    }),
    {
      action: 'POST /api/gateway/keys',
      op: 'create',
      target: { type: 'gateway.keys', name: 'ci pipeline' },
      outcome: 'ok',
      status: 200,
    },
  );
  assert.deepEqual(
    requestEntry({ method: 'POST', path: '/api/monitors/tool_loop', status: 200, body: '{"enabled":false}' }),
    { action: 'POST /api/monitors/:id', target: { type: 'monitors', id: 'tool_loop' }, outcome: 'ok', status: 200 },
  );
  // An admin answer of { errors } with 200 is a refusal; 4xx is refused, 5xx an error.
  const refused = requestEntry({
    method: 'POST',
    path: '/api/gateway/keys',
    status: 200,
    body: '{"action":"create"}',
    reply: { errors: ['name is required'] },
  });
  assert.equal(refused.outcome, 'refused');
  assert.equal(requestEntry({ method: 'POST', path: '/api/config', status: 415, body: '' }).outcome, 'refused');
  assert.equal(requestEntry({ method: 'DELETE', path: '/api/datasets/a', status: 500 }).outcome, 'error');
  // Only short words and ids from a body: a long or odd action, a path-like id and a long name are cut or left out.
  assert.deepEqual(
    requestEntry({
      method: 'POST',
      path: '/api/brain/sources',
      status: 200,
      body: JSON.stringify({ action: 'Save Now', id: '../etc/passwd', name: 'n'.repeat(200), token: 't' }),
    }),
    {
      action: 'POST /api/brain/sources',
      target: { type: 'brain', name: 'n'.repeat(80) },
      outcome: 'ok',
      status: 200,
    },
  );
  assert.equal(requestEntry({ method: 'POST', path: '/api/config', status: 200, body: '{not json' }).op, undefined);
});

test('requests: reads sent as POST are not entries', () => {
  const read = (path, body) => requestEntry({ method: 'POST', path, status: 200, body: JSON.stringify(body) });
  assert.equal(read('/api/gateway/collab', { action: 'get', id: 'run_1' }), null);
  assert.equal(read('/api/gateway/collab', { action: 'list' }), null);
  assert.equal(read('/api/gateway/providers', { action: 'test', id: 'p' }), null);
  assert.equal(read('/api/gateway/logs', {}), null);
  assert.equal(read('/api/integrations/test-draft', { id: 'x' }), null);
  assert.equal(read('/api/cost/settings/preview', {}), null);
  assert.equal(read('/api/brain/sources', { action: 'test', id: 'obsidian' }), null);
  assert.equal(read('/api/gateway/collab', { action: 'cancel', id: 'run_1' }).op, 'cancel');
  assert.equal(read('/api/gateway/providers', { action: 'save', id: 'p' }).op, 'save');
});

test('control lines: agent and runtime actions, a rule as the actor of its own pause', () => {
  assert.deepEqual(
    controlEntry({
      ts: 1,
      action: 'pause',
      pid: 4242,
      startTime: 9,
      app: 'claude',
      by: 'rule',
      rule: 'tool_loop',
      ok: true,
    }),
    {
      action: 'agent.pause',
      actor: { via: 'rule', rule: 'tool_loop' },
      target: { type: 'agent', id: '4242', name: 'claude' },
      outcome: 'ok',
    },
  );
  assert.deepEqual(
    controlEntry({ ts: 1, kind: 'runtime', action: 'start', id: 'ollama', by: 'owner', ok: false, status: 409 }),
    { action: 'runtime.start', target: { type: 'runtime', id: 'ollama' }, outcome: 'refused', status: 409 },
  );
  assert.equal(controlEntry({ kind: 'runtime', action: 'stop', id: 'x', ok: false, status: 502 }).outcome, 'error');
  assert.equal(controlEntry({ action: 'Bad Action' }), null);
  assert.equal(controlEntry(null), null);
});

test('gateway: a request with an API key acts as that key; without one it acts as no one', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-ctx-'));
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: {} }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
  });
  const seen = [];
  const server = http.createServer((req, res) =>
    runAs(null, async () => {
      if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
        res.writeHead(404);
        res.end();
      }
      seen.push(actor());
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.close();
    gateway.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const made = gateway.keys.create({ name: 'ci', scopes: ['llm'] });
  const ok = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${made.secret}` } });
  assert.equal(ok.status, 200);
  await ok.text();
  const no = await fetch(`${base}/v1/models`);
  assert.equal(no.status, 401);
  await no.text();
  await sleep(10);
  assert.deepEqual(seen, [{ via: 'apikey', keyId: made.key.id }, null]);
});
