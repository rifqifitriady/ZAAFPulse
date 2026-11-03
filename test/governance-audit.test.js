// Governance audit log (AI Governance 2): the store (lib/governance/audit.js). Monthly files chained across months,
// the key from the store or the file, a rekey when the key is gone, the degraded state and its gap entry, list filters
// and paging, the exports with the formula guard, retention by whole months, and the CLI's pending events.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('../lib/governance/audit');
const { seal, GENESIS, REKEYED } = require('../lib/governance/chain');
const { createSecretStore } = require('../lib/secret-store');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
function setup(t, { store = null } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-audit-')), 'audit');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const clock = { t: NOW };
  const make = (s = store) =>
    A.createGovernanceAudit({ dir, getKey: A.keySource({ dir, store: s, now: () => clock.t }), now: () => clock.t });
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

// A file-only attacker: a key of their own in chain.key and entries sealed with it, written into the month file.
const forgeWith = (dir, key) => fs.writeFileSync(path.join(dir, 'chain.key'), `${key.toString('base64')}\n`);
const sys = { via: 'system' };

test('verify: a forged audit.rekey sealed with a chain.key of its own does not hide an edit before it', (t) => {
  const { dir, audit, make } = setup(t, { store: memStore() });
  audit.record({ action: 'POST /api/gateway/keys', op: 'create', target: { type: 'gateway.keys', name: 'evil' } });
  audit.record({ action: 'config.change', target: { type: 'config', id: 'gateway' } });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const lines = linesIn(file);
  lines[1].target.name = 'harmless'; // the edit
  const k = crypto.randomBytes(32);
  forgeWith(dir, k);
  const rekey = { action: 'audit.rekey', actor: sys, outcome: 'ok', reason: 'key missing', keyed: 'file' };
  lines.push(seal(k, { seq: 4, ts: '2026-11-03T12:00:00.000Z', ...rekey, prev: REKEYED }));
  fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const after = make(); // after a restart
  const changed = { ok: false, checked: 1, from: 1, to: 1, brokenAt: 2, reason: 'entry changed' };
  assert.deepEqual(after.verify(), changed);
  after.record({ action: 'later' });
  assert.deepEqual(after.verify(), changed);
});

test('verify: a log rebuilt from scratch shows at entry 1; a new log over a key the store holds still says so', (t) => {
  const store = memStore();
  const { dir, audit, make } = setup(t, { store });
  audit.record({ action: 'auth.login', actor: dash });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const ts = '2026-11-03T12:00:00.000Z';
  const atOne = { ok: false, checked: 0, from: null, to: null, brokenAt: 1, reason: 'chain broken' };
  // Rewritten with a key of one's own: a first entry keyed in chain.key while the store holds the key.
  const k = crypto.randomBytes(32);
  forgeWith(dir, k);
  const e1 = seal(k, {
    seq: 1,
    ts,
    action: 'audit.key_created',
    actor: sys,
    outcome: 'ok',
    keyed: 'file',
    prev: GENESIS,
  });
  const e2 = seal(k, { seq: 2, ts, action: 'auth.login', actor: dash, outcome: 'ok', keyed: 'file', prev: e1.mac });
  fs.writeFileSync(file, `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`);
  assert.deepEqual(make().verify(), atOne);
  // A first entry that is not audit.key_created, even when it is sealed with the right key.
  fs.rmSync(path.join(dir, 'chain.key'));
  const real = Buffer.from(store.items.get(A.SERVICE), 'base64');
  const f1 = seal(real, { seq: 1, ts, action: 'auth.login', actor: dash, outcome: 'ok', prev: GENESIS });
  fs.writeFileSync(file, `${JSON.stringify(f1)}\n`);
  assert.deepEqual(make().verify(), atOne);
  // A second data folder with the same store (another checkout on this Mac) finds the key there: its log still
  // starts with audit.key_created and verifies.
  const other = setup(t, { store });
  assert.equal(other.audit.record({ action: 'auth.login', actor: dash }).seq, 2);
  const [first] = linesIn(path.join(other.dir, 'governance-2026-11.jsonl'));
  assert.deepEqual([first.action, first.keyed, first.prev], ['audit.key_created', 'store', GENESIS]);
  assert.deepEqual(other.audit.verify(), { ok: true, checked: 2, from: 1, to: 2 });
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
  assert.equal(last.keptFrom, 4); // the first entry of 2025-11, the oldest month kept
  assert.deepEqual(audit.verify(), { ok: true, checked: 3, from: 4, to: 6 });
  assert.deepEqual(audit.prune(12), []);
  // The oldest kept month deleted by hand: the kept months no longer start where the pruning said.
  fs.rmSync(path.join(dir, 'governance-2025-11.jsonl'));
  assert.deepEqual(audit.verify(), {
    ok: false,
    checked: 0,
    from: null,
    to: null,
    brokenAt: 4,
    reason: 'sequence broken',
  });
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

test('pending: a file whose time is no date is removed and not recorded; the files after it still are', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending', '1-0000000a.json'), '{"action":"auth.password_set","ts":1e20}');
  A.queueEvent(dir, { action: 'auth.password_set' }, Date.UTC(2026, 10, 2, 9));
  assert.equal(audit.importPending(), 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
  assert.deepEqual(
    audit.list({}).entries.map((e) => [e.action, e.occurredAt]),
    [
      ['auth.password_set', '2026-11-02T09:00:00.000Z'],
      ['audit.key_created', undefined],
    ],
  );
});

// A store that can be locked (every read answers null, every write fails, as a locked Keychain does) or answer null
// to a number of reads of the audit key (a timeout).
const flakyStore = () => {
  const items = new Map();
  const s = {
    items,
    down: false,
    nullReads: 0,
    get(k) {
      if (s.down) return null;
      if (k === A.SERVICE && s.nullReads > 0) {
        s.nullReads--;
        return null;
      }
      return items.get(k) || null;
    },
    set(k, v) {
      if (s.down) throw new Error('locked');
      items.set(k, v);
    },
  };
  return s;
};
const brokenAtStart = (brokenAt) => ({
  ok: false,
  checked: 0,
  from: null,
  to: null,
  brokenAt,
  reason: 'sequence broken',
});

test('verify: lines deleted from the start, or a whole month deleted by hand, break the chain', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  for (let i = 0; i < 4; i++) audit.record({ action: 'config.change', actor: dash, op: `n${i}` });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  fs.writeFileSync(file, lines.slice(3).join('\n') + '\n');
  assert.deepEqual(audit.verify(), brokenAtStart(1));

  const other = setup(t, { store: memStore() });
  for (const m of [8, 9, 10]) {
    other.clock.t = Date.UTC(2026, m, 15);
    other.audit.record({ action: 'auth.login', actor: dash });
  }
  assert.deepEqual(other.audit.verify(), { ok: true, checked: 4, from: 1, to: 4 });
  fs.rmSync(path.join(other.dir, 'governance-2026-09.jsonl')); // no audit.prune says it went
  assert.deepEqual(other.audit.verify(), brokenAtStart(1));
});

test('record: a last line left half written is cut off before the next entry, which reads and verifies', (t) => {
  const { dir, clock, audit, make } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  audit.record({ action: 'auth.logout', actor: dash });
  const file = path.join(dir, 'governance-2026-11.jsonl');
  fs.appendFileSync(file, '{"seq":4,"ts":"2026-11-03T12:0'); // the server stopped mid-write
  const again = make();
  const e = again.record({ action: 'config.change', actor: dash });
  assert.equal(e.seq, 4);
  assert.deepEqual(
    linesIn(file).map((x) => x.seq),
    [1, 2, 3, 4],
  );
  assert.deepEqual([again.list({}).entries[0], again.list({}).skipped], [e, 0]);
  assert.deepEqual(again.verify(), { ok: true, checked: 4, from: 1, to: 4 });
  // The same at the end of a month: the next entry goes to the next month's file.
  fs.appendFileSync(file, '{"seq":5,"ts":"2026-11-30T23:5');
  clock.t = Date.UTC(2026, 11, 1, 0, 5);
  const later = make();
  assert.equal(later.record({ action: 'auth.login', actor: dash }).seq, 5);
  assert.deepEqual(later.verify(), { ok: true, checked: 5, from: 1, to: 5 });
  // A whole entry that only lacks its "\n" is the one the chain goes on from: it stays.
  const dec = path.join(dir, 'governance-2026-12.jsonl');
  fs.writeFileSync(dec, fs.readFileSync(dec, 'utf8').replace(/\n$/, ''));
  const last = make();
  assert.equal(last.record({ action: 'auth.logout', actor: dash }).seq, 6);
  assert.deepEqual(last.verify(), { ok: true, checked: 6, from: 1, to: 6 });
});

test('record: a write that fails half way is cut back, so the next entry does not run into it', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  audit.record({ action: 'auth.login', actor: dash });
  const real = fs.writeSync;
  fs.writeSync = (fd, buf) => {
    real(fd, Buffer.from(buf).subarray(0, 10));
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  };
  try {
    assert.equal(audit.record({ action: 'config.change', actor: dash }), null);
  } finally {
    fs.writeSync = real;
  }
  assert.equal(audit.record({ action: 'auth.logout', actor: dash }).seq, 4); // 3 is the audit.gap
  assert.deepEqual(
    linesIn(path.join(dir, 'governance-2026-11.jsonl')).map((x) => x.action),
    ['audit.key_created', 'auth.login', 'audit.gap', 'auth.logout'],
  );
  assert.deepEqual(audit.verify(), { ok: true, checked: 4, from: 1, to: 4 });
});

test('key: a store that cannot be read while entries exist is not a lost key; the slot is never written over', (t) => {
  const store = flakyStore();
  const { dir, audit, make } = setup(t, { store });
  audit.record({ action: 'auth.login', actor: dash });
  audit.record({ action: 'auth.logout', actor: dash });
  const slot = store.items.get(A.SERVICE);
  const file = path.join(dir, 'governance-2026-11.jsonl');
  // Locked: the call is degraded, no new key is made.
  store.down = true;
  const locked = make();
  assert.equal(locked.record({ action: 'config.change', actor: dash }), null);
  assert.equal(locked.status().degraded.missed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'chain.key')), false);
  // Unlocked: the next call goes on with the same key.
  store.down = false;
  assert.equal(locked.record({ action: 'config.change', actor: dash }).seq, 5);
  assert.deepEqual(
    linesIn(file).map((x) => x.action),
    ['audit.key_created', 'auth.login', 'auth.logout', 'audit.gap', 'config.change'],
  );
  assert.deepEqual(locked.verify(), { ok: true, checked: 5, from: 1, to: 5 });
  // One read that answers null (a timeout) is not a lost key either.
  store.nullReads = 1;
  const slow = make();
  assert.equal(slow.record({ action: 'auth.login', actor: dash }).seq, 6);
  assert.equal(store.items.get(A.SERVICE), slot);
  assert.deepEqual(slow.verify(), { ok: true, checked: 6, from: 1, to: 6 });
  // Really gone from a store that works: the chain restarts with a key in chain.key, never in the store's slot.
  store.items.delete(A.SERVICE);
  const lost = make();
  assert.equal(lost.record({ action: 'auth.login', actor: dash }).keyed, 'file');
  assert.equal(store.items.has(A.SERVICE), false);
  assert.equal(fs.existsSync(path.join(dir, 'chain.key')), true);
  assert.deepEqual(lost.verify(), { ok: true, checked: 2, from: 7, to: 8, unverified: 6, rekeyedAt: 7 });
  // The old key comes back to the store: the chain goes on with the file's key, and verify checks both parts, each
  // with its own key.
  store.items.set(A.SERVICE, slot);
  const back = make();
  assert.equal(back.record({ action: 'auth.logout', actor: dash }).keyed, 'file');
  assert.deepEqual(back.verify(), { ok: true, checked: 9, from: 1, to: 9 });
});

test('key: a chain keyed in chain.key stays on it when the store later answers with a key of its own', (t) => {
  const store = flakyStore();
  store.down = true; // the store cannot take the first key
  const { audit, make } = setup(t, { store });
  assert.equal(audit.record({ action: 'auth.login', actor: dash }).keyed, 'file');
  assert.deepEqual(audit.verify(), { ok: true, checked: 2, from: 1, to: 2 });
  store.down = false;
  store.items.set(A.SERVICE, Buffer.alloc(32, 7).toString('base64'));
  const again = make();
  assert.equal(again.record({ action: 'auth.logout', actor: dash }).keyed, 'file');
  // A log that began in chain.key while the store holds a key is what a rewrite from scratch looks like, so verify
  // says so (the price of catching one: a store that was locked when the log began, and held a key, looks the same).
  assert.deepEqual(again.verify(), {
    ok: false,
    checked: 0,
    from: null,
    to: null,
    brokenAt: 1,
    reason: 'chain broken',
  });
});

test('record: the chain fields are the store’s own, never the caller’s', (t) => {
  const { audit } = setup(t, { store: memStore() });
  const e = audit.record({
    action: 'auth.login',
    actor: dash,
    seq: 99,
    ts: 'then',
    prev: 'genesis',
    mac: 'f'.repeat(64),
    keyed: 'file',
  });
  assert.deepEqual([e.seq, e.ts, e.keyed, e.prev === 'genesis'], [2, '2026-11-03T12:00:00.000Z', undefined, false]);
  assert.deepEqual(audit.verify(), { ok: true, checked: 2, from: 1, to: 2 });
});

test('record: a clock that steps back into the month before writes to the newest month file', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  clock.t = Date.UTC(2026, 11, 1, 0, 0, 5);
  audit.record({ action: 'auth.login', actor: dash });
  clock.t = Date.UTC(2026, 10, 30, 23, 59, 59);
  assert.equal(audit.record({ action: 'auth.logout', actor: dash }).seq, 3);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')),
    ['governance-2026-12.jsonl'],
  );
  assert.deepEqual(audit.verify(), { ok: true, checked: 3, from: 1, to: 3 });
});

test('record: a folder that already exists with looser modes is tightened to 0700', (t) => {
  if (process.platform === 'win32') return;
  const { dir, audit } = setup(t, { store: memStore() });
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  audit.record({ action: 'auth.login', actor: dash });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('list: a limit that is not a whole number still stops the page', (t) => {
  const { audit } = setup(t, { store: memStore() });
  for (let i = 0; i < 5; i++) audit.record({ action: 'auth.login', actor: dash });
  const page = audit.list({ limit: 2.5 });
  assert.deepEqual([page.entries.length, page.next], [2, 5]);
});

test('pending: a file that cannot be removed is not recorded twice', (t) => {
  const { dir, audit } = setup(t, { store: memStore() });
  A.queueEvent(dir, { action: 'auth.password_set' }, Date.UTC(2026, 10, 2, 9));
  const real = fs.rmSync;
  fs.rmSync = (p, o) => {
    if (String(p).includes(`${path.sep}pending${path.sep}`)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return real(p, o);
  };
  try {
    assert.equal(audit.importPending(), 1);
    assert.equal(audit.importPending(), 0);
  } finally {
    fs.rmSync = real;
  }
  assert.equal(audit.importPending(), 0);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'pending')), []);
  assert.equal(audit.list({ action: 'auth.password_set' }).entries.length, 1);
});

test('prune: keptFrom comes from the months deleted, so a pruning cannot launder lines deleted from the head', (t) => {
  const { dir, clock, audit } = setup(t, { store: memStore() });
  clock.t = Date.UTC(2025, 9, 10);
  for (let i = 0; i < 3; i++) audit.record({ action: 'auth.login', actor: dash }); // 2025-10: seq 1-4
  clock.t = Date.UTC(2025, 10, 10);
  for (let i = 0; i < 3; i++) audit.record({ action: 'auth.logout', actor: dash }); // 2025-11: seq 5-7
  const nov = path.join(dir, 'governance-2025-11.jsonl');
  const lines = fs.readFileSync(nov, 'utf8').trim().split('\n');
  fs.writeFileSync(nov, lines.slice(2).join('\n') + '\n');
  assert.deepEqual([audit.verify().ok, audit.verify().brokenAt], [false, 5]);
  clock.t = Date.UTC(2026, 10, 1);
  assert.deepEqual(audit.prune(12), ['2025-10']);
  assert.equal(audit.list({ limit: 1 }).entries[0].keptFrom, 5);
  assert.deepEqual(audit.verify(), brokenAtStart(5));
});

test('key: while a store-keyed chain cannot read its key, the store is probed at most once a minute', (t) => {
  const store = flakyStore();
  const calls = { get: 0, set: 0 };
  const { get, set } = store;
  store.get = (k) => (calls.get++, get(k));
  store.set = (k, v) => (calls.set++, set(k, v));
  const { clock, audit, make } = setup(t, { store });
  audit.record({ action: 'auth.login', actor: dash });
  store.down = true;
  const locked = make();
  const before = { ...calls };
  for (let i = 0; i < 5; i++) {
    clock.t += 1000;
    assert.equal(locked.record({ action: 'config.change', actor: dash }), null);
  }
  // Each call reads the key once; only the first also writes the probe and reads the key again.
  assert.deepEqual([calls.set - before.set, calls.get - before.get], [1, 6]);
  clock.t += 60000;
  assert.equal(locked.record({ action: 'config.change', actor: dash }), null);
  assert.deepEqual([calls.set - before.set, calls.get - before.get], [2, 8]);
  store.down = false;
  assert.equal(locked.record({ action: 'auth.logout', actor: dash }).seq, 4); // 3 is the audit.gap (6 missed)
  assert.equal(locked.verify().ok, true);
});
