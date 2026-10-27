// The Cost Control pages (public/costview.js): the control bar from the hash and storage, money, the status ribbon and
// the table, without a browser; the page's wiring in index.html, iso.js and app.js; one global scope for every page
// script; and an audit of the file for server or owner text put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const U = require('../public/costview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
const CUR = ['USD', 'IDR'];

test('controls: the URL first, else the stored choice, each bad value back to its default', () => {
  const D = { range: '30d', from: null, to: null, cur: 'USD', measure: 'list' };
  assert.deepEqual(U.costParseControls('', null, CUR), D);
  assert.deepEqual(U.costParseControls('range=7d&cur=IDR&measure=billed', null, CUR), {
    ...D,
    range: '7d',
    cur: 'IDR',
    measure: 'billed',
  });
  assert.deepEqual(U.costParseControls('range=custom&from=2026-09-01&to=2026-10-05', null, CUR), {
    ...D,
    range: 'custom',
    from: '2026-09-01',
    to: '2026-10-05',
  });
  for (const q of [
    'range=custom&from=2026-02-30&to=2026-03-02', // a date that does not exist
    'range=custom&from=2026-10-05&to=2026-09-01', // reversed
    'range=custom&from=2025-01-01&to=2026-10-05', // over 400 days
    'range=custom&from=2026-10-01', // half a range
    'range=decade',
  ])
    assert.equal(U.costParseControls(q, null, CUR).range, '30d', q);
  assert.equal(U.costParseControls('cur=IDR', null, ['USD']).cur, 'USD', 'a currency without rates');
  assert.equal(U.costParseControls('measure=both', null, CUR).measure, 'list');
  const stored = JSON.stringify({ range: 'lastmonth', cur: 'IDR', measure: 'billed' });
  assert.deepEqual(U.costParseControls('', stored, CUR), { ...D, range: 'lastmonth', cur: 'IDR', measure: 'billed' });
  assert.deepEqual(U.costParseControls('focus=x', stored, CUR).range, 'lastmonth', 'only the controls count as named');
  assert.equal(U.costParseControls('range=7d', stored, CUR).cur, 'USD', 'a URL that names any control wins whole');
  for (const bad of ['{', '[]', '"7d"', JSON.stringify({ range: 7 })])
    assert.deepEqual(U.costParseControls('', bad, CUR), D, bad);
});

test('controls: the days each range covers, and the query and hash that name them', () => {
  const t = '2026-10-27';
  const days = (range, extra = {}) => U.costRangeDays({ range, ...extra }, t);
  assert.deepEqual(days('7d'), { from: '2026-10-21', to: t });
  assert.deepEqual(days('30d'), { from: '2026-09-28', to: t });
  assert.deepEqual(days('month'), { from: '2026-10-01', to: t });
  assert.deepEqual(days('lastmonth'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(U.costRangeDays({ range: 'lastmonth' }, '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(days('custom', { from: '2026-10-01', to: '2026-10-03' }), { from: '2026-10-01', to: '2026-10-03' });
  assert.equal(U.costControlsQuery({ range: '30d', cur: 'USD', measure: 'list' }), 'range=30d');
  assert.equal(
    U.costHash('breakdown', { range: 'custom', from: '2026-10-01', to: '2026-10-03', cur: 'IDR', measure: 'billed' }),
    '#cost/breakdown?range=custom&from=2026-10-01&to=2026-10-03&cur=IDR&measure=billed',
  );
  assert.equal(U.costHash('', { range: '7d', cur: 'USD', measure: 'list' }), '#cost?range=7d');
  assert.equal(U.costAddDays('2026-03-28', 2), '2026-03-30', 'across a daylight-saving change');
});

test('controls: localStorage is optional; a throwing store reads as empty and writes nothing', () => {
  const saved = global.localStorage;
  try {
    const box = new Map();
    global.localStorage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
    U.costStoreSet({ range: '7d', cur: 'USD', measure: 'list' });
    assert.equal(box.get(U.COST_STORE_KEY), JSON.stringify({ range: '7d', cur: 'USD', measure: 'list' }));
    assert.equal(U.costStoreGet(), box.get('zp.cost.controls'));
    global.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.equal(U.costStoreGet(), null);
    assert.doesNotThrow(() => U.costStoreSet({ range: '7d' }));
    delete global.localStorage;
    assert.equal(U.costStoreGet(), null, 'no storage at all');
  } finally {
    if (saved !== undefined) global.localStorage = saved;
  }
});

test('money: USD to the cent, small amounts to two significant digits, other currencies in whole units', () => {
  assert.equal(U.costMoney(1234.5), '$1,234.50');
  assert.equal(U.costMoney(0.9), '$0.90');
  assert.equal(U.costMoney(0.0423), '$0.042');
  assert.equal(U.costMoney(0), '$0.00');
  assert.equal(U.costMoney(-2.5), '−$2.50');
  assert.equal(U.costMoney(2500000), '$2.5M');
  assert.equal(U.costMoney(1386421.6, 'IDR'), 'IDR 1.4M');
  assert.equal(U.costMoney(61690.4, 'IDR'), 'IDR 61,690');
  assert.equal(U.costMoney(null), '—');
  assert.equal(U.costMoney(NaN, 'IDR'), '—');
});

test('ribbon and notes: the status problems in the server words, unread months by name', () => {
  assert.deepEqual(U.costRibbonItems(null), []);
  assert.deepEqual(
    U.costRibbonItems({ ledger: { unread: [] }, billing: {}, prices: { problems: [] }, settings: {} }),
    [],
  );
  assert.deepEqual(
    U.costRibbonItems({
      settings: {
        error: 'the cost settings in config.json are invalid, so the ledger pass waits until they are fixed',
      },
      ledger: { error: null, unread: ['2026-10', 'folder'] },
      billing: { error: 'BILLING_UNREAD', historyLost: true },
      prices: { problems: ['price version 3 had 1 unusable model entries that were ignored'] },
    }),
    [
      'the cost settings in config.json are invalid, so the ledger pass waits until they are fixed',
      'October 2026 could not be read: figures leave it out.',
      'The ledger folder could not be read: figures leave it out.',
      'The billing history: BILLING_UNREAD',
      'The billing history was lost: past days are billed as metered until restated.',
      'Prices: price version 3 had 1 unusable model entries that were ignored',
    ],
  );
  assert.equal(U.costUnreadText('corrections'), 'The restate corrections could not be read: figures leave them out.');
});

test('table rows: spend in the chosen currency and measure, shares, the flow filter, empty plan rows left out', () => {
  const led = {
    rows: [
      { model: 'opus', requests: 4, tokens: { in: 10, out: 5 }, listUSD: 6, billedUSD: 0, list: 96000, billed: 0 },
      { model: 'sonnet', requests: 2, tokens: { in: 4 }, listUSD: 2, billedUSD: 2, list: null, billed: null },
      { model: null, requests: 0, tokens: {}, listUSD: 0, billedUSD: 5, list: 0, billed: 80000 },
    ],
  };
  const usd = U.costTableRows(led, ['model'], { measure: 'list', cur: 'USD', filter: null });
  assert.deepEqual(
    usd.rows.map((r) => [r.keys[0], r.spend, r.share, r.tokens, r.perRequest]),
    [
      ['opus', 6, 0.75, 15, 1.5],
      ['sonnet', 2, 0.25, 4, 1],
    ],
  );
  const idr = U.costTableRows(led, ['model'], { measure: 'billed', cur: 'IDR', filter: null });
  assert.deepEqual(
    idr.rows.map((r) => [r.keys[0], r.spend]),
    [
      ['opus', 0],
      ['sonnet', 2],
      [null, 80000],
    ],
    'a day without a rate falls back to USD, as the ledger answers it',
  );
  const one = U.costTableRows(led, ['model'], { measure: 'list', cur: 'USD', filter: { dim: 'model', key: 'sonnet' } });
  assert.deepEqual(
    one.rows.map((r) => [r.keys[0], r.share]),
    [['sonnet', 1]],
  );
});

test('the page is wired: sidebar entry with its badge, sub-pages, scripts before app.js, route, title and mount', () => {
  const html = read('index.html');
  const cost = html.indexOf('<a href="#cost" data-route="cost">');
  assert.ok(cost > html.indexOf('data-route="quality/rankings"') && cost < html.indexOf('data-route="brain"'));
  assert.match(html, /<span data-icon="dollar"><\/span>Cost Control<b class="badge" id="b-cost"><\/b>/);
  for (const sub of ['breakdown', 'value'])
    assert.match(html, new RegExp(`href="#cost/${sub}" data-route="cost/${sub}"`));
  const app = html.indexOf('<script src="app.js"></script>');
  for (const f of ['costcharts.js', 'costview.js']) {
    const at = html.indexOf(`<script src="${f}"></script>`);
    assert.ok(at > html.indexOf('<script src="iso.js"></script>') && at < app, f);
  }
  const iso = read('iso.js');
  assert.match(iso, /cost: \[\s*\['', 'Overview'\],\s*\['breakdown', 'Breakdown'\],\s*\['value', 'Value'\],/);
  const a = read('app.js');
  assert.match(a, /cost: 'COST CONTROL'/);
  assert.match(a, /cost: viewCost,/);
  assert.match(a, /if \(state\.route === 'cost'\) mountCost\(\);/);
  assert.match(a, /\['live', 'brain', 'integrations', 'trace', 'datasets', 'cost'\]\.includes\(state\.route\)/);
  assert.match(
    a,
    /\['settings', 'brain', 'squad', 'trace', 'datasets', 'cost'\]\.includes\(state\.route\)/,
    'it refreshes itself',
  );
  const css = read('styles.css');
  for (const c of ['.cost-bar', '.cost-ribbon', '.animate .cost-line', '.cost-stage']) assert.ok(css.includes(c), c);
});

test('every page script shares one global scope: no top-level name is declared twice', () => {
  const html = read('index.html');
  const files = [...html.matchAll(/<script src="([\w.-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.ok(files.includes('costview.js') && files.includes('costcharts.js'));
  const seen = new Map();
  const twice = [];
  for (const f of files)
    for (const m of read(f).matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) twice.push(`${m[1]}: ${seen.get(m[1])} and ${f}`);
      else seen.set(m[1], f);
    }
  assert.deepEqual(twice, []);
});

test('costview.js builds no markup from server or owner text without esc() (S1) and loads in Node', () => {
  const src = read('costview.js');
  const CONTENT =
    /\.(name|reason|reasons|project|model|center|provider|source|plan|label|title|text|error|message|id|key|value|code|currency|cur|from|to|note|dim|budget)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  // innerHTML takes markup this file built (a cost…Html helper, a template), never a field straight from data.
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.doesNotMatch(m[1], /^\s*[\w$.]+\.(message|error|reason|name|text)\s*$/, `innerHTML = ${m[1]}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=["`']/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:cost|COST)|^(?:viewCost|mountCost)$/, `${name}: starts with cost`);
});

// The page builders against answers the server can give when a reader failed (budgets, tool-call accuracy). The page
// helpers of iso.js are stood in for, as the page scripts share them through the global scope.
test('pages: a budget list that did not read is said, not drawn as "no budgets"; no accuracy says so twice', () => {
  const C = require('../public/costcharts');
  Object.assign(global, C, {
    COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc' },
    COST_SERIES: ['#4de8ff'],
    metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
    panel: (title, meta, body) => `<section><h3>${title}</h3>${meta}${body}</section>`,
    holoEmpty: (text) => `<div class="empty">${text}</div>`,
  });
  const ctx = { measure: 'list', cur: 'USD', fmt: (v) => U.costMoney(v), centers: {}, keys: {} };
  const day = { day: '2026-10-01', spend: 1, cum: 1 };
  const o = {
    month: { from: '2026-10-01', to: '2026-10-31', today: '2026-10-01', day: 1, days: 31 },
    spent: { list: 1, billed: 1 },
    total: 1,
    daily: [day],
    forecast: {
      perDay: 1,
      projected: 31,
      low: null,
      high: null,
      early: true,
      line: [{ ...day, low: null, high: null }],
    },
    budgetLines: [],
    spikes: [{ day: '2026-10-01', spend: 1, baseline: null, spike: false, topModel: null }],
    rings: [],
    moreBudgets: 0,
    atRisk: { count: 0, total: 0 },
    topCenter: null,
    budgetsError: 'budgets could not be read',
  };
  const html = U.costOverviewHtml(o, ctx);
  assert.match(html, /Budgets could not be read\./);
  assert.doesNotMatch(html, /No budgets yet|no budgets yet|Add a monthly budget/);
  assert.match(U.costOverviewHtml({ ...o, budgetsError: null }, ctx), /No budgets yet/);

  const v = {
    plans: [],
    waterfall: { withoutCache: 0, cacheSaved: 0, usage: 0, planSaved: 0, paid: 0 },
    local: { requests: 2, tokens: 9, models: [{ model: 'qwen3:8b', source: 'judge', requests: 2, tokens: 9 }] },
    scatter: { dots: [], noToolCalls: [{ model: '<b>m</b>' }] },
    unit: [{ day: '2026-10-01', perRequest: 1, perMillionTokens: 1, perThousandToolCalls: null }],
    accuracyError: 'tool-call accuracy could not be read',
  };
  const val = U.costValueHtml(v, ctx);
  assert.equal(val.match(/Tool-call accuracy could not be read\./g).length, 2, 'the scatter and the tool-call line');
  assert.match(val, /<td>Judge<\/td>/, 'local models name their source');
  const ok = U.costValueHtml({ ...v, accuracyError: null }, ctx);
  assert.doesNotMatch(ok, /could not be read/);
  assert.match(ok, /No tool calls to measure: &lt;b&gt;m&lt;\/b&gt;/);
});

/* ---------- fix round 1 ---------- */

const ROW = (model, extra = {}) => ({
  model,
  requests: 1,
  tokens: {},
  listUSD: 1,
  billedUSD: 1,
  list: 16000,
  billed: 16000,
  ...extra,
});
const CTX = (cur = 'USD') => ({ measure: 'list', cur, fmt: (v) => U.costMoney(v, cur), centers: {}, keys: {} });
// A fake ledger: each request waits until the test answers it.
function fakeLedger() {
  const calls = [];
  global.fetch = (url) => new Promise((res) => calls.push({ url, res }));
  const answer = (i, rows) => calls[i].res({ status: 200, json: async () => ({ rows }) });
  return { calls, answer };
}
function tableHost() {
  const host = { isConnected: true, innerHTML: '', scrollIntoView() {} };
  global.$ = (s) => (s === '#cost-table' ? host : null);
  return host;
}
function resetTable(over = {}) {
  U.COST.table = { groupBy: ['model'], sort: { key: 'spend', dir: -1 }, filter: null, data: null, ...over };
  U.COST.controls = { range: '7d', from: null, to: null, cur: 'USD', measure: 'list' };
  U.COST.ctx = CTX();
}

test('table: an older ledger answer never paints over a newer one, nor after the page is left', async () => {
  const host = tableHost();
  const L = fakeLedger();
  resetTable();
  const a = U.costLoadTable();
  const b = U.costLoadTable();
  L.answer(1, [ROW('newer')]);
  await b;
  L.answer(0, [ROW('older')]);
  await a;
  assert.match(host.innerHTML, /newer/);
  assert.doesNotMatch(host.innerHTML, /older/);
  const c = U.costLoadTable();
  U.costUnmount(); // leaving the page
  L.answer(2, [ROW('gone')]);
  await c;
  assert.doesNotMatch(host.innerHTML, /gone/);
  const d = U.costLoadTable(() => false); // a newer page load
  L.answer(3, [ROW('stale')]);
  await d;
  assert.doesNotMatch(host.innerHTML, /stale/);
  host.isConnected = false;
  const e = U.costLoadTable();
  L.answer(4, [ROW('detached')]);
  await e;
  assert.doesNotMatch(host.innerHTML, /detached/);
});

test("table: the query and the labels come from the page's current controls and context together", async () => {
  const host = tableHost();
  const L = fakeLedger();
  resetTable();
  U.COST.controls = { ...U.COST.controls, cur: 'IDR' };
  U.COST.ctx = CTX('IDR');
  const p = U.costLoadTable();
  assert.match(L.calls[0].url, /currency=IDR/);
  L.answer(0, [ROW('opus')]);
  await p;
  assert.match(host.innerHTML, /IDR 16,000/);
});

test('table: Unassigned filters rows without a center; a filter never drops a checked grouping', () => {
  const led = { rows: [ROW('a', { center: null }), ROW('b', { center: 'acme' })] };
  const un = U.costTableRows(led, ['model'], { measure: 'list', cur: 'USD', filter: { dim: 'center', key: 'unassigned' } });
  assert.deepEqual(
    un.rows.map((r) => r.keys[0]),
    ['a'],
  );
  const four = ['source', 'provider', 'model', 'project'];
  assert.deepEqual(U.costTablePlan(['model'], null), { query: ['model'], show: ['model'], left: null });
  assert.deepEqual(U.costTablePlan(['model'], { dim: 'model', key: 'x' }), {
    query: ['model'],
    show: ['model'],
    left: null,
  });
  assert.deepEqual(U.costTablePlan(['model'], { dim: 'center', key: 'x' }), {
    query: ['center', 'model'],
    show: ['model'],
    left: null,
  });
  const full = U.costTablePlan(four, { dim: 'center', key: 'x' });
  assert.equal(full.query.length, 4, 'the ledger groups by 4 at most');
  assert.ok(full.query.includes('center'), 'the filter needs its dimension');
  assert.equal(full.left, 'project', 'the grouping left out is named, not dropped silently');
  assert.deepEqual(full.show, ['source', 'provider', 'model']);
});

test('table: aria-sort sits on the header cell; a sort key whose column is gone falls back to spend', () => {
  const host = tableHost();
  resetTable({ sort: { key: 'requests', dir: -1 } });
  U.COST.table.data = { led: { rows: [ROW('a'), ROW('b')] }, plan: U.costTablePlan(['model'], null), ctx: CTX() };
  U.costPaintTable();
  assert.match(host.innerHTML, /<th class="num" aria-sort="descending"><button[^>]*data-cost-sort="requests"/);
  assert.doesNotMatch(host.innerHTML, /<button[^>]*aria-sort/);
  U.COST.table.sort = { key: 'd:project', dir: 1 };
  U.costPaintTable();
  assert.deepEqual(U.COST.table.sort, { key: 'spend', dir: -1 });
});

test('quiet refresh: waits in a form field of the page or a hidden tab, not after a click on a button', () => {
  const field = { matches: (s) => s.includes('input') };
  const button = { matches: () => false };
  const app = { contains: (el) => el === field || el === button };
  assert.equal(U.costQuietWait({ hidden: false, activeElement: field }, app), true);
  assert.equal(U.costQuietWait({ hidden: false, activeElement: button }, app), false);
  assert.equal(U.costQuietWait({ hidden: true, activeElement: null }, app), true);
  assert.equal(U.costQuietWait({ hidden: false, activeElement: { matches: () => true } }, app), false, 'outside');
});
