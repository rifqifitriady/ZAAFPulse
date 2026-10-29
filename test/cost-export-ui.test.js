// Cost Control 5 in the browser file: the Breakdown table's Export CSV link (public/costview.js) names the page's
// range, currency and measure and the table's grouping, as GET /api/cost/export reads them.
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const U = require('../public/costview');

const T = '2026-10-29';

test('the export link: the range of the controls, the grouping, the measure and a display currency', () => {
  const c = { range: '7d', from: null, to: null, cur: 'USD', measure: 'list' };
  assert.equal(
    U.costExportHref(c, ['model'], T),
    '/api/cost/export?format=csv&from=2026-10-23&to=2026-10-29&groupBy=model&measure=list',
  );
  assert.equal(
    U.costExportHref(
      { ...c, range: 'custom', from: '2026-09-01', to: '2026-09-30', cur: 'IDR', measure: 'billed' },
      ['center', 'model'],
      T,
    ),
    '/api/cost/export?format=csv&from=2026-09-01&to=2026-09-30&groupBy=center%2Cmodel&measure=billed&currency=IDR',
  );
  const q = new URL(U.costExportHref({ ...c, range: 'lastmonth' }, ['day', 'source'], T), 'http://x').searchParams;
  assert.deepEqual([q.get('from'), q.get('to'), q.get('groupBy')], ['2026-09-01', '2026-09-30', 'day,source']);
});

test('the Breakdown table carries the link, with the filter dimension in its grouping and the markup escaped', () => {
  const saved = { $: global.$ };
  const host = { isConnected: true, innerHTML: '' };
  global.$ = (s) => (s === '#cost-table' ? host : null);
  try {
    U.COST.controls = { range: '30d', from: null, to: null, cur: 'IDR', measure: 'billed' };
    const ctx = { measure: 'billed', cur: 'IDR', fmt: (v) => U.costMoney(v, 'IDR'), centers: {}, keys: {} };
    const plan = U.costTablePlan(['model'], { dim: 'center', key: 'acme' });
    U.COST.table = {
      groupBy: ['model'],
      sort: { key: 'spend', dir: -1 },
      filter: { dim: 'center', key: 'acme' },
      data: { led: { rows: [] }, plan, ctx },
    };
    U.costPaintTable();
    const m = /<a class="btn ghost cost-export" href="([^"]+)" download>Export CSV<\/a>/.exec(host.innerHTML);
    assert.ok(m, host.innerHTML);
    const q = new URL(m[1].replace(/&amp;/g, '&'), 'http://x').searchParams;
    assert.deepEqual(
      [q.get('format'), q.get('groupBy'), q.get('measure'), q.get('currency')],
      ['csv', 'center,model', 'billed', 'IDR'],
    );
    assert.doesNotMatch(m[1], /&(?!amp;)/, 'the href is escaped');
  } finally {
    Object.assign(global, saved);
  }
});
