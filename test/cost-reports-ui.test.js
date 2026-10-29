// Cost Control 5 in the browser file, without a browser: the Reports page (public/costreports.js), its controls, the
// report's tables, budgets and notes, the CSV it downloads, the print rules, and its wiring. Every server or owner
// string reaches the markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page scripts share one global scope: costreports.js uses costview.js, the charts and the iso.js page helpers.
const C = require('../public/costcharts');
Object.assign(global, C, {
  COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc', blue: '#5b8cff' },
  COST_SERIES: ['#4de8ff'],
  metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
  panel: (title, meta, body) => `<section><h3>${title}</h3>${meta}${body}</section>`,
  holoEmpty: (text) => `<div class="empty">${text}</div>`,
});
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costreports');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const EVIL = '<img src=x onerror=alert(1)>';
const CTX = {
  cur: 'USD',
  fmt: (v) => V.costMoney(v),
  currencies: ['USD'],
  centers: { acme: 'Client: Acme' },
  keys: {},
};
const money = (l, b) => ({ listUSD: l, billedUSD: b });
const REPORT = {
  month: '2026-10',
  from: '2026-10-01',
  to: '2026-10-29',
  center: { id: 'acme', name: 'Client: Acme' },
  currency: 'USD',
  generatedAt: new Date(2026, 9, 29, 14, 5).getTime(),
  months: ['2026-10', '2026-09'],
  totals: { requests: 12, tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 }, ...money(42.5, 12) },
  tables: {
    source: [{ key: 'gateway', requests: 10, tokens: 900, ...money(40, 12) }],
    model: [
      { key: EVIL, requests: 2, tokens: 10, ...money(2, 0) },
      { key: '__plan', requests: 0, tokens: 0, ...money(0, 6.5) },
      { key: '__other', count: 7, requests: 1, tokens: 1, ...money(0.5, 0.5) },
    ],
    key: [
      { key: 'key_a', name: EVIL, requests: 1, tokens: 1, ...money(1, 1) },
      { key: '__none', name: null, requests: 1, tokens: 1, ...money(1, 1) },
    ],
    project: [{ key: '=cmd|"/c calc"!A1', requests: 1, tokens: 1, ...money(1, 1) }],
  },
  daily: [
    { day: '2026-10-01', ...money(1.5, 1) },
    { day: '2026-10-02', ...money(0, 0) },
  ],
  budgets: [
    {
      id: 'acme',
      name: EVIL,
      scope: { dim: 'center', value: 'acme' },
      period: 'month',
      from: '2026-10-01',
      to: '2026-10-31',
      amount: 100,
      currency: 'USD',
      measure: 'list',
      state: 'warn_80',
      projected: true,
      percent: 84.5,
      spent: 84.5,
      reason: null,
    },
  ],
  budgetsError: null,
  notes: {
    unread: ['2026-09'],
    assumed: ['2026-10-02'],
    billingError: null,
    corrections: [{ ts: 1, from: '2026-10-03', to: '2026-10-04', reason: EVIL }],
  },
};

test('the choice: from the hash, back to it, and to the report query', () => {
  assert.deepEqual(U.costRepParse('month=2026-09&center=acme&cur=IDR'), {
    month: '2026-09',
    center: 'acme',
    cur: 'IDR',
  });
  assert.deepEqual(U.costRepParse('month=2026-13&center=../x&cur=idr'), {});
  assert.equal(U.costRepHash({ month: '2026-09', center: '__all', cur: 'USD' }), '#cost/reports?month=2026-09');
  assert.equal(
    U.costRepHash({ month: '2026-09', center: 'acme', cur: 'IDR' }),
    '#cost/reports?month=2026-09&center=acme&cur=IDR',
  );
  assert.equal(U.costRepHash({}), '#cost/reports');
  assert.equal(
    U.costRepQuery({ month: '2026-09', center: 'acme', cur: 'IDR' }),
    'month=2026-09&center=acme&currency=IDR',
  );
  assert.equal(U.costRepQuery({}), '');
});

test('the header: the center and the month, the period and when it was generated', () => {
  assert.equal(U.costRepTitle(REPORT), 'Cost report · Client: Acme · October 2026');
  assert.equal(U.costRepPeriod(REPORT), '1–29 October 2026 · generated 29 Oct 2026, 14:05');
  assert.equal(U.costRepName('model', { key: '__other', count: 7 }), 'Other (7)');
  assert.equal(U.costRepName('model', { key: '__plan' }), 'Plan fee');
  assert.equal(U.costRepName('key', { key: '__none' }), 'Unknown');
  assert.equal(U.costRepName('source', { key: 'claude' }), 'Claude Code');
  assert.equal(U.costRepName('key', { key: 'key_a', name: 'Acme app' }), 'Acme app');
  assert.equal(U.costRepState({ state: 'warn_80', projected: true }), 'Past 80 %, projected over');
  assert.equal(U.costRepState({ state: 'exceeded' }), 'Used up');
});

test('the report: totals, four tables with Other, daily spend, budgets and notes; every name escaped', () => {
  const html = U.costRepHtml(REPORT, CTX);
  assert.match(html, /<h2>Cost report · Client: Acme · October 2026<\/h2>/);
  assert.match(html, /Usage value\|\$42\.50\|/);
  assert.match(html, /Paid\|\$12\.00\|/);
  for (const t of ['By source', 'By model', 'By key', 'By project', 'Daily spend', 'Budgets', 'Notes'])
    assert.ok(html.includes(`<h3>${t}</h3>`), t);
  assert.match(html, /<td>Other \(7\)<\/td>/);
  assert.match(html, /<td>Plan fee<\/td>/);
  assert.match(html, /<td>Past 80 %, projected over<\/td>/);
  assert.match(html, /aria-label="Daily spend"/);
  assert.match(html, /September 2026 could not be read: figures leave it out\./);
  assert.match(html, /Billing was assumed as metered on 1 day\(s\): 2 Oct\./);
  assert.match(html, /Restated 2026-10-03 to 2026-10-04: &lt;img/);
  assert.ok(!html.includes(EVIL), 'no raw owner text');
  const past = U.costRepHtml(
    { ...REPORT, month: '2026-09', budgets: null, notes: { unread: [], assumed: [], corrections: [] } },
    CTX,
  );
  assert.match(past, /Budget states are shown for the current month only\./);
  assert.match(U.costRepHtml({ ...REPORT, budgets: null }, CTX), /Budgets are not available\./, 'no budget service');
  assert.doesNotMatch(past, /<h3>Notes<\/h3>/);
  assert.match(U.costRepHtml({ ...REPORT, budgets: [] }, CTX), /No budget for this center\./);
  assert.match(U.costRepHtml({ ...REPORT, budgets: null, budgetsError: 'x' }, CTX), /Budgets could not be read\./);
  assert.match(
    U.costRepHtml({ ...REPORT, notes: { ...REPORT.notes, corrections: null } }, CTX),
    /The restates could not be read\./,
  );
});

test('the controls: month, center with All and Unassigned, Print and Export CSV, none of it printed', () => {
  const ctx = { ...CTX, currencies: ['USD', 'IDR'], centers: { acme: 'Client: Acme', evil: EVIL } };
  const html = U.costRepControlsHtml(REPORT, ctx);
  assert.match(html, /class="cost-bar cost-rep-controls cost-noprint"/);
  assert.match(
    html,
    /<option value="2026-10" selected>October 2026<\/option><option value="2026-09" >September 2026<\/option>/,
  );
  assert.match(
    html,
    /<option value="__all" >All centers<\/option><option value="acme" selected>Client: Acme<\/option>/,
  );
  assert.match(html, /<option value="unassigned" >Unassigned<\/option>/);
  assert.match(html, /data-cost-rep-cur="IDR" aria-pressed="false"/);
  assert.match(html, /<button type="button" class="btn ghost" data-cost-rep-print>Print<\/button>/);
  assert.match(html, /<button type="button" class="btn" data-cost-rep-csv>Export CSV<\/button>/);
  assert.ok(!html.includes(EVIL));
  assert.doesNotMatch(U.costRepControlsHtml(REPORT, CTX), /data-cost-rep-cur/, 'USD only: no currency switch');
});

test('the CSV: a title, then each table with its header row, formula cells prefixed, amounts plain', () => {
  const text = U.costRepCsv(REPORT, CTX);
  const lines = text.split('\r\n');
  assert.equal(lines[0], 'Cost report · Client: Acme · October 2026');
  assert.equal(lines[2], '');
  assert.equal(lines[3], 'By source');
  assert.equal(lines[4], 'Name,Usage value (USD),Paid (USD),Requests,Tokens');
  assert.equal(lines[5], 'Gateway,40.00000000,12.00000000,10,900');
  assert.ok(lines.includes('Other (7),0.50000000,0.50000000,1,1'));
  assert.ok(lines.includes('"\'=cmd|""/c calc""!A1",1.00000000,1.00000000,1,1'), 'CSV injection');
  assert.ok(lines.includes('Day,Usage value (USD),Paid (USD)'));
  assert.ok(lines.includes('2026-10-01,1.50000000,1.00000000'));
  assert.equal(lines.pop(), '', 'every line ends with CRLF');
  const idr = U.costRepCsv(
    {
      ...REPORT,
      tables: { source: [{ key: 'gateway', requests: 1, tokens: 1, ...money(1, 1), list: 16000, billed: null }] },
    },
    { ...CTX, cur: 'IDR' },
  );
  assert.ok(idr.includes('Name,Usage value (USD),Paid (USD),Usage value (IDR),Paid (IDR),Requests,Tokens'));
  assert.ok(idr.includes('Gateway,1.00000000,1.00000000,16000.00000000,,1,1'));
  assert.equal(U.costRepCsvName(REPORT), 'zaafpulse-report-acme-2026-10.csv');
});

test('the page loads the report the hash names, in a currency it has rates for, and paints the bar and body', async () => {
  const saved = {
    $: global.$,
    state: global.state,
    location: global.location,
    fetch: global.fetch,
    document: global.document,
  };
  const els = {
    '#cost-body': { isConnected: true, innerHTML: '' },
    '#cost-bar': { innerHTML: '' },
    '#cost-ribbon': { innerHTML: '' },
  };
  const urls = [];
  global.$ = (s) => els[s] || null;
  global.state = { sub: 'reports' };
  global.location = { hash: '#cost/reports?month=2026-09&center=acme&cur=IDR' };
  global.document = { addEventListener() {} };
  const settings = {
    settings: {
      centers: [{ id: 'acme', name: 'Client: Acme' }],
      currency: { code: 'IDR', rates: [{ from: '2026-01-01', perUSD: 16000 }] },
    },
    keys: [],
    sources: ['claude'],
  };
  global.fetch = async (url) => {
    urls.push(url);
    const json = url.startsWith('/api/cost/settings') ? settings : url.startsWith('/api/cost/status') ? {} : REPORT;
    return { status: 200, json: async () => json };
  };
  try {
    await U.costMountReports();
    assert.ok(urls.includes('/api/cost/report?month=2026-09&center=acme&currency=IDR'), urls.join(' '));
    assert.match(els['#cost-bar'].innerHTML, /data-cost-rep-month/);
    assert.match(els['#cost-body'].innerHTML, /class="cost-report"/);
    assert.equal(U.COST_REP.ctx.cur, 'IDR');
    U.costRepGo({ center: '__all' });
    assert.equal(global.location.hash, '#cost/reports?month=2026-10&cur=IDR', 'All centers is the default');
    global.location = { hash: '#cost/reports?cur=EUR' };
    urls.length = 0;
    await U.costMountReports();
    assert.ok(urls.includes('/api/cost/report?'), 'a currency without rates is USD');
  } finally {
    Object.assign(global, saved);
  }
});

test('the page is wired: sub-page and sidebar entry before Settings, the script after costsettings.js, no quiet refresh', () => {
  const html = read('index.html');
  assert.match(
    html,
    /href="#cost\/budgets"[^\n]*\n\s*<a class="nav-sub" href="#cost\/reports" data-route="cost\/reports">Reports<\/a>\n\s*<a class="nav-sub" href="#cost\/settings"/,
  );
  const at = html.indexOf('<script src="costreports.js"></script>');
  assert.ok(
    at > html.indexOf('<script src="costsettings.js"></script>') && at < html.indexOf('<script src="app.js"></script>'),
  );
  assert.match(read('iso.js'), /\['budgets', 'Budgets'\],\s*\['reports', 'Reports'\],\s*\['settings', 'Settings'\],/);
  assert.deepEqual(V.COST_SUBS.slice(-2), [
    ['reports', 'Reports'],
    ['settings', 'Settings'],
  ]);
  assert.match(
    read('costview.js'),
    /if \(costSub\(\) === 'reports'\) return quiet \? undefined : costMountReports\(\);/,
  );
});

test('print: the sidebar, the top bar, the tabs and the controls are hidden; one column for A4 and Letter', () => {
  const css = read('styles.css');
  const at = css.indexOf('@media print {');
  assert.ok(at > 0);
  const print = css.slice(at);
  for (const sel of ['.sidebar', '.topbar', '.subtabs', '.hero', '.cost-noprint', '#cost-ribbon'])
    assert.ok(print.includes(sel), sel);
  assert.match(print, /display: none !important;/);
  assert.match(print, /@page \{\s*margin: 12mm;/);
  assert.match(print, /\.cost-rep-tables \{\s*grid-template-columns: 1fr;/);
});

test('costreports.js builds no markup from server or owner text without esc(), and prints from a delegated click', () => {
  const src = read('costreports.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|value|code|currency|cur|from|to|note|dim|budget|month|day)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  // Plain-text helpers build text that esc() takes later: costRepTitle, costRepPeriod, the CSV and its file name.
  const TEXT_ONLY = ['r.center.name', 'r.center.id', 'r.month', 'c.from', 'c.to', 'c.reason'];
  assert.deepEqual(
    bare.filter((e) => !TEXT_ONLY.includes(e)),
    [],
    'content interpolated without esc()',
  );
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  assert.match(src, /if \(t\.hasAttribute\('data-cost-rep-print'\)\) return void window\.print\(\);/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:costRep|COST_REP)|^costMountReports$/, `${name}: starts with costRep`);
});

test('fix round 1: unrated day, unread line, one-day period, file name for All centers', () => {
  const idr = { ...CTX, cur: 'IDR', fmt: (v) => V.costMoney(v, 'IDR') };
  const html = U.costRepHtml(
    { ...REPORT, daily: [{ day: '2026-10-01', ...money(5, 5), list: null, billed: null }] },
    idr,
  );
  assert.ok(!/\$5\.00/.test(html), 'no USD amount in an IDR chart');
  const withUnread = U.costRepCsv(REPORT, CTX);
  assert.ok(withUnread.endsWith('\r\n# unread: 2026-09\r\n'), withUnread.slice(-40));
  assert.ok(!U.costRepCsv({ ...REPORT, notes: { unread: [] } }, CTX).includes('# unread'));
  assert.equal(U.costRepPeriod({ ...REPORT, to: '2026-10-01', generatedAt: null }), '1 October 2026');
  assert.equal(U.costRepCsvName({ ...REPORT, center: { id: '__all' } }), 'zaafpulse-report-all-2026-10.csv');
});

test('fix round 1: a refused report shows its error and keeps the controls; the stored currency is the fallback', async () => {
  const saved = {
    $: global.$,
    state: global.state,
    location: global.location,
    fetch: global.fetch,
    document: global.document,
    localStorage: global.localStorage,
  };
  const els = {
    '#cost-body': { isConnected: true, innerHTML: '' },
    '#cost-bar': { innerHTML: '' },
    '#cost-ribbon': { innerHTML: '' },
  };
  const urls = [];
  global.$ = (s) => els[s] || null;
  global.state = { sub: 'reports' };
  global.location = { hash: '#cost/reports?month=2026-01&center=gone' };
  global.document = { addEventListener() {} };
  global.localStorage = { getItem: () => JSON.stringify({ cur: 'IDR' }) };
  const settings = {
    settings: { centers: [], currency: { code: 'IDR', rates: [{ from: '2026-01-01', perUSD: 16000 }] } },
    keys: [],
    sources: [],
  };
  global.fetch = async (url) => {
    urls.push(url);
    if (url.startsWith('/api/cost/settings')) return { status: 200, json: async () => settings };
    if (url.startsWith('/api/cost/status')) return { status: 200, json: async () => ({}) };
    return { status: 400, json: async () => ({ error: 'unknown center' }) };
  };
  try {
    await U.costMountReports();
    assert.ok(urls.includes('/api/cost/report?month=2026-01&center=gone&currency=IDR'), urls.join(' '));
    assert.match(els['#cost-body'].innerHTML, /unknown center/);
    assert.match(els['#cost-bar'].innerHTML, /data-cost-rep-center/);
  } finally {
    Object.assign(global, saved);
    if (saved.localStorage === undefined) delete global.localStorage;
  }
});
