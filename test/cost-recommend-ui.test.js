// Cost Control 4b in the browser file, without a browser: the Value page's Recommendations card (public/costview.js),
// its row texts, empty states, plan footnote and experiment link. Every model, dataset and experiment name reaches the
// markup through esc().
const test = require('node:test');
const assert = require('node:assert/strict');

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
const ENDED = new Date(2026, 9, 12, 15).getTime(); // 12 Oct, local time
const rec = (over = {}) => ({
  model: 'claude-opus-5-5',
  candidate: 'claude-sonnet-5-5',
  local: false,
  spendUSD: 135.2,
  savingUSD: 42.4,
  costRatio: 0.3125,
  rateA: 0.93,
  rateB: 0.9083,
  rowsA: 120,
  rowsB: 120,
  experiment: { id: 'exp_00000000000000a0', dataset: 'support-tickets', datasetName: null, endedAt: ENDED },
  alsoBackedBy: 0,
  onPlan: false,
  ...over,
});
const answer = (over = {}) => ({
  items: [rec()],
  gaps: [{ model: 'gpt-6.1-sol', spendUSD: 13.45, reason: 'no_experiment' }],
  basis: { experiments: 1, from: '2026-09-29', to: '2026-10-28' },
  ...over,
});
const FOOT = 'Estimates from your own experiments and the last 30 days&#39; use. Nothing is switched for you.';

test('a recommendation row: the saving, the cost per example, the pass rates, the rows and the day', () => {
  assert.deepEqual(U.costRecTexts(rec()), {
    saving: "about $42 a month at the last 30 days' use (cost per example 31 % of today's)",
    rates: 'Pass rate 91 % vs 93 %',
    dataset: 'support-tickets',
    detail: '120 rows each, 12 Oct',
    more: '',
  });
  const t = U.costRecTexts(
    rec({ savingUSD: 4.256, rowsA: 40, rowsB: 38, alsoBackedBy: 1, experiment: { datasetName: 'Support tickets' } }),
  );
  assert.deepEqual(
    [t.saving.slice(0, 15), t.dataset, t.detail, t.more],
    ['about $4.26 a m', 'Support tickets', '38 and 40 rows', '+1 more experiment agrees'],
  );
  assert.equal(U.costRecTexts(rec({ alsoBackedBy: 3 })).more, '+3 more experiments agree');
  assert.equal(U.costAbout(1234.5), '$1,235');
  assert.equal(U.costPercent(0), '0 %');
  for (const v of [null, undefined, NaN, 'x']) assert.equal(U.costPercent(v), '—', String(v));
});

test('the experiment link opens its run in Datasets; without an id, the Experiments tab', () => {
  assert.equal(U.costExperimentHref('exp_00000000000000a0'), '#datasets/experiments?run=exp_00000000000000a0');
  assert.equal(U.costExperimentHref('a&b'), '#datasets/experiments?run=a%26b');
  for (const bad of [null, undefined, '', 7]) assert.equal(U.costExperimentHref(bad), '#datasets/experiments');
  const html = U.costRecommendationsHtml(answer());
  assert.match(html, /<a href="#datasets\/experiments\?run=exp_00000000000000a0">/);
  assert.match(html, /Pass rate 91 % vs 93 % on <i>support-tickets<\/i> \(120 rows each, 12 Oct\)<\/a>/);
});

test('the card: rows, a local chip, the experiments that agree, the gaps and the footnote', () => {
  const html = U.costRecommendationsHtml(
    answer({
      items: [rec(), rec({ model: 'gpt-6.1-sol', candidate: 'qwen3-coder:30b', local: true, alsoBackedBy: 2 })],
      gaps: [
        { model: 'claude-sonnet-5-5', spendUSD: 33.23, reason: 'no_cheaper_match' },
        { model: 'deepseek-chat', spendUSD: 1.22, reason: 'no_experiment' },
      ],
    }),
  );
  assert.match(html, /<b>claude-opus-5-5 → claude-sonnet-5-5<\/b>: about \$42 a month at the last 30 days&#39; use/);
  assert.equal(html.match(/<span class="cost-chip">local<\/span>/g).length, 1, 'only the local candidate');
  assert.match(html, /\+2 more experiments agree/);
  assert.match(html, /No evidence yet/);
  assert.match(html, /<b>claude-sonnet-5-5<\/b> · \$33\.23 in the last 30 days · No cheaper model did as well/);
  assert.match(html, /<b>deepseek-chat<\/b> · \$1\.22 in the last 30 days · No experiment yet/);
  assert.equal(html.match(/<a href="#datasets">Run an experiment in Datasets<\/a>/g).length, 2);
  assert.ok(html.endsWith(`<p class="cost-note">${FOOT}</p>`), 'no plan sentence');
  assert.doesNotMatch(html, /Run an experiment in Datasets to compare/);
});

test('the footnote says so when a recommended model ran under a plan', () => {
  const html = U.costRecommendationsHtml(answer({ items: [rec({ onPlan: true })] }));
  assert.ok(
    html.endsWith(
      `${FOOT} Some of this use was covered by a plan: switching there saves usage value, not money paid.</p>`,
    ),
  );
  const gapOnly = U.costRecommendationsHtml(answer({ items: [] }));
  assert.doesNotMatch(gapOnly, /covered by a plan/);
});

test('empty states: could not be computed, no spend, no experiments', () => {
  for (const bad of [null, undefined, {}, { items: [] }])
    assert.equal(
      U.costRecommendationsHtml(bad),
      '<p class="cost-note warn">Recommendations could not be computed right now</p>',
    );
  assert.equal(
    U.costRecommendationsHtml(answer({ items: [], gaps: [] })),
    '<div class="empty">No model spend in the last 30 days</div>',
  );
  const none = U.costRecommendationsHtml(answer({ items: [], basis: { experiments: 0 } }));
  assert.ok(
    none.startsWith('<p class="cost-note">Run an experiment in Datasets to compare models on your own examples</p>'),
  );
  assert.match(none, /No evidence yet/);
});

test('every model, dataset and experiment name goes through esc()', () => {
  const html = U.costRecommendationsHtml(
    answer({
      items: [
        rec({
          model: EVIL,
          candidate: `${EVIL}2`,
          experiment: { id: `"><script>x</script>`, dataset: EVIL, datasetName: `<b>${EVIL}</b>`, endedAt: ENDED },
        }),
      ],
      gaps: [{ model: `${EVIL}3`, spendUSD: 1, reason: EVIL }],
    }),
  );
  assert.doesNotMatch(html, /<img|<script|<b><img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; → &lt;img src=x onerror=alert\(1\)&gt;2/);
  assert.match(html, /href="#datasets\/experiments\?run=%22%3E%3Cscript%3Ex%3C%2Fscript%3E"/);
  assert.match(html, /<i>&lt;b&gt;&lt;img src=x onerror=alert\(1\)&gt;&lt;\/b&gt;<\/i>/);
  assert.match(html, /No experiment yet/, 'an unknown reason reads as no experiment');
});

test('the Value page places the Recommendations card after its charts', () => {
  const v = {
    plans: [],
    waterfall: { withoutCache: 0, cacheSaved: 0, usage: 0, planSaved: 0, paid: 0 },
    local: { requests: 0, tokens: 0, models: [] },
    scatter: { dots: [], noToolCalls: [] },
    unit: [{ day: '2026-10-01', perRequest: 1, perMillionTokens: 1, perThousandToolCalls: null }],
    accuracyError: null,
    recommendations: answer(),
  };
  const html = U.costValueHtml(v, { measure: 'list', cur: 'USD', fmt: (x) => U.costMoney(x), centers: {}, keys: {} });
  const at = html.indexOf('<h3>Recommendations</h3>');
  assert.ok(at > html.indexOf('Per 1,000 successful tool calls'), 'after the unit charts');
  assert.match(html.slice(at), /claude-opus-5-5 → claude-sonnet-5-5/);
  assert.match(
    U.costValueHtml({ ...v, recommendations: null }, { fmt: (x) => U.costMoney(x) }),
    /Recommendations could not be computed right now/,
  );
});
