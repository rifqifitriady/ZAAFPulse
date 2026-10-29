// Cost Control 5: GET /api/cost/export, in-process on the demo ledger. The ledger's range, groupBy and currency rules,
// the view's measure, a download's type and name, the 413 cap and the 503 of a ledger that does not read; path-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const NOW = new Date(2026, 9, 22, 15).getTime();
const TODAY = dayOf(NOW);

function setup({ cost: fake } = {}) {
  const d = costDemo(NOW);
  const cost =
    fake || createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const api = createCostApi({ cost, settings: { get: () => d.settings, save: () => {} }, home: HOME, now: () => NOW });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/export', query: new URLSearchParams(query) });
    bodies.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return r;
  };
  return { get, bodies, cost };
}

test('export: CSV by default, as a download named by its range, the rows of the ledger grouping', async () => {
  const s = setup();
  const from = addDays(TODAY, -6);
  const r = await s.get(`from=${from}&to=${TODAY}&groupBy=model,center`);
  assert.equal(r.status, 200);
  assert.equal(r.type, 'text/csv; charset=utf-8');
  assert.deepEqual(r.headers, {
    'Content-Disposition': `attachment; filename="zaafpulse-cost-${from}-${TODAY}.csv"`,
  });
  const lines = r.body.split('\r\n');
  assert.equal(
    lines[0],
    'model,center,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD',
  );
  const led = s.cost.ledger({ from, to: TODAY, groupBy: ['model', 'center'] });
  const usage = led.rows.filter((x) => x.requests || x.listUSD);
  assert.equal(lines.length - 2, usage.length, 'one line per row with usage, then the final CRLF');
  assert.ok(!r.body.includes('# unread'));
  for (const l of lines.slice(1, -1)) assert.match(l, /,\d+\.\d{8},\d+\.\d{8}$/);
});

test('export: JSON with the totals, paid keeps the plan fee rows, and a display currency adds its columns', async () => {
  const s = setup();
  const r = await s.get('format=json&groupBy=source,kind&measure=billed&currency=IDR');
  assert.equal(r.status, 200);
  assert.equal(r.type, 'application/json');
  assert.match(r.headers['Content-Disposition'], /filename="zaafpulse-cost-2026-10-01-2026-10-22\.json"$/);
  const j = r.body;
  assert.deepEqual(
    [j.from, j.to, j.groupBy, j.currency, j.measure],
    ['2026-10-01', TODAY, ['source', 'kind'], 'IDR', 'billed'],
  );
  const led = s.cost.ledger({ from: '2026-10-01', to: TODAY, groupBy: ['source', 'kind'] });
  assert.equal(j.rows.length, led.rows.length);
  const fee = j.rows.find((x) => x.source === 'claude' && x.kind === 'plan');
  assert.ok(fee && fee.requests === 0 && fee.billedUSD > 0, 'the Claude plan fee');
  assert.ok(j.rows.every((x) => 'listIDR' in x && 'billedIDR' in x));
  assert.ok(Math.abs(j.totals.billedUSD - led.totals.billedUSD) < 1e-6);
  assert.deepEqual(j.unread, []);
  const list = await s.get('format=json&groupBy=source,kind');
  assert.ok(!list.body.rows.some((x) => x.kind === 'plan'), 'usage value leaves the fee rows out');
});

test('export: the ledger and view rules give the same 400s; every error is path-free', async () => {
  const s = setup();
  const bad = [
    ['format=xlsx', 'format: csv or json'],
    ['measure=both', 'measure: list or billed'],
    ['groupBy=colour', 'groupBy: unknown dimension colour'],
    ['groupBy=day,source,provider,model,project', /groupBy: 1 to 4/],
    ['from=2026-10-09&to=2026-10-02', 'from must be on or before to'],
    ['from=2025-01-01&to=2026-10-22', 'at most 400 days at a time'],
    ['to=2026-02-30', 'from and to are dates (YYYY-MM-DD)'],
    ['currency=EUR', 'no rates for that currency; set it in the cost settings'],
  ];
  for (const [q, msg] of bad) {
    const r = await s.get(q);
    assert.equal(r.status, 400, q);
    if (typeof msg === 'string') assert.equal(r.body.error, msg, q);
    else assert.match(r.body.error, msg, q);
  }
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('export: over 100,000 rows is a 413; a ledger that does not read is a 503 with its code; unread months', async () => {
  const many = Array.from({ length: 100001 }, (_, i) => ({ model: `m${i}`, requests: 1, tokens: {}, listUSD: 1 }));
  const big = setup({
    cost: { ledger: (q) => ({ ...q, currency: 'USD', rows: many, totals: {}, unread: [] }) },
  });
  const r = await big.get('groupBy=model');
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'too many rows; narrow the range or group by fewer dimensions');
  const down = setup({
    cost: {
      ledger: () => {
        throw Object.assign(new Error(`ledger month 2026-10 could not be read at ${HOME}/x`), {
          code: 'LEDGER_MONTH_UNREAD',
        });
      },
    },
  });
  const d = await down.get('groupBy=model');
  assert.equal(d.status, 503);
  assert.equal(d.body.code, 'LEDGER_MONTH_UNREAD');
  assert.doesNotMatch(JSON.stringify(d.body), PATHS);
  const part = setup({
    cost: {
      ledger: (q) => ({
        ...q,
        currency: 'USD',
        rows: [{ model: 'm', requests: 1, tokens: {}, listUSD: 1, billedUSD: 1 }],
        unread: ['2026-09'],
      }),
    },
  });
  const csv = await part.get('from=2026-09-20&to=2026-10-02&groupBy=model');
  assert.match(csv.body, /\r\n# unread: 2026-09\r\n$/);
  assert.deepEqual((await part.get('format=json&from=2026-09-20&to=2026-10-02&groupBy=model')).body.unread, [
    '2026-09',
  ]);
});

test('export: the header row and the cells use one column list, the ledger answer', async () => {
  const s = setup({
    cost: {
      ledger: () => ({
        groupBy: ['model'],
        currency: 'USD',
        rows: [{ model: 'm', requests: 1, tokens: {}, listUSD: 1, billedUSD: 1 }],
        unread: [],
      }),
    },
  });
  const r = await s.get('from=2026-10-01&to=2026-10-02&groupBy=day&currency=IDR');
  const [head, line] = r.body.split('\r\n');
  assert.equal(head, 'model,requests,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,listUSD,billedUSD');
  assert.equal(line.split(',').length, head.split(',').length);
  assert.equal(line.split(',')[0], 'm');
});

test('final fix: a ledger answering unread folder is a 503 with its code, not a header-only 200', async () => {
  const down = setup({
    cost: { ledger: (q) => ({ ...q, currency: 'USD', rows: [], totals: {}, unread: ['folder'] }) },
  });
  for (const format of ['csv', 'json']) {
    const r = await down.get(`format=${format}&groupBy=model`);
    assert.equal(r.status, 503, format);
    assert.equal(r.body.code, 'LEDGER_MONTH_UNREAD');
    assert.doesNotMatch(JSON.stringify(r.body), PATHS);
  }
});
