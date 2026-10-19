const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntegrationConfig, buildEntry, secretResolver } = require('../lib/integration-config');

const tmpConfig = (cfg) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-ic-')), 'config.json');
  fs.writeFileSync(f, JSON.stringify(cfg));
  return f;
};
const fakeSecrets = { resolve: (ref) => (ref && ref.keychain ? `kc:${ref.keychain}` : null), mask: (s) => s };

test('buildEntry validates ids, urls, required fields and JSON shapes', () => {
  const r = secretResolver({ store: () => {} });
  assert.deepEqual(buildEntry({ id: 'Bad Id', type: 'dynatrace', values: {} }, null, r).errors.slice(0, 1), [
    'id: use 1-32 lowercase letters, digits or dashes',
  ]);
  const e = buildEntry({ id: 'dt', type: 'dynatrace', values: { baseUrl: 'ftp://x' } }, null, r).errors;
  assert.ok(e.includes('Environment URL: must start with http:// or https://'));
  assert.ok(e.includes('API token: required'));
  const h = buildEntry(
    { id: 'api', type: 'http', values: { baseUrl: 'https://a.example', endpoints: '{"name":"x"}' } },
    null,
    r,
  ).errors;
  assert.ok(h.includes('Endpoints: must be a JSON array'));
});

test('secret inputs become references; a pasted value is stored, never written', () => {
  const stored = [];
  const r = secretResolver({ store: (service, value) => stored.push([service, value]) });
  const built = buildEntry(
    {
      id: 'n8n-prod',
      type: 'n8n',
      values: { baseUrl: 'http://localhost:5678', apiKey: { mode: 'store', value: 's3cret' } },
    },
    null,
    r,
  );
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.entry.apiKey, { keychain: 'acc.n8n-prod' });
  assert.deepEqual(stored, [['acc.n8n-prod', 's3cret']]);
  assert.ok(!JSON.stringify(built.entry).includes('s3cret'));
  // A new reference to an environment variable is written in config.json by hand, not through the form;
  // an existing one stays as it is.
  const env = buildEntry(
    { id: 'x', type: 'n8n', values: { baseUrl: 'http://h', apiKey: { mode: 'env', name: 'N8N_KEY' } } },
    null,
    r,
  );
  assert.match(String(env.errors), /config\.json by hand/);
  const envKept = buildEntry(
    { id: 'x', type: 'n8n', values: { baseUrl: 'http://h', apiKey: { mode: 'env', name: 'N8N_KEY' } } },
    { type: 'n8n', baseUrl: 'http://h', apiKey: { env: 'N8N_KEY' } },
    r,
  );
  assert.deepEqual(envKept.entry.apiKey, { env: 'N8N_KEY' });
  const keep = buildEntry(
    { id: 'x', type: 'n8n', values: { baseUrl: 'http://h' } },
    { type: 'n8n', apiKey: { keychain: 'acc.old' } },
    r,
  );
  assert.deepEqual(keep.entry.apiKey, { keychain: 'acc.old' });
  const http = buildEntry(
    {
      id: 'api',
      type: 'http',
      values: {
        baseUrl: 'https://a.example',
        authPrefix: 'Bearer ',
        authSecret: { mode: 'keychain', service: 'acc.api' },
        endpoints: '[{"name":"x","method":"GET","path":"/x"}]',
      },
    },
    null,
    r,
  );
  assert.match(String(http.errors), /config\.json by hand/, 'a new entry cannot borrow an existing secret item');
  const httpKept = buildEntry(
    {
      id: 'api',
      type: 'http',
      values: {
        baseUrl: 'https://a.example',
        authPrefix: 'Bearer ',
        authSecret: { mode: 'keychain', service: 'acc.api' },
        endpoints: '[{"name":"x","method":"GET","path":"/x"}]',
      },
    },
    { type: 'http', baseUrl: 'https://a.example', auth: { prefix: 'Bearer ', secret: { keychain: 'acc.api' } } },
    r,
  );
  assert.deepEqual(httpKept.entry.auth, { prefix: 'Bearer ', secret: { keychain: 'acc.api' } });
});

test('save adds, renames in place and refuses duplicates; remove deletes', () => {
  const file = tmpConfig({
    userName: 'me',
    integrations: { a: { type: 'router', baseUrl: 'http://localhost:1' }, b: { type: 'router' } },
  });
  const ic = createIntegrationConfig({ file, secrets: fakeSecrets, store: () => {} });
  assert.deepEqual(ic.save({ id: 'a', type: 'router', values: {} }).errors, [
    'id: an integration called "a" already exists',
  ]);
  assert.equal(ic.save({ id: 'c', type: 'router', values: { flavor: '9router' } }).id, 'c');
  assert.equal(
    ic.save({ id: 'a2', originalId: 'a', type: 'router', values: { baseUrl: 'http://localhost:2' } }).id,
    'a2',
  );
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(cfg.integrations), ['a2', 'b', 'c']);
  assert.equal(cfg.integrations.a2.baseUrl, 'http://localhost:2');
  assert.equal(cfg.userName, 'me');
  ic.remove('b');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).integrations), ['a2', 'c']);
});

test('a dry run uses the pasted secret in memory and masks it in errors', async () => {
  const file = tmpConfig({ integrations: {} });
  let seen = null;
  const connectors = {
    n8n: {
      type: 'n8n',
      create: (id, cfg, { secrets }) => {
        seen = secrets.resolve(cfg.apiKey);
        return {
          tools: [{ name: 'ping', run: () => 'ok' }],
          health: async () => ({ ok: false, error: `bad key ${seen}`, latencyMs: 5 }),
        };
      },
    },
  };
  const ic = createIntegrationConfig({
    file,
    secrets: fakeSecrets,
    store: () => {
      throw new Error('must not store during a test');
    },
    connectors,
  });
  const r = await ic.test({
    id: 'n8n',
    type: 'n8n',
    values: { baseUrl: 'http://localhost:5678', apiKey: { mode: 'store', value: 'pasted-key' } },
  });
  assert.equal(seen, 'pasted-key');
  assert.equal(r.status.state, 'error');
  assert.equal(r.status.error, 'bad key ***');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).integrations, {});
});
