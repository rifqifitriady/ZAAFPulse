// Governance inventory (AI Governance 3): the router's inventory routes (lib/governance/api.js) with stand-in sources,
// settings and seen store: GET builds the items with their reviews and saves the seen dates; POST checks a review
// field by field (400 naming it, nothing written), saves it into governance.inventory beside the other settings, and
// clears it; the sources are read at most every 5 s. Also the audit diff of a review of a key item stays readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGovernanceApi } = require('../lib/governance/api');
const { cleanReview } = require('../lib/governance/inventory');
const { diff } = require('../lib/governance/diff');

const NOW = Date.UTC(2026, 10, 3, 12);
function setup({ governance = { audit: { retentionMonths: 24 } }, seenWrite } = {}) {
  const st = {
    governance,
    saved: [],
    reads: 0,
    seen: { exists: false, baselineDone: false, map: {} },
    writes: 0,
    t: NOW,
    logs: [],
  };
  const api = createGovernanceApi({
    audit: { status: () => ({}), verify: () => ({}), list: () => ({}), export: () => ({}) },
    settings: { get: () => st.governance, save: (g) => st.saved.push((st.governance = g)) },
    sources: async () => {
      st.reads++;
      return {
        live: { apps: [{ id: 'claude', name: 'Claude Code' }], installed: [], names: {} },
        mcp: [
          {
            client: 'claude',
            name: 'Claude Code',
            file: '~/.claude.json',
            state: 'ok',
            servers: [{ name: 'github', transport: 'stdio', command: 'npx', package: '@x/github', origin: null }],
          },
        ],
      };
    },
    seen: {
      read: () => st.seen,
      write: seenWrite || ((state) => ((st.seen = state), st.writes++, true)),
    },
    now: () => st.t,
    log: (m) => st.logs.push(m),
  });
  const call = (p, { method = 'GET', body, contentType = 'application/json' } = {}) =>
    api.route({
      method,
      path: p,
      query: new URLSearchParams(),
      contentType,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
  return { api, call, st };
}

test('GET inventory: the items with their counts, failed sources and clients; the seen dates are saved', async () => {
  const s = setup();
  const r = await s.call('/api/governance/inventory');
  assert.equal(r.status, 200);
  assert.equal(r.body.generatedAt, '2026-11-03T12:00:00.000Z');
  assert.deepEqual(
    r.body.items.map((i) => [i.id, i.state, i.status]),
    [
      ['app:claude', 'running', 'unreviewed'],
      ['mcp:github', 'configured', 'unreviewed'],
    ],
  );
  assert.deepEqual(r.body.failed, []);
  assert.deepEqual(r.body.clients, [
    { client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 1 },
  ]);
  assert.equal(r.body.counts.total, 2);
  // The first build is the baseline: every item is stored as such, and the baseline is done (no source failed).
  assert.deepEqual(s.st.seen, {
    baselineDone: true,
    map: {
      'app:claude': { first: '2026-11-03', last: '2026-11-03', state: 'running', baseline: true },
      'mcp:github': { first: '2026-11-03', last: '2026-11-03', state: 'configured', baseline: true },
    },
  });
  // The sources are read again only after 5 s; the seen store is asked on every build.
  await s.call('/api/governance/inventory');
  assert.equal(s.st.reads, 1);
  s.st.t += 5000;
  await s.call('/api/governance/inventory');
  assert.equal(s.st.reads, 2);
  assert.equal((await s.call('/api/governance/inventory', { method: 'PUT', body: {} })).status, 405);
});

test('GET inventory: a seen store that cannot be written never fails the page', async () => {
  const s = setup({
    seenWrite: () => {
      throw Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' });
    },
  });
  const r = await s.call('/api/governance/inventory');
  assert.equal(r.status, 200);
  assert.deepEqual(s.st.logs, ['governance: the inventory dates could not be saved (EACCES)']);
});

test('POST inventory: a review is saved beside the other settings, shown on the item, and cleared', async () => {
  const s = setup();
  const post = (body) => s.call('/api/governance/inventory', { method: 'POST', body });
  const r = await post({
    id: 'mcp:github',
    owner: ' Ana ',
    purpose: 'Issues',
    risk: 'limited',
    decision: 'approved',
    note: '',
  });
  assert.deepEqual(r, {
    status: 200,
    body: {
      id: 'mcp:github',
      review: {
        owner: 'Ana',
        purpose: 'Issues',
        note: '',
        risk: 'limited',
        decision: 'approved',
        reviewedAt: '2026-11-03T12:00:00.000Z',
      },
    },
  });
  assert.deepEqual(s.st.governance.audit, { retentionMonths: 24 }, 'the retention stays');
  const item = (await s.call('/api/governance/inventory')).body.items.find((i) => i.id === 'mcp:github');
  assert.deepEqual([item.status, item.review.owner], ['reviewed', 'Ana']);
  // A review of an item that is not here (yet, or any more) is kept: it shows as gone.
  assert.equal((await post({ id: 'key:key_ab12', owner: 'Ops' })).status, 200);
  const gone = (await s.call('/api/governance/inventory')).body.items.find((i) => i.id === 'key:key_ab12');
  assert.deepEqual([gone.state, gone.status], ['gone', 'gone']);
  assert.deepEqual(await post({ id: 'key:key_ab12', clear: true }), {
    status: 200,
    body: { id: 'key:key_ab12', review: null },
  });
  assert.deepEqual(Object.keys(s.st.governance.inventory), ['mcp:github']);
});

test('POST inventory: each bad field is a 400 that names it, and nothing is written', async () => {
  const s = setup();
  const post = (body, contentType) => s.call('/api/governance/inventory', { method: 'POST', body, contentType });
  for (const [body, error] of [
    [{ owner: 'Ana' }, 'id: an inventory id (<kind>:<name>)'],
    [{ id: 'robot:x' }, 'id: an inventory id (<kind>:<name>)'],
    [{ id: 'mcp:x', owner: 'x'.repeat(201) }, 'owner: text of at most 200 characters'],
    [{ id: 'mcp:x', purpose: 7 }, 'purpose: text of at most 200 characters'],
    [{ id: 'mcp:x', note: ['a'] }, 'note: text of at most 200 characters'],
    [{ id: 'mcp:x', risk: 'medium' }, 'risk: minimal, limited, high, unacceptable or empty'],
    [{ id: 'mcp:x', decision: 'maybe' }, 'decision: approved, restricted, blocked or empty'],
    [{ id: 'mcp:x', clear: 'yes' }, 'clear: true or left out'],
    [{ id: 'mcp:x', reviewedAt: 'x' }, 'reviewedAt: not a review field'],
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, error);
  }
  assert.equal((await post([1])).body.error, 'body: an object');
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('x', 'text/plain')).status, 415);
  assert.equal(s.st.saved.length, 0, 'nothing written');
  // At most 2000 reviews; an existing one can still be changed.
  const full = setup({
    governance: { inventory: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`mcp:s${i}`, {}])) },
  });
  const more = await full.call('/api/governance/inventory', { method: 'POST', body: { id: 'mcp:new' } });
  assert.deepEqual([more.status, more.body.error], [400, 'inventory: at most 2000 reviews']);
  const same = await full.call('/api/governance/inventory', { method: 'POST', body: { id: 'mcp:s1', owner: 'Ana' } });
  assert.equal(same.status, 200);
});

test('reviews: 200 characters after trimming; the audit diff of a key item review stays readable', () => {
  assert.deepEqual(cleanReview({ id: 'app:x', owner: `  ${'a'.repeat(200)}  ` }).errors, []);
  assert.deepEqual(diff({}, { governance: { inventory: { 'key:key_ab12': { owner: 'Ops' } } } }).changes, [
    { path: 'governance.inventory.key:key_ab12.owner', from: null, to: 'Ops' },
  ]);
  // Elsewhere a secret-looking name is still masked.
  assert.deepEqual(diff({}, { governance: { apiKey: 'zp_x' } }).changes, [
    { path: 'governance.apiKey', from: null, to: '‹changed›' },
  ]);
});
