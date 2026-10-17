const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const router = require('../lib/connectors/router');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('omniroute with a management token uses the management API', async () => {
  const srv = await fakeServer({
    'GET /api/health': { body: { status: 'ok' } },
    'GET /api/health/degradation': { body: { active: false } },
    'GET /api/models': { body: { models: [{ provider: 'p', model: 'm', fullModel: 'p/m', available: true }] } },
    'GET /api/providers': { body: { connections: [{ id: 'c1', provider: 'openai', name: 'work', email: 'me@x.com', providerSpecificData: { k: 1 }, isActive: true, testStatus: 'ok' }], total: 1 } },
    'GET /api/combos': { body: { combos: [], total: 0 } },
    'GET /api/usage/analytics': { body: { summary: { totalRequests: 3 }, byModel: [], byProvider: [], dailyTrend: [], errorBreakdown: [], activityMap: { a: 1 }, byApiKey: [{ k: 1 }] } },
    'GET /api/telemetry/summary': { body: { p95: 120 } },
  });
  try {
    const c = router.create('omniroute', { flavor: 'omniroute', baseUrl: srv.url, managementToken: { env: 'OM' } }, { secrets: secretsFor({ OM: 'oma_live_token1' }) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), ['health', 'list_models', 'list_providers', 'list_combos', 'usage', 'telemetry']);
    assert.deepEqual((await t.health.run({})).health, { status: 'ok' });
    assert.equal((await t.list_models.run({})).models[0].fullModel, 'p/m');
    assert.deepEqual((await t.list_providers.run({})).connections[0], { id: 'c1', provider: 'openai', name: 'work', isActive: true, testStatus: 'ok' });
    await t.list_combos.run({});
    const u = await t.usage.run({ period: 'week' });
    assert.deepEqual(Object.keys(u).sort(), ['byModel', 'byProvider', 'dailyTrend', 'errorBreakdown', 'period', 'summary']);
    await t.telemetry.run({});
    assert.equal(srv.requests.find((r) => r.path === '/api/models').headers.authorization, 'Bearer oma_live_token1');
    assert.equal(srv.requests.find((r) => r.path === '/api/usage/analytics').query.period, 'week');
    assert.equal(c.tools.every((x) => !x.write), true);
    assert.equal((await c.health()).ok, true);
  } finally { await srv.close(); }
});

test('provider names that are email addresses are masked', async () => {
  const srv = await fakeServer({ 'GET /api/providers': { body: { connections: [{ id: 'c2', provider: 'claude', name: 'someone.long@example.com', displayName: 'someone.long@example.com', email: 'someone.long@example.com' }], total: 1 } } });
  try {
    const c = router.create('om', { flavor: 'omniroute', baseUrl: srv.url, managementToken: { env: 'OM' } }, { secrets: secretsFor({ OM: 'oma_live_token1' }) });
    const p = (await tools(c).list_providers.run({})).connections[0];
    assert.deepEqual(p, { id: 'c2', provider: 'claude', name: 'so***@example.com', displayName: 'so***@example.com' });
  } finally { await srv.close(); }
});

test('omniroute with only an inference key lists models from /v1/models', async () => {
  const srv = await fakeServer({ 'GET /v1/models': { body: { data: [{ id: 'auto', owned_by: 'omniroute' }] } }, 'GET /api/health': { body: { status: 'ok' } } });
  try {
    const t = tools(router.create('om', { flavor: 'omniroute', baseUrl: srv.url, apiKey: { env: 'K' } }, { secrets: secretsFor({ K: 'sk-inference-1' }) }));
    assert.deepEqual(Object.keys(t), ['health', 'list_models']);
    assert.deepEqual(await t.list_models.run({}), { models: [{ id: 'auto', owned_by: 'omniroute' }] });
  } finally { await srv.close(); }
});

test('9router exposes the OpenAI-compatible tools only', async () => {
  const srv = await fakeServer({ 'GET /v1/models': { body: { data: [{ id: 'cc/claude', owned_by: '9router' }] } } });
  try {
    const c = router.create('9router', { flavor: '9router', baseUrl: srv.url }, { secrets: secretsFor({}) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), ['health', 'list_models']);
    assert.equal((await t.health.run({})).models, 1);
    assert.equal((await c.health()).ok, true);
  } finally { await srv.close(); }
});

test('rejects unknown flavors', () => {
  assert.throws(() => router.create('r', { flavor: 'litellm' }, { secrets: secretsFor({}) }), /flavor must be/);
});
