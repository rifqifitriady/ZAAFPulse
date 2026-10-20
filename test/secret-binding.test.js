// Regression tests: a stored secret only ever goes to the addresses it was saved for. Each test is one
// way a kept secret used to reach another host (review finding F1/F1b) and proves it no longer does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const { makeClient, joinUrl, pathParam } = require('../lib/connectors/base');
const http = require('../lib/connectors/http');
const n8n = require('../lib/connectors/n8n');

const fixed = (value) => ({ resolve: (ref) => (ref ? value : null), mask: (s) => s });

/* ---------- connectors: every request stays on the base URL's origin ---------- */

test('connectors: a path cannot point a request at another host or out of the base path', () => {
  const base = 'https://api.good.example/base';
  for (const p of [
    '/\\evil.example/x', // URL parsing reads "\" as "/": https://evil.example/x
    '\\\\evil.example/x',
    '//evil.example/x',
    '/http://evil.example/x',
    'https://evil.example/x',
    '/a/../../x',
    '/a/%2e%2E/x',
    '/a/.\t./x', // the tab is dropped by URL parsing, leaving ".."
  ])
    assert.throws(() => joinUrl(base, p), /path/, p);
  assert.equal(joinUrl(base, '/v1/items', { q: 'a b' }), 'https://api.good.example/base/v1/items?q=a+b');
  assert.equal(joinUrl(base, '/v1/query:execute'), 'https://api.good.example/base/v1/query:execute');
  assert.equal(joinUrl(base, '/http:/x'), 'https://api.good.example/base/http:/x', 'stays a path');
});

test('connectors: path parameters are encoded and never "." or ".."', () => {
  assert.equal(pathParam('a/b?c'), 'a%2Fb%3Fc');
  for (const v of ['..', '.', '', undefined]) assert.throws(() => pathParam(v), /not a valid id/, String(v));
});

test('connectors: a client with credentials never calls another origin, even with an explicit url', async () => {
  const other = await fakeServer({ 'POST /hook': { body: { ok: true } } });
  const home = await fakeServer({});
  try {
    const withKey = makeClient({ baseUrl: home.url, headers: { 'x-api-key': 'k-123456' } });
    await assert.rejects(withKey('POST', 'hook', { url: `${other.url}/hook`, body: {} }), /only calls/);
    const bare = makeClient({ baseUrl: home.url });
    await assert.rejects(
      bare('POST', 'hook', { url: `${other.url}/hook`, headers: { authorization: 'x' } }),
      /only calls/,
      'no per-call headers off-origin either',
    );
    assert.deepEqual(await bare('POST', 'hook', { url: `${other.url}/hook`, body: {} }), { ok: true });
    assert.equal(other.requests.length, 1);
    assert.equal(other.requests[0].headers['x-api-key'], undefined);
  } finally {
    await other.close();
    await home.close();
  }
});

test('http connector: a healthPath or endpoint path that resolves to another host is refused', async () => {
  const evil = await fakeServer({ 'GET /x': { body: {} } });
  const evilHost = new URL(evil.url).host;
  try {
    const cfg = (extra) => ({
      baseUrl: 'https://api.good.example/base',
      auth: { secret: { keychain: 'acc.hp' } },
      endpoints: [{ name: 'x', path: '/x' }],
      ...extra,
    });
    for (const healthPath of [`/\\${evilHost}/x`, `/${evil.url}/x`, `//${evilHost}/x`])
      assert.throws(() => http.create('hp', cfg({ healthPath }), { secrets: fixed('SECRET-hp') }), /path/);
    assert.throws(
      () =>
        http.create('hp', cfg({ endpoints: [{ name: 'x', path: `/\\${evilHost}/x` }] }), {
          secrets: fixed('SECRET-hp'),
        }),
      /path/,
    );
    assert.equal(evil.requests.length, 0);
  } finally {
    await evil.close();
  }
});

test('http connector: a path parameter of ".." cannot reach another endpoint', async () => {
  const srv = await fakeServer({ 'GET /api/items/a%2Fb': { body: {} } });
  try {
    const c = http.create(
      'hp',
      { baseUrl: srv.url, endpoints: [{ name: 'get_item', path: '/api/items/{id}' }] },
      { secrets: secretsFor() },
    );
    await assert.rejects(async () => c.tools[0].run({ id: '..' }), /not a valid id/);
    await c.tools[0].run({ id: 'a/b' });
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].path, '/api/items/a%2Fb');
  } finally {
    await srv.close();
  }
});

test('n8n: id ".." does not turn set_workflow_active into POST /api/v1/activate', async () => {
  const srv = await fakeServer({ 'POST /api/v1/activate': { body: {} } });
  try {
    const c = n8n.create('n8', { baseUrl: srv.url, apiKey: { keychain: 'acc.n8' } }, { secrets: fixed('N8N-KEY') });
    const run = (name, args) => c.tools.find((t) => t.name === name).run(args);
    await assert.rejects(async () => run('set_workflow_active', { id: '..', active: true }), /not a valid id/);
    await assert.rejects(async () => run('get_execution', { id: '.' }), /not a valid id/);
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});
