// Dashboard users (AI Governance 4) in the governance audit log: the list filters by account (GET
// /api/governance/audit?user=), the CSV's actor_id is the account of a dashboard entry, and the Audit log page names the
// account and its role and has a User filter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');
const { createGovernanceApi } = require('../lib/governance/api');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/governanceview');

const NOW = Date.UTC(2026, 10, 4, 12);
const actor = (user, role) => ({ via: 'dashboard', user, role, mode: 'password', device: 'Ab12', ip: '10.0.0.2' });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-users-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createGovernanceAudit({ dir, now: () => NOW, getKey: keySource({ dir }) });
  const api = createGovernanceApi({ audit, settings: { get: () => undefined, save: () => {} }, now: () => NOW });
  const call = (q) =>
    api.route({ method: 'GET', path: '/api/governance/audit', query: new URLSearchParams(q), contentType: '' });
  return { audit, call };
}

test('the list by account: only that account, "owner" included; a value that is no account name is a 400', async (t) => {
  const s = setup(t);
  s.audit.record({ action: 'user.create', actor: actor('owner', 'owner'), target: { type: 'user', id: 'vera' } });
  s.audit.record({ action: 'POST /api/config', actor: actor('vera', 'viewer'), outcome: 'refused', status: 403 });
  s.audit.record({ action: 'POST /api/governance/inventory', actor: actor('rex', 'reviewer') });
  s.audit.record({ action: 'config.change', actor: { via: 'apikey', keyId: 'key_1' } });
  const actions = async (q) => (await s.call(q)).body.entries.map((e) => e.action);
  assert.deepEqual(await actions('user=vera'), ['POST /api/config']);
  assert.deepEqual(await actions('user=owner'), ['user.create']);
  assert.deepEqual(await actions('user=rex&actor=dashboard'), ['POST /api/governance/inventory']);
  assert.deepEqual(await actions('user=nobody'), []);
  for (const bad of ['Vera', 'v', 'vera smith', 'x'.repeat(33)])
    assert.deepEqual(await s.call(`user=${encodeURIComponent(bad)}`), {
      status: 400,
      body: { error: 'user: owner or an account name' },
    });
  // The CSV: actor_id is the account for a dashboard entry, the key for a key's.
  const lines = s.audit.export({ format: 'csv' }).body.split('\r\n');
  assert.match(lines[0], /^seq,time,actor,actor_id,ip,/);
  assert.match(lines[2], /^2,2026-11-04T12:00:00\.000Z,dashboard,owner,10\.0\.0\.2,user\.create,/);
  assert.match(lines[3], /^3,[^,]+,dashboard,vera,10\.0\.0\.2,POST \/api\/config,/);
  assert.match(lines[5], /^5,[^,]+,apikey,key_1,,config\.change,/);
  // An entry from before accounts keeps its device.
  s.audit.record({ action: 'auth.logout', actor: { via: 'dashboard', mode: 'password', device: 'Zz99', ip: '::1' } });
  assert.match(s.audit.export({ format: 'csv' }).body.split('\r\n')[6], /^6,[^,]+,dashboard,Zz99,::1,auth\.logout,/);
});

test('the Audit log page: the account and its role in words, and a User filter in the query', () => {
  assert.equal(
    U.govActorLabel(actor('vera', 'viewer')),
    'Dashboard · vera (viewer) · password · device Ab12 · 10.0.0.2',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', user: 'owner', role: 'owner', mode: 'none', device: null, ip: '127.0.0.1' }),
    'Dashboard · owner · none · 127.0.0.1',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', user: null, role: null, mode: 'password', device: null, ip: '10.0.0.9' }),
    'Dashboard · password · 10.0.0.9',
  );
  assert.equal(
    U.govQuery({ range: 'all', actor: '', user: ' Vera ', action: '', outcome: '' }, { now: NOW }),
    'user=vera&limit=100',
  );
  assert.deepEqual(U.GOV.filters, { range: '7', actor: '', user: '', action: '', outcome: '' });
  const form = U.govFiltersHtml({ range: '7', actor: '', user: '<b>x', action: '', outcome: '' });
  assert.match(
    form,
    /<label>User<input class="input" name="user" maxlength="32" placeholder="owner, an account…" value="&lt;b&gt;x"><\/label>/,
  );
});
