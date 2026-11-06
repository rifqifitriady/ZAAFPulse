// Dashboard users (AI Governance 4): the role policy (lib/users/policy.js), pure. A table of every route class: what a
// viewer may read, what is never shown to anyone but the owner (content, secrets, previews), the writes, a reviewer's
// extra routes, the password route and the mustChange gate; every route a viewer may read exists; and the redacted
// gateway view keeps no system prompt, note text, session title, run task, key secret or secret reference.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  allowed,
  redactGateway,
  redactTraceSessions,
  redactSummary,
  redactLogs,
  VIEWER_READS,
  REVIEWER_EXTRA,
  GATEWAY_PARTS,
} = require('../lib/users/policy');

const ROOT = path.join(__dirname, '..');
const may = (role, method, p, action, mustChange = false) => allowed({ role, method, path: p, action, mustChange });

test('a viewer reads the metadata routes, a reviewer too; the list is exactly these', () => {
  assert.deepEqual(VIEWER_READS, [
    '/api/platform',
    '/api/summary',
    '/api/live',
    '/api/insights',
    '/api/topology',
    '/api/timeline',
    '/api/office',
    '/api/logs',
    '/api/mcp-calls',
    '/api/router',
    '/api/openrouter',
    '/api/openrouter/endpoints',
    '/api/config',
    '/api/prices',
    '/api/trace/sources',
    '/api/trace/settings',
    '/api/trace/sessions',
    '/api/trace/deps',
    '/api/trace/find',
    '/api/evals/summary',
    '/api/evals/status',
    '/api/evals/evaluators',
    '/api/evals/settings',
    '/api/datasets',
    '/api/datasets/settings',
    '/api/experiments',
    '/api/monitors',
    '/api/monitors/status',
    '/api/alerts',
    '/api/agents/candidates',
    '/api/runtimes',
    '/api/runtimes/config',
    '/api/cost/ledger',
    '/api/cost/export',
    '/api/cost/status',
    '/api/cost/settings',
    '/api/cost/restates',
    '/api/cost/prices/versions',
    '/api/cost/view',
    '/api/cost/report',
    '/api/cost/budgets',
    '/api/governance/audit',
    '/api/governance/audit/export',
    '/api/governance/audit/verify',
    '/api/governance/audit/status',
    '/api/governance/inventory',
    '/api/governance/controls',
    '/api/governance/evidence',
    '/api/integrations',
    '/api/gateway',
    '/api/gateway/logs',
  ]);
  for (const p of VIEWER_READS)
    for (const role of ['viewer', 'reviewer']) {
      assert.deepEqual(may(role, 'GET', p), { ok: true, reason: null }, `${role} GET ${p}`);
      // The same path written to is a change: refused (but a reviewer's inventory review, below).
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        if (!(role === 'reviewer' && `${m} ${p}` === 'POST /api/governance/inventory'))
          assert.equal(may(role, m, p).ok, false, `${role} ${m} ${p}`);
    }
});

test('every route a viewer may read is a route the server answers', () => {
  const src = [
    'server.js',
    'lib/evals/api.js',
    'lib/datasets/api.js',
    'lib/monitors/api.js',
    'lib/runtimes/api.js',
    'lib/cost/api.js',
    'lib/governance/api.js',
  ]
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  // Routes built from a word: the trace routes, the request log and the datasets' settings.
  const word = {
    '/api/trace/': (w) =>
      src.includes(`'sources', 'settings', 'sessions', 'session', 'title', 'content', 'reveal'`) &&
      src.includes(`'${w}'`),
    '/api/gateway/': (w) => src.includes(`gwAdmin[1] === '${w}'`),
    '/api/datasets/': (w) => src.includes(`a === '${w}'`),
  };
  for (const p of VIEWER_READS) {
    const prefix = Object.keys(word).find((x) => p.startsWith(x));
    assert.ok(prefix ? word[prefix](p.slice(prefix.length)) : src.includes(`'${p}'`), p);
  }
});

test('never for a non-owner: content, secrets and previews; every write; the owner is never refused', () => {
  const ownerOnly = [
    ['GET', '/api/trace/session'],
    ['GET', '/api/trace/title'],
    ['GET', '/api/trace/content'],
    ['GET', '/api/trace/live'],
    ['POST', '/api/trace/reveal'],
    ['GET', '/api/evals'],
    ['GET', '/api/feedback'],
    ['GET', '/api/feedback/sessions'],
    ['POST', '/api/feedback'],
    ['POST', '/api/evals/preview'],
    ['POST', '/api/evals/run'],
    ['POST', '/api/evals/settings'],
    ['GET', '/api/datasets/ds_1'],
    ['GET', '/api/datasets/ds_1/export'],
    ['POST', '/api/datasets'],
    ['POST', '/api/datasets/import'],
    ['PUT', '/api/datasets/ds_1'],
    ['DELETE', '/api/datasets/ds_1'],
    ['GET', '/api/experiments/exp_1'],
    ['POST', '/api/experiments'],
    ['GET', '/api/brain'],
    ['GET', '/api/brain/graph'],
    ['POST', '/api/brain/sources', 'test'],
    ['GET', '/api/vault'],
    ['GET', '/api/integrations/config'],
    ['POST', '/api/integrations/test'],
    ['POST', '/api/integrations/test-draft'],
    ['POST', '/api/integrations/save'],
    ['POST', '/api/integrations/delete'],
    ['POST', '/api/gateway/knowledge', 'get'],
    ['POST', '/api/gateway/knowledge', 'search'],
    ['POST', '/api/gateway/sessions', 'get'],
    ['POST', '/api/gateway/quota'],
    ['POST', '/api/gateway/providers', 'test'],
    ['POST', '/api/gateway/providers', 'models'],
    ['POST', '/api/gateway/logs'],
    ['POST', '/api/gateway/keys', 'create'],
    ['POST', '/api/gateway/settings'],
    ['POST', '/api/gateway/playground'],
    ['POST', '/api/gateway/collab', 'start'],
    ['POST', '/api/gateway/collab', 'cancel'],
    ['POST', '/api/cost/settings/preview'],
    ['POST', '/api/cost/restate/preview'],
    ['POST', '/api/cost/budgets'],
    ['POST', '/api/config'],
    ['POST', '/api/prices', 'refresh'],
    ['POST', '/api/governance/settings'],
    ['POST', '/api/monitors/tool_loop'],
    ['POST', '/api/monitors/channels'],
    ['POST', '/api/agents/pause'],
    ['POST', '/api/runtimes/start'],
    ['POST', '/api/rescan'],
    ['POST', '/api/mcp/register'],
    ['GET', '/api/users'],
    ['POST', '/api/users', 'create'],
    ['GET', '/api/something-new'],
  ];
  for (const [m, p, action] of ownerOnly) {
    for (const role of ['viewer', 'reviewer'])
      assert.deepEqual(may(role, m, p, action), { ok: false, reason: 'your role cannot do this' }, `${role} ${m} ${p}`);
    assert.equal(may('owner', m, p, action).ok, true);
  }
  // A role that is not one of the three, or none, gets nothing from /api; the page itself is not /api.
  for (const role of [undefined, null, 'admin', 'OWNER'])
    assert.deepEqual(may(role, 'GET', '/api/summary'), { ok: false, reason: 'your role cannot do this' });
  assert.equal(may('viewer', 'GET', '/index.html').ok, true);
  assert.equal(may('viewer', 'GET', '/api').ok, true, '"/api" alone is a file path, not an /api route');
});

test("a reviewer's extras: inventory reviews and run approvals (get, list, resume); a viewer has none of them", () => {
  assert.deepEqual(REVIEWER_EXTRA, [
    'POST /api/governance/inventory',
    'GET /api/users/names',
    'POST /api/gateway/collab get',
    'POST /api/gateway/collab list',
    'POST /api/gateway/collab resume',
  ]);
  const extras = [
    ['POST', '/api/governance/inventory'],
    ['GET', '/api/users/names'],
    ['POST', '/api/gateway/collab', 'get'],
    ['POST', '/api/gateway/collab', 'list'],
    ['POST', '/api/gateway/collab', 'resume'],
  ];
  for (const [m, p, action] of extras) {
    assert.equal(may('reviewer', m, p, action).ok, true, `reviewer ${m} ${p} ${action || ''}`);
    assert.equal(may('viewer', m, p, action).ok, false, `viewer ${m} ${p} ${action || ''}`);
  }
  // The action must be the word itself: no other route, no other spelling.
  for (const action of [undefined, null, 'Resume', 'resume ', ['resume'], 'resume\nx'])
    assert.equal(may('reviewer', 'POST', '/api/gateway/collab', action).ok, false, JSON.stringify(action));
  assert.equal(may('reviewer', 'POST', '/api/gateway/keys', 'get').ok, false);
  assert.equal(may('reviewer', 'GET', '/api/gateway/collab', 'get').ok, false);
});

test('the password route is for anyone signed in; until then every other route says "change your password first"', () => {
  for (const role of ['owner', 'reviewer', 'viewer']) {
    assert.equal(may(role, 'POST', '/api/account/password').ok, true);
    assert.equal(may(role, 'POST', '/api/account/password', null, true).ok, true);
    assert.equal(may(role, 'GET', '/api/account/password').ok, role === 'owner');
  }
  for (const role of ['reviewer', 'viewer']) {
    assert.deepEqual(may(role, 'GET', '/api/summary', null, true), { ok: false, reason: 'change your password first' });
    assert.deepEqual(may(role, 'POST', '/api/gateway/collab', 'get', true).reason, 'change your password first');
  }
  assert.equal(may('nobody', 'POST', '/api/account/password').ok, false);
});

test('the gateway view for a non-owner: no prompt, note text, title, task, key secret, secret reference or quota', () => {
  const g = {
    presets: { openai: {} },
    providers: [
      {
        id: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: { keychain: 'SECRET-REF-1' },
        auth: { type: 'oauth2', clientId: 'SECRET-CLIENT-2', tokenUrl: 'https://t' },
      },
      { id: 'local', apiKey: null },
    ],
    keys: [
      {
        id: 'key_1',
        name: 'ci',
        prefix: 'zp_ab…',
        scopes: ['llm'],
        budgetUSD: 5,
        createdAt: 1,
        expiresAt: null,
        lastUsedAt: 2,
        revokedAt: null,
        models: ['SECRET-MODEL-LIST-3'],
        guardrails: { secrets: 'off' },
        secret: 'zp_SECRET4',
      },
    ],
    agents: [{ id: 'sre', name: 'SRE', systemPrompt: 'SECRET-PROMPT-5' }],
    sessions: [{ id: 'ses_1', title: 'SECRET-TITLE-6', messages: 2 }],
    memory: [{ id: 'mem_1', text: 'SECRET-NOTE-7', scope: 'global' }],
    runs: [
      { id: 'run_1', title: 'SECRET-TASK-8', error: 'SECRET-ERROR-9', pending: { step: 2, question: 'SECRET-Q-10' } },
      { id: 'run_2', title: 'x', pending: null, state: 'done' },
    ],
    quota: [{ id: 'openai', token: 'SECRET-QUOTA-11' }],
    usage: { month: '2026-11' },
    somethingNew: 'SECRET-NEW-12',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactGateway(g, role);
    assert.ok(!/SECRET/.test(JSON.stringify(r)), JSON.stringify(r));
    assert.deepEqual(r.providers, [
      { id: 'openai', baseUrl: 'https://api.openai.com/v1', auth: { type: 'oauth2' } },
      { id: 'local', auth: { type: 'key' } },
    ]);
    assert.deepEqual(Object.keys(r.keys[0]), [
      'id',
      'name',
      'prefix',
      'scopes',
      'budgetUSD',
      'createdAt',
      'expiresAt',
      'lastUsedAt',
      'revokedAt',
    ]);
    assert.deepEqual(r.agents, [{ id: 'sre', name: 'SRE' }]);
    assert.deepEqual(r.sessions, [{ id: 'ses_1', messages: 2 }]);
    assert.deepEqual(r.memory, [{ id: 'mem_1', scope: 'global' }]);
    assert.deepEqual(r.runs, [
      { id: 'run_1', pending: { step: 2 } },
      { id: 'run_2', state: 'done', pending: null },
    ]);
    assert.deepEqual(r.quota, []);
    assert.deepEqual(r.usage, { month: '2026-11' });
    assert.ok(Object.keys(r).every((k) => GATEWAY_PARTS.includes(k)));
  }
  assert.equal(redactGateway(g, 'owner'), g, 'the owner sees it all');
  assert.equal(redactGateway(null, 'viewer'), null);
});

test('the trace session list for a non-owner: no title (the first prompt)', () => {
  const body = {
    sessions: [
      { key: 'claude.ab', title: 'SECRET-PROMPT-1', tokens: 9 },
      { key: 'codex.cd', title: null },
    ],
  };
  for (const role of ['viewer', 'reviewer'])
    assert.deepEqual(redactTraceSessions(body, role), {
      sessions: [{ key: 'claude.ab', tokens: 9 }, { key: 'codex.cd' }],
    });
  assert.equal(redactTraceSessions(body, 'owner'), body);
  assert.equal(redactTraceSessions(null, 'viewer'), null);
});

test("/api/openrouter?section=account is the owner's; the other sections are viewer reads", () => {
  const sec = (role, section) => allowed({ role, method: 'GET', path: '/api/openrouter', section });
  for (const role of ['viewer', 'reviewer']) {
    assert.equal(sec(role, undefined).ok, true);
    assert.equal(sec(role, 'usage').ok, true);
    for (const s of ['account', 'Account', ' account ', ['account'], { a: 1 }, 5])
      assert.deepEqual(sec(role, s), { ok: false, reason: 'your role cannot do this' }, JSON.stringify(s));
    // Other routes ignore the section.
    assert.equal(allowed({ role, method: 'GET', path: '/api/summary', section: 'account' }).ok, true);
  }
  assert.equal(sec('owner', 'account').ok, true);
});

const SECRETS = /SECRET|\/Users\/|\/home\//;

test('the summary for a non-owner: counts, costs and names stay; no quality text, no path, no branch', () => {
  const ev = (o) => ({ ts: 5, sid: 'SECRET-SID', project: 'SECRET-PROJ', text: 'SECRET-TEXT /Users/me/x', ...o });
  const row = {
    id: 's1',
    tool: 'claude',
    project: 'app',
    projectPath: '/Users/me/app',
    branch: 'SECRET-BRANCH',
    entrypoint: 'cli',
    start: 1,
    end: 2,
    prompts: 3,
    calls: 4,
    subCalls: 0,
    tokens: 100,
    output: 10,
    cost: 1.5,
    model: 'claude-sonnet-5',
    models: ['claude-sonnet-5'],
    subagents: 0,
  };
  const s = {
    generatedAt: 1,
    range: { days: 30 },
    kpis: { cost: 9, tokens: 5 },
    month: { daily: [] },
    entrypoints: [{ name: 'cli', count: 1 }],
    topCostSessions: [row],
    daily: [],
    heatmap: [],
    tools: [{ id: 'claude', name: 'Claude Code', cost: 1 }],
    models: [{ model: 'claude-sonnet-5', tokens: 100 }],
    projects: [
      {
        path: '/Users/me/app',
        name: 'app',
        sessions: 1,
        calls: 4,
        tokens: 100,
        output: 10,
        cost: 1.5,
        tools: { claude: 1 },
        last: 2,
      },
    ],
    sessions: [row],
    totalSessions: 1,
    toolUse: [{ name: 'Bash', count: 3 }],
    skills: [],
    subagents: [],
    unpriced: [],
    estimated: [],
    quality: {
      accuracy: 0.9,
      calls: 4,
      tools: [{ tool: 'Bash', calls: 9 }],
      events: {
        correction: [ev({ kind: 'correction', label: 'Correction prompt' })],
        risky: [ev({ kind: 'risky', label: 'rm -rf rule', source: 'Bash', tool: 'claude' })],
        error: [ev({ kind: 'error', category: 'model', label: 'bad args', source: 'Bash' })],
      },
      feed: [ev({ kind: 'error', category: 'hallucination', label: 'x' })],
    },
    codexLimits: null,
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactSummary(s, role);
    assert.ok(!SECRETS.test(JSON.stringify(r)), JSON.stringify(r));
    assert.equal(r.kpis.cost, 9);
    assert.equal(r.quality.accuracy, 0.9);
    assert.deepEqual(r.quality.events.risky, [
      { ts: 5, kind: 'risky', label: 'rm -rf rule', source: 'Bash', tool: 'claude' },
    ]);
    assert.equal(r.quality.feed.length, 1);
    assert.deepEqual(r.projects, [
      { name: 'app', sessions: 1, calls: 4, tokens: 100, output: 10, cost: 1.5, tools: { claude: 1 }, last: 2 },
    ]);
    assert.equal(r.sessions[0].project, 'app');
    assert.equal(r.sessions[0].model, 'claude-sonnet-5');
    assert.equal(r.tools[0].name, 'Claude Code');
    assert.ok(!('somethingNew' in r));
  }
  assert.equal(redactSummary(s, 'owner'), s);
  assert.equal(redactSummary(null, 'viewer'), null);
});

test('the request log for a non-owner: types, sizes, counts and times; no error text, no tool target', () => {
  const l = {
    ts: 9,
    windowMs: 1000,
    requests: [
      {
        id: 'a:1',
        ts: 1,
        source: 'claude',
        agentId: 'a',
        kind: 'cli',
        model: 'claude-sonnet-5',
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        ttftMs: 100,
        durationMs: 900,
        stop: 'end_turn',
        status: 'tool error',
        agent: 'app',
        toolErrors: 1,
        inputs: [
          { type: 'tool_result', tool: 'Bash', ok: false, size: 40, text: 'SECRET-OUT' },
          { type: 'prompt', size: 12 },
        ],
        blocks: [
          { ts: 1, type: 'tool_use', id: 't1', tool: 'Bash', target: 'cat /Users/me/SECRET-FILE', zone: 'shell' },
          { ts: 1, type: 'text', size: 80 },
        ],
      },
    ],
    errors: [
      {
        ts: 2,
        kind: 'tool',
        agent: 'app',
        source: 'Bash',
        label: 'Exit code',
        category: 'environment',
        text: 'SECRET-ERR /home/x',
      },
      {
        ts: 3,
        kind: 'interrupt',
        agent: 'app',
        source: 'You',
        label: 'Interrupted',
        text: 'You stopped the model mid-turn',
      },
    ],
    somethingNew: 'SECRET-NEW',
  };
  for (const role of ['viewer', 'reviewer']) {
    const r = redactLogs(l, role);
    assert.ok(!SECRETS.test(JSON.stringify(r)), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('stopped the model'));
    assert.equal(r.requests[0].model, 'claude-sonnet-5');
    assert.equal(r.requests[0].status, 'tool error');
    assert.deepEqual(r.requests[0].inputs, [
      { type: 'tool_result', tool: 'Bash', ok: false, size: 40 },
      { type: 'prompt', size: 12 },
    ]);
    assert.deepEqual(r.requests[0].blocks, [
      { ts: 1, type: 'tool_use', id: 't1', tool: 'Bash', zone: 'shell' },
      { ts: 1, type: 'text', size: 80 },
    ]);
    assert.deepEqual(r.errors[0], {
      ts: 2,
      kind: 'tool',
      agent: 'app',
      source: 'Bash',
      label: 'Exit code',
      category: 'environment',
    });
    assert.equal(r.ts, 9);
  }
  assert.equal(redactLogs(l, 'owner'), l);
  assert.equal(redactLogs(null, 'viewer'), null);
});
