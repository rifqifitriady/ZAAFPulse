// Governance compliance (AI Governance 3): the evidence export (lib/governance/evidence.js and GET
// /api/governance/evidence). The report holds the inventory with its reviews, the controls with evidence and clauses,
// the audit log's verify and retention, the time and the version; it holds no path and no secret; the Markdown is
// readable and an owner's text cannot break its tables; the export is recorded as governance.export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceReport, toJson, toMarkdown } = require('../lib/governance/evidence');
const { controls } = require('../lib/governance/controls');
const { createGovernanceApi } = require('../lib/governance/api');

const NOW = Date.UTC(2026, 10, 3, 12);
const inventory = {
  generatedAt: '2026-11-03T12:00:00.000Z',
  counts: { total: 2, reviewed: 1, unreviewed: 1, gone: 0 },
  failed: ['trace'],
  clients: [{ client: 'claude', name: 'Claude Code', file: '~/.claude.json', state: 'ok', servers: 1 }],
  items: [
    {
      id: 'mcp:db',
      kind: 'mcp',
      name: 'db',
      vendor: null,
      where: ['Claude Code config'],
      state: 'configured',
      firstSeen: '2026-11-01',
      lastSeen: '2026-11-03',
      status: 'reviewed',
      review: {
        owner: 'Ana | Ops',
        purpose: 'orders\n<script>x</script>',
        risk: 'high',
        decision: 'restricted',
        note: '',
      },
      transport: 'stdio',
      command: 'uvx',
      package: 'pg-mcp',
      origin: null,
      clients: ['Claude Code'],
      projects: ['~/code/secret-client-project'],
    },
    { id: 'app:claude', kind: 'app', name: 'Claude Code', vendor: 'Anthropic', where: ['running'], state: 'running' },
  ],
};
const audit = {
  retentionMonths: 12,
  degraded: null,
  lastVerify: { ok: true, checked: 4, from: 1, to: 4, at: '2026-11-03T02:00:00.000Z' },
};
const report = () =>
  evidenceReport({
    inventory,
    controls: { controls: controls({ now: NOW, audit, inventory: inventory.counts }) },
    audit,
    version: '1.0.4',
    generatedAt: '2026-11-03T12:00:00.000Z',
  });

test('the report: what it holds, and no project folder or client file', () => {
  const r = report();
  assert.deepEqual(Object.keys(r), [
    'title',
    'notice',
    'generatedAt',
    'version',
    'frameworks',
    'controls',
    'audit',
    'inventory',
  ]);
  assert.deepEqual([r.version, r.generatedAt, r.controls.length], ['1.0.4', '2026-11-03T12:00:00.000Z', 17]);
  assert.deepEqual(r.audit, audit);
  assert.deepEqual(r.inventory.failed, ['trace']);
  assert.equal(r.inventory.items[0].review.risk, 'high');
  assert.deepEqual(r.controls[1].clauses[0], { framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' });
  const text = toJson(r);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), r);
  for (const s of ['secret-client-project', '~/.claude.json', 'projects', '"file"'])
    assert.ok(!text.includes(s), `${s} must not be exported`);
});

test('Markdown: notice, controls, each framework, audit log and inventory; owner text cannot break out', () => {
  const md = toMarkdown(report());
  const lines = md.split('\n');
  const has = (line) => assert.ok(lines.includes(line), line);
  assert.deepEqual(lines.slice(0, 7), [
    '# ZAAFPulse governance evidence',
    '',
    'Generated 2026-11-03T12:00:00.000Z by ZAAFPulse 1.0.4.',
    '',
    '> Evidence for your assessment, not a certification. Statuses follow the current settings and state.',
    '',
    'Frameworks: EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744); ' +
      'NIST AI RMF (NIST AI RMF 1.0); ISO/IEC 42001 (ISO/IEC 42001:2023).',
  ]);
  has('| Control | Status | Evidence | Clauses | Page |');
  has(
    '| Governance audit log | in place | kept 12 months (at least 6); last verify (2026-11-03): chain intact, ' +
      '4 entries checked | Art. 12, Art. 26, GOVERN 1.4, MANAGE 4.1, A.6 | #governance/audit |',
  );
  has('## EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744)');
  has('## NIST AI RMF (NIST AI RMF 1.0)');
  has('## ISO/IEC 42001 (ISO/IEC 42001:2023)');
  has('| Art. 14 Human oversight | Human approval in workflows | unknown |');
  // A framework's clauses come in their own order.
  const eu = lines.slice(
    lines.indexOf('## EU AI Act (Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744)'),
  );
  assert.deepEqual(
    eu.slice(4, 7).map((l) => l.split(' | ')[0]),
    ['| Art. 12 Record-keeping', '| Art. 12 Record-keeping', '| Art. 12 Record-keeping'],
  );
  has('- Last verify: chain intact, entries 1–4 checked (2026-11-03T02:00:00.000Z)');
  has('2 items: 1 reviewed, 1 unreviewed, 0 reviews of items no longer seen.');
  has('Sources that could not be read: trace.');
  has(
    '| db (mcp:db) | mcp | — | Claude Code config | configured | 2026-11-01 | 2026-11-03 | Ana \\| Ops | ' +
      'orders &lt;script&gt;x&lt;/script&gt; | high | restricted | — |',
  );
  assert.ok(!md.includes('<script>') && !md.includes('secret-client-project'));
  assert.doesNotMatch(md, /complian/i);
});

test('GET evidence: JSON or Markdown as a download, recorded as governance.export; a bad format is 400', async () => {
  const recorded = [];
  const api = createGovernanceApi({
    audit: { status: () => audit },
    settings: { get: () => ({ audit: { retentionMonths: 12 } }), save: () => {} },
    sources: async () => ({ live: { apps: [{ id: 'claude', name: 'Claude Code' }] } }),
    record: (e) => recorded.push(e),
    version: '1.0.4',
    now: () => NOW,
  });
  const get = (q) => api.route({ method: 'GET', path: '/api/governance/evidence', query: new URLSearchParams(q) });
  const json = await get('');
  assert.equal(json.status, 200);
  assert.equal(json.type, 'application/json; charset=utf-8');
  assert.deepEqual(json.headers, {
    'Content-Disposition': 'attachment; filename="zaafpulse-evidence-2026-11-03.json"',
  });
  const r = JSON.parse(json.body);
  assert.deepEqual([r.version, r.inventory.items[0].id, r.audit.retentionMonths], ['1.0.4', 'app:claude', 12]);
  const md = await get('format=md');
  assert.equal(md.type, 'text/markdown; charset=utf-8');
  assert.match(md.headers['Content-Disposition'], /zaafpulse-evidence-2026-11-03\.md"$/);
  assert.match(md.body, /^# ZAAFPulse governance evidence/);
  assert.deepEqual(recorded, [
    { action: 'governance.export', target: { type: 'evidence', id: 'json' } },
    { action: 'governance.export', target: { type: 'evidence', id: 'md' } },
  ]);
  assert.deepEqual(await get('format=pdf'), { status: 400, body: { error: 'format: json or md' } });
  assert.equal(recorded.length, 2, 'a refused export is not an export');
});

test('privacy: no absolute project folder, home path or secret-looking value in either format', async () => {
  const HOME = '/Users/ana';
  const planted = {
    mcp: [
      {
        client: 'claude',
        name: 'Claude Code',
        file: `${HOME}/.claude.json`,
        state: 'ok',
        servers: [
          { name: 'db', transport: 'stdio', command: 'uvx', package: 'pg-mcp', project: '/srv/clients/acme-secret' },
          { name: 'web', transport: 'http', origin: 'https://mcp.example.com', project: `${HOME}/code/shop` },
        ],
      },
    ],
  };
  const api = createGovernanceApi({
    audit: { status: () => audit },
    settings: { get: () => ({}), save: () => {} },
    sources: async () => planted,
    record: () => {},
    version: '1.0.4',
    now: () => NOW,
  });
  const get = (q) => api.route({ method: 'GET', path: '/api/governance/evidence', query: new URLSearchParams(q) });
  const json = await get('format=json');
  const md = await get('format=md');
  assert.ok(JSON.parse(json.body).inventory.items.some((i) => i.id === 'mcp:db'));
  for (const text of [json.body, md.body])
    for (const s of ['/srv/clients', 'acme-secret', HOME, '/code/shop', '.claude.json', 'sk-live-SECRET'])
      assert.ok(!text.includes(s), `${s} must not be exported`);
  // Direct: an item that carries a project, a file and a secret-looking extra field exports none of them.
  const r = evidenceReport({
    inventory: {
      counts: {},
      failed: [],
      items: [
        {
          id: 'mcp:x',
          kind: 'mcp',
          name: 'x',
          where: ['c'],
          state: 'configured',
          project: '/srv/clients/acme-secret',
          projects: [`${HOME}/code/shop`],
          file: `${HOME}/.claude.json`,
          token: 'sk-live-SECRET',
        },
      ],
    },
    controls: { controls: [] },
    audit,
    version: '1',
    generatedAt: '2026-11-03T12:00:00.000Z',
  });
  for (const text of [toJson(r), toMarkdown(r)])
    for (const s of ['/srv/clients', HOME, '.claude.json', 'sk-live-SECRET'])
      assert.ok(!text.includes(s), `${s} must not be exported`);
});

test('Markdown: the summary counts all four statuses, unknown included', () => {
  const r = report();
  r.controls[0].status = 'unknown';
  const line = toMarkdown(r)
    .split('\n')
    .find((l) => /^\d+ in place · /.test(l));
  assert.match(line, /^\d+ in place · \d+ partial · \d+ off · [1-9]\d* unknown$/);
});
