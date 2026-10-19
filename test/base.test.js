const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const { makeClient, authHeaders, tool, S, timedHealth } = require('../lib/connectors/base');

test('joins base paths, sends headers and drops empty query values', async () => {
  const srv = await fakeServer({ 'GET /e/env1/api/v2/problems': { body: { ok: 1 } } });
  try {
    const api = makeClient({ baseUrl: `${srv.url}/e/env1`, headers: { authorization: 'Api-Token t' } });
    assert.deepEqual(
      await api('GET', '/api/v2/problems', { query: { from: 'now-2h', pageSize: 5, empty: '', none: undefined } }),
      { ok: 1 },
    );
    assert.deepEqual(srv.requests[0].query, { from: 'now-2h', pageSize: '5' });
    assert.equal(srv.requests[0].headers.authorization, 'Api-Token t');
  } finally {
    await srv.close();
  }
});

test('sends JSON bodies', async () => {
  const srv = await fakeServer({ 'POST /v2/spans': (r) => ({ body: { echo: r.body } }) });
  try {
    const api = makeClient({ baseUrl: srv.url });
    assert.deepEqual(await api('POST', '/v2/spans', { body: { project_id: 'p' } }), { echo: { project_id: 'p' } });
    assert.equal(srv.requests[0].headers['content-type'], 'application/json');
  } finally {
    await srv.close();
  }
});

test('errors carry the status and a masked body', async () => {
  const srv = await fakeServer({ 'GET /x': { status: 401, body: { error: 'bad token tok-123456' } } });
  try {
    const api = makeClient({ baseUrl: srv.url, mask: (s) => s.split('tok-123456').join('***') });
    await assert.rejects(api('GET', '/x'), /HTTP 401 from GET \/x: .*\*\*\*/);
  } finally {
    await srv.close();
  }
});

test('times out', async () => {
  const srv = await fakeServer({ 'GET /slow': () => new Promise((r) => setTimeout(() => r({ body: {} }), 500)) });
  try {
    const api = makeClient({ baseUrl: srv.url, timeoutMs: 50 });
    await assert.rejects(api('GET', '/slow'), /timeout after 0.05s: GET \/slow/);
  } finally {
    await srv.close();
  }
});

test('rejects a base URL that is not http(s)', () => {
  assert.throws(() => makeClient({ baseUrl: 'ftp://x' }), /baseUrl must start with http/);
  assert.throws(() => makeClient({}), /baseUrl must start with http/);
});

test('authHeaders resolves the secret and validates the header name', () => {
  const secrets = secretsFor({ T: 'abc123456' });
  assert.deepEqual(authHeaders({ prefix: 'Bearer ', secret: { env: 'T' } }, secrets), {
    Authorization: 'Bearer abc123456',
  });
  assert.deepEqual(authHeaders({ header: 'X-Api-Key', secret: { env: 'T' } }, secrets), { 'X-Api-Key': 'abc123456' });
  assert.deepEqual(authHeaders(undefined, secrets), {});
  assert.throws(() => authHeaders({ header: 'bad header', secret: { env: 'T' } }, secrets), /not a valid header name/);
});

test('tool builds a closed object schema', () => {
  const t = tool('get', 'Get one', { id: S.str('Id'), n: S.int('N', 10) }, async () => 1, {
    required: ['id'],
    write: true,
  });
  assert.deepEqual(t.inputSchema, {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Id' },
      n: { type: 'integer', minimum: 1, maximum: 10, description: 'N' },
    },
    required: ['id'],
    additionalProperties: false,
  });
  assert.equal(t.write, true);
});

test('timedHealth reports ok and failures', async () => {
  const good = await timedHealth(async () => 'fine');
  assert.equal(good.ok, true);
  assert.equal(good.detail, 'fine');
  assert.ok(good.latencyMs >= 0);
  const bad = await timedHealth(async () => {
    throw new Error('down');
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'down');
});
