// Cost Control charts (public/costcharts.js), Value: plan bars, the savings waterfall, local models, the cost against
// quality scatter and the unit-cost lines, on the data of lib/cost/views.js value().
const test = require('node:test');
const assert = require('node:assert/strict');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const C = require('../public/costcharts');

const fmt = (v) => `$${Number(v || 0).toFixed(2)}`;
const EVIL = '<img src=x onerror=alert(1)>';
const count = (s, re) => (s.match(re) || []).length;

test('plan bars: usage value against the fee with the multiplier; under 1× orange and said so', () => {
  const html = C.costPlanBarsHtml(
    [
      { source: 'claude', plan: EVIL, days: 30, value: 41, fee: 10, multiplier: 4.1 },
      { source: 'codex', plan: 'Pro', days: 30, value: 3, fee: 5, multiplier: 0.6 },
    ],
    fmt,
    (s) => ({ claude: 'Claude Code', codex: 'Codex' })[s],
  );
  assert.match(html, /4\.1× the fee/);
  assert.match(html, /0\.60× the fee/);
  assert.equal(count(html, /The plan cost more than metered use would have\./g), 1);
  assert.equal(count(html, /class="cost-plan under"/g), 1);
  assert.match(html, /width:100\.0%/, 'the largest bar fills the row');
  assert.doesNotMatch(html, /<img/);
  assert.equal(C.costPlanBarsHtml([], fmt, String), '');
});

test('waterfall: four steps, savings down, a dearer plan up, labels as text', () => {
  const svg = C.costWaterfallSvg({ withoutCache: 53, cacheSaved: 8, usage: 45, planSaved: 30, paid: 15 }, fmt);
  assert.equal(count(svg, /class="cost-grow"/g), 4);
  for (const t of ['Without cache', 'Cache savings', 'Plan savings', 'Paid']) assert.match(svg, new RegExp(`>${t}<`));
  assert.match(svg, />−\$8\.00</);
  assert.match(svg, />−\$30\.00</);
  assert.match(svg, />\$15\.00</);
  const up = C.costWaterfallSvg({ withoutCache: 1, cacheSaved: 0, usage: 1, planSaved: -2, paid: 3 }, fmt);
  assert.match(up, />Plan cost more</);
  assert.match(up, />\+\$2\.00</);
});

test('local models: requests and tokens only, with the note; none in the range says so', () => {
  const html = C.costLocalHtml({
    requests: 25,
    tokens: 1570,
    models: [{ model: EVIL, source: 'judge', requests: 25, tokens: 1570 }],
  });
  assert.match(html, /Not priced: these run on your own machine\. A later version compares them with a cloud model\./);
  assert.match(html, />1,570</);
  assert.doesNotMatch(html, /<img|\$/);
  assert.match(C.costLocalHtml({ requests: 0, tokens: 0, models: [] }), /No local model calls/);
});

test('scatter: a dot per model, hollow and labeled with little data, pass rate in the tooltip', () => {
  const svg = C.costScatterSvg(
    {
      dots: [
        {
          model: 'claude-opus-5-5',
          requests: 400,
          spend: 10,
          perRequest: 0.025,
          accuracy: 0.98,
          toolResults: 900,
          littleData: false,
          passRate: { pass: 3, total: 4, rate: 0.75 },
        },
        {
          model: EVIL,
          requests: 10,
          spend: 1,
          perRequest: 0.1,
          accuracy: 1,
          toolResults: 12,
          littleData: true,
          passRate: null,
        },
      ],
      noToolCalls: [],
    },
    fmt,
  );
  assert.equal(count(svg, /class="cost-dot"/g), 2);
  assert.equal(count(svg, /fill="none"/g), 1, 'the little-data dot is hollow');
  assert.match(svg, /little data/);
  assert.match(svg, /Datasets pass rate 75% \(3\/4\)/);
  assert.doesNotMatch(svg, /<img/);
});

test('unit line: one path broken where a day has no denominator, a dot for a lone day', () => {
  const unit = [
    { day: '2026-10-01', perRequest: 2 },
    { day: '2026-10-02', perRequest: 3 },
    { day: '2026-10-03', perRequest: null },
    { day: '2026-10-04', perRequest: 1 },
    { day: '2026-10-05', perRequest: null },
  ];
  const svg = C.costUnitSvg(unit, 'perRequest', fmt, '#4de8ff');
  const d = /class="cost-line" pathLength="1" d="([^"]*)"/.exec(svg)[1];
  assert.equal(count(d, /M/g), 2, 'a gap, not a zero');
  assert.equal(count(svg, /<circle/g), 1, 'the lone day');
  assert.match(svg, /data-tip="3 Oct · no data"/);
});

test('scatter: when accuracy could not be read it says so; models with no tool calls are listed escaped', () => {
  const err = C.costScatterSvg({ dots: [], noToolCalls: [{ model: EVIL }] }, fmt, { accuracyError: 'x' });
  assert.match(err, /Tool-call accuracy could not be read\./);
  assert.doesNotMatch(err, /no tool calls|<img/i);
  const ok = C.costScatterSvg({ dots: [], noToolCalls: [{ model: EVIL }] }, fmt);
  assert.match(ok, /No tool calls to measure: &lt;img/);
  assert.doesNotMatch(ok, /<img/);
});

test('plan, local and unit rows show the source and label escaped once; charts carry labels', () => {
  const local = C.costLocalHtml({
    requests: 1,
    tokens: 1,
    models: [{ model: 'm', source: EVIL, requests: 1, tokens: 1 }],
  });
  assert.match(local, /&lt;img src=x/);
  assert.doesNotMatch(local, /&amp;lt;/);
  const w = C.costWaterfallSvg({ withoutCache: 2, cacheSaved: 1, usage: 1, planSaved: 0, paid: 1 }, fmt);
  assert.match(w, /aria-label="Savings waterfall"/);
  assert.match(
    C.costUnitSvg([{ day: '2026-10-01', perRequest: 1 }], 'perRequest', fmt, '#fff'),
    /aria-label="Unit cost per request"/,
  );
});

test('fix round 1: multiplier below 1x keeps two decimals, a zero step has no sign', () => {
  const p = (multiplier) => ({ source: 'claude', plan: 'P', days: 30, value: 1, fee: 1, multiplier });
  assert.match(C.costPlanBarsHtml([p(0.96)], fmt, String), />0\.96× the fee</);
  assert.match(C.costPlanBarsHtml([p(4.14)], fmt, String), />4\.1× the fee</);
  const svg = C.costWaterfallSvg({ withoutCache: 5, cacheSaved: 0, usage: 5, planSaved: 0, paid: 5 }, fmt);
  assert.match(svg, />\$0\.00</);
  assert.doesNotMatch(svg, />[−+]\$0\.00</);
});

test('fix round 1: waterfall upward step spans paid (top) to usage (bottom)', () => {
  const svg = C.costWaterfallSvg({ withoutCache: 10, cacheSaved: 0, usage: 10, planSaved: -10, paid: 20 }, fmt);
  const rects = [
    ...svg.matchAll(/<rect class="cost-grow" x="[^"]*" y="([\d.]+)" width="[^"]*" height="([\d.]+)"/g),
  ].map((m) => [Number(m[1]), Number(m[2])]);
  const [paidTop] = rects[3];
  const [upTop, upH] = rects[2];
  assert.equal(upTop, paidTop, 'the bar top is at paid');
  assert.ok(Math.abs(upTop + upH - rects[0][0]) < 0.11, 'the bottom is at usage');
});

test('fix round 1: scatter edge dots stay inside the viewBox; right-hand labels end at the dot', () => {
  const dot = (model, perRequest, accuracy) => ({
    model,
    requests: 100,
    spend: 1,
    perRequest,
    accuracy,
    toolResults: 100,
    littleData: false,
    passRate: null,
  });
  const svg = C.costScatterSvg({ dots: [dot('a', 0.01, 0.9), dot('far', 1, 1)], noToolCalls: [] }, fmt);
  const cs = [...svg.matchAll(/<circle[^>]* cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) =>
    m.slice(1).map(Number),
  );
  for (const [cx, cy, r] of cs) {
    assert.ok(cx + r <= 1100 && cx - r >= 0 && cy - r >= 0 && cy + r <= 320);
  }
  assert.match(svg, /text-anchor="end"[^>]*>far</);
});

test('fix round 1: unit charts are named by key; local rows use the source label; no dots says so', () => {
  const u = [{ day: '2026-10-01', perRequest: 1 }];
  assert.match(C.costUnitSvg(u, 'perRequest', fmt, '#fff'), /aria-label="Unit cost per request"/);
  assert.match(C.costUnitSvg(u, 'perMillionTokens', fmt, '#fff'), /aria-label="Unit cost per million tokens"/);
  assert.match(
    C.costUnitSvg(u, 'perThousandToolCalls', fmt, '#fff'),
    /aria-label="Unit cost per 1,000 successful tool calls"/,
  );
  const l = C.costLocalHtml(
    { requests: 1, tokens: 1, models: [{ model: 'm', source: 'judge', requests: 1, tokens: 1 }] },
    () => EVIL,
  );
  assert.match(l, /<td>&lt;img src=x/);
  assert.doesNotMatch(l, /&amp;lt;|<img/);
  assert.match(C.costScatterSvg({ dots: [], noToolCalls: [] }, fmt), /No model had requests in this range\./);
});
