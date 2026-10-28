// Cost Control 4a in the browser files, without a browser: the Overview's forecast caption, Anomalies card and ring
// captions (public/costview.js, public/costcharts.js), a budget card's forecast line, and the bell line and Monitors
// card of cost_anomaly (public/monitorsview.js). Server and owner text reaches the markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');
const { daysBetween } = require('../lib/cost/days');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// The page scripts share one global scope: costview.js uses the chart builders and the iso.js page helpers.
const C = require('../public/costcharts');
Object.assign(global, C, {
  COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc', blue: '#5b8cff' },
  COST_SERIES: ['#4de8ff'],
  metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
  panel: (title, meta, body) => `<section><h3>${title}</h3><span class="meta">${meta}</span>${body}</section>`,
  holoEmpty: (text) => `<div class="empty">${text}</div>`,
});
const U = require('../public/costview');

const EVIL = '<img src=x onerror=alert(1)>';
const CTX = {
  measure: 'list',
  cur: 'USD',
  fmt: (v) => U.costMoney(v),
  centers: { client: 'Client: Acme' },
  keys: { key_a: 'ci-bot' },
};
const row = (day, over = {}) => ({
  day,
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'client',
  keyId: 'key_a',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});

test('the burn-down caption names the forecast method', () => {
  assert.equal(U.costForecastCaption('weekday'), 'Forecast: weekday pattern of the last 4 weeks');
  assert.equal(U.costForecastCaption('mean'), 'Forecast: daily mean (little history yet)');
  for (const m of [null, undefined, 'toString', 'other']) assert.equal(U.costForecastCaption(m), 'No forecast yet');
});

test('anomaly rows: the figures against the usual amount, and drivers as text', () => {
  assert.equal(U.costAnomalyFigures({ spentUSD: 18.4, expectedUSD: 6.1 }), '$18.40, usually $6.10 (3.0×)');
  assert.equal(U.costAnomalyFigures({ spentUSD: 1.5, expectedUSD: 0 }), '$1.50, usually $0.00', 'no ratio over 0');
  const d = (dim, value, extraUSD, share, label = value) => ({ dim, value, label, extraUSD, share });
  assert.equal(U.costDriverText(d('model', 'claude-opus-5-5', 9.2, 0.75), CTX), 'claude-opus-5-5 · +$9.20 (75 %)');
  assert.equal(U.costDriverText(d('project', '~/Github/acme-web', 7, 0.57), CTX), '~/Github/acme-web · +$7.00 (57 %)');
  assert.equal(
    U.costDriverText(d('keyId', 'key_b', 5.1, 0.41, 'Acme client'), CTX),
    'Key: Acme client · +$5.10 (41 %)',
  );
  assert.equal(U.costDriverText(d('keyId', 'key_a', 1, 1, null), CTX), 'Key: ci-bot · +$1.00 (100 %)');
  assert.equal(U.costDriverText(d('center', 'client', 2, 0.5), CTX), 'Client: Acme · +$2.00 (50 %)');
  assert.equal(U.costDriverText(d('center', 'unassigned', 2, 0.5), CTX), 'Unassigned · +$2.00 (50 %)');
});

test('the Overview: caption, spike meta and an Anomalies card with today and yesterday, names escaped', () => {
  // Every day DeepSeek through key_a (1); yesterday (Wednesday the 21st) a project with a hostile name spends 6 more.
  const all = [
    ...daysBetween('2026-09-02', '2026-10-21').map((d) => row(d)),
    row('2026-10-21', { source: 'claude', model: EVIL, project: `~/${EVIL}`, keyId: null, listUSD: 6 }),
    row('2026-10-22', { listUSD: 0.5 }),
  ];
  const o = V.overview({
    rows: all.filter((r) => r.day >= '2026-10-01'),
    history: all.filter((r) => r.day < '2026-10-01'),
    today: '2026-10-22',
  });
  const html = U.costOverviewHtml(o, CTX);
  assert.match(html, /day 22 of 31 · Forecast: weekday pattern of the last 4 weeks · band: 25th–75th percentile days/);
  assert.match(html, /usage value, each day against the same weekday of the 4 weeks before it/);
  assert.match(html, /over 2× the usual amount and at least \$1\.00 more · usage value in USD/);
  assert.match(html, /<b>Yesterday<\/b><span class="cost-chip warn">Anomaly<\/span>/);
  assert.match(html, /\$7\.00, usually \$1\.00 \(7\.0×\)/);
  assert.match(html, /<li>&lt;img src=x onerror=alert\(1\)&gt; · \+\$6\.00 \(100 %\)<\/li>/);
  assert.match(html, /<b>Today \(so far\)<\/b><span class="cost-chip">Normal<\/span>/);
  assert.equal((html.match(/<li>/g) || []).length, 3, 'drivers only for the anomaly');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /href="#settings\/monitors"/);
  const young = U.costOverviewHtml(V.overview({ rows: [row('2026-10-01')], today: '2026-10-02' }), CTX);
  assert.match(young, /· No forecast yet</);
  assert.equal((young.match(/Not enough history/g) || []).length, 2);
  const lost = U.costOverviewHtml({ ...o, anomalies: null }, CTX);
  assert.match(lost, /The ledger history could not be read: no anomalies for now\./);
});

test('rings: a runs-out date in the caption and the tooltip; none when the forecast stays under', () => {
  const ring = (over) => ({
    id: 'team',
    name: EVIL,
    state: 'warn_50',
    tone: 'warn',
    percent: 60,
    projected: true,
    ...over,
  });
  const html = C.costRingsHtml([ring({ runsOut: '2026-11-21' })], 0);
  assert.match(html, /<small class="cost-ring-out">runs out ~21 Nov<\/small>/);
  assert.match(html, /data-tip="&lt;img src=x onerror=alert\(1\)&gt; · projected over · runs out ~21 Nov"/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(C.costRingsHtml([ring({ runsOut: null, projected: false })], 0), /runs out/);
});
