const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const dynatrace = require('../lib/connectors/dynatrace');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('list_problems sends the API token and defaults (Managed-style base path)', async () => {
  const srv = await fakeServer({ 'GET /e/abc/api/v2/problems': { body: { totalCount: 1, problems: [{ problemId: 'p1' }] } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: `${srv.url}/e/abc`, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
    const r = await tools(c).list_problems.run({});
    assert.equal(r.problems[0].problemId, 'p1');
    assert.equal(srv.requests[0].headers.authorization, 'Api-Token dt0c01.token');
    assert.deepEqual(srv.requests[0].query, { from: 'now-2h', pageSize: '50' });
  } finally { await srv.close(); }
});

test('get_problem, entities, metrics, logs and security map to API v2', async () => {
  const srv = await fakeServer({
    'GET /api/v2/problems/abc-1': { body: { problemId: 'abc-1' } },
    'GET /api/v2/entities': { body: { entities: [] } },
    'GET /api/v2/metrics/query': { body: { result: [] } },
    'GET /api/v2/logs/search': { body: { results: [] } },
    'GET /api/v2/securityProblems': { body: { securityProblems: [] } },
  });
  try {
    const t = tools(dynatrace.create('dt', { baseUrl: srv.url, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) }));
    await t.get_problem.run({ problemId: 'abc-1' });
    await t.list_entities.run({ entitySelector: 'type("SERVICE")' });
    await t.query_metrics.run({ metricSelector: 'builtin:service.response.time:avg', resolution: '5m' });
    await t.query_logs.run({ query: 'status="ERROR"' });
    await t.list_security_problems.run({});
    assert.deepEqual(srv.requests.map((r) => r.path), ['/api/v2/problems/abc-1', '/api/v2/entities', '/api/v2/metrics/query', '/api/v2/logs/search', '/api/v2/securityProblems']);
    assert.equal(srv.requests[1].query.entitySelector, 'type("SERVICE")');
    assert.equal(srv.requests[2].query.resolution, '5m');
    assert.equal(srv.requests[3].query.limit, '100');
    assert.deepEqual(t.list_entities.inputSchema.required, ['entitySelector']);
  } finally { await srv.close(); }
});

test('no dql tool without a platform token', () => {
  const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
  assert.equal(tools(c).dql, undefined);
  assert.equal(c.tools.every((t) => !t.write), true);
});

test('dql polls until the query succeeds', async () => {
  let polls = 0;
  const srv = await fakeServer({
    'POST /platform/storage/query/v1/query:execute': { body: { state: 'RUNNING', requestToken: 'rt1' } },
    'GET /platform/storage/query/v1/query:poll': () => ({ body: ++polls < 2 ? { state: 'RUNNING' } : { state: 'SUCCEEDED', result: { records: [{ n: 1 }] } } }),
  });
  try {
    const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' }, platformUrl: srv.url, platformToken: { env: 'PT' } }, { secrets: secretsFor({ DT: 'dt0c01.token', PT: 'pt-token-1' }) });
    const r = await tools(c).dql.run({ query: 'fetch logs | limit 1' });
    assert.deepEqual(r.records, [{ n: 1 }]);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer pt-token-1');
    assert.equal(srv.requests[0].body.query, 'fetch logs | limit 1');
    assert.equal(srv.requests[1].query['request-token'], 'rt1');
  } finally { await srv.close(); }
});

test('dql surfaces a failed query', async () => {
  const srv = await fakeServer({ 'POST /platform/storage/query/v1/query:execute': { body: { state: 'FAILED', error: 'syntax' } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: 'https://x.live.dynatrace.com', token: { env: 'DT' }, platformUrl: srv.url, platformToken: { env: 'PT' } }, { secrets: secretsFor({ DT: 'dt0c01.token', PT: 'pt-token-1' }) });
    await assert.rejects(tools(c).dql.run({ query: 'bad' }), /DQL query did not finish \(state FAILED\)/);
  } finally { await srv.close(); }
});

test('health asks for one problem; a token is required', async () => {
  const srv = await fakeServer({ 'GET /api/v2/problems': { body: { problems: [] } } });
  try {
    const c = dynatrace.create('dt', { baseUrl: srv.url, token: { env: 'DT' } }, { secrets: secretsFor({ DT: 'dt0c01.token' }) });
    assert.equal((await c.health()).ok, true);
    assert.equal(srv.requests[0].query.pageSize, '1');
  } finally { await srv.close(); }
  assert.throws(() => dynatrace.create('dt', { baseUrl: 'https://x' }, { secrets: secretsFor({}) }), /token is required/);
});
