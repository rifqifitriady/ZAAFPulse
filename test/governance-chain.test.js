// Governance audit log (AI Governance 2): the pure chain (lib/governance/chain.js) and the field-level changes
// (lib/governance/diff.js). A changed field, a deleted or moved line and an unreadable line are each found at the right
// seq; a chain that starts after deleted months, or restarts after a rekey, still verifies.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { canonical, macOf, seal, verifyChain, GENESIS, REKEYED } = require('../lib/governance/chain');
const { diff, MASK } = require('../lib/governance/diff');

const KEY = Buffer.alloc(32, 7);
// n sealed entries in a row, the first one after `prev`.
function chainOf(n, { key = KEY, prev = GENESIS, from = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = seal(key, {
      seq: from + i,
      ts: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
      action: 'config.change',
      actor: { via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' },
      prev: out.length ? out[out.length - 1].mac : prev,
    });
    out.push(e);
  }
  return out;
}

test('chain: canonical JSON sorts keys at every level and leaves undefined out', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: undefined } }), '{"a":{"d":[2,{"x":0,"y":1}]},"b":1}');
  assert.equal(canonical('x'), '"x"');
  assert.equal(canonical(null), 'null');
});

test('chain: the mac is HMAC-SHA256 of prev, a newline and the canonical entry without its mac', () => {
  const e = { seq: 1, ts: '2026-11-01T00:00:00.000Z', action: 'audit.key_created', prev: GENESIS };
  const want = crypto
    .createHmac('sha256', KEY)
    .update(`genesis\n${canonical(e)}`)
    .digest('hex');
  assert.equal(macOf(KEY, e), want);
  assert.equal(seal(KEY, e).mac, want);
  assert.equal(macOf(KEY, { ...e, mac: 'ignored' }), want);
  assert.notEqual(macOf(Buffer.alloc(32, 8), e), want);
});

test('verify: an untouched chain is ok, also when it starts after deleted months', () => {
  assert.deepEqual(verifyChain(chainOf(5), KEY), { ok: true, checked: 5, from: 1, to: 5 });
  // Retention deleted seq 1-40: the first kept entry points at a mac that is no longer there.
  const kept = chainOf(3, { prev: 'f'.repeat(64), from: 41 });
  assert.deepEqual(verifyChain(kept, KEY), { ok: true, checked: 3, from: 41, to: 43 });
  assert.deepEqual(verifyChain([], KEY), { ok: true, checked: 0, from: null, to: null });
});

test('verify: a changed field, a deleted line, a moved line and an unreadable line are found at their seq', () => {
  const c = chainOf(5);
  const changed = c.map((e) => (e.seq === 3 ? { ...e, actor: { ...e.actor, ip: '10.0.0.9' } } : e));
  assert.deepEqual(verifyChain(changed, KEY), {
    ok: false,
    checked: 2,
    from: 1,
    to: 2,
    brokenAt: 3,
    reason: 'entry changed',
  });
  const deleted = c.filter((e) => e.seq !== 4);
  assert.equal(verifyChain(deleted, KEY).brokenAt, 4);
  assert.equal(verifyChain(deleted, KEY).reason, 'sequence broken');
  const moved = [c[0], c[2], c[1], c[3], c[4]];
  assert.equal(verifyChain(moved, KEY).brokenAt, 2);
  // A line renumbered to hide a deletion still breaks the chain: its prev names the deleted entry.
  const renumbered = [c[0], c[1], { ...c[3], seq: 3 }];
  assert.equal(verifyChain(renumbered, KEY).reason, 'chain broken');
  const unreadable = [c[0], c[1], null, c[3]];
  assert.deepEqual(
    [verifyChain(unreadable, KEY).brokenAt, verifyChain(unreadable, KEY).reason],
    [3, 'unreadable line'],
  );
  assert.equal(verifyChain([null, c[1]], KEY).brokenAt, 1);
  assert.equal(verifyChain(c, Buffer.alloc(32, 1)).reason, 'entry changed');
});

test('verify: each part between rekeys is checked with its own key; a part whose key is gone is unverified', () => {
  const OLD = Buffer.alloc(32, 1);
  const old = chainOf(3, { key: OLD });
  const fresh = chainOf(2, { prev: REKEYED, from: 4 });
  const keys = (oldKey) => (part) => (part.index === 0 ? oldKey : KEY);
  assert.deepEqual(verifyChain([...old, ...fresh], keys(null)), {
    ok: true,
    checked: 2,
    from: 4,
    to: 5,
    unverified: 3,
    rekeyedAt: 4,
  });
  const tampered = [...old, fresh[0], { ...fresh[1], action: 'auth.login' }];
  assert.equal(verifyChain(tampered, keys(null)).brokenAt, 5);
  // The old key still reads: the part before the rekey is checked too.
  assert.deepEqual(verifyChain([...old, ...fresh], keys(OLD)), { ok: true, checked: 5, from: 1, to: 5 });
  // An edit before the rekey shows, whatever key the part after it was sealed with.
  const edited = [old[0], { ...old[1], action: 'auth.login' }, old[2], ...fresh];
  assert.deepEqual(verifyChain(edited, keys(OLD)), {
    ok: false,
    checked: 1,
    from: 1,
    to: 1,
    brokenAt: 2,
    reason: 'entry changed',
  });
  // A part whose key is gone is still checked for its order.
  assert.equal(verifyChain([old[0], old[2], ...fresh], keys(null)).reason, 'sequence broken');
  assert.equal(verifyChain([...old, { ...fresh[0], seq: 7 }, fresh[1]], keys(null)).brokenAt, 4);
});

test('diff: field paths, secrets masked by key name and by reference, text cut to 120 characters', () => {
  const before = {
    userName: 'Ana',
    gateway: { guardrails: { secrets: 'redact' }, tokenSaver: true },
    monitors: { channels: { webhook: { url: { keychain: 'acc.monitors-webhook-url' } } } },
    vaultPaths: ['/a'],
  };
  const after = {
    userName: 'x'.repeat(200),
    gateway: { guardrails: { secrets: 'block' }, tokenSaver: true, apiToken: 'plain-text' },
    monitors: { channels: { webhook: { url: { keychain: 'acc.other' } } } },
    vaultPaths: ['/a', '/b'],
  };
  const d = diff(before, after);
  assert.deepEqual(d.changes, [
    { path: 'gateway.apiToken', from: null, to: MASK },
    { path: 'gateway.guardrails.secrets', from: 'redact', to: 'block' },
    { path: 'monitors.channels.webhook.url', from: MASK, to: MASK },
    { path: 'userName', from: 'Ana', to: `${'x'.repeat(119)}…` },
    { path: 'vaultPaths', from: '["/a"]', to: '["/a","/b"]' },
  ]);
  assert.deepEqual(d.sections, ['gateway', 'monitors', 'userName', 'vaultPaths']);
  assert.equal(d.truncated, undefined);
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), { changes: [], sections: [] });
  // A switch or a number under a secret-looking name cannot hold a secret, and stays readable.
  assert.deepEqual(diff({ gateway: { tokenSaver: true } }, { gateway: { tokenSaver: false } }).changes, [
    { path: 'gateway.tokenSaver', from: true, to: false },
  ]);
});

test('diff: arrays of objects are compared by id or name; a new section counts', () => {
  const p = (id, extra = {}) => ({ id, preset: 'custom', baseUrl: `https://${id}.example/v1`, ...extra });
  const before = { gateway: { providers: [p('a'), p('b')], routes: [{ name: 'r1', targets: ['a/m'] }] } };
  const after = {
    gateway: {
      providers: [p('b', { baseUrl: 'https://b2.example/v1' }), p('c', { apiKey: { keychain: 'acc.gw-c' } })],
      routes: [{ name: 'r1', targets: ['a/m', 'b/m'] }],
    },
    governance: { audit: { retentionMonths: 24 } },
  };
  assert.deepEqual(diff(before, after).changes, [
    { path: 'gateway.providers[a].baseUrl', from: 'https://a.example/v1', to: null },
    { path: 'gateway.providers[a].id', from: 'a', to: null },
    { path: 'gateway.providers[a].preset', from: 'custom', to: null },
    { path: 'gateway.providers[b].baseUrl', from: 'https://b.example/v1', to: 'https://b2.example/v1' },
    { path: 'gateway.providers[c].apiKey', from: null, to: MASK },
    { path: 'gateway.providers[c].baseUrl', from: null, to: 'https://c.example/v1' },
    { path: 'gateway.providers[c].id', from: null, to: 'c' },
    { path: 'gateway.providers[c].preset', from: null, to: 'custom' },
    { path: 'gateway.routes[r1].targets', from: '["a/m"]', to: '["a/m","b/m"]' },
    { path: 'governance.audit.retentionMonths', from: null, to: 24 },
  ]);
  // A list whose objects have no id is compared whole, and masked when it holds a secret.
  assert.deepEqual(diff({ x: [{ a: 1 }] }, { x: [{ a: 2 }] }).changes, [
    { path: 'x', from: '[{"a":1}]', to: '[{"a":2}]' },
  ]);
  assert.deepEqual(diff({ x: [{ a: 1 }] }, { x: [{ token: 'abc' }] }).changes, [
    { path: 'x', from: '[{"a":1}]', to: MASK },
  ]);
  assert.deepEqual(diff({}, { cost: {} }).changes, [{ path: 'cost', from: null, to: '{}' }]);
});

test('diff: at most 50 changes, then truncated says how many more', () => {
  const after = {};
  for (let i = 0; i < 73; i++) after[`k${String(i).padStart(2, '0')}`] = i;
  const d = diff({}, after);
  assert.equal(d.changes.length, 50);
  assert.equal(d.truncated, 23);
  assert.equal(d.changes[0].path, 'k00');
  assert.equal(d.sections.length, 73);
});

test('fix round 1: the mac covers the entry as JSON writes it (a Date, a function)', () => {
  const e = seal(KEY, {
    seq: 1,
    ts: new Date(Date.UTC(2026, 10, 1)),
    action: 'x',
    fn() {},
    sym: Symbol('s'),
    prev: GENESIS,
  });
  const line = JSON.parse(JSON.stringify(e));
  assert.equal(verifyChain([line], KEY).ok, true);
  assert.equal(macOf(KEY, line), e.mac);
});

test('fix round 1: a mac that differs in the last digit is still an entry changed', () => {
  const [e] = chainOf(1);
  const bad = { ...e, mac: e.mac.slice(0, 63) + (e.mac.endsWith('0') ? '1' : '0') };
  assert.equal(verifyChain([bad], KEY).reason, 'entry changed');
});

test('fix round 1: a list under a secret-looking key is one masked value, with no id in the path', () => {
  const d = diff(
    { x: { tokens: [{ id: 'sk-abcdef123456', label: 'a' }] } },
    { x: { tokens: [{ id: 'sk-abcdef123456', label: 'b' }] } },
  );
  assert.deepEqual(d.changes, [{ path: 'x.tokens', from: MASK, to: MASK }]);
});

test('fix round 1: a number under a secret-looking key is masked; a boolean is not', () => {
  assert.deepEqual(diff({ gateway: { pin: { password: 1234 } } }, { gateway: { pin: { password: 987654 } } }).changes, [
    { path: 'gateway.pin.password', from: MASK, to: MASK },
  ]);
  assert.deepEqual(diff({ n: 1 }, { n: 2 }).changes, [{ path: 'n', from: 1, to: 2 }]);
});

test('fix round 1: secrets and keyCenters are exempt only at their own paths', () => {
  assert.deepEqual(diff({ foo: { secrets: { openai: 'sk-a' } } }, { foo: { secrets: { openai: 'sk-b' } } }).changes, [
    { path: 'foo.secrets.openai', from: MASK, to: MASK },
  ]);
  assert.deepEqual(
    diff({ gateway: { guardrails: { secrets: 'redact' } } }, { gateway: { guardrails: { secrets: 'block' } } }).changes,
    [{ path: 'gateway.guardrails.secrets', from: 'redact', to: 'block' }],
  );
  assert.deepEqual(
    diff({ cost: { keyCenters: { key_a: 'acme' } } }, { cost: { keyCenters: { key_a: 'beta' } } }).changes,
    [{ path: 'cost.keyCenters.key_a', from: 'acme', to: 'beta' }],
  );
  assert.deepEqual(diff({ foo: { keyCenters: { a: 'x' } } }, { foo: { keyCenters: { a: 'y' } } }).changes, [
    { path: 'foo.keyCenters.a', from: MASK, to: MASK },
  ]);
});

test('diff: a guardrails mode is readable at any path ending in guardrails.secrets; other secrets stay masked', () => {
  // A list compared by id (a list named "keys" would itself be a secret-looking name, and stays masked).
  const list = (name, mode) => ({ [name]: [{ id: 'k1', guardrails: mode ? { secrets: mode } : {} }] });
  assert.deepEqual(diff(list('providers', null), list('providers', 'block')).changes, [
    { path: 'providers[k1].guardrails.secrets', from: null, to: 'block' },
  ]);
  assert.deepEqual(diff(list('keys', null), list('keys', 'block')).changes, [{ path: 'keys', from: MASK, to: MASK }]);
  assert.deepEqual(diff({ guardrails: { secrets: 'off' } }, { guardrails: { secrets: 'redact' } }).changes, [
    { path: 'guardrails.secrets', from: 'off', to: 'redact' },
  ]);
  assert.deepEqual(diff({ foo: { secrets: { openai: 'sk-a' } } }, { foo: { secrets: { openai: 'sk-b' } } }).changes, [
    { path: 'foo.secrets.openai', from: MASK, to: MASK },
  ]);
  // Under a secret-looking parent, or a segment that only ends in "guardrails": masked as before.
  assert.deepEqual(
    diff({ apiKey: { guardrails: { secrets: 'a' } } }, { apiKey: { guardrails: { secrets: 'b' } } }).changes,
    [{ path: 'apiKey.guardrails.secrets', from: MASK, to: MASK }],
  );
  assert.deepEqual(diff({ myguardrails: { secrets: 'a' } }, { myguardrails: { secrets: 'b' } }).changes, [
    { path: 'myguardrails.secrets', from: MASK, to: MASK },
  ]);
});

test('fix round 1: cut never splits a surrogate pair', () => {
  const s = `${'a'.repeat(118)}😀${'b'.repeat(10)}`;
  const to = diff({ t: '' }, { t: s }).changes[0].to;
  assert.equal(to, `${'a'.repeat(118)}😀…`);
  assert.doesNotMatch(to, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('diff: URL credentials in a text value are replaced on both sides of a change', () => {
  const { changes } = diff(
    { gateway: { note: 'see https://bob:hunter2@host.example/x', hook: 'ftp://svc:pw@h' } },
    { gateway: { note: 'see https://bob:newpass@host.example/y', hook: 'ftp://h' } },
  );
  assert.deepEqual(changes, [
    { path: 'gateway.hook', from: 'ftp://‹changed›@h', to: 'ftp://h' },
    { path: 'gateway.note', from: 'see https://‹changed›@host.example/x', to: 'see https://‹changed›@host.example/y' },
  ]);
  assert.ok(!JSON.stringify(changes).includes('hunter2') && !JSON.stringify(changes).includes('newpass'));
});

test('diff: a URL password with an @ in it is masked whole, and so are query values under secret-looking names', () => {
  const { changes } = diff(
    {},
    {
      a: 'https://admin:p@ss-W0rd@host/x',
      b: 'https://h/v1?api_key=sk-live-123&x=1',
      c: 'wss://h/s?token=t0k&Sig=abc#frag',
      d: 'https://h/p?monkey=1&keys=2&access_token=zz&apikey=q&password=pw&auth=a&signature=s&secret=x&key=k',
    },
  );
  assert.deepEqual(
    changes.map((c) => c.to),
    [
      'https://‹changed›@host/x',
      'https://h/v1?api_key=‹changed›&x=1',
      'wss://h/s?token=‹changed›&Sig=‹changed›#frag',
      'https://h/p?monkey=1&keys=2&access_token=‹changed›&apikey=‹changed›&password=‹changed›&auth=‹changed›&signature=‹changed›&secret=‹changed›&key=‹changed›',
    ].map((s) => (Array.from(s).length > 120 ? `${Array.from(s).slice(0, 119).join('')}…` : s)),
  );
  const text = JSON.stringify(changes);
  for (const secret of ['ss-W0rd', 'p@ss', 'sk-live-123', 't0k', 'abc', '=zz', '=pw', '=k'])
    assert.ok(!text.includes(secret), secret);
});
