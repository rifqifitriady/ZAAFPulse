// Governance audit log (AI Governance 2): what the gateway reports to it (createGateway({ audit })): key changes with
// the key's id and name, and approvals, rejections and cancels of collaboration runs from the dashboard, /v1/runs and
// A2A, each with the actor of its request; and the MCP audit line of a call made with a key names the key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fakeServer, secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { createIntegrations } = require('../lib/integrations');
const { tool, S } = require('../lib/connectors/base');
const { runAs, actor } = require('../lib/governance/context');

const reply = (content) => ({
  body: { choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
});
const fake = {
  type: 'fake',
  create: () => ({
    tools: [tool('read', 'Read', { q: S.str('Query') }, async (a) => ({ got: a.q ?? null }), { required: [] })],
    health: async () => ({ ok: true, latencyMs: 1 }),
  }),
};

async function setup(t) {
  const upstream = await fakeServer({
    'POST /chat/completions': () => reply('done'),
    'GET /models': { body: { data: [{ id: 'm' }] } },
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-gw-'));
  const mcpCalls = [];
  const registry = createIntegrations({
    config: { integrations: { one: { type: 'fake' } } },
    secrets: secretsFor(),
    connectors: { fake, acc: { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true }) }) } },
    audit: { record: (e) => mcpCalls.push(e) },
  });
  const seen = []; // each entry with the actor of the request it was made in
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({
      gateway: {
        providers: [{ id: 'fake', preset: 'custom', baseUrl: upstream.url, tier: 'private', approved: true }],
        defaults: { model: 'fake/m', plannerModel: 'fake/m' },
      },
    }),
    writeGatewayConfig: () => {},
    secrets: secretsFor(),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => registry,
    audit: (e) => seen.push({ ...e, by: actor() }),
  });
  const server = http.createServer((req, res) =>
    runAs(null, async () => {
      if (!(await gateway.handle(req, res, new URL(req.url, 'http://x')))) {
        res.writeHead(404);
        res.end();
      }
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections?.();
    server.close();
    await upstream.close();
    gateway.flush();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, secret, body) => {
    const r = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { gateway, seen, call, mcpCalls, base };
}
// A run waiting for approval at its second step, started with `secret`.
async function gatedRun(s, secret) {
  s.gateway.workflows.save({
    id: 'gated',
    name: 'Gated',
    steps: [
      { agent: 'hr-finance', prompt: 'Review {{input}}' },
      { agent: 'legal-compliance', prompt: 'Sign off {{step1}}', approve: true },
    ],
  });
  const r = await s.call('/v1/workflows/gated/run', secret, { input: 'laptop' });
  assert.equal(r.json.state, 'input-required');
  return r.json.id;
}

test('keys: create, update, revoke and delete are entries with the key id and name; an update lists its fields', async (t) => {
  const s = await setup(t);
  const made = await s.gateway.admin('keys', 'POST', { action: 'create', name: 'ci', scopes: ['llm'] });
  const id = made.key.id;
  await s.gateway.admin('keys', 'POST', { action: 'update', id, rpm: 120, guardrails: { secrets: 'block' } });
  await s.gateway.admin('keys', 'POST', { action: 'update', id, name: 'ci' }); // nothing changes
  await s.gateway.admin('keys', 'POST', { action: 'revoke', id });
  await s.gateway.admin('keys', 'POST', { action: 'delete', id });
  await s.gateway.admin('keys', 'POST', { action: 'delete', id }); // already gone: no entry
  await s.gateway.admin('keys', 'POST', { action: 'create' }); // refused by the key rules: no entry
  const target = { type: 'key', id, name: 'ci' };
  assert.deepEqual(
    s.seen.map(({ by, ...e }) => e),
    [
      { action: 'key.create', target },
      {
        action: 'key.update',
        target,
        changes: [
          { path: 'guardrails.secrets', from: null, to: 'block' },
          { path: 'rpm', from: 60, to: 120 },
        ],
      },
      { action: 'key.update', target },
      { action: 'key.revoke', target },
      { action: 'key.delete', target },
    ],
  );
  assert.ok(!JSON.stringify(s.seen).includes(made.secret), 'the secret is never in an entry');
});

test('runs: approvals, rejections and cancels name the key or the dashboard; a refused approval too', async (t) => {
  const s = await setup(t);
  const { key, secret } = s.gateway.keys.create({ name: 'app', scopes: ['agents', 'llm'] });
  const run1 = await gatedRun(s, secret);
  s.seen.length = 0;
  assert.equal((await s.call(`/v1/runs/${run1}/resume`, secret, { approve: true })).status, 403);
  assert.equal((await s.call(`/v1/runs/${run1}/resume`, secret, { approve: false })).json.state, 'rejected');
  assert.equal((await s.call(`/v1/runs/${run1}/cancel`, secret, {})).status, 409);
  const run2 = await gatedRun(s, secret);
  const a2a = await s.call('/a2a', secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message: { taskId: run2, role: 'user', parts: [{ kind: 'text', text: 'approve' }] } },
  });
  assert.match(a2a.json.error.message, /approve this task in the ZAAFPulse dashboard/);
  await runAs({ via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' }, () =>
    s.gateway.admin('collab', 'POST', { action: 'resume', id: run2, approve: true }),
  );
  const run3 = await gatedRun(s, secret);
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: run3 });
  // A key allowed to approve its own runs (a pipeline with its own human approval) approves through the API.
  const own = s.gateway.keys.create({ name: 'pipeline', scopes: ['agents', 'llm'], approveOwnRuns: true });
  const run4 = await gatedRun(s, own.secret);
  assert.equal((await s.call(`/v1/runs/${run4}/resume`, own.secret, { approve: true })).status, 200);
  const byKey = { via: 'apikey', keyId: key.id };
  const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };
  assert.deepEqual(
    s.seen.filter((e) => e.action.startsWith('run.')),
    [
      { action: 'run.approve', target: { type: 'run', id: run1 }, outcome: 'refused', status: 403, by: byKey },
      { action: 'run.reject', target: { type: 'run', id: run1 }, outcome: 'ok', by: byKey },
      { action: 'run.cancel', target: { type: 'run', id: run1 }, outcome: 'refused', status: 409, by: byKey },
      { action: 'run.approve', target: { type: 'run', id: run2 }, outcome: 'refused', status: 403, by: byKey },
      { action: 'run.approve', target: { type: 'run', id: run2 }, outcome: 'ok', by: dash },
      { action: 'run.cancel', target: { type: 'run', id: run3 }, outcome: 'ok', by: null },
      {
        action: 'run.approve',
        target: { type: 'run', id: run4 },
        outcome: 'ok',
        by: { via: 'apikey', keyId: own.key.id },
      },
    ],
  );
});

test('api keys: a document added to a knowledge base and a deleted session are entries naming the key', async (t) => {
  const s = await setup(t);
  s.gateway.knowledge.create({ id: 'policies', name: 'Policies' });
  const { key, secret } = s.gateway.keys.create({ name: 'app', scopes: ['agents', 'rag'] });
  const byKey = { via: 'apikey', keyId: key.id };
  s.seen.length = 0;
  const add = await s.call('/v1/knowledge/policies/documents', secret, { title: 'Leave', content: '12 days a year.' });
  assert.equal(add.status, 200);
  assert.equal((await s.call('/v1/knowledge/policies/documents', secret, { title: 'Empty' })).status, 400);
  const ses = s.gateway.sessions.open(null, { keyId: key.id, agent: 'hr-finance' }).session;
  const del = (id) =>
    fetch(`${s.base}/v1/sessions/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${secret}` } });
  assert.equal((await del(ses.id)).status, 200);
  assert.equal((await del(ses.id)).status, 404); // already gone: no entry
  assert.deepEqual(s.seen, [
    { action: 'knowledge.ingest', target: { type: 'knowledge', id: 'policies' }, by: byKey },
    { action: 'session.delete', target: { type: 'session', id: ses.id }, by: byKey },
  ]);
  assert.ok(!JSON.stringify(s.seen).includes('12 days'), 'no document text in an entry');
});

test('runs: a run id from a request body is kept only when it is id-shaped', async (t) => {
  const s = await setup(t);
  const { secret } = s.gateway.keys.create({ name: 'app', scopes: ['agents', 'llm'] });
  s.seen.length = 0;
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: { $where: 1 } });
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: 'run 1<script>' });
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: 'r'.repeat(81) });
  await s.gateway.admin('collab', 'POST', { action: 'cancel', id: 'run_feed' });
  await s.call('/a2a', secret, { jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { id: 'a\nb' } });
  assert.deepEqual(
    s.seen.map((e) => e.target),
    [{ type: 'run' }, { type: 'run' }, { type: 'run' }, { type: 'run', id: 'run_feed' }, { type: 'run' }],
  );
});

test('mcp: a tool call through /mcp with a key leaves an MCP audit line that names the key', async (t) => {
  const s = await setup(t);
  const { key, secret } = s.gateway.keys.create({ name: 'mcp', scopes: ['mcp'] });
  const r = await s.call('/mcp', secret, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'one_read', arguments: { q: 'x' } },
  });
  assert.equal(r.status, 200);
  assert.equal(s.mcpCalls.length, 1);
  assert.equal(s.mcpCalls[0].tool, 'one_read');
  assert.equal(s.mcpCalls[0].keyId, key.id);
  // The same registry used outside a key's request (the stdio MCP server, the dashboard) names none.
  const { createIntegrations: again } = require('../lib/integrations');
  const lines = [];
  const local = again({
    config: { integrations: { one: { type: 'fake' } } },
    secrets: secretsFor(),
    connectors: { fake, acc: { type: 'acc', create: () => ({ tools: [], health: async () => ({ ok: true }) }) } },
    audit: { record: (e) => lines.push(e) },
  });
  await local.callTool('one_read', { q: 'y' });
  assert.equal(lines[0].keyId, undefined);
});
