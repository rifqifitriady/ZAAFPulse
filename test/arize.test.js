const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const arize = require('../lib/connectors/arize');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));

test('phoenix maps tools to REST /v1 and works without a key', async () => {
  const srv = await fakeServer({
    'GET /v1/projects': { body: { data: [{ name: 'default' }] } },
    'GET /v1/projects/default/spans': { body: { data: [] } },
    'GET /v1/projects/default/traces': { body: { data: [] } },
    'GET /v1/datasets': { body: { data: [] } },
    'GET /v1/datasets/ds1/experiments': { body: { data: [] } },
  });
  try {
    const c = arize.create('phoenix', { flavor: 'phoenix', baseUrl: srv.url }, { secrets: secretsFor({}) });
    const t = tools(c);
    assert.deepEqual(Object.keys(t), [
      'list_projects',
      'search_spans',
      'list_traces',
      'list_datasets',
      'list_experiments',
    ]);
    await t.list_projects.run({ name_contains: 'def' });
    await t.search_spans.run({ project: 'default', span_kind: 'LLM', status_code: 'ERROR', limit: 20 });
    await t.list_traces.run({ project: 'default', error: true });
    await t.list_datasets.run({});
    await t.list_experiments.run({ dataset_id: 'ds1' });
    assert.equal(srv.requests[0].query.name_contains, 'def');
    assert.deepEqual(srv.requests[1].query, { span_kind: 'LLM', status_code: 'ERROR', limit: '20' });
    assert.equal(srv.requests[2].query.error, 'true');
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally {
    await srv.close();
  }
});

test('phoenix sends a bearer key when configured; health lists one project', async () => {
  const srv = await fakeServer({ 'GET /s/space/v1/projects': { body: { data: [] } } });
  try {
    const c = arize.create(
      'phoenix',
      { flavor: 'phoenix', baseUrl: `${srv.url}/s/space`, apiKey: { env: 'PX' } },
      { secrets: secretsFor({ PX: 'px-key-123' }) },
    );
    assert.equal((await c.health()).ok, true);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer px-key-123');
    assert.equal(srv.requests[0].query.limit, '1');
  } finally {
    await srv.close();
  }
});

test('ax maps tools to REST /v2, spans and traces are POST searches', async () => {
  const srv = await fakeServer({
    'GET /v2/projects': { body: { projects: [] } },
    'POST /v2/spans': { body: { spans: [] } },
    'POST /v2/traces': { body: { traces: [] } },
    'GET /v2/datasets': { body: {} },
    'GET /v2/experiments': { body: {} },
    'GET /v2/monitors': { body: {} },
  });
  try {
    const c = arize.create(
      'ax',
      { flavor: 'ax', baseUrl: srv.url, apiKey: { env: 'AX' } },
      { secrets: secretsFor({ AX: 'ax-key-123' }) },
    );
    const t = tools(c);
    assert.ok(t.list_monitors);
    await t.list_projects.run({ space_id: 'sp1', limit: 10 });
    await t.search_spans.run({ project_id: 'p1', filter: "status_code = 'ERROR'", limit: 100 });
    await t.list_traces.run({ project_id: 'p1' });
    await t.list_datasets.run({});
    await t.list_experiments.run({ dataset_id: 'd1' });
    await t.list_monitors.run({ project_id: 'p1' });
    assert.equal(srv.requests[0].headers.authorization, 'Bearer ax-key-123');
    assert.deepEqual(srv.requests[1].body, { project_id: 'p1', filter: "status_code = 'ERROR'" });
    assert.equal(srv.requests[1].query.limit, '100');
    assert.equal(srv.requests[2].method, 'POST');
    assert.deepEqual(t.search_spans.inputSchema.required, ['project_id']);
  } finally {
    await srv.close();
  }
});

test('ax needs a key; unknown flavors are rejected', () => {
  assert.throws(() => arize.create('ax', { flavor: 'ax' }, { secrets: secretsFor({}) }), /apiKey is required/);
  assert.throws(() => arize.create('x', { flavor: 'cloud' }, { secrets: secretsFor({}) }), /flavor must be/);
});
