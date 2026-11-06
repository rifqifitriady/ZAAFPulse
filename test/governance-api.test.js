// Governance audit log (AI Governance 2): the router for /api/governance/* (lib/governance/api.js) on a real store in a
// temp folder: query checks (400 with nothing read), paging, the export as a download, verify, status with the
// retention, and the retention setting (400 on a bad value, nothing written).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGovernanceAudit, keySource } = require('../lib/governance/audit');
const { createGovernanceApi } = require('../lib/governance/api');

function setup(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-api-')), 'audit');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const audit = createGovernanceAudit({ dir, getKey: keySource({ dir }), now: () => Date.UTC(2026, 10, 3, 12) });
  const saved = [];
  let governance;
  const api = createGovernanceApi({
    audit,
    settings: { get: () => governance, save: (g) => saved.push((governance = g)) },
  });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) => {
    const u = new URL(p, 'http://x');
    return api.route({ role: 'owner',
      method,
      path: u.pathname,
      query: u.searchParams,
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
  return { audit, call, saved };
}
const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };

test('list: newest first with paging; every bad query value is a 400', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i++) s.audit.record({ action: 'config.change', actor: dash });
  const r = await s.call('/api/governance/audit?limit=2');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.entries.map((e) => e.seq), r.body.next, r.body.skipped], [[5, 4], 4, 0]);
  const next = await s.call(`/api/governance/audit?limit=2&before=${r.body.next}`);
  assert.deepEqual(
    next.body.entries.map((e) => e.seq),
    [3, 2],
  );
  const q = (x) => s.call(`/api/governance/audit?${x}`);
  assert.deepEqual(
    (await q('actor=system')).body.entries.map((e) => e.action),
    ['audit.key_created'],
  );
  assert.equal((await q('from=2026-11-03&to=2026-11-03')).body.entries.length, 5);
  assert.equal((await q('to=2026-11-02')).body.entries.length, 0);
  for (const [bad, message] of [
    ['from=2026-02-30', 'from: a date (YYYY-MM-DD) or an ISO time'],
    ['to=yesterday', 'to: a date (YYYY-MM-DD) or an ISO time'],
    ['from=2026-11-04&to=2026-11-03', 'from is after to'],
    ['actor=root', 'actor: dashboard, apikey, cli, system, rule or a key id'],
    ['outcome=maybe', 'outcome: ok, refused or error'],
    ['limit=0', 'limit: a whole number from 1 to 500'],
    ['limit=501', 'limit: a whole number from 1 to 500'],
    ['before=-1', 'before: a whole number from 1'],
    [`action=${'a'.repeat(81)}`, 'action: at most 80 characters'],
  ])
    assert.deepEqual(await q(bad), { status: 400, body: { error: message } }, bad);
  assert.equal((await q('actor=key_abc&from=2026-11-03T00:00:00.000Z')).status, 200);
});

test('export, verify and status; the routes answer 404, 405 and 415 as the other routers do', async (t) => {
  const s = setup(t);
  s.audit.record({ action: 'POST /api/gateway/keys', actor: dash, target: { type: 'gateway.keys', name: '@SUM(A1)' } });
  const csv = await s.call('/api/governance/audit/export?format=csv&from=2026-11-01');
  assert.equal(csv.status, 200);
  assert.equal(csv.type, 'text/csv; charset=utf-8');
  assert.deepEqual(csv.headers, {
    'Content-Disposition': 'attachment; filename="zaafpulse-audit-2026-11-01-now.csv"',
  });
  assert.match(csv.body, /,'@SUM\(A1\),/);
  const jsonl = await s.call('/api/governance/audit/export?format=jsonl');
  assert.equal(jsonl.body.trim().split('\n').length, 2);
  assert.deepEqual((await s.call('/api/governance/audit/export?format=xml')).body, { error: 'format: jsonl or csv' });
  assert.deepEqual((await s.call('/api/governance/audit/verify')).body, { ok: true, checked: 2, from: 1, to: 2 });
  const st = (await s.call('/api/governance/audit/status')).body;
  assert.equal(st.retentionMonths, 12);
  assert.deepEqual(
    st.months.map((m) => m.month),
    ['2026-11'],
  );
  assert.equal(st.degraded, null);
  assert.equal(st.lastVerify.ok, true);
  assert.equal((await s.call('/api/governance/nope')).status, 404);
  assert.equal((await s.call('/api/governance/audit', { method: 'POST', body: {} })).status, 405);
  assert.equal((await s.call('/api/governance/settings')).status, 405);
  assert.equal(await s.call('/api/other'), null);
  const plain = await s.call('/api/governance/settings', { method: 'POST', body: 'x', contentType: 'text/plain' });
  assert.equal(plain.status, 415);
});

test('settings: the retention from 6 to 120 months is saved beside other governance settings; anything else is 400', async (t) => {
  const s = setup(t);
  const post = (body) => s.call('/api/governance/settings', { method: 'POST', body });
  for (const bad of [
    {},
    { audit: {} },
    { audit: { retentionMonths: 5 } },
    { audit: { retentionMonths: 121 } },
    { audit: { retentionMonths: '24' } },
    { audit: { retentionMonths: 6.5 } },
  ])
    assert.deepEqual(await post(bad), {
      status: 400,
      body: { error: 'audit.retentionMonths: a whole number from 6 to 120' },
    });
  assert.equal(s.saved.length, 0, 'nothing written');
  assert.deepEqual(await post({ audit: { retentionMonths: 24 } }), {
    status: 200,
    body: { audit: { retentionMonths: 24 } },
  });
  assert.deepEqual(s.saved, [{ audit: { retentionMonths: 24 } }]);
  assert.equal((await s.call('/api/governance/audit/status')).body.retentionMonths, 24);
  assert.equal((await post('{nope')).status, 400);
});

test('the daily pass: each step runs when one before it fails, and a failure is logged without its message', () => {
  const done = [];
  const logs = [];
  const audit = {
    importPending: () => {
      done.push('importPending');
      throw Object.assign(new Error('EACCES: permission denied, open /Users/x/.data/audit/pending'), {
        code: 'EACCES',
      });
    },
    prune: (n) => {
      done.push(`prune ${n}`);
      throw new TypeError('bad value in /tmp/x');
    },
    verify: () => done.push('verify'),
  };
  const api = createGovernanceApi({
    audit,
    settings: { get: () => ({ audit: { retentionMonths: 24 } }), save() {} },
    log: (m) => logs.push(m),
  });
  api.dailyPass();
  assert.deepEqual(done, ['importPending', 'prune 24', 'verify']);
  assert.deepEqual(logs, [
    'audit: the daily pass failed at importPending (EACCES)',
    'audit: the daily pass failed at prune (TypeError)',
  ]);
});
