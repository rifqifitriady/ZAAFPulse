const test = require('node:test');
const assert = require('node:assert/strict');
const { createOmniRoute } = require('../lib/omniroute');

const CFG = () => ({ integrations: { omni: { type: 'router', baseUrl: 'http://router.test:20128' } } });
const secrets = { resolve: () => null, mask: (s) => s };
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const make = (fetchImpl) => createOmniRoute(CFG, { secrets, fetchImpl });

test('health(): ok from /api/health, and an { error } when the fetch fails', async () => {
  const seen = [];
  const good = make(async (url) => (seen.push(url), reply({ status: 'ok' })));
  assert.deepEqual(await good.health(), { ok: true });
  assert.equal(seen[0], 'http://router.test:20128/api/health');
  const bad = make(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  assert.equal((await bad.health()).error, 'connect ECONNREFUSED');
  assert.equal((await make(async () => reply({}, 401)).health()).error, 'HTTP 401');
});

test('providers(): keeps the PROVIDER_FIELDS, masks emails, and fails on its own', async () => {
  const conn = {
    id: 'abcdef123456',
    provider: 'claude',
    name: 'someone@example.com',
    displayName: 'other.person@example.org',
    authType: 'oauth',
    isActive: true,
    testStatus: 'active',
    accessToken: 'sk-secret-token',
    email: 'someone@example.com',
  };
  const r = make(async () => reply({ connections: [conn, null, 'x', [1]] }));
  const out = await r.providers();
  assert.equal(out.connections.length, 1, 'a connection that is not an object is dropped');
  const c = out.connections[0];
  assert.equal(c.id, 'abcd…', 'connection ids are shortened');
  assert.equal(c.provider, 'claude');
  assert.equal(c.name, 'so***@example.com');
  assert.equal(c.displayName, 'ot***@example.org');
  assert.equal(c.accessToken, undefined);
  assert.equal(c.email, undefined);
  assert.doesNotMatch(JSON.stringify(out), /someone@|sk-secret/);
  const bad = make(async () => reply({}, 500));
  assert.deepEqual(await bad.providers(), { error: 'HTTP 500' });
});
