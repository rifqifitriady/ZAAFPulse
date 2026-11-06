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
  return { audit, api, call };
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

test('the export by account: a valid ?user= keeps that account only; any other value is a 400', async (t) => {
  const s = setup(t);
  s.audit.record({ action: 'user.create', actor: actor('owner', 'owner'), target: { type: 'user', id: 'vera' } });
  s.audit.record({ action: 'POST /api/config', actor: actor('vera', 'viewer'), outcome: 'refused', status: 403 });
  s.audit.record({ action: 'POST /api/governance/inventory', actor: actor('rex', 'reviewer') });
  const exp = (q, role) =>
    s.api.route({
      method: 'GET',
      path: '/api/governance/audit/export',
      query: new URLSearchParams(q),
      contentType: '',
      role,
    });
  const csv = await exp('format=csv&user=vera', 'owner');
  assert.equal(csv.status, 200);
  const rows = csv.body.trim().split('\r\n');
  assert.equal(rows.length, 2);
  assert.match(rows[1], /,dashboard,vera,10\.0\.0\.2,POST \/api\/config,/);
  const jsonl = await exp('format=jsonl&user=rex', 'viewer');
  assert.deepEqual(
    jsonl.body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).actor.user),
    ['rex'],
  );
  assert.equal((await exp('format=csv', 'owner')).body.trim().split('\r\n').length, 5); // key_created and the three
  assert.deepEqual(await exp('format=csv&user=Vera', 'owner'), {
    status: 400,
    body: { error: 'user: owner or an account name' },
  });
  // The page's export links carry the User filter.
  assert.equal(
    U.govExportHref({ range: 'all', user: ' Vera ' }, 'csv', NOW),
    '/api/governance/audit/export?user=vera&format=csv',
  );
  assert.equal(U.govExportHref({ range: 'all', user: '' }, 'jsonl', NOW), '/api/governance/audit/export?format=jsonl');
});

test("a change's values are the owner's: reviewers and viewers get the changed paths only, in the list and the export", async (t) => {
  const s = setup(t);
  const changes = [
    { path: 'userName', from: 'Ann', to: 'SECRET-NAME' },
    { path: 'integrations.dt.url', from: null, to: 'https://SECRET-HOST' },
  ];
  s.audit.record({ action: 'config.change', actor: actor('owner', 'owner'), changes });
  s.audit.record({
    action: 'user.update',
    actor: actor('owner', 'owner'),
    changes: [{ path: 'role', from: 'viewer', to: 'reviewer' }],
  });
  s.audit.record({ action: 'auth.login', actor: actor('vera', 'viewer') });
  const get = (p, q, role) =>
    s.api.route({ method: 'GET', path: p, query: new URLSearchParams(q), contentType: '', role });
  for (const role of ['viewer', 'reviewer']) {
    const list = await get('/api/governance/audit', '', role);
    assert.ok(!/SECRET|Ann/.test(JSON.stringify(list.body)), JSON.stringify(list.body));
    const byAction = Object.fromEntries(list.body.entries.map((e) => [e.action, e]));
    assert.deepEqual(byAction['config.change'].changes, [{ path: 'userName' }, { path: 'integrations.dt.url' }]);
    assert.deepEqual(byAction['user.update'].changes, [{ path: 'role' }]);
    assert.ok(!('changes' in byAction['auth.login']));
    for (const format of ['csv', 'jsonl']) {
      const x = await get('/api/governance/audit/export', `format=${format}`, role);
      assert.equal(x.status, 200);
      assert.ok(!/SECRET|Ann|reviewer"|→ reviewer/.test(x.body), x.body);
      assert.match(x.body, /userName/);
    }
    // A line without values to hide is the line as written (a copy of it still verifies).
    const lines = (await get('/api/governance/audit/export', 'format=jsonl', role)).body.trim().split('\n');
    const written = s.audit.export({ format: 'jsonl' }).body.trim().split('\n');
    assert.equal(lines.at(-1), written.at(-1));
  }
  const owner = await get('/api/governance/audit', '', 'owner');
  assert.deepEqual(owner.body.entries.find((e) => e.action === 'config.change').changes, changes);
  assert.match((await get('/api/governance/audit/export', 'format=csv', 'owner')).body, /userName: Ann → SECRET-NAME/);
});
