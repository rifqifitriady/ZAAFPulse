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
  // One unusual day among 28: the 25th and 75th percentile days are as expected, so the band is the line itself.
  assert.match(html, /day 22 of 31 · Forecast: weekday pattern of the last 4 weeks</);
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

test('the burn-down meta claims a percentile band only when the band has a width', () => {
  // Every day 1: each known day is as expected, so the band is the line itself.
  const flat = daysBetween('2026-09-02', '2026-10-22').map((d) => row(d));
  const o = V.overview({
    rows: flat.filter((r) => r.day >= '2026-10-01'),
    history: flat.filter((r) => r.day < '2026-10-01'),
    today: '2026-10-22',
  });
  assert.deepEqual([o.forecastMethod, o.forecast.early, o.forecast.low, o.forecast.high], ['weekday', false, 31, 31]);
  assert.equal(U.costBandShown(o.forecast), false);
  const html = U.costOverviewHtml(o, CTX);
  assert.match(html, /day 22 of 31 · Forecast: weekday pattern of the last 4 weeks</);
  assert.doesNotMatch(html, /percentile/);
  // Fewer than 3 usable day ratios: the band is the line too.
  const three = [1, 1, 1].map((v, i) => row(`2026-10-0${i + 1}`, { listUSD: v }));
  const few = V.overview({ rows: three, today: '2026-10-04' });
  assert.equal(few.forecastMethod, 'mean');
  assert.equal(U.costBandShown(few.forecast), false);
  assert.equal(U.costBandShown({ early: true, line: [{ low: null, high: null }] }), false);
  // Days of the same weekday alternate 1 and 2: a band with a width, and the meta names it.
  const varied = daysBetween('2026-09-02', '2026-10-22').map((d, i) => row(d, { listUSD: 1 + (i % 2) }));
  const wide = V.overview({
    rows: varied.filter((r) => r.day >= '2026-10-01'),
    history: varied.filter((r) => r.day < '2026-10-01'),
    today: '2026-10-22',
  });
  assert.ok(wide.forecast.low < wide.forecast.high);
  assert.match(U.costOverviewHtml(wide, CTX), /weekday pattern of the last 4 weeks · band: 25th–75th percentile days</);
  assert.equal(
    U.costBandShown({
      early: false,
      line: [
        { low: 1, high: 1 },
        { low: 1.5, high: 2.5 },
      ],
    }),
    true,
  );
});

test('the Anomalies meta rounds the ratio to 2 decimals', () => {
  assert.equal(
    U.costAnomalyMeta({ ratio: 2.123456, minUSD: 1 }),
    'over 2.12× the usual amount and at least $1.00 more · usage value in USD',
  );
  assert.match(U.costAnomalyMeta({ ratio: 3, minUSD: 0.5 }), /^over 3× the usual amount and at least \$0\.50 more/);
  assert.match(U.costAnomalyMeta(null), /^over 2× /);
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

/* ---------- Budgets, the bell and the Monitors card ---------- */

const M = require('../public/monitorsview');
const budgetView = (over = {}) => ({
  id: 'team',
  name: 'Team',
  scope: 'global',
  period: 'month',
  amount: 500,
  currency: 'USD',
  measure: 'list',
  thresholds: [50, 80],
  projection: true,
  enforce: 'none',
  legacy: null,
  from: '2026-11-01',
  to: '2026-11-30',
  state: 'warn_50',
  projected: false,
  spent: 260,
  amountUSD: 500,
  percent: 52,
  forecastUSD: 412,
  runsOut: null,
  reason: null,
  ...over,
});

test('a budget card: the runs-out date, or that it stays under with the forecast in its currency, or nothing', () => {
  assert.equal(
    U.costForecastLine(budgetView({ runsOut: '2026-11-21', forecastUSD: 640 })),
    'Runs out ~21 Nov at this pace',
  );
  assert.equal(U.costForecastLine(budgetView()), 'Stays under the amount this period (forecast $412.00)');
  assert.equal(
    U.costForecastLine(budgetView({ currency: 'IDR', amount: 1650000, amountUSD: 100, forecastUSD: 50 })),
    'Stays under the amount this period (forecast IDR 825,000)',
  );
  for (const over of [{ forecastUSD: null }, { state: 'exceeded', forecastUSD: 700 }, { state: 'no_data' }])
    assert.equal(U.costForecastLine(budgetView(over)), '', JSON.stringify(over));
  const card = U.costBudgetCardHtml(
    budgetView({ name: EVIL, runsOut: '2026-11-21' }),
    { centers: {}, keys: {} },
    false,
  );
  assert.match(card, /<p class="cost-card-forecast">Runs out ~21 Nov at this pace<\/p>/);
  assert.doesNotMatch(card, /<img/);
  assert.doesNotMatch(U.costBudgetCardHtml(budgetView({ forecastUSD: null }), {}, false), /cost-card-forecast/);
});

test('the bell: a cost anomaly reads its day, spend and usual amount, and links to the Overview', () => {
  const a = (over) => ({
    id: 'a1',
    ts: null,
    rule: 'cost_anomaly',
    ruleTitle: 'Cost anomaly',
    instance: 'x',
    sessionKey: null,
    title: 'Wed 28 Oct (so far)',
    value: 18.4,
    threshold: 12.2,
    usual: 6.1,
    state: 'triggered',
    previous: null,
    ...over,
  });
  const l = M.alertLine(a(), []);
  assert.equal(l.text, 'Cost anomaly · Wed 28 Oct (so far): $18.40, usual $6.10');
  assert.deepEqual([l.change, l.tone, l.costHref, l.session], ['Triggered', 'bad', '#cost', null]);
  const row = M.monAlertRow(l, false);
  assert.match(row, /<a class="mon-session" href="#cost">Open in Cost Control →<\/a>/);
  assert.match(row, /<div class="mon-measure">Wed 28 Oct \(so far\): \$18\.40, usual \$6\.10<\/div>/);
  const ok = M.alertLine(a({ state: 'ok', previous: 'triggered', title: 'Tue 27 Oct', value: 3, usual: 2 }), []);
  assert.equal(ok.text, 'Cost anomaly · Resolved · Tue 27 Oct: $3.00, usual $2.00');
  assert.equal(M.alertLine(a({ usual: null }), []).text, 'Cost anomaly · Wed 28 Oct (so far): $18.40');
  assert.doesNotMatch(M.monAlertRow(M.alertLine(a({ title: EVIL }), []), false), /<img/);
});

test('the Monitors card: the two parameters, and each day today first', () => {
  const rule = {
    id: 'cost_anomaly',
    title: 'Cost anomaly',
    describe: "Today's or yesterday's spend is well above what the same weekday usually costs.",
    kind: 'aggregate',
    enabled: true,
    state: 'triggered',
    params: { ratio: 2, minUSD: 1 },
    defaults: { ratio: 2, minUSD: 1 },
    autoPause: false,
    mayAutoPause: false,
    instances: [
      { instance: '2026-10-27', title: 'Tue 27 Oct', state: 'ok', value: 3, threshold: 4 },
      { instance: '2026-10-28', title: 'Wed 28 Oct (so far)', state: 'triggered', value: 18.4, threshold: 12.2 },
      { title: null, state: 'no_data', value: null, threshold: null },
    ],
  };
  const html = M.monRuleCard(rule, { pause: false });
  assert.match(html, /Times the usual amount<input[^>]*data-mon-param="ratio"/);
  assert.match(html, /Minimum rise \(USD\)<input[^>]*data-mon-param="minUSD"/);
  assert.equal(
    M.monRuleNow(rule),
    'Wed 28 Oct (so far): $18.40 spent against an anomaly level of $12.20 · Tue 27 Oct: $3.00 spent against an anomaly level of $4.00',
  );
  const young = {
    ...rule,
    instances: [{ title: 'Wed 28 Oct (so far)', state: 'no_data', value: null, threshold: null }],
  };
  assert.equal(M.monRuleNow(young), 'Wed 28 Oct (so far): not enough history');
});

test('the bell: a state named like an Object member is muted, with no function text', () => {
  const l = M.alertLine(
    {
      id: 1,
      ts: 1,
      rule: 'cost_anomaly',
      ruleTitle: 'Cost anomaly',
      state: 'constructor',
      title: 'Wed 28 Oct',
      value: 3,
    },
    [],
  );
  assert.equal(l.tone, 'muted');
  assert.doesNotMatch(l.text, /function|native code/);
});

test('the rule card lists the day instances newest first whatever order the server sent', () => {
  const inst = (instance, title) => ({ instance, title, state: 'ok', value: 1, threshold: 2 });
  const out = M.monRuleNow({
    id: 'cost_anomaly',
    enabled: true,
    kind: 'cost',
    instances: [
      inst('2026-10-27', 'Tue 27 Oct'),
      inst('2026-10-28', 'Wed 28 Oct (so far)'),
      inst('2026-10-26', 'Mon 26 Oct'),
    ],
  });
  assert.deepEqual(
    out.split(' · ').map((s) => s.split(':')[0]),
    ['Wed 28 Oct (so far)', 'Tue 27 Oct', 'Mon 26 Oct'],
  );
});
