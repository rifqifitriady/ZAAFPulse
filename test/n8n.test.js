const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const n8n = require('../lib/connectors/n8n');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));
const make = (url, extra = {}) => n8n.create('n8n', { baseUrl: url, apiKey: { env: 'N8N' }, ...extra }, { secrets: secretsFor({ N8N: 'n8n-key-123' }) });

test('read tools use the public API with the key header', async () => {
  const srv = await fakeServer({
    'GET /api/v1/workflows': { body: { data: [{ id: 'w1', name: 'Daily', active: true, tags: [{ name: 'ops' }], nodes: [{ name: 'x' }], updatedAt: 't' }], nextCursor: null } },
    'GET /api/v1/workflows/w1': { body: { id: 'w1', name: 'Daily', active: true, nodes: [{ name: 'Cron', type: 'n8n-nodes-base.cron', credentials: { x: 1 } }], settings: {} } },
    'GET /api/v1/executions': { body: { data: [{ id: 'e1' }] } },
    'GET /api/v1/executions/e1': { body: { id: 'e1' } },
  });
  try {
    const t = tools(make(srv.url));
    const list = await t.list_workflows.run({ active: true });
    assert.deepEqual(list.workflows[0], { id: 'w1', name: 'Daily', active: true, tags: ['ops'], updatedAt: 't' });
    const w = await t.get_workflow.run({ id: 'w1' });
    assert.deepEqual(w.nodes, [{ name: 'Cron', type: 'n8n-nodes-base.cron', disabled: false }]);
    await t.list_executions.run({ workflowId: 'w1', status: 'error' });
    await t.get_execution.run({ id: 'e1' });
    assert.equal(srv.requests[0].headers['x-n8n-api-key'], 'n8n-key-123');
    assert.equal(srv.requests[0].query.active, 'true');
    assert.deepEqual(srv.requests[2].query, { workflowId: 'w1', status: 'error', limit: '20' });
    assert.equal(srv.requests[3].query.includeData, undefined);
  } finally { await srv.close(); }
});

test('run_workflow posts only to allowlisted webhooks, without the API key', async () => {
  const srv = await fakeServer({ 'POST /webhook/abc': (r) => ({ body: { received: r.body } }) });
  try {
    const t = tools(make(srv.url, { webhooks: { 'daily-report': `${srv.url}/webhook/abc` } }));
    assert.equal(t.run_workflow.write, true);
    assert.deepEqual(t.run_workflow.inputSchema.properties.name.enum, ['daily-report']);
    assert.deepEqual(await t.run_workflow.run({ name: 'daily-report', payload: { day: 'mon' } }), { received: { day: 'mon' } });
    assert.equal(srv.requests[0].headers['x-n8n-api-key'], undefined);
    await assert.rejects(t.run_workflow.run({ name: 'other' }), /not in the webhooks allowlist/);
  } finally { await srv.close(); }
});

test('no run_workflow without webhooks; set_workflow_active is a write tool', async () => {
  const srv = await fakeServer({ 'POST /api/v1/workflows/w1/deactivate': { body: { id: 'w1', name: 'Daily', active: false } } });
  try {
    const t = tools(make(srv.url));
    assert.equal(t.run_workflow, undefined);
    assert.equal(t.set_workflow_active.write, true);
    assert.equal((await t.set_workflow_active.run({ id: 'w1', active: false })).active, false);
  } finally { await srv.close(); }
});

test('rejects bad webhook URLs and a missing key', () => {
  assert.throws(() => make('http://x', { webhooks: { a: 'ftp://y' } }), /webhooks.a must be an http/);
  assert.throws(() => n8n.create('n8n', { baseUrl: 'http://x' }, { secrets: secretsFor({}) }), /apiKey is required/);
});
