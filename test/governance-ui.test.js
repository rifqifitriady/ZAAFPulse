// Governance → Audit log in the browser file, without a browser (public/governanceview.js): the queries and export
// links from the filters, actors and targets in words, the rows with their changes, the status line ("Degraded since
// …"), the verify result; the page's wiring in index.html and app.js; and an audit of the file for server or owner
// text put into markup without esc() (S1).
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
const NOW = Date.UTC(2026, 10, 3, 12);

test('filters: the list query and the export links', () => {
  assert.equal(U.govFrom('7', NOW), '2026-10-27T12:00:00.000Z');
  assert.equal(U.govFrom('all', NOW), null);
  assert.equal(
    U.govQuery({ range: '1', actor: 'apikey', action: 'run.', outcome: 'refused' }, { now: NOW }),
    'from=2026-11-02T12%3A00%3A00.000Z&actor=apikey&action=run.&outcome=refused&limit=100',
  );
  assert.equal(
    U.govQuery({ range: 'all', actor: '', action: '', outcome: '' }, { before: 41, now: NOW }),
    'limit=100&before=41',
  );
  assert.equal(
    U.govExportHref({ range: '30' }, 'csv', NOW),
    '/api/governance/audit/export?from=2026-10-04T12%3A00%3A00.000Z&format=csv',
  );
  assert.equal(U.govExportHref({ range: 'all' }, 'jsonl', NOW), '/api/governance/audit/export?format=jsonl');
});

test('words: actors, targets, the verify result and the size', () => {
  assert.equal(
    U.govActorLabel({ via: 'dashboard', mode: 'password', device: 'Ab12', ip: '10.0.0.2' }),
    'Dashboard · password · device Ab12 · 10.0.0.2',
  );
  assert.equal(
    U.govActorLabel({ via: 'dashboard', mode: 'local', device: null, ip: '127.0.0.1' }),
    'Dashboard · local · 127.0.0.1',
  );
  assert.equal(U.govActorLabel({ via: 'apikey', keyId: 'key_ab12' }), 'API key key_ab12');
  assert.equal(U.govActorLabel({ via: 'rule', rule: 'tool_loop' }), 'Monitors rule tool_loop');
  assert.equal(U.govActorLabel({ via: 'cli' }), 'Command line');
  assert.equal(U.govActorLabel({ via: 'system' }), 'ZAAFPulse');
  assert.equal(U.govTargetLabel({ type: 'key', id: 'key_1', name: 'ci' }), 'key ci (key_1)');
  assert.equal(U.govTargetLabel({ type: 'monitors', id: 'tool_loop' }), 'monitors tool_loop');
  assert.equal(U.govTargetLabel(undefined), '—');
  assert.equal(U.govVerifyText(null), 'Not checked yet.');
  assert.equal(U.govVerifyText({ ok: true, checked: 9, from: 3, to: 11 }), 'Chain intact: entries 3–11 checked.');
  assert.equal(
    U.govVerifyText({ ok: true, checked: 2, from: 4, to: 5, unverified: 3, rekeyedAt: 4 }),
    'Chain intact: entries 4–5 checked. 3 older entries were sealed with a key that is gone.',
  );
  assert.equal(
    U.govVerifyText({ ok: false, brokenAt: 7, reason: 'entry changed' }),
    'Broken at entry 7: entry changed.',
  );
  assert.equal(
    U.govVerifyText({ ok: false, brokenAt: null, reason: 'key missing' }),
    'Cannot be checked: the audit key is missing.',
  );
  assert.equal(U.govSize({ months: [{}, {}], bytes: 2048 }), '2 months · 2.0 KB');
  assert.equal(
    U.govErrorText(new Error('400 {"error":"audit.retentionMonths: a whole number from 6 to 120"}')),
    'audit.retentionMonths: a whole number from 6 to 120',
  );
  assert.equal(U.govErrorText(new Error('400 {"errors":["first","second"]}')), 'first');
  assert.equal(U.govErrorText(new Error('500 boom')), '500 boom');
});

test('rows: every server string escaped, changes in a details element, refusals with their status', () => {
  const html = U.govRowsHtml([
    {
      seq: 2,
      ts: '2026-11-03T12:00:00.000Z',
      action: 'config.change',
      actor: { via: 'dashboard', mode: 'none', device: null, ip: '127.0.0.1' },
      target: { type: 'config', id: 'userName' },
      outcome: 'ok',
      changes: [{ path: 'userName', from: null, to: '<img src=x>' }],
      truncated: 3,
    },
    {
      seq: 1,
      ts: '2026-11-03T11:00:00.000Z',
      action: 'POST /api/gateway/keys',
      op: 'create',
      actor: { via: 'apikey', keyId: 'key_<b>' },
      target: { type: 'gateway.keys', name: '<script>' },
      outcome: 'refused',
      status: 403,
    },
  ]);
  assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('key_<b>'));
  assert.match(html, /<details class="gov-changes"><summary>4 fields changed<\/summary>/);
  assert.match(html, /<code>userName<\/code>: ∅ → &lt;img src=x&gt;/);
  assert.match(html, /and 3 more/);
  assert.match(html, /<span class="tag warn">Refused 403<\/span>/);
  assert.match(html, /<span class="tag">OK<\/span>/);
  assert.match(U.govRowsHtml([]), /No entries for these filters\./);
});

test('status: the degraded line, the retention, verify and the export links', () => {
  const f = { range: 'all', actor: '', action: '', outcome: '' };
  const st = {
    retentionMonths: 24,
    months: [{ month: '2026-11', bytes: 512 }],
    bytes: 512,
    degraded: { since: '2026-11-03T10:00:00.000Z', missed: 2 },
    lastVerify: { ok: true, checked: 0, from: null, to: null },
  };
  const html = U.govStatusHtml(st, f);
  assert.match(
    html,
    /<div class="gov-banner">Degraded since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}: 2 audit entries could not be written\./,
  );
  assert.match(html, /name="retentionMonths" min="6" max="120" step="1" value="24"/);
  assert.match(html, /Chain intact: no entries yet\./);
  assert.match(html, /href="\/api\/governance\/audit\/export\?format=csv" download>Export CSV</);
  assert.match(html, /href="\/api\/governance\/audit\/export\?format=jsonl" download>Export JSONL</);
  assert.ok(!U.govStatusHtml({ ...st, degraded: null }, f).includes('gov-banner'));
  assert.match(
    U.govStatusHtml({ ...st, lastVerify: { ok: false, brokenAt: 9, reason: 'chain broken' } }, f),
    /Broken at entry 9: chain broken\./,
  );
  const form = U.govFiltersHtml({ range: '30', actor: 'rule', action: '"><x', outcome: 'error' });
  assert.match(form, /<option value="30" selected>Last 30 days<\/option>/);
  assert.match(form, /<option value="rule" selected>Monitors rule<\/option>/);
  assert.match(form, /value="&quot;&gt;&lt;x"/);
  assert.match(U.govView('audit'), /GOVERNANCE · AUDIT LOG\|Audit log\|/);
});

test('status: the verify line is the server’s last result, so a later daily verify is never hidden', () => {
  const f = { range: 'all', actor: '', action: '', outcome: '' };
  const st = { retentionMonths: 12, months: [], bytes: 0, degraded: null };
  const broken = { ok: false, brokenAt: 9, reason: 'chain broken' };
  const clicked = { ok: true, checked: 8, from: 1, to: 8 }; // what an earlier Verify click answered
  assert.match(U.govStatusHtml({ ...st, lastVerify: broken }, f, clicked), /Broken at entry 9: chain broken\./);
  assert.ok(!('verify' in U.GOV), 'the page keeps no verify result of its own');
  assert.doesNotMatch(read('governanceview.js'), /GOV\.verify/);
});

test('status: a rekey in the last verify is a warning line; the hero line says what is recorded', () => {
  const f = { range: 'all', actor: '', action: '', outcome: '' };
  const st = { retentionMonths: 12, months: [], bytes: 0, degraded: null };
  const v = { ok: true, checked: 9, from: 1, to: 9, rekeyedAt: 7, rekeyedTs: '2026-11-02T10:00:00.000Z' };
  const html = U.govStatusHtml({ ...st, lastVerify: v }, f);
  assert.match(
    html,
    /<div class="gov-banner">The audit key was replaced at entry 7 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\)\. Entries before it are checked only when the old key can still be read\.<\/div>/,
  );
  assert.ok(!U.govStatusHtml({ ...st, lastVerify: { ...v, rekeyedAt: undefined } }, f).includes('was replaced'));
  const odd = U.govStatusHtml({ ...st, lastVerify: { ...v, rekeyedAt: '<x>' } }, f);
  assert.ok(!odd.includes('<x>'), 'escaped');
  assert.match(
    U.govView('audit'),
    /\|Changes made through the dashboard and by API keys: who, when, what and the outcome\. Read requests are not recorded; see docs\/governance\.md for the full list\.<\/div>/,
  );
});

test('wiring: the Governance menu, the script before app.js, the route and its mount', () => {
  const html = read('index.html');
  assert.match(html, /<div class="nav-label">GOVERNANCE<\/div>\s*<a href="#governance" data-route="governance">/);
  assert.match(html, /<a class="nav-sub" href="#governance\/audit" data-route="governance\/audit">Audit log<\/a>/);
  assert.ok(html.indexOf('governanceview.js') > html.indexOf('costreports.js'));
  assert.ok(html.indexOf('governanceview.js') < html.indexOf('src="app.js"'));
  const app = read('app.js');
  assert.match(app, /governance: 'GOVERNANCE',/);
  assert.match(app, /governance: govView,/);
  assert.match(
    app,
    /if \(state\.route === 'governance'\) \{\s*el\.innerHTML = govView\(state\.sub\);\s*return govMount\(state\.sub\);/,
  );
  assert.match(app, /state\.route !== 'governance' &&/);
  assert.ok(read('styles.css').includes('.gov-banner'));
});

test('governanceview.js puts no server or owner text into markup unescaped (S1) and loads in Node', () => {
  // Every string the server or the owner can set is "<x>": none may reach the markup as a tag.
  const x = '<x>';
  const entry = {
    seq: 1,
    ts: x,
    action: x,
    op: x,
    actor: { via: 'dashboard', mode: x, device: x, ip: x },
    target: { type: x, id: x, name: x },
    outcome: x,
    status: x,
    changes: [{ path: x, from: x, to: x }],
    truncated: x,
  };
  const others = [
    { ...entry, actor: { via: 'apikey', keyId: x } },
    { ...entry, actor: { via: 'rule', rule: x } },
    { ...entry, actor: { via: x } },
  ];
  const status = { retentionMonths: x, months: [{ month: x, bytes: 1 }], bytes: 1, degraded: { since: x, missed: x } };
  const filters = { range: x, actor: x, action: x, outcome: x };
  const html = [
    U.govRowsHtml([entry, ...others]),
    U.govStatusHtml({ ...status, lastVerify: { ok: false, brokenAt: x, reason: x } }, filters),
    U.govStatusHtml({ ...status, lastVerify: { ok: true, checked: 1, from: x, to: x, unverified: x } }, filters),
    U.govFiltersHtml(filters),
  ].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
  const src = read('governanceview.js');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.match(m[1].trim(), /^(gov[A-Z]\w*Html\(|`)/, `innerHTML from ${m[1].trim().slice(0, 40)}`);
  assert.equal(typeof document, 'undefined', 'loaded above with no DOM at all');
});
