// Governance → Inventory and Compliance in the browser file, without a browser (public/governanceview.js): the sub-page
// of a hash, the filters, the rows and their review tags, the summary with failed sources, the review drawer and the
// body it posts, the Compliance tables by framework with the export links; the menu, the sub-pages and the route; and
// every server or owner string escaped (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/governanceview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const items = [
  {
    id: 'mcp:github',
    kind: 'mcp',
    name: 'github',
    vendor: null,
    where: ['Claude Code config', 'logs'],
    state: 'used',
    firstSeen: '2026-11-01',
    lastSeen: '2026-11-03',
    status: 'unreviewed',
    review: null,
    transport: 'stdio',
    command: 'npx',
    package: '@modelcontextprotocol/server-github',
    clients: ['Claude Code'],
    projects: ['~/code/shop'],
  },
  {
    id: 'provider:openai',
    kind: 'provider',
    name: 'openai',
    vendor: 'OpenAI',
    where: ['gateway'],
    state: 'configured',
    firstSeen: '2026-10-01',
    lastSeen: '2026-11-03',
    status: 'reviewed',
    review: { owner: 'Ana', purpose: 'chat', risk: 'limited', decision: 'approved', note: '', reviewedAt: null },
    origin: 'https://api.openai.com',
  },
  {
    id: 'key:key_old',
    kind: 'key',
    name: 'key:key_old',
    vendor: null,
    where: [],
    state: 'gone',
    firstSeen: '2026-09-01',
    lastSeen: '2026-09-30',
    status: 'gone',
    review: { owner: 'Ops', purpose: '', risk: 'high', decision: '', note: '', reviewedAt: null },
  },
];

test('sub-pages: Inventory by default, then Compliance and the Audit log', () => {
  assert.deepEqual(U.GOV_SUBS, [
    ['', 'Inventory'],
    ['compliance', 'Compliance'],
    ['audit', 'Audit log'],
  ]);
  assert.deepEqual(['', 'compliance', 'audit', 'nope', undefined].map(U.govSub), ['', 'compliance', 'audit', '', '']);
  assert.match(
    U.govView(''),
    /<nav class="subtabs">governance<\/nav><div class="hero">GOVERNANCE · INVENTORY\|AI inventory\|/,
  );
  assert.match(
    U.govView('compliance'),
    /GOVERNANCE · COMPLIANCE\|Compliance\|Evidence for your assessment, not a certification:/,
  );
  assert.match(U.govView('audit'), /<nav class="subtabs">governance<\/nav><div class="hero">GOVERNANCE · AUDIT LOG\|/);
  assert.match(U.govView('x'), /GOVERNANCE · INVENTORY/);
  assert.match(U.govInvView(), /<tbody id="gov-inv-rows"><\/tbody>/);
  assert.match(U.govInvView(), /<div id="gov-review-host"><\/div>/);
});

test('inventory: the filters, the rows with their review, and the summary', () => {
  assert.deepEqual(
    U.govInvFilter(items, { kind: '', state: '', review: 'unreviewed' }).map((i) => i.id),
    ['mcp:github'],
  );
  assert.deepEqual(
    U.govInvFilter(items, { kind: 'provider', state: 'configured', review: '' }).map((i) => i.id),
    ['provider:openai'],
  );
  assert.equal(U.govInvFilter(items, { kind: '', state: 'gone', review: 'gone' }).length, 1);
  const rows = U.govInvRowsHtml(items);
  assert.match(
    rows,
    /<b>github<\/b><div class="muted mono gov-id">mcp:github<\/div><div class="muted">@modelcontextprotocol\/server-github<\/div>/,
  );
  assert.match(rows, /<td>MCP server<\/td><td>Claude Code config, logs<\/td><td>Used<\/td>/);
  assert.match(rows, /<span class="tag warn">Unreviewed<\/span>/);
  assert.match(rows, /<span class="tag">Limited · Approved<\/span><div class="muted">Ana<\/div>/);
  assert.match(rows, /<span class="tag warn">Gone · High<\/span>/);
  assert.match(rows, /data-gov-review="mcp:github">Review</);
  assert.match(rows, /data-gov-review="provider:openai">Edit</);
  assert.match(U.govInvRowsHtml([{ ...items[1], stale: true }]), /not confirmed this build/);
  assert.ok(!U.govInvRowsHtml([items[1]]).includes('not confirmed'));
  assert.match(U.govInvRowsHtml([]), /No items for these filters\./);
  const sum = U.govInvSummaryHtml({
    counts: { total: 2, reviewed: 1, unreviewed: 1, newUnreviewed: 1, gone: 1 },
    failed: ['gateway', 'mcp'],
    clients: [{ client: 'zed', name: 'Zed', file: '~/.config/zed/settings.json', state: 'unreadable', servers: 0 }],
  });
  assert.match(sum, /Could not read the gateway, the AI clients&#39; MCP settings; the list is built from the rest\./);
  assert.match(sum, /MCP settings that could not be read: Zed \(~\/\.config\/zed\/settings\.json\)\./);
  assert.match(
    sum,
    /<p class="gov-summary">2 items · 1 reviewed · 1 unreviewed · 1 new this week and not reviewed · 1 reviews of items no longer seen<\/p>/,
  );
  assert.ok(!U.govInvSummaryHtml({ counts: {}, failed: [], clients: [] }).includes('gov-banner'));
  const f = U.govInvFiltersHtml({ kind: 'mcp', state: '', review: 'gone' });
  assert.match(f, /<form id="gov-inv-filters" class="gov-bar">/);
  assert.match(f, /<option value="mcp" selected>MCP server<\/option>/);
  assert.match(f, /<option value="gone" selected>Gone<\/option>/);
  assert.match(f, /<option value="">Any state<\/option>/);
});

test('review drawer: what is known of the item, the fields, Clear only when reviewed; the body it posts', () => {
  const html = U.govReviewFormHtml(items[0]);
  assert.match(html, /<form id="gov-review" novalidate data-gov-id="mcp:github">/);
  assert.match(html, /<dt>Package<\/dt><dd>@modelcontextprotocol\/server-github<\/dd>/);
  assert.match(html, /<dt>Projects<\/dt><dd>~\/code\/shop<\/dd>/);
  assert.match(html, /name="owner" maxlength="200" value=""/);
  assert.match(html, /<option value="unacceptable">Unacceptable<\/option>/);
  assert.match(html, /The decision is a record: blocking a system stays with API keys and the guardrails\./);
  assert.match(html, /Notes are exported with the evidence; do not paste secrets\./);
  assert.ok(!html.includes('data-gov-clear'), 'nothing to clear yet');
  const edit = U.govReviewFormHtml(items[1]);
  assert.match(edit, /name="owner" maxlength="200" value="Ana"/);
  assert.match(edit, /<option value="limited" selected>Limited<\/option>/);
  assert.match(edit, /<option value="approved" selected>Approved<\/option>/);
  assert.match(edit, /data-gov-clear>Clear review</);
  const form = { owner: ' Ana ', purpose: 'chat', risk: 'high', decision: '', note: null };
  assert.deepEqual(
    U.govReviewBody('mcp:github', (k) => form[k]),
    {
      id: 'mcp:github',
      owner: 'Ana',
      purpose: 'chat',
      risk: 'high',
      decision: '',
      note: '',
    },
  );
});

test('compliance: one table per framework with its clauses in order, the counts and the export links', () => {
  const d = {
    notice: 'Evidence for your assessment, not a certification.',
    frameworks: [
      {
        id: 'eu-ai-act',
        name: 'EU AI Act',
        version: 'Regulation (EU) 2024/1689 as amended by Regulation (EU) 2026/1744',
      },
      { id: 'iso-42001', name: 'ISO/IEC 42001', version: 'ISO/IEC 42001:2023' },
    ],
    clauses: [
      { id: 'eu-12', framework: 'eu-ai-act', ref: 'Art. 12', title: 'Record-keeping' },
      { id: 'eu-14', framework: 'eu-ai-act', ref: 'Art. 14', title: 'Human oversight' },
      { id: 'iso-a6', framework: 'iso-42001', ref: 'A.6', title: 'AI system life cycle' },
    ],
    controls: [
      {
        id: 'agent_control',
        title: 'Pause and stop an agent',
        status: 'off',
        evidence: ['agent control is off on this server'],
        link: '#settings/monitors',
        clauses: [{ id: 'eu-14' }],
      },
      {
        id: 'audit_log',
        title: 'Governance audit log',
        status: 'in place',
        evidence: ['kept 12 months (at least 6)', 'not verified yet'],
        link: 'javascript:alert(1)',
        clauses: [{ id: 'eu-12' }, { id: 'iso-a6' }],
      },
    ],
  };
  const html = U.govCompHtml(d);
  assert.match(html, /1 in place · 0 partial · 1 off · 0 unknown/);
  assert.match(U.govStatusTag('unknown'), /<span class="tag warn">Unknown<\/span>/);
  assert.match(html, /href="\/api\/governance\/evidence\?format=md" download>Export Markdown</);
  assert.match(html, /href="\/api\/governance\/evidence\?format=json" download>Export JSON</);
  assert.match(
    html,
    /<h3>EU AI Act<\/h3><span class="meta">Regulation \(EU\) 2024\/1689 as amended by Regulation \(EU\) 2026\/1744<\/span>/,
  );
  assert.ok(html.indexOf('Art. 12') < html.indexOf('Art. 14'), 'clauses in their order');
  assert.match(
    html,
    /<td><b>Art\. 14<\/b> Human oversight<\/td><td><a href="#settings\/monitors">Pause and stop an agent<\/a><\/td><td><span class="tag warn">Off<\/span><\/td><td>agent control is off on this server<\/td>/,
  );
  assert.match(
    html,
    /<a href="#governance">Governance audit log<\/a><\/td><td><span class="tag">In place<\/span><\/td><td>kept 12 months \(at least 6\) · not verified yet<\/td>/,
  );
  assert.ok(!html.includes('javascript:'), 'a link is a dashboard hash or the Governance page');
  assert.doesNotMatch(html, /complian/i);
});

test('wiring: three sub-links in the menu, the sub-pages in iso.js, the route with its sub-page', () => {
  const html = read('index.html');
  assert.match(
    html,
    /<a href="#governance" data-route="governance"><span data-icon="shield"><\/span>Governance<\/a>\s*<a class="nav-sub" href="#governance" data-route="governance\/">Inventory<\/a>\s*<a class="nav-sub" href="#governance\/compliance" data-route="governance\/compliance">Compliance<\/a>\s*<a class="nav-sub" href="#governance\/audit" data-route="governance\/audit">Audit log<\/a>/,
  );
  assert.match(
    read('iso.js'),
    /governance: \[\s*\['', 'Inventory'\],\s*\['compliance', 'Compliance'\],\s*\['audit', 'Audit log'\],\s*\],/,
  );
  assert.match(read('app.js'), /el\.innerHTML = govView\(state\.sub\);\s*return govMount\(state\.sub\);/);
  const css = read('styles.css');
  for (const c of ['.gov-summary', '.gov-id', '.gov-facts']) assert.ok(css.includes(c), c);
});

test('S1: no server or owner string reaches the inventory or compliance markup unescaped', () => {
  const x = '<x>';
  const item = {
    id: x,
    kind: x,
    name: x,
    vendor: x,
    where: [x],
    state: x,
    firstSeen: x,
    lastSeen: x,
    status: 'reviewed',
    review: { owner: x, purpose: x, risk: x, decision: x, note: x, reviewedAt: x },
    transport: x,
    command: x,
    package: x,
    origin: x,
    clients: [x],
    projects: [x],
  };
  const html = [
    U.govInvRowsHtml([item, { ...item, status: 'unreviewed' }, { ...item, status: 'gone' }]),
    U.govInvSummaryHtml({ counts: { total: x }, failed: [x], clients: [{ name: x, file: x, state: 'unreadable' }] }),
    U.govInvFiltersHtml({ kind: x, state: x, review: x }),
    U.govReviewFormHtml(item),
    U.govCompHtml({
      notice: x,
      frameworks: [{ id: x, name: x, version: x }],
      clauses: [{ id: x, framework: x, ref: x, title: x }],
      controls: [{ id: x, title: x, status: x, evidence: [x], link: x, clauses: [{ id: x }] }],
    }),
  ].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
});
