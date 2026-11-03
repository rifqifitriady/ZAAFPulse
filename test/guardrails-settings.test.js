// Gateway guardrails (AI Governance 1): the policy in config.json (gateway.guardrails) through the settings route, a
// key's own modes, the status payload and this month's counts. No provider is called here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { secretsFor } = require('./helpers');
const { createGateway } = require('../lib/gateway');
const { createUsage } = require('../lib/gateway/usage');
const { cleanKeyInput } = require('../lib/gateway/keys');

function setup(gwExtra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-set-'));
  let gw = { providers: [], ...gwExtra };
  const writes = [];
  const gateway = createGateway({
    dataDir,
    toolsHome: dataDir,
    getConfig: () => ({ gateway: gw }),
    writeGatewayConfig: (g) => {
      writes.push(g);
      gw = g;
    },
    secrets: secretsFor({}),
    resolveSecret: () => undefined,
    getPricing: () => ({}),
    getIntegrations: () => ({ listTools: async () => [], callTool: async () => ({ result: { content: [] } }) }),
  });
  return { gateway, writes, cfg: () => gw, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test('settings: the policy is saved, merged with what was there, and shown in the status payload', async (t) => {
  const s = setup({ tokenSaver: false, modelMap: [{ match: 'claude-*', to: 'up/m1' }] });
  t.after(s.cleanup);
  assert.deepEqual((await s.gateway.admin('', 'GET')).settings.guardrails, {
    scope: 'external',
    secrets: 'redact',
    pii: 'off',
    injection: 'log',
  });
  const r = await s.gateway.admin('settings', 'POST', { guardrails: { pii: 'redact', scope: 'all' } });
  assert.deepEqual(r.settings.guardrails, { scope: 'all', secrets: 'redact', pii: 'redact', injection: 'log' });
  assert.deepEqual(s.cfg().guardrails, r.settings.guardrails);
  assert.equal(s.cfg().tokenSaver, false, 'the other settings stay');
  assert.deepEqual(s.cfg().modelMap, [{ match: 'claude-*', to: 'up/m1' }]);
  await s.gateway.admin('settings', 'POST', { tokenSaver: true });
  assert.equal(s.cfg().guardrails.pii, 'redact', 'a save without guardrails keeps them');
  assert.deepEqual((await s.gateway.admin('', 'GET')).settings.guardrails, r.settings.guardrails);
});

test('settings: a value that is not allowed is refused (400) and nothing is written', async (t) => {
  const s = setup();
  t.after(s.cleanup);
  const r = await s.gateway.admin('settings', 'POST', { guardrails: { secrets: 'shout', injection: 'redact' } });
  assert.deepEqual(r, {
    errors: ['guardrails.secrets: off, log, redact or block', 'guardrails.injection: off, log or block'],
    badRequest: true,
  });
  assert.equal(s.writes.length, 0);
  // server.js answers a refused setting with 400 (every other admin answer keeps its 200).
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /send\(res, out && out\.badRequest === true \? 400 : 200, out\)/);
});

test('settings: a bad policy in config.json counts as the defaults, field by field', async (t) => {
  const s = setup({ guardrails: { scope: 'everywhere', secrets: 'block', pii: 7 } });
  t.after(s.cleanup);
  assert.deepEqual((await s.gateway.admin('', 'GET')).settings.guardrails, {
    scope: 'external',
    secrets: 'block',
    pii: 'off',
    injection: 'log',
  });
});

test('keys: a key sets any of the three modes; empty means the global one; a bad value is refused', async (t) => {
  assert.deepEqual(
    cleanKeyInput({ name: 'a', guardrails: { secrets: 'block', pii: '', injection: null } }).value.guardrails,
    { secrets: 'block' },
  );
  assert.deepEqual(cleanKeyInput({ name: 'a' }).value.guardrails, {});
  assert.deepEqual(cleanKeyInput({ name: 'a', guardrails: { injection: 'redact' } }).errors, [
    'guardrails.injection: off, log or block, or empty for the global setting',
  ]);
  const s = setup();
  t.after(s.cleanup);
  const made = s.gateway.keys.create({ name: 'app', guardrails: { pii: 'redact' } });
  assert.deepEqual(made.key.guardrails, { pii: 'redact' });
  const id = made.key.id;
  assert.deepEqual(s.gateway.keys.update(id, { rpm: 30 }).key.guardrails, { pii: 'redact' }, 'kept on an update');
  assert.deepEqual(s.gateway.keys.update(id, { guardrails: { pii: '' } }).key.guardrails, {}, 'back to the global');
  assert.deepEqual(s.gateway.keys.update(id, { guardrails: { pii: 'loud' } }).errors, [
    'guardrails.pii: off, log, redact or block, or empty for the global setting',
  ]);
  assert.deepEqual((await s.gateway.admin('', 'GET')).keys[0].guardrails, {});
});

test('usage: this month counts requests redacted, blocked and logged', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-guard-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = new Date(2026, 10, 3, 12).getTime();
  const usage = createUsage({ file: path.join(dir, 'u.jsonl'), getPricing: () => ({}), now: () => now });
  const hits = [{ check: 'secrets', label: 'GitHub token', count: 1 }];
  now = new Date(2026, 9, 31, 12).getTime();
  usage.record({ keyId: 'k', model: 'm', status: 400, guard: { action: 'blocked', hits } }); // last month
  now = new Date(2026, 10, 3, 12).getTime();
  usage.record({ keyId: 'k', model: 'm', status: 200, guard: { action: 'redacted', hits } });
  usage.record({ keyId: 'k', model: 'm', status: 200, guard: { action: 'redacted', hits } });
  usage.record({
    keyId: 'k',
    model: 'm',
    status: 400,
    error: 'blocked by guardrails',
    guard: { action: 'blocked', hits },
  });
  usage.record({ keyId: 'k', model: 'm', status: 200, guard: { action: 'logged', hits: [], error: true } });
  usage.record({ keyId: 'k', model: 'm', status: 200 });
  assert.deepEqual(usage.summary().totals.guard, { redacted: 2, blocked: 1, logged: 1 });
});
