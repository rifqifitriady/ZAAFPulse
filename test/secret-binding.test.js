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

/* ---------- integrations: test-draft and save refuse a kept secret that would move ---------- */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildEntry, secretResolver, createIntegrationConfig, entryAddresses } = require('../lib/integration-config');
const { secretMove, keepsSecret } = require('../lib/secret-binding');

const KEEP = { mode: 'keep' };
const keep = secretResolver({ store: () => {} });
const build = (form, current) => buildEntry({ id: 'x', ...form }, current, keep);
const refused = (r) => r.errors.some((e) => /enter the secret again/.test(e));

test('integrations: a built-in default URL counts as the address the secret was saved for', () => {
  const ax = { type: 'arize', flavor: 'ax', apiKey: { keychain: 'acc.az' } };
  assert.ok(
    refused(build({ type: 'arize', values: { flavor: 'ax', baseUrl: 'https://evil.example', apiKey: KEEP } }, ax)),
  );
  assert.deepEqual(
    build({ type: 'arize', values: { flavor: 'ax', baseUrl: 'https://api.arize.com', apiKey: KEEP } }, ax).errors,
    [],
    'spelling out the default is not a move',
  );
  const phoenix = { type: 'arize', apiKey: { keychain: 'acc.ph' } };
  assert.ok(refused(build({ type: 'arize', values: { baseUrl: 'https://evil.example', apiKey: KEEP } }, phoenix)));
  const router = { type: 'router', flavor: '9router', apiKey: { keychain: 'acc.rt' } };
  assert.ok(
    refused(
      build({ type: 'router', values: { flavor: '9router', baseUrl: 'http://evil.example', apiKey: KEEP } }, router),
    ),
  );
});

test('integrations: an HTTP health or endpoint path that resolves to another host is refused', () => {
  const current = {
    type: 'http',
    baseUrl: 'https://api.good.example/base',
    auth: { secret: { keychain: 'acc.hp' } },
    endpoints: [{ name: 'x', path: '/x' }],
  };
  const form = (values) => ({
    type: 'http',
    values: {
      baseUrl: 'https://api.good.example/base',
      authSecret: KEEP,
      endpoints: '[{"name":"x","path":"/x"}]',
      ...values,
    },
  });
  for (const healthPath of ['/\\evil.example/x', '/http://evil.example/x', '//evil.example/x'])
    assert.ok(build(form({ healthPath }), current).errors.length, healthPath);
  assert.ok(build(form({ endpoints: '[{"name":"x","path":"/\\\\evil.example/x"}]' }), current).errors.length);
  assert.deepEqual(build(form({ healthPath: '/api/health' }), current).errors, [], 'a path on the same host is fine');
  // Hand-written entries are checked the same way: every resolved path is one of the entry's addresses.
  const { urls } = entryAddresses({ ...current, healthPath: '/\\evil.example/x' });
  assert.ok(urls.includes('invalid:/\\evil.example/x'), urls.join(' '));
});

test('integrations: a type or flavor change needs the secret again', () => {
  const n8 = { type: 'n8n', baseUrl: 'http://localhost:5678', apiKey: { keychain: 'acc.n8' } };
  assert.ok(refused(build({ type: 'openrouter', values: { apiKey: KEEP } }, n8)), 'n8n key must not go to OpenRouter');
  const phoenix = { type: 'arize', flavor: 'phoenix', baseUrl: 'https://ph.example', apiKey: { keychain: 'acc.az' } };
  assert.ok(
    refused(build({ type: 'arize', values: { flavor: 'ax', baseUrl: 'https://ph.example', apiKey: KEEP } }, phoenix)),
  );
  const omni = { type: 'router', baseUrl: 'http://localhost:20128', apiKey: { keychain: 'acc.rt' } };
  assert.ok(
    refused(
      build({ type: 'router', values: { flavor: '9router', baseUrl: 'http://localhost:20128', apiKey: KEEP } }, omni),
    ),
  );
  // Pasting a new secret is always allowed.
  assert.deepEqual(
    build({ type: 'openrouter', values: { apiKey: { mode: 'store', value: 'sk-or-new-123' } } }, n8).errors,
    [],
  );
});

test('integrations: naming the same secret item again counts as keeping it', () => {
  const n8 = { type: 'n8n', baseUrl: 'https://n8n.example.com', apiKey: { keychain: 'acc.n8' } };
  const r = build(
    { type: 'n8n', values: { baseUrl: 'https://attacker.example', apiKey: { mode: 'keychain', service: 'acc.n8' } } },
    n8,
  );
  assert.ok(refused(r), r.errors.join('; '));
  assert.ok(keepsSecret(undefined, { keychain: 'a' }) && !keepsSecret({ mode: 'store' }, { keychain: 'a' }));
  assert.equal(
    secretMove({ kind: 'a', urls: ['https://x.example/a'] }, { kind: 'a', urls: ['https://x.example/b'] }),
    null,
  );
});

test('integrations: test-draft and save send nothing to the new host and store nothing', async () => {
  const evil = await fakeServer({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-bind-'));
  const file = path.join(dir, 'config.json');
  const integrations = {
    az: { type: 'arize', flavor: 'ax', apiKey: { keychain: 'acc.az' } },
    hp: {
      type: 'http',
      baseUrl: 'https://api.good.example',
      auth: { secret: { keychain: 'acc.hp' } },
      endpoints: [{ name: 'x', path: '/x' }],
    },
    n8: { type: 'n8n', baseUrl: 'http://localhost:5678', apiKey: { keychain: 'acc.n8' } },
  };
  fs.writeFileSync(file, JSON.stringify({ integrations }));
  const ic = createIntegrationConfig({
    file,
    secrets: { resolve: (ref) => (ref ? `SECRET-OF-${ref.keychain}` : null), mask: (s) => s },
    store: () => {
      throw new Error('nothing is stored');
    },
  });
  const forms = [
    { originalId: 'az', id: 'az', type: 'arize', values: { flavor: 'ax', baseUrl: evil.url, apiKey: KEEP } },
    {
      originalId: 'hp',
      id: 'hp',
      type: 'http',
      values: {
        baseUrl: 'https://api.good.example',
        healthPath: `/\\${new URL(evil.url).host}/x`,
        authSecret: KEEP,
        endpoints: '[{"name":"x","path":"/x"}]',
      },
    },
    { originalId: 'n8', id: 'n8', type: 'router', values: { baseUrl: evil.url, apiKey: KEEP } },
  ];
  try {
    for (const form of forms) {
      const t = await ic.test(form);
      assert.ok(t.errors && t.errors.length, `test-draft ${form.id}: ${JSON.stringify(t)}`);
      const s = ic.save(form);
      assert.ok(s.errors && s.errors.length, `save ${form.id}: ${JSON.stringify(s)}`);
    }
    assert.deepEqual(evil.requests, [], 'the new host received nothing');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).integrations, integrations, 'nothing was saved');
  } finally {
    await evil.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- second brain: a source re-saved as another type ---------- */

const { createBrain } = require('../lib/brain');

function brainWith(sources) {
  let conf = { brain: { sources } };
  const brain = createBrain({
    getConfig: () => conf,
    writeBrainConfig: (b) => (conf = { ...conf, brain: b }),
    secrets: { resolve: (r) => `TOKEN-${r.keychain}`, mask: (s) => s },
    resolveSecret: (id, input, current) => keep(`brain-${id}`, { key: 'token' }, input, current),
  });
  return { brain, conf: () => conf };
}

test('brain: a kept token does not follow a type change or a URL added to the source', async () => {
  const evil = await fakeServer({});
  const notion = {
    id: 'nt',
    type: 'notion',
    name: 'Notion',
    enabled: true,
    options: {},
    secret: { keychain: 'acc.brain-nt' },
  };
  const hey = {
    id: 'hb',
    type: 'heybrain',
    name: 'Heybrain',
    enabled: true,
    options: {},
    path: os.tmpdir(),
    secret: { keychain: 'acc.brain-hb' },
  };
  const { brain, conf } = brainWith([notion, hey]);
  try {
    const r = brain.save({ originalId: 'nt', id: 'nt', type: 'qdrant', url: evil.url, secret: KEEP });
    assert.match(String(r.errors), /type changed.*enter the secret again/);
    const same = brain.save({
      originalId: 'nt',
      id: 'nt',
      type: 'qdrant',
      url: evil.url,
      secret: { mode: 'keychain', service: 'acc.brain-nt' },
    });
    assert.match(String(same.errors), /enter the secret again/, 'naming the same item is still keeping it');
    const added = brain.save({ originalId: 'hb', id: 'hb', type: 'heybrain', url: evil.url, path: os.tmpdir() });
    assert.match(String(added.errors), /URL changed.*enter the secret again/);
    assert.deepEqual(conf().brain.sources, [notion, hey], 'nothing was saved');
    assert.equal((await brain.test('nt')).ok, false);
    assert.deepEqual(evil.requests, []);
    const ok = brain.save({ originalId: 'nt', id: 'nt', type: 'notion', name: 'Renamed', secret: KEEP });
    assert.ok(!ok.errors, String(ok.errors));
  } finally {
    await evil.close();
  }
});

/* ---------- gateway providers ---------- */

const { createGateway } = require('../lib/gateway');

async function gatewayWith(providers, fetchImpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-bind-gw-'));
  let gw = { providers };
  const gateway = createGateway({
    dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => (gw = g),
    secrets: { resolve: (r) => `sk-REAL-${r.keychain}`, mask: (s) => s },
    resolveSecret: (id, input, current) => keep(`gw-${id}`, { key: 'apiKey' }, input, current),
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({}) }),
    fetchImpl,
  });
  return { gateway, gw: () => gw };
}

test('gateway: a kept key does not follow a switch to OAuth2 or a base URL set over the preset default', async () => {
  const evil = await fakeServer({ 'POST /token': { body: { access_token: 'x' } } });
  const seen = [];
  const fetchImpl = (u, init) => (
    seen.push(String(u)),
    String(u).startsWith(evil.url) ? fetch(u, init) : Promise.reject(new Error('offline'))
  );
  const key = {
    id: 'oa',
    preset: 'custom',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: { keychain: 'acc.gw-oa' },
    enabled: true,
  };
  const preset = { id: 'or', preset: 'openrouter', apiKey: { keychain: 'acc.gw-or' }, enabled: true }; // hand-written, no baseUrl
  const { gateway, gw } = await gatewayWith([key, preset], fetchImpl);
  try {
    const toOauth = await gateway.admin('providers', 'POST', {
      action: 'save',
      originalId: 'oa',
      id: 'oa',
      preset: 'custom',
      baseUrl: 'https://api.openai.com/v1',
      authType: 'oauth2',
      oauth: { tokenUrl: `${evil.url.replace('http:', 'https:')}/token`, clientId: 'c' },
      secret: KEEP,
    });
    assert.match(String(toOauth.errors), /sign-in method changed.*enter the key again/);
    const moved = await gateway.admin('providers', 'POST', {
      action: 'save',
      originalId: 'or',
      id: 'or',
      preset: 'openrouter',
      baseUrl: evil.url,
      secret: { mode: 'keychain', service: 'acc.gw-or' },
    });
    assert.match(String(moved.errors), /address changed.*enter the key again/);
    assert.deepEqual(gw().providers, [key, preset], 'nothing was saved');
    assert.deepEqual(evil.requests, []);
    assert.deepEqual(seen, []);
    const same = await gateway.admin('providers', 'POST', {
      action: 'save',
      originalId: 'or',
      id: 'or',
      preset: 'openrouter',
    });
    assert.ok(!same.errors, String(same.errors));
  } finally {
    await evil.close();
  }
});

test('gateway: an OAuth2 client secret is not re-sent when the token endpoint redirects', async () => {
  const other = await fakeServer({ 'POST /steal': { body: { access_token: 'stolen' } } });
  const token = await fakeServer({ 'POST /token': { status: 307, headers: { location: `${other.url}/steal` } } });
  const { createProviders } = require('../lib/gateway/providers');
  const p = {
    id: 'az',
    preset: 'azure-openai',
    baseUrl: token.url,
    enabled: true,
    apiKey: { keychain: 'acc.gw-az' },
    auth: { type: 'oauth2', tokenUrl: `${token.url}/token`, clientId: 'app', grant: 'client_credentials' },
  };
  const providers = createProviders({
    getConfig: () => ({ gateway: { providers: [p] } }),
    secrets: { resolve: () => 'CLIENT-SECRET-123', mask: (s) => s },
  });
  try {
    await assert.rejects(providers.accessToken(p), /redirect/);
    assert.equal(token.requests.length, 1);
    assert.deepEqual(other.requests, [], 'the redirect target never saw the client secret');
  } finally {
    await other.close();
    await token.close();
  }
});
