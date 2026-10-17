const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeServer, secretsFor } = require('./helpers');
const http = require('../lib/connectors/http');

const tools = (c) => Object.fromEntries(c.tools.map((t) => [t.name, t]));
const cfg = (url, endpoints, extra = {}) => ({ baseUrl: url, auth: { header: 'Authorization', prefix: 'Bearer ', secret: { env: 'AION' } }, endpoints, ...extra });

test('GET endpoints fill path parameters and send the rest as query', async () => {
  const srv = await fakeServer({ 'GET /api/agents/a1/runs': { body: { runs: [] } } });
  try {
    const c = http.create('aion', cfg(srv.url, [{ name: 'list_runs', method: 'GET', path: '/api/agents/{agentId}/runs', description: 'Runs', params: { status: { type: 'string' } } }]), { secrets: secretsFor({ AION: 'aion-token-1' }) });
    const t = tools(c).list_runs;
    assert.deepEqual(t.inputSchema.required, ['agentId']);
    assert.equal(t.write, false);
    await t.run({ agentId: 'a1', status: 'failed' });
    assert.deepEqual(srv.requests[0].query, { status: 'failed' });
    assert.equal(srv.requests[0].headers.authorization, 'Bearer aion-token-1');
  } finally { await srv.close(); }
});

test('POST endpoints send a JSON body merged over the fixed body and are writes by default', async () => {
  const srv = await fakeServer({ 'POST /api/agents/a1/invoke': (r) => ({ body: { got: r.body } }) });
  try {
    const c = http.create('aion', cfg(srv.url, [
      { name: 'invoke', method: 'POST', path: '/api/agents/{agentId}/invoke', params: { input: { type: 'string' } }, body: { mode: 'async' } },
      { name: 'search', method: 'POST', path: '/api/search', write: false },
    ]), { secrets: secretsFor({ AION: 'aion-token-1' }) });
    const t = tools(c);
    assert.equal(t.invoke.write, true);
    assert.equal(t.search.write, false);
    assert.deepEqual(await t.invoke.run({ agentId: 'a1', input: 'hi' }), { got: { mode: 'async', input: 'hi' } });
  } finally { await srv.close(); }
});

test('health is unchecked without healthPath and checked with it', async () => {
  const srv = await fakeServer({ 'GET /health': { body: { ok: true } } });
  try {
    const s = secretsFor({ AION: 'aion-token-1' });
    assert.equal((await http.create('a', cfg(srv.url, [{ name: 'x', path: '/x' }]), { secrets: s }).health()).ok, null);
    assert.equal((await http.create('a', cfg(srv.url, [{ name: 'x', path: '/x' }], { healthPath: '/health' }), { secrets: s }).health()).ok, true);
  } finally { await srv.close(); }
});

test('validates endpoint definitions and plain headers', () => {
  const s = secretsFor({ AION: 'aion-token-1' });
  assert.throws(() => http.create('a', cfg('http://x', []), { secrets: s }), /endpoints must be a non-empty list/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'Bad-Name', path: '/x' }]), { secrets: s }), /endpoints\[0\].name/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', method: 'TRACE', path: '/x' }]), { secrets: s }), /method must be one of/);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', path: 'x' }]), { secrets: s }), /path must start with \//);
  assert.throws(() => http.create('a', cfg('http://x', [{ name: 'x', path: '/x' }], { headers: { 'X-Key': { env: 'AION' } } }), { secrets: s }), /headers.X-Key must be a string/);
});
