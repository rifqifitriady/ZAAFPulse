// Governance audit log (AI Governance 2): the store (lib/governance/audit.js). Monthly files chained across months,
// the key from the store or the file, a rekey when the key is gone, the degraded state and its gap entry, list filters
// and paging, the exports with the formula guard, retention by whole months, and the CLI's pending events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/governance/audit');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
function setup(t, { store = null } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-audit-')), 'audit');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const clock = { t: NOW };
  const make = (s = store) =>
    A.createGovernanceAudit({ dir, getKey: A.keySource({ dir, store: s }), now: () => clock.t });
  return { dir, clock, audit: make(), make };
}
const memStore = () => {
  const items = new Map();
  return { items, get: (k) => items.get(k) || null, set: (k, v) => items.set(k, v) };
};
const linesIn = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const dash = { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' };

test('record: the first entry makes the key (in the store) and says so; entries are chained in a month file', (t) => {
  const store = memStore();
  const { dir, audit } = setup(t, { store });
  const e = audit.record({ action: 'config.change', actor: dash, changes: [{ path: 'userName', from: 'a', to: 'b' }] });
  assert.equal(e.seq, 2);
  assert.equal(store.items.get(A.SERVICE).length, 44); // 32 bytes, base64
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const [k, c] = linesIn(file);
  assert.deepEqual(
    [k.seq, k.action, k.actor, k.keyed, k.prev, c.prev, c.action, c.outcome],
    [1, 'audit.key_created', { via: 'system' }, 'store', 'genesis', k.mac, 'config.change', 'ok'],
  );
  assert.deepEqual(Object.keys(c), ['seq', 'ts', 'action', 'actor', 'outcome', 'changes', 'prev', 'mac']);
  assert.equal(c.ts, '2026-11-03T12:00:00.000Z');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(audit.verify(), { ok: true, checked: 2, from: 1, to: 2 });
  // A record without an actor is the server's own.
  assert.deepEqual(audit.record({ action: 'audit.prune' }).actor, { via: 'system' });
});

test('record: the chain runs across months; a store that cannot hold the key leaves it in chain.key', (t) => {
  const broken = { get: () => null, set: () => {} }; // takes the key, never gives it back
  const { dir, clock, audit, make } = setup(t, { store: broken });
  audit.record({ action: 'auth.login', actor: dash });
  clock.t = Date.UTC(2026, 11, 1, 0, 5);
  audit.record({ action: 'auth.logout', actor: dash });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['chain.key', 'governance-2026-11.jsonl', 'governance-2026-12.jsonl']);
  const [dec] = linesIn(path.join(dir, 'governance-2026-12.jsonl'));
  assert.equal(dec.seq, 3);
  assert.equal(dec.keyed, 'file');
  assert.equal(dec.prev, linesIn(path.join(dir, 'governance-2026-11.jsonl'))[1].mac);
  // A fresh server finds the key in the file and goes on with the chain.
  const again = make();
  assert.equal(again.record({ action: 'auth.login', actor: dash }).seq, 4);
  assert.deepEqual(again.verify(), { ok: true, checked: 4, from: 1, to: 4 });
});

test('verify: a changed field, a deleted line and lines cut from the end are reported with their seq', (t) => {
  const { dir, audit, make } = setup(t, { store: memStore() });
  for (let i = 0; i < 5; i++) audit.record({ action: 'config.change', actor: dash, op: `n${i}` });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('"op":"n2"', '"op":"nX"'));
  assert.deepEqual([audit.verify().brokenAt, audit.verify().reason], [4, 'entry changed']);
  const lines = text.trim().split('\n');
  fs.writeFileSync(file, [...lines.slice(0, 2), ...lines.slice(3)].join('\n') + '\n');
  assert.deepEqual([audit.verify().brokenAt, audit.verify().reason], [3, 'sequence broken']);
  // The chain left after the last line is cut holds together; the server knows what it wrote last.
  fs.writeFileSync(file, lines.slice(0, 5).join('\n') + '\n');
  assert.deepEqual([audit.verify().ok, audit.verify().brokenAt], [false, 6]);
  assert.equal(audit.status().lastVerify.brokenAt, 6);
  assert.equal(audit.status().lastVerify.at, '2026-11-03T12:00:00.000Z');
  // An unparsable line: verify breaks there, list skips it and counts it.
  fs.writeFileSync(file, [...lines.slice(0, 3), '{"seq":4,"half', ...lines.slice(4)].join('\n') + '\n');
  const fresh = make();
  assert.deepEqual([fresh.verify().brokenAt, fresh.verify().reason], [4, 'unreadable line']);
  assert.equal(fresh.list({}).skipped, 1);
  assert.equal(fresh.list({}).entries.length, 5);
});

test('rekey: entries without their key are not sealed over silently; the chain restarts with audit.rekey', (t) => {
  const { dir, audit, make } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  audit.record({ action: 'auth.logout', actor: dash });
  const lost = make(memStore()); // another store: the key is gone
  assert.deepEqual(lost.verify(), {
    ok: false,
    checked: 0,
    from: null,
    to: null,
    brokenAt: null,
    reason: 'key missing',
  });
  const e = lost.record({ action: 'config.change', actor: dash });
  const all = linesIn(path.join(dir, 'governance-2026-11.jsonl'));
  assert.deepEqual(
    all.map((x) => [x.seq, x.action, x.prev === 'rekeyed']),
    [
      [1, 'audit.key_created', false],
      [2, 'auth.login', false],
      [3, 'auth.logout', false],
      [4, 'audit.rekey', true],
      [5, 'config.change', false],
    ],
  );
  assert.equal(e.seq, 5);
  assert.deepEqual(lost.verify(), { ok: true, checked: 2, from: 4, to: 5, unverified: 3, rekeyedAt: 4 });
});

test('degraded: a write that fails is counted, the status says since when, and one audit.gap entry follows', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const kept = fs.readFileSync(file);
  fs.rmSync(file);
  fs.mkdirSync(file); // the month file is now a folder: every append fails
  clock.t += 1000;
  assert.equal(audit.record({ action: 'config.change', actor: dash }), null);
  clock.t += 1000;
  assert.equal(audit.record({ action: 'config.change', actor: dash }), null);
  assert.deepEqual(audit.status().degraded, { since: '2026-11-03T12:00:01.000Z', missed: 2 });
  fs.rmdirSync(file);
  fs.writeFileSync(file, kept, { mode: 0o600 });
  clock.t += 1000;
  const e = audit.record({ action: 'auth.logout', actor: dash });
  assert.equal(e.seq, 4);
  const gap = linesIn(file)[2];
  assert.deepEqual(
    [gap.seq, gap.action, gap.outcome, gap.missed, gap.since],
    [3, 'audit.gap', 'error', 2, '2026-11-03T12:00:01.000Z'],
  );
  assert.equal(audit.status().degraded, null);
  assert.equal(audit.verify().ok, true);
});

test('list: newest first, filters by time, actor kind or key id, action text and outcome, pages with before', (t) => {
  const { clock, audit } = setup(t, { store: memStore() });
  const key = { via: 'apikey', keyId: 'key_abc123' };
  const rows = [
    ['auth.login', dash, 'ok'],
    ['POST /api/gateway/keys', dash, 'ok', 'create'],
    ['run.approve', key, 'refused'],
    ['run.cancel', key, 'ok'],
    ['config.change', dash, 'ok'],
    ['POST /api/config', dash, 'error'],
  ];
  for (const [action, actor, outcome, op] of rows) {
    clock.t += DAY;
    audit.record({ action, actor, outcome, ...(op ? { op } : {}) });
  }
  const seqs = (q) => audit.list(q).entries.map((e) => e.seq);
  assert.deepEqual(seqs({}), [7, 6, 5, 4, 3, 2, 1]);
  const page = audit.list({ limit: 3 });
  assert.deepEqual([page.entries.map((e) => e.seq), page.next], [[7, 6, 5], 5]);
  assert.deepEqual(
    audit.list({ limit: 3, before: 5 }).entries.map((e) => e.seq),
    [4, 3, 2],
  );
  assert.equal(audit.list({ limit: 3, before: 2 }).next, null);
  assert.deepEqual(seqs({ actor: 'apikey' }), [5, 4]);
  assert.deepEqual(seqs({ actor: 'key_abc123' }), [5, 4]);
  assert.deepEqual(seqs({ actor: 'system' }), [1]);
  assert.deepEqual(seqs({ action: 'KEYS CREATE' }), [3]);
  assert.deepEqual(seqs({ action: 'run.' }), [5, 4]);
  assert.deepEqual(seqs({ outcome: 'refused' }), [4]);
  assert.deepEqual(seqs({ from: NOW + 2 * DAY, to: NOW + 4 * DAY }), [5, 4, 3]);
  assert.equal(audit.list({ limit: 9999 }).entries.length, 7);
});

test('export: JSON lines exactly as written, CSV with one line per entry and the formula guard', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  audit.record({
    action: 'POST /api/gateway/keys',
    actor: { via: 'apikey', keyId: 'key_1' },
    op: 'create',
    target: { type: 'gateway.keys', id: 'key_2', name: '=HYPERLINK("x")' },
    status: 200,
  });
  audit.record({ action: 'config.change', actor: dash, changes: [{ path: 'userName', from: null, to: '+1, two' }] });
  const j = audit.export({ format: 'jsonl' });
  assert.equal(j.body, fs.readFileSync(path.join(dir, 'governance-2026-11.jsonl'), 'utf8'));
  assert.equal(j.type, 'application/x-ndjson');
  assert.equal(j.name, 'zaafpulse-audit-start-now.jsonl');
  const c = audit.export({ format: 'csv', from: Date.UTC(2026, 10, 1), to: NOW });
  assert.equal(c.name, 'zaafpulse-audit-2026-11-01-2026-11-03.csv');
  const lines = c.body.split('\r\n');
  assert.equal(lines[0], A.CSV_COLUMNS.join(','));
  assert.equal(lines.length, 5); // header, three entries, the empty end
  assert.match(
    lines[2],
    /^2,2026-11-03T12:00:00\.000Z,apikey,key_1,,POST \/api\/gateway\/keys,create,gateway\.keys,key_2,"'=HYPERLINK\(""x""\)",ok,200,,/,
  );
  assert.match(lines[3], /,"userName: ∅ → \+1, two",/);
});

test('prune: whole months that ended more than the retention ago go, and the pruning is an entry', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  for (const [y, m] of [
    [2025, 8],
    [2025, 9],
    [2025, 10],
    [2026, 10],
  ]) {
    clock.t = Date.UTC(y, m, 15);
    audit.record({ action: 'auth.login', actor: dash });
  }
  clock.t = NOW;
  assert.deepEqual(audit.prune(12), ['2025-09', '2025-10']);
  assert.deepEqual(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort(),
    ['governance-2025-11.jsonl', 'governance-2026-11.jsonl'],
  );
  const last = audit.list({ limit: 1 }).entries[0];
  assert.deepEqual([last.action, last.months, last.retentionMonths], ['audit.prune', ['2025-09', '2025-10'], 12]);
  assert.deepEqual(audit.verify(), { ok: true, checked: 3, from: 4, to: 6 });
  assert.deepEqual(audit.prune(12), []);
  // A retention out of range counts as 12; at most 120, at least 6.
  assert.deepEqual(
    [A.cleanRetention(5), A.cleanRetention(6), A.cleanRetention(120), A.cleanRetention('24')],
    [12, 6, 120, 12],
  );
});

test('pending: the CLI leaves an event, the server records it with the cli actor and removes the file', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  const made = A.queueEvent(dir, { action: 'auth.password_set' }, Date.UTC(2026, 10, 2, 9));
  assert.equal(made.length, 3);
  fs.writeFileSync(path.join(dir, 'pending', '1-0000000a.json'), '{"action":"config.change","ts":1}');
  assert.equal(audit.importPending(), 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
  const e = audit.list({}).entries[0];
  assert.deepEqual(
    [e.action, e.actor, e.occurredAt],
    ['auth.password_set', { via: 'cli' }, '2026-11-02T09:00:00.000Z'],
  );
  assert.equal(audit.importPending(), 0);
});
