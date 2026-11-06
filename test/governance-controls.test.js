// Governance compliance (AI Governance 3): the control catalogue (lib/governance/controls.js) worked out from fixture
// states, every control in place, partial and off; the clause mapping complete; the wording (framework versions, "not a
// certification", never "compliant"); and GET /api/governance/controls with the audit log's state and the inventory's
// counts added by the router.
const test = require('node:test');
const assert = require('node:assert/strict');
const { controls, CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, STATUSES } = require('../lib/governance/controls');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 864e5;
// A state where every control is in place.
const good = () => ({
  now: NOW,
  guardrails: { scope: 'external', secrets: 'redact', pii: 'redact', injection: 'block' },
  audit: {
    retentionMonths: 12,
    degraded: null,
    lastVerify: { ok: true, checked: 40, from: 1, to: 40, at: '2026-11-03T02:00:00.000Z' },
  },
  usage: { requests: 120, oldest: NOW - 400 * DAY, rotated: true },
  providers: [
    { id: 'openai', tier: 'external', approved: true, recorded: true, enabled: true },
    { id: 'local', tier: 'private', approved: true, recorded: false },
  ],
  keys: [
    { budgetUSD: 20, expiresAt: null, scopes: ['llm'] },
    { budgetUSD: null, expiresAt: NOW + 30 * DAY, scopes: ['llm', 'agents', 'mcp', 'rag'] },
    { revokedAt: NOW - DAY, budgetUSD: null, expiresAt: null, scopes: ['llm'] },
  ],
  workflows: [
    { tier: 'R2', gated: true },
    { tier: 'R0', gated: false },
  ],
  agentControl: { off: null },
  monitors: [
    { id: 'guardrail_block', enabled: true },
    { id: 'audit_chain_broken', enabled: true },
    { id: 'inventory_unreviewed', enabled: true },
    { id: 'cost_burn', enabled: false },
  ],
  evals: { judge: true, evaluators: 3, total: 5, ok: true, model: 'llama3', today: 12, paused: null },
  datasets: { count: 2, experiments: [{ status: 'done', endedAt: NOW - 10 * DAY }] },
  budgets: [{ enforce: 'block' }, { enforce: 'none' }],
  secretStore: { id: 'keychain', label: 'macOS Keychain' },
  signIn: { mode: 'local', serverMode: false, tls: false },
  accounts: { mode: 'local', state: 'ok', users: [] },
  content: { otelCapture: false, traceContentOff: false },
  otel: { enabled: true, error: false, failed: 0, origin: 'https://otel.example.com', protocol: 'http/protobuf' },
  traces: { store: true, enabled: true, retentionDays: 190, maxBytes: 500 * 1048576 },
  inventory: {
    total: 4,
    reviewed: 4,
    high: 1,
    unacceptable: 0,
    riskUndecided: 0,
    unacceptableNotBlocked: 0,
    failed: 0,
    sources: 7,
  },
});
const statusOf = (state) => Object.fromEntries(controls(state).map((c) => [c.id, c.status]));
const one = (state, id) => controls(state).find((c) => c.id === id);

test('the catalogue: eighteen controls in a fixed order, each with a link and at least one clause', () => {
  assert.deepEqual(
    CATALOGUE.map((c) => c.id),
    [
      'guardrails',
      'audit_log',
      'usage_log',
      'provider_approval',
      'api_keys',
      'approval_gates',
      'agent_control',
      'monitors',
      'evals',
      'experiments',
      'cost_budgets',
      'secret_store',
      'sign_in',
      'access_roles',
      'content_capture',
      'otel_export',
      'trace_retention',
      'inventory_coverage',
    ],
  );
  const ids = new Set(CLAUSES.map((c) => c.id));
  assert.equal(ids.size, CLAUSES.length, 'clause ids are unique');
  for (const c of CATALOGUE) {
    assert.ok(c.clauses.length >= 1, c.id);
    for (const id of c.clauses) assert.ok(ids.has(id), `${c.id}: ${id}`);
    assert.match(c.link, /^#[a-z0-9/-]+$/, c.id);
  }
  const used = new Set(CATALOGUE.flatMap((c) => c.clauses));
  assert.deepEqual(
    CLAUSES.filter((c) => !used.has(c.id)).map((c) => c.id),
    [],
    'every clause is shown by a control',
  );
  assert.deepEqual(
    FRAMEWORKS.map((f) => [f.id, CLAUSES.filter((c) => c.framework === f.id).length > 0]),
    [
      ['eu-ai-act', true],
      ['nist-ai-rmf', true],
      ['iso-42001', true],
    ],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'eu-ai-act').map((c) => c.ref),
    ['Art. 12', 'Art. 14', 'Art. 26', 'Art. 26(2)', 'Art. 50'],
  );
  assert.deepEqual(
    CLAUSES.filter((c) => c.framework === 'iso-42001').map((c) => c.ref),
    ['A.2', 'A.3', 'A.4', 'A.5', 'A.6', 'A.7', 'A.8', 'A.9', 'A.10'],
  );
  for (const c of CLAUSES.filter((x) => x.framework === 'nist-ai-rmf'))
    assert.match(c.ref, /^(GOVERN 1|GOVERN 2|MAP 1|MEASURE 2|MANAGE 2|MANAGE 4)\.\d+$/);
});

test('wording: the framework versions, "not a certification", and never "compliant"', () => {
  assert.deepEqual(
    FRAMEWORKS.map((f) => f.version),
    ['Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744', 'NIST AI RMF 1.0', 'ISO/IEC 42001:2023'],
  );
  assert.match(NOTICE, /^Evidence for your assessment, not a certification\./);
  const all = JSON.stringify({ CATALOGUE, CLAUSES, FRAMEWORKS, NOTICE, out: [controls(good()), controls({})] });
  assert.doesNotMatch(all, /complian/i);
  assert.deepEqual(STATUSES, ['in place', 'partial', 'off', 'unknown']);
});

test('every control is in place for a good state, with its evidence', () => {
  const out = controls(good());
  assert.deepEqual(new Set(out.map((c) => c.status)), new Set(['in place']));
  const ev = Object.fromEntries(out.map((c) => [c.id, c.evidence]));
  assert.deepEqual(ev.guardrails, [
    'secrets: redact',
    'personal data: redact',
    'prompt injection: block',
    'scope: external',
  ]);
  assert.deepEqual(ev.audit_log, [
    'kept 12 months (at least 6)',
    'last verify (2026-11-03): chain intact, 40 entries checked',
  ]);
  assert.deepEqual(ev.usage_log, [
    '120 gateway requests recorded this month',
    `oldest entry ${new Date(NOW - 400 * DAY).toISOString().slice(0, 10)}`,
  ]);
  assert.deepEqual(ev.provider_approval, ['1 external provider', '1 approved', '0 waiting for approval']);
  assert.deepEqual(ev.secret_store, ['secrets saved from the dashboard are kept in the macOS Keychain']);
  assert.deepEqual(ev.api_keys, ['2 active keys', '1 with a budget', '1 with an expiry', '1 limited to some scopes']);
  assert.deepEqual(ev.approval_gates, [
    'workflows that send, change or decide: 1 of 1 wait for a person',
    'workflows with an approval step: 1 of 2',
  ]);
  assert.deepEqual(ev.monitors, ['3 of 4 rules on', 'guardrail_block, audit_chain_broken, inventory_unreviewed on']);
  assert.deepEqual(ev.evals, [
    'code evaluators run on every session',
    'judge model: llama3',
    '3 of 5 judge evaluators on',
    '12 judged today',
  ]);
  assert.deepEqual(ev.experiments, ['2 datasets', '1 finished experiment', 'last finished 2026-10-24']);
  assert.deepEqual(ev.otel_export, ['to https://otel.example.com over http/protobuf']);
  assert.deepEqual(ev.trace_retention, ['kept 190 days, up to 500 MB']);
  assert.deepEqual(ev.inventory_coverage, [
    '4 of 4 items reviewed (100%)',
    '1 high risk, 0 unacceptable',
    '0 high or unacceptable without a decision',
    '0 unacceptable not blocked',
  ]);
  const c = one(good(), 'audit_log');
  assert.deepEqual([c.title, c.link], ['Governance audit log', '#governance/audit']);
  assert.deepEqual(
    c.clauses.map((x) => `${x.framework} ${x.ref}`),
    ['eu-ai-act Art. 12', 'eu-ai-act Art. 26', 'nist-ai-rmf GOVERN 1.4', 'nist-ai-rmf MANAGE 4.1', 'iso-42001 A.6'],
  );
});

test('partial: a check, a key, a gate or a rule missing; an old approval; a short retention; part reviewed', () => {
  const s = good();
  s.guardrails.pii = 'off';
  s.audit.lastVerify = null;
  s.providers.push({ id: 'old', tier: 'external', approved: true, recorded: false });
  s.keys.push({ budgetUSD: null, expiresAt: null, scopes: ['llm'] });
  s.workflows.push({ tier: 'R3', gated: false });
  s.monitors[2].enabled = false;
  s.evals.ok = false;
  s.datasets.experiments = [{ status: 'done', endedAt: NOW - 200 * DAY }];
  s.budgets = [{ enforce: 'none' }];
  s.secretStore = { id: 'file', label: 'encrypted secret file' };
  s.otel.failed = 3;
  s.usage = { requests: 5, oldest: NOW - 30 * DAY, rotated: true };
  s.traces.retentionDays = 14;
  s.inventory = { total: 4, reviewed: 3, high: 1, unacceptable: 1, riskUndecided: 1, unacceptableNotBlocked: 1 };
  const st = statusOf(s);
  for (const id of [
    'guardrails',
    'audit_log',
    'usage_log',
    'provider_approval',
    'api_keys',
    'approval_gates',
    'monitors',
    'evals',
    'experiments',
    'cost_budgets',
    'secret_store',
    'otel_export',
    'trace_retention',
    'inventory_coverage',
  ])
    assert.equal(st[id], 'partial', id);
  assert.deepEqual(one(s, 'audit_log').evidence, ['kept 12 months (at least 6)', 'not verified yet']);
  assert.ok(
    one(s, 'provider_approval').evidence.includes(
      '1 served without a recorded approval (set up before approvals existed)',
    ),
  );
  assert.deepEqual(one(s, 'monitors').evidence, ['2 of 4 rules on', 'off: inventory_unreviewed']);
  assert.deepEqual(one(s, 'trace_retention').evidence, ['kept 14 days, up to 500 MB', 'under 183 days (6 months)']);
  assert.equal(one(s, 'evals').evidence[1], 'judge waiting for a model');
  assert.deepEqual(one(s, 'otel_export').evidence, [
    'to https://otel.example.com over http/protobuf',
    '3 spans failed to export since start',
  ]);
});

test('usage log: a young install that never rotated is in place; one that rotated under 183 days is partial', () => {
  const s = good();
  s.usage = { requests: 5, oldest: NOW - 30 * DAY, rotated: false };
  assert.equal(one(s, 'usage_log').status, 'in place');
  s.usage = { requests: 0, oldest: null, rotated: false };
  assert.deepEqual(one(s, 'usage_log').evidence, ['0 gateway requests recorded this month', 'no entry yet']);
});

test('guardrails: thresholds, and a key that weakens a check', () => {
  const at = (g) => {
    const s = good();
    s.guardrails = { scope: 'external', ...g };
    return one(s, 'guardrails').status;
  };
  assert.equal(at({ secrets: 'block', pii: 'block', injection: 'block' }), 'in place');
  assert.equal(at({ secrets: 'redact', pii: 'redact', injection: 'log' }), 'partial');
  assert.equal(at({ secrets: 'redact', pii: 'off', injection: 'log' }), 'partial', 'the default config');
  assert.equal(at({ secrets: 'log', pii: 'block', injection: 'block' }), 'off');
  assert.equal(at({ secrets: 'off', pii: 'block', injection: 'block' }), 'off');
  const s = good();
  s.keys.push({ budgetUSD: null, expiresAt: null, scopes: ['llm'], guardrails: { pii: 'log', injection: 'block' } });
  s.keys.push({ revokedAt: NOW - DAY, scopes: ['llm'], guardrails: { secrets: 'off' } });
  s.keys.push({ budgetUSD: null, expiresAt: null, scopes: ['llm'], guardrails: { secrets: 'block' } });
  const g = one(s, 'guardrails');
  assert.equal(g.status, 'partial');
  assert.equal(g.evidence.at(-1), '1 key weakens a check');
  // Keys that cannot be read may hold a weaker check: in place is capped at partial, and the evidence says why.
  for (const keys of ['x', null, undefined]) {
    s.keys = keys;
    const k = one(s, 'guardrails');
    assert.deepEqual([k.status, k.evidence.at(-1)], ['partial', 'keys could not be read'], String(keys));
  }
  s.guardrails = { scope: 'external', secrets: 'off', pii: 'off', injection: 'off' };
  assert.equal(one(s, 'guardrails').status, 'off', 'a cap never raises a status');
});

test('otel: failures by count, a settings error is unknown', () => {
  const s = good();
  s.otel = { enabled: false, error: true };
  assert.deepEqual(
    [one(s, 'otel_export').status, one(s, 'otel_export').evidence],
    ['unknown', ['the OpenTelemetry settings could not be used']],
  );
  s.otel = { enabled: true, error: false, failed: 1, origin: 'https://o.example.com', protocol: 'grpc' };
  assert.equal(one(s, 'otel_export').evidence[1], '1 span failed to export since start');
});

test('inventory coverage: sources that failed to read', () => {
  const s = good();
  s.inventory = { ...s.inventory, failed: 2, sources: 7 };
  const c = one(s, 'inventory_coverage');
  assert.equal(c.status, 'partial');
  assert.equal(c.evidence.at(-1), '2 inventory sources could not be read');
  s.inventory = { ...s.inventory, failed: 7, sources: 7 };
  assert.deepEqual(
    [one(s, 'inventory_coverage').status, one(s, 'inventory_coverage').evidence[0]],
    ['unknown', 'could not be read'],
  );
});

test('inventory coverage: AI client files that could not be read cap it at partial', () => {
  const s = good();
  s.inventory = { ...s.inventory, unreadableClients: 1 };
  const c = one(s, 'inventory_coverage');
  assert.deepEqual([c.status, c.evidence.at(-1)], ['partial', '1 AI client file could not be read']);
  s.inventory = { ...s.inventory, failed: 1, unreadableClients: 2 };
  assert.deepEqual(one(s, 'inventory_coverage').evidence.slice(-2), [
    '1 inventory source could not be read',
    '2 AI client files could not be read',
  ]);
  s.inventory = { ...s.inventory, reviewed: 0, failed: 0 };
  assert.equal(one(s, 'inventory_coverage').status, 'off', 'a cap never raises a status');
});

test('budgets: pause budgets count for nothing when agent control cannot be read', () => {
  const s = good();
  s.budgets = [{ enforce: 'pause' }];
  for (const agentControl of [null, undefined, 'x']) {
    s.agentControl = agentControl;
    const b = one(s, 'cost_budgets');
    assert.deepEqual(
      [b.status, b.evidence.at(-1)],
      ['partial', 'pause budgets are not counted: agent control could not be read'],
      String(agentControl),
    );
  }
  s.budgets = [{ enforce: 'pause' }, { enforce: 'block' }];
  assert.equal(one(s, 'cost_budgets').status, 'in place', 'a block budget still counts');
});

test('other checks: pause budgets need agent control; a paused judge; disabled providers; wrong-shape parts', () => {
  const s = good();
  s.budgets = [{ enforce: 'pause' }];
  assert.equal(one(s, 'cost_budgets').status, 'in place');
  s.agentControl = { off: 'agent control is off on this server' };
  const b = one(s, 'cost_budgets');
  assert.equal(b.status, 'partial');
  assert.ok(b.evidence.includes('pause budgets do nothing while agent control is off'));
  s.budgets = [{ enforce: 'block' }, { enforce: 'pause' }];
  assert.equal(one(s, 'cost_budgets').status, 'in place');
  const e = good();
  e.evals.paused = 'daily cap';
  assert.equal(one(e, 'evals').status, 'partial');
  assert.equal(one(e, 'evals').evidence[1], 'judge paused: daily cap');
  const p = good();
  p.providers.push({ id: 'off', tier: 'external', approved: false, recorded: true, enabled: false });
  assert.deepEqual(one(p, 'provider_approval').evidence.slice(0, 3), [
    '1 external provider',
    '1 approved',
    '0 waiting for approval',
  ]);
  // Entries that are not keys are skipped, and fields of the wrong shape count for nothing: one active key without a
  // budget, an expiry or a scope list.
  const t = good();
  t.keys = [null, { scopes: 5, guardrails: 5 }];
  assert.deepEqual(
    [one(t, 'api_keys').status, one(t, 'api_keys').evidence],
    ['off', ['1 active key', '0 with a budget', '0 with an expiry', '0 limited to some scopes']],
  );
  assert.equal(one(t, 'guardrails').status, 'in place', 'a key whose guardrails are not an object weakens nothing');
  // A part whose check throws is unknown.
  const bad = good();
  Object.defineProperty(bad, 'workflows', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(one(bad, 'approval_gates').status, 'unknown');
});

test('off: everything switched off, degraded or broken; unknown: a part that cannot be read', () => {
  const s = good();
  s.guardrails = { scope: 'all', secrets: 'off', pii: 'off', injection: 'off' };
  s.audit.degraded = { since: '2026-11-03T10:00:00.000Z', missed: 2 };
  s.keys = [{ budgetUSD: null, expiresAt: null, scopes: ['llm'] }];
  s.workflows = [{ tier: 'R2', gated: false }];
  s.agentControl = { off: 'agent control is off on this server' };
  s.monitors = s.monitors.map((r) => ({ ...r, enabled: false }));
  s.datasets = { count: 0, experiments: [] };
  s.budgets = [];
  s.signIn = { mode: 'none', serverMode: false, tls: false };
  s.accounts = { mode: 'none', state: 'ok', users: [] };
  s.content = { otelCapture: true, traceContentOff: true };
  s.otel = { enabled: false };
  s.traces = { store: true, enabled: false, retentionDays: 14, maxBytes: 1 };
  s.inventory = { total: 3, reviewed: 0 };
  s.usage = null;
  const st = statusOf(s);
  assert.equal(st.usage_log, 'unknown');
  for (const id of CATALOGUE.map((c) => c.id).filter(
    (x) => !['provider_approval', 'evals', 'secret_store', 'usage_log'].includes(x),
  ))
    assert.equal(st[id], 'off', id);
  assert.deepEqual(one(s, 'audit_log').evidence, [
    'kept 12 months (at least 6)',
    'degraded since 2026-11-03T10:00:00.000Z: 2 entries not written',
  ]);
  assert.deepEqual(one(s, 'usage_log').evidence, ['could not be read']);
  assert.deepEqual(one(s, 'agent_control').evidence, ['agent control is off on this server']);
  assert.deepEqual(one(s, 'sign_in').evidence, ['sign-in: no sign-in', 'this machine only']);
  s.audit = { retentionMonths: 12, degraded: null, lastVerify: { ok: false, reason: 'key missing' } };
  assert.equal(one(s, 'audit_log').evidence[1], 'last verify: the audit key is missing');
  s.audit = { retentionMonths: 12, degraded: null, lastVerify: { ok: false, brokenAt: 9, reason: 'chain broken' } };
  assert.deepEqual(one(s, 'audit_log').evidence[1], 'last verify: broken at entry 9 (chain broken)');
  // A state that is not there at all, or a part of the wrong shape, never throws.
  assert.ok(controls(undefined).every((c) => c.status === 'unknown' && c.evidence[0] === 'could not be read'));
  assert.equal(one({ guardrails: 'x' }, 'guardrails').status, 'unknown');
});

test('GET /api/governance/controls: the controls with the audit state and the inventory counts', async () => {
  const st = good();
  const api = createGovernanceApi({
    audit: { status: () => ({ degraded: null, lastVerify: st.audit.lastVerify }) },
    settings: { get: () => ({ audit: { retentionMonths: 24 } }), save: () => {} },
    sources: async () => ({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }),
    controlState: async () => {
      const { audit, inventory, now, ...rest } = st;
      return rest;
    },
    now: () => NOW,
  });
  const r = await api.route({ method: 'GET', path: '/api/governance/controls', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['generatedAt', 'notice', 'frameworks', 'clauses', 'controls']);
  assert.equal(r.body.controls.length, 18);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  assert.equal(by.audit_log.evidence[0], 'kept 24 months (at least 6)');
  assert.deepEqual(
    [by.inventory_coverage.status, by.inventory_coverage.evidence[0]],
    ['off', '0 of 1 item reviewed (0%)'],
  );
  assert.equal((await api.route({ method: 'POST', path: '/api/governance/controls' })).status, 405);
});

test('GET /api/governance/controls: a rejecting server part or inventory only makes its controls unknown', async () => {
  const st = good();
  const mk = (extra) =>
    createGovernanceApi({
      audit: { status: () => ({ degraded: null, lastVerify: st.audit.lastVerify }) },
      settings: { get: () => ({}), save: () => {} },
      sources: async () => {
        throw new Error('/secret/path failed');
      },
      controlState: async () => {
        throw new Error('/secret/path failed');
      },
      now: () => NOW,
      ...extra,
    });
  const r = await mk({}).route({ method: 'GET', path: '/api/governance/controls', query: new URLSearchParams() });
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.controls.map((c) => [c.id, c]));
  assert.equal(by.guardrails.status, 'unknown');
  assert.equal(by.inventory_coverage.status, 'unknown');
  assert.notEqual(by.audit_log.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(r.body), /secret\/path/);
});

test('usage.oldest: the first entry kept and whether the log rotated', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createUsage } = require('../lib/gateway/usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-usage-'));
  try {
    const file = path.join(dir, 'u.jsonl');
    const mk = () => createUsage({ file, getPricing: () => ({}), now: () => NOW });
    assert.deepEqual(mk().oldest(), { ts: null, rotated: false });
    fs.writeFileSync(file, JSON.stringify({ ts: NOW - 5 * DAY }) + '\n');
    assert.deepEqual(mk().oldest(), { ts: NOW - 5 * DAY, rotated: false });
    fs.writeFileSync(`${file}.1`, JSON.stringify({ ts: NOW - 9 * DAY }) + '\n');
    assert.deepEqual(mk().oldest(), { ts: NOW - 9 * DAY, rotated: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage.oldest: read when asked, so two rotations in one run move it to the first entry of the rotated file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createUsage } = require('../lib/gateway/usage');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-usage-'));
  try {
    const file = path.join(dir, 'u.jsonl');
    let t = NOW - 30 * DAY;
    // A tiny size cap, so every append after the first rotates the log (lib/gateway/store.js jsonlLog).
    const u = createUsage({ file, getPricing: () => ({}), now: () => t, maxBytes: 10 });
    const first = u.record({ model: 'm' }).ts;
    assert.deepEqual(u.oldest(), { ts: first, rotated: false });
    t += DAY;
    u.record({ model: 'm' });
    assert.deepEqual(u.oldest(), { ts: first, rotated: true }, 'one rotation: the first entry is in the .1 file');
    t += DAY;
    const third = u.record({ model: 'm' }).ts;
    t += DAY;
    u.record({ model: 'm' });
    assert.deepEqual(u.oldest(), { ts: third, rotated: true }, 'the entries before the last rotation are gone');
    // Only the start of the file is read: a long file costs no more.
    fs.appendFileSync(`${file}.1`, `${'x'.repeat(1 << 20)}\n`);
    assert.equal(u.oldest().ts, third);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
