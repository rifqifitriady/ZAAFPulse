// Governance inventory (AI Governance 3): the pure builder (lib/governance/inventory.js) and the seen dates store
// (lib/governance/seen.js). The same system from several sources is one item with a stable id; first and last seen
// follow the store; a review whose item is no longer there is "gone"; a failed source is listed and the rest still
// counts; nothing secret (an agent's system prompt, a URL's path or token, a key's secret) reaches an item.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildInventory } = require('../lib/governance/inventory');
const { createSeenStore } = require('../lib/governance/seen');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
const sources = () => ({
  live: {
    apps: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'ollama', name: 'Ollama' },
    ],
    installed: ['claude', 'cursor', 'ollama'],
    names: { claude: 'Claude Code', cursor: 'Cursor', ollama: 'Ollama', antigravity: 'Antigravity / Gemini' },
  },
  summary: {
    tools: [
      { id: 'claude', name: 'Claude Code', lastActive: NOW - DAY },
      { id: 'codex', name: 'Codex', lastActive: NOW - 90 * DAY },
    ],
    toolUse: [{ name: 'Read' }, { name: 'mcp__GitHub__create_issue' }, { name: 'mcp__github__list_prs' }],
    models: [{ model: 'claude-sonnet-4-5' }],
  },
  trace: [
    { id: 'claude', ok: true, count: 4 },
    { id: 'gemini', ok: true, count: 2 },
    { id: 'gateway', ok: true, count: 9 },
    { id: 'kiro', ok: false, count: 0 },
  ],
  gateway: {
    providers: [
      { id: 'openai', preset: 'openai', baseUrl: 'https://api.openai.com/v1/secret-path?key=SECRET-1', enabled: true },
      { id: 'local', preset: 'ollama', baseUrl: '', enabled: false },
    ],
    models: ['openai/gpt-5', '—', 'router/fast'],
    keys: [
      { id: 'key_a1', name: 'ci', lastUsedAt: NOW - 2 * DAY, secret: 'zp_SECRET-2', hash: 'SECRET-3' },
      { id: 'key_b2', name: 'old', revokedAt: NOW - DAY },
      { id: 'key_c3', name: 'spare', expiresAt: NOW + DAY },
    ],
    agents: [
      { id: 'researcher', name: 'Researcher', enabled: true, systemPrompt: 'SECRET-PROMPT-4' },
      { id: 'remote', name: 'Remote', enabled: false, remoteUrl: 'https://a2a.example.com/agents/x?t=SECRET-5' },
    ],
    skills: [
      { name: 'zaafpulse', claude: 'installed', agents: 'missing' },
      { name: 'cost', claude: 'missing', agents: 'missing' },
    ],
    workflows: [{ id: 'incident-triage-rca', name: 'Incident triage to mitigation' }],
    knowledge: [{ id: 'kb_1', name: 'Runbooks' }],
  },
  runtimes: [
    { id: 'ollama', name: 'Ollama', kind: 'server', preset: true, installed: true, running: true },
    { id: 'jan', name: 'Jan', kind: 'server', preset: true, installed: false, running: false },
    { id: 'my-llama', name: 'My llama', kind: 'server', preset: false, installed: false, running: false },
    { id: 'chatgpt', name: 'ChatGPT', kind: 'app', preset: true, installed: true, running: false },
  ],
  integrations: [
    { id: 'dt', type: 'dynatrace', enabled: true, url: 'https://abc.live.dynatrace.com/api?Api-Token=SECRET-6' },
    { id: 'upstream', type: 'mcp', enabled: false, url: 'https://mcp.example.com/mcp' },
  ],
  mcp: [
    {
      client: 'claude',
      name: 'Claude Code',
      file: '~/.claude.json',
      state: 'ok',
      servers: [
        {
          name: 'github',
          transport: 'http',
          command: null,
          package: null,
          origin: 'https://api.github.com',
          ours: false,
        },
        { name: 'zaafpulse', transport: 'stdio', command: 'node', package: null, origin: null, ours: true },
        {
          name: 'db',
          transport: 'stdio',
          command: 'uvx',
          package: 'mcp-server-postgres',
          origin: null,
          ours: false,
          project: '~/code/shop',
        },
      ],
    },
    {
      client: 'cursor',
      name: 'Cursor',
      file: '~/.cursor/mcp.json',
      state: 'ok',
      servers: [{ name: 'db', transport: 'stdio', command: 'uvx', package: 'mcp-server-postgres', origin: null }],
    },
    { client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: [] },
  ],
});
const done = (map) => ({ exists: true, baselineDone: true, map });
const byId = (inv) => Object.fromEntries(inv.items.map((i) => [i.id, i]));

test('one item per system: sources merge by id, the best state wins, every source is named in where', () => {
  const inv = buildInventory(sources(), {}, {}, NOW);
  const it = byId(inv);
  assert.deepEqual(
    inv.items.map((i) => i.id),
    [
      'app:antigravity',
      'app:chatgpt',
      'app:claude',
      'app:codex',
      'app:cursor',
      'mcp:db',
      'mcp:github',
      'mcp:zaafpulse',
      'provider:local',
      'provider:openai',
      'model:claude-sonnet-4-5',
      'model:openai/gpt-5',
      'agent:remote',
      'agent:researcher',
      'skill:cost',
      'skill:zaafpulse',
      'workflow:incident-triage-rca',
      'knowledge:kb_1',
      'runtime:my-llama',
      'runtime:ollama',
      'integration:dt',
      'integration:upstream',
      'key:key_a1',
      'key:key_b2',
      'key:key_c3',
    ],
    'by kind, then by name',
  );
  assert.equal(inv.items.length, 25);
  assert.deepEqual(it['app:claude'], {
    id: 'app:claude',
    kind: 'app',
    name: 'Claude Code',
    vendor: 'Anthropic',
    where: ['running', 'installed', 'logs', 'trace'],
    state: 'running',
    firstSeen: '2026-11-03',
    lastSeen: '2026-11-03',
    baseline: true,
    review: null,
    status: 'unreviewed',
  });
  assert.deepEqual([it['app:codex'].state, it['app:codex'].where], ['idle', ['logs']], 'last active 90 days ago');
  assert.deepEqual([it['app:antigravity'].name, it['app:antigravity'].where], ['Antigravity / Gemini', ['trace']]);
  assert.deepEqual(
    [it['runtime:ollama'].state, it['runtime:ollama'].where],
    ['running', ['running', 'installed', 'runtimes']],
  );
  assert.equal(it['app:chatgpt'].state, 'idle');
  assert.equal(it['runtime:my-llama'].state, 'configured', "the owner's own entry");
  assert.ok(!it['runtime:jan'], 'a preset that is not installed is not here');
  assert.deepEqual(it['mcp:github'].where, ['logs', 'Claude Code config']);
  assert.equal(it['mcp:github'].state, 'used');
  assert.equal(it['mcp:github'].name, 'GitHub', 'the first source names it; the id is lowercased');
  assert.deepEqual(
    [it['mcp:db'].clients, it['mcp:db'].projects, it['mcp:db'].package, it['mcp:db'].where],
    [['Claude Code', 'Cursor'], ['~/code/shop'], 'mcp-server-postgres', ['Claude Code config', 'Cursor config']],
  );
  assert.equal(it['mcp:zaafpulse'].ours, true);
  assert.deepEqual([it['provider:openai'].vendor, it['provider:openai'].origin], ['OpenAI', 'https://api.openai.com']);
  assert.equal(it['provider:local'].state, 'idle');
  assert.deepEqual([it['model:openai/gpt-5'].vendor, it['model:openai/gpt-5'].where], ['OpenAI', ['gateway usage']]);
  assert.equal(it['model:claude-sonnet-4-5'].vendor, 'Anthropic');
  assert.deepEqual(
    ['key:key_a1', 'key:key_b2', 'key:key_c3'].map((id) => it[id].state),
    ['used', 'idle', 'configured'],
  );
  assert.deepEqual([it['agent:remote'].state, it['agent:remote'].origin], ['idle', 'https://a2a.example.com']);
  assert.deepEqual(
    ['skill:zaafpulse', 'skill:cost'].map((id) => [it[id].state, it[id].vendor]),
    [
      ['configured', 'ZAAFPulse'],
      ['idle', 'ZAAFPulse'],
    ],
  );
  assert.deepEqual(
    [it['integration:dt'].vendor, it['integration:dt'].origin, it['integration:upstream'].state],
    ['Dynatrace', 'https://abc.live.dynatrace.com', 'idle'],
  );
  assert.deepEqual(inv.clients, [
    { client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 3 },
    { client: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json', state: 'ok', servers: 1 },
    { client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: 0 },
  ]);
  const text = JSON.stringify(inv);
  for (const s of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'SECRET-PROMPT-4', 'SECRET-5', 'SECRET-6', 'secret-path'])
    assert.ok(!text.includes(s), `${s} must not reach an item`);
});

test('first and last seen: kept from the store, today for a new item; a review of a gone item is kept', () => {
  const seen = {
    'app:claude': { first: '2026-09-01', last: '2026-10-30' },
    'mcp:retired': { first: '2026-01-01', last: '2026-02-01' },
    'app:broken': { first: 'yesterday', last: 3 },
  };
  const reviews = {
    'app:claude': { owner: 'Ana', purpose: 'coding', risk: 'limited', decision: 'approved', note: '', reviewedAt: 'x' },
    'mcp:retired': { owner: 'Ana', risk: 'high', decision: 'blocked' },
    'not an id': { owner: 'x' },
  };
  const inv = buildInventory({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }, reviews, done(seen), NOW);
  assert.deepEqual(
    inv.items.map((i) => [i.id, i.state, i.status, i.firstSeen, i.lastSeen]),
    [
      ['app:claude', 'running', 'reviewed', '2026-09-01', '2026-11-03'],
      ['mcp:retired', 'gone', 'gone', '2026-01-01', '2026-02-01'],
    ],
  );
  assert.deepEqual(inv.items[0].review, {
    owner: 'Ana',
    purpose: 'coding',
    risk: 'limited',
    decision: 'approved',
    note: '',
    reviewedAt: 'x',
  });
  assert.deepEqual(inv.nextSeen, {
    baselineDone: true,
    map: {
      'app:claude': { first: '2026-09-01', last: '2026-11-03', state: 'running' },
      'mcp:retired': { first: '2026-01-01', last: '2026-02-01' },
    },
  });
  assert.deepEqual(
    [inv.counts.total, inv.counts.reviewed, inv.counts.unreviewed, inv.counts.gone],
    [1, 1, 0, 1],
    'a gone item is not counted as present',
  );
});

test('counts: new unreviewed items (first seen in the last 7 days, not ours) by kind only; risk and decisions', () => {
  const seen = {
    'app:claude': { first: '2026-10-28', last: '2026-11-02' }, // 6 days ago: still new
    'app:codex': { first: '2026-10-27', last: '2026-11-02' }, // 7 days ago: not new
  };
  const reviews = {
    'provider:openai': { risk: 'high' },
    'provider:x': { risk: 'unacceptable', decision: 'restricted' },
  };
  const s = sources();
  s.gateway.providers.push({ id: 'x', preset: 'custom', enabled: true });
  const inv = buildInventory(s, reviews, done(seen), NOW);
  assert.equal(inv.counts.total, 26);
  assert.equal(inv.counts.reviewed, 2);
  assert.equal(inv.counts.newUnreviewed, 22, 'all but codex (old), the two reviewed and ours');
  assert.deepEqual(inv.counts.newKinds, [
    'agent',
    'app',
    'integration',
    'key',
    'knowledge',
    'mcp',
    'model',
    'provider',
    'runtime',
    'skill',
    'workflow',
  ]);
  assert.deepEqual(
    [inv.counts.high, inv.counts.unacceptable, inv.counts.riskUndecided, inv.counts.unacceptableNotBlocked],
    [1, 1, 1, 1],
  );
  assert.equal(inv.counts.byKind.mcp, 3);
  assert.equal(inv.counts.byState.running, 2);
});

test('a failed source is listed and the rest still counts; bad shapes never throw', () => {
  const inv = buildInventory({ ...sources(), gateway: null, mcp: null }, {}, {}, NOW);
  assert.deepEqual(inv.failed, ['gateway', 'mcp']);
  assert.ok(inv.items.some((i) => i.id === 'app:claude'));
  assert.ok(!inv.items.some((i) => i.kind === 'key'));
  const odd = buildInventory(
    { live: { apps: 'x', installed: [1, null] }, summary: { tools: [null, { id: 'claude' }] }, trace: {}, gateway: 7 },
    null,
    'x',
    NOW,
  );
  assert.deepEqual([odd.items, odd.failed], [[], []]);
  assert.deepEqual(buildInventory(undefined, undefined, undefined, NOW).counts.total, 0);
});

test('seen store: written atomically and privately only when it changed; a corrupt file reads loud', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-seen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'governance', 'seen.json');
  const store = createSeenStore({ file });
  assert.deepEqual(store.read(), { exists: false, baselineDone: false, map: {} });
  const map = { 'app:claude': { first: '2026-11-03', last: '2026-11-03' } };
  assert.equal(store.write({ baselineDone: false, map: {} }), true, 'the first build writes even an empty map');
  assert.deepEqual(createSeenStore({ file }).read(), { exists: true, baselineDone: false, map: {} });
  const next = { baselineDone: true, map };
  assert.equal(store.write(next), true);
  assert.equal(store.write(next), false, 'unchanged: not written again');
  assert.deepEqual(createSeenStore({ file }).read(), { exists: true, baselineDone: true, map });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['seen.json'], 'no temp file left');
  // The older flat shape still reads (the baseline was done by then).
  fs.writeFileSync(file, JSON.stringify(map));
  assert.deepEqual(createSeenStore({ file }).read(), { exists: true, baselineDone: true, map });
  // Corrupt: loud, so that tampering cannot silence the new-item alert.
  for (const bad of ['{ torn', '[1]', 'null', '"x"']) {
    fs.writeFileSync(file, bad);
    assert.deepEqual(createSeenStore({ file }).read(), { exists: true, baselineDone: true, map: {} }, bad);
  }
});

test('baseline: the first build with no seen dates marks every item; an item first seen later is not a baseline', () => {
  const first = buildInventory(sources(), {}, {}, NOW);
  assert.ok(first.items.length > 0 && first.items.every((i) => i.baseline === true));
  assert.equal(first.nextSeen.baselineDone, true);
  assert.ok(Object.values(first.nextSeen.map).every((d) => d.baseline === true && d.first === '2026-11-03'));
  assert.ok(first.items.every((i) => i.status === 'unreviewed' && i.firstSeen === '2026-11-03'));
  assert.equal(first.counts.unreviewed, first.counts.total, 'baseline items still show as unreviewed');
  assert.equal(first.counts.newUnreviewed, 0, 'but none of them is new');
  assert.deepEqual(first.counts.newKinds, []);
  for (const bad of [null, 'x', [1], {}, { exists: false, baselineDone: false, map: {} }])
    assert.equal(buildInventory(sources(), {}, bad, NOW).counts.newUnreviewed, 0, 'no seen file: a baseline');

  // A later build: the stored baseline stays, a new system is not a baseline and counts as new.
  const later = sources();
  later.gateway.knowledge.push({ id: 'kb_2', name: 'Playbooks' });
  const next = buildInventory(later, {}, first.nextSeen, NOW + 2 * DAY);
  const it = byId(next);
  assert.equal(it['app:claude'].baseline, true);
  assert.equal(it['app:claude'].firstSeen, '2026-11-03');
  assert.equal(it['app:claude'].lastSeen, '2026-11-05');
  assert.equal(it['knowledge:kb_2'].baseline, undefined);
  assert.equal(it['knowledge:kb_2'].firstSeen, '2026-11-05');
  assert.deepEqual(next.nextSeen.map['knowledge:kb_2'], {
    first: '2026-11-05',
    last: '2026-11-05',
    state: 'configured',
  });
  assert.equal(next.nextSeen.map['app:claude'].baseline, true);
  assert.equal(next.counts.newUnreviewed, 1);
  assert.deepEqual(next.counts.newKinds, ['knowledge']);
});

test('baseline: a seen file that is there with no entries is not a baseline; a corrupt one is loud', () => {
  const inv = buildInventory(sources(), {}, done({}), NOW);
  assert.ok(inv.items.every((i) => i.baseline === undefined && i.firstSeen === '2026-11-03'));
  assert.equal(inv.counts.newUnreviewed, 24, 'all but the zaafpulse MCP server (ours)');
  const one = buildInventory({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }, {}, done({}), NOW);
  assert.equal(one.counts.newUnreviewed, 1);
  assert.equal(one.items[0].baseline, undefined);
  assert.equal(one.nextSeen.baselineDone, true);
});

test('baseline: a first build with a failed source keeps baselining until a build with every source', () => {
  const partial = buildInventory(
    { ...sources(), gateway: null },
    {},
    { exists: false, baselineDone: false, map: {} },
    NOW,
  );
  assert.deepEqual(partial.failed, ['gateway']);
  assert.ok(partial.items.every((i) => i.baseline === true));
  assert.equal(partial.nextSeen.baselineDone, false, 'not done: a source was missing');
  const full = buildInventory(sources(), {}, { exists: true, ...partial.nextSeen }, NOW + DAY);
  const it = byId(full);
  assert.equal(it['provider:openai'].baseline, true, 'found late, still the baseline');
  assert.equal(it['app:claude'].baseline, true);
  assert.equal(full.counts.newUnreviewed, 0);
  assert.equal(full.nextSeen.baselineDone, true);
  const later = sources();
  later.gateway.knowledge.push({ id: 'kb_2', name: 'Playbooks' });
  const after = buildInventory(later, {}, { exists: true, ...full.nextSeen }, NOW + 3 * DAY);
  assert.equal(byId(after)['knowledge:kb_2'].baseline, undefined);
  assert.equal(after.counts.newUnreviewed, 1);
});

test('ids: control characters are stripped so an id round-trips; names are looked up as own keys only', () => {
  const inv = buildInventory(
    {
      gateway: { keys: [{ id: 'a\nb\u0007c', name: 'k' }], agents: [{ id: 'x' }] },
      live: { apps: [], installed: ['constructor', 'toString'], names: {} },
    },
    { 'key:abc': { risk: 'high' } },
    done({}),
    NOW,
  );
  assert.ok(inv.items.some((i) => i.id === 'key:abc'));
  assert.equal(inv.items.find((i) => i.id === 'key:abc').status, 'reviewed', 'the review finds the cleaned id');
  assert.ok(inv.items.every((i) => /^[a-z]+:[^\u0000-\u001f]+$/.test(i.id)));
  assert.deepEqual(
    inv.items.filter((i) => i.kind === 'app').map((i) => i.name),
    ['constructor', 'toString'],
  );
});

test('seen entries last seen over 400 days ago are dropped', () => {
  const seen = {
    'mcp:old': { first: '2025-01-01', last: '2025-09-28' }, // 400+ days before 2026-11-03
    'mcp:keep': { first: '2025-01-01', last: '2025-10-30' },
  };
  const inv = buildInventory({}, { 'mcp:old': { risk: 'high' } }, done(seen), NOW);
  assert.deepEqual(Object.keys(inv.nextSeen.map), ['mcp:keep']);
  assert.equal(inv.items[0].firstSeen, null, 'a review whose dates were dropped has none');
});

test('a reviewed item whose kind source failed is stale, not gone', () => {
  const seen = {
    'key:key_a1': { first: '2026-10-01', last: '2026-11-02', state: 'used' },
    'mcp:retired': { first: '2026-10-01', last: '2026-11-02', state: 'configured' },
  };
  const reviews = { 'key:key_a1': { owner: 'Ana' }, 'mcp:retired': { owner: 'Ana' } };
  const inv = buildInventory({ gateway: null, mcp: [] }, reviews, done(seen), NOW);
  const it = byId(inv);
  assert.deepEqual(
    [it['key:key_a1'].state, it['key:key_a1'].stale, it['key:key_a1'].status],
    ['used', true, 'reviewed'],
  );
  assert.deepEqual(
    [it['mcp:retired'].state, it['mcp:retired'].stale, it['mcp:retired'].status],
    ['gone', undefined, 'gone'],
  );
  assert.equal(it['key:key_a1'].lastSeen, '2026-11-02', 'not refreshed: it was not seen');
  assert.equal(inv.counts.gone, 1);
});

test('seen store: write never throws; a folder that cannot be made gives failed and the next write tries again', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-seen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'governance'), 'a file where the folder should be');
  const file = path.join(dir, 'governance', 'seen.json');
  const store = createSeenStore({ file });
  const state = { baselineDone: true, map: { 'app:claude': { first: '2026-11-03', last: '2026-11-03' } } };
  assert.equal(store.write(state), 'failed');
  fs.rmSync(path.join(dir, 'governance'));
  assert.equal(store.write(state), true, 'the failed write was not remembered as done');
});

test('baseline: the time of the first write is kept, and 24 h later the baseline ends even if a source keeps failing', () => {
  const down = { ...sources(), gateway: null };
  const first = buildInventory(down, {}, { exists: false, baselineDone: false, map: {} }, NOW);
  assert.deepEqual([first.nextSeen.baselineDone, first.nextSeen.baselineSince], [false, NOW]);
  const soon = buildInventory(down, {}, { exists: true, ...first.nextSeen }, NOW + DAY - 1);
  assert.deepEqual([soon.nextSeen.baselineDone, soon.nextSeen.baselineSince], [false, NOW], 'the first time stays');
  const late = buildInventory(down, {}, { exists: true, ...first.nextSeen }, NOW + DAY);
  assert.equal(late.nextSeen.baselineDone, true);
  assert.equal(late.nextSeen.baselineSince, undefined, 'a finished baseline keeps no start time');
  // The start time survives the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-gov-seen-'));
  try {
    const store = createSeenStore({ file: path.join(dir, 'seen.json') });
    assert.equal(store.write(first.nextSeen), true);
    assert.equal(createSeenStore({ file: path.join(dir, 'seen.json') }).read().baselineSince, NOW);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ids: U+2028 and U+2029 are stripped like other line breaks', () => {
  const inv = buildInventory({ gateway: { keys: [{ id: 'a b c', name: 'k' }] } }, {}, done({}), NOW);
  assert.ok(inv.items.some((i) => i.id === 'key:abc'));
});
