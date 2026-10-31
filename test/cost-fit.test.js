'use strict';
// Cost Control layout polish: the charts draw at their panel's width (public/costcharts.js `width`, public/costview.js
// costFitCharts) so their text keeps its size on a narrow screen, crowded labels thin out or move apart, and the
// styles keep panels apart and tables inside their panels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('../lib/cost/views');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const C = require('../public/costcharts');
const U = require('../public/costview');

const fmt = (v) => `$${Number(v || 0).toFixed(2)}`;
const viewBox = (svg) =>
  svg
    .match(/viewBox="0 0 (\d+) (\d+)"/)
    .slice(1)
    .map(Number);
const count = (s, re) => (s.match(re) || []).length;
const row = (day, listUSD) => ({
  day,
  source: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: '~/acme-web',
  center: 'platform',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD,
  billedUSD: listUSD,
});
const month = () => {
  const rows = [];
  for (let d = 1; d <= 30; d++) rows.push(row(`2026-10-${String(d).padStart(2, '0')}`, 1 + (d % 4)));
  return V.overview({ rows, today: '2026-10-30' });
};
// The x-axis labels: the text at the chart's bottom line.
const xLabels = (svg) => {
  const H = viewBox(svg)[1];
  return count(svg, new RegExp(`<text x="[\\d.]+" y="${H - 6}" text-anchor="middle">`, 'g'));
};

test('fit: without a width each chart keeps its default drawing and names itself for the page', () => {
  const o = month();
  const burn = C.costBurnSvg(o, fmt);
  assert.deepEqual(viewBox(burn), [1100, 300]);
  assert.match(burn, /data-cost-fit="burn"/);
  assert.deepEqual(viewBox(C.costSpikeSvg(o.spikes, fmt)), [640, 170]);
  assert.match(C.costSpikeSvg(o.spikes, fmt), /data-cost-fit="spikes"/);
  const unit = [{ day: '2026-10-01', perRequest: 1 }];
  assert.match(C.costUnitSvg(unit, 'perRequest', fmt, '#fff'), /data-cost-fit="unit:perRequest"/);
  const w = { withoutCache: 2, cacheSaved: 1, usage: 1, planSaved: 0, paid: 1 };
  assert.match(C.costWaterfallSvg(w, fmt), /data-cost-fit="waterfall"/);
  // The calendar keeps its drawn size: it is never redrawn.
  assert.doesNotMatch(C.costCalendarSvg({ days: [] }, fmt), /data-cost-fit/);
});

test('fit: a measured width is the drawing width, never below the chart minimum; the burn-down gets shorter', () => {
  const o = month();
  assert.deepEqual(viewBox(C.costBurnSvg(o, fmt, { width: 760 })), [760, 228]);
  assert.deepEqual(viewBox(C.costBurnSvg(o, fmt, { width: 320 })), [320, 200]);
  assert.deepEqual(viewBox(C.costBurnSvg(o, fmt, { width: 1400 })), [1400, 300]);
  assert.equal(viewBox(C.costBurnSvg(o, fmt, { width: 90 }))[0], 280);
  assert.equal(viewBox(C.costSpikeSvg(o.spikes, fmt, { width: 300.4 }))[0], 300);
  assert.equal(viewBox(C.costSpikeSvg(o.spikes, fmt, { width: 100 }))[0], 260);
  const flow = { columns: ['source'], nodes: [], links: [] };
  assert.equal(viewBox(C.costFlowSvg(flow, { fmt, label: (c, k) => k, width: 320 }))[0], 600);
  assert.equal(viewBox(C.costFlowSvg(flow, { fmt, label: (c, k) => k, width: 1000 }))[0], 1000);
});

test('fit: a narrow chart shows fewer x-axis labels, so they never run into each other', () => {
  const o = month();
  assert.equal(xLabels(C.costBurnSvg(o, fmt)), 8);
  assert.ok(xLabels(C.costBurnSvg(o, fmt, { width: 300 })) < 8);
  assert.ok(xLabels(C.costBurnSvg(o, fmt, { width: 300 })) >= 2);
  const wide = xLabels(C.costSpikeSvg(o.spikes, fmt));
  const narrow = xLabels(C.costSpikeSvg(o.spikes, fmt, { width: 280 }));
  assert.ok(narrow < wide && narrow >= 2, `${narrow} < ${wide}`);
  const unit = o.spikes.map((s) => ({ day: s.day, perRequest: 1 }));
  assert.ok(xLabels(C.costUnitSvg(unit, 'perRequest', fmt, '#fff', { width: 200 })) <= 3);
});

test('fit: a waterfall step too narrow for its name puts it on two lines', () => {
  const w = { withoutCache: 5, cacheSaved: 1, usage: 4, planSaved: -2, paid: 6 };
  assert.doesNotMatch(C.costWaterfallSvg(w, fmt), /<tspan/);
  const narrow = C.costWaterfallSvg(w, fmt, { width: 300 });
  assert.match(narrow, /<tspan x="[\d.]+">Plan cost<\/tspan><tspan x="[\d.]+" dy="12">more<\/tspan>/);
  assert.match(narrow, />Paid</, 'a one-word name stays on one line');
});

test('fit: scatter labels of two models at about the same place are a line apart', () => {
  const dot = (model, perRequest) => ({
    model,
    perRequest,
    accuracy: 0.995,
    requests: 100,
    toolResults: 100,
    littleData: false,
    passRate: null,
  });
  const svg = C.costScatterSvg({ dots: [dot('model-a', 0.01), dot('model-b', 0.0101)], noToolCalls: [] }, fmt);
  const ys = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"(?: text-anchor="end")?>model-[ab]</g)].map((m) => +m[1]);
  assert.equal(ys.length, 2);
  assert.ok(Math.abs(ys[0] - ys[1]) >= 12, ys.join(' '));
  // A label never runs across another model's dot: it moves under it.
  const near = C.costScatterSvg(
    { dots: [dot('model-a', 0.002), dot('model-b', 0.003), dot('model-c', 0.05)], noToolCalls: [] },
    fmt,
  );
  const circles = [...near.matchAll(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
  const [, aY] = near.match(/<text x="[\d.]+" y="([\d.]+)">model-a</);
  const [bx, by, br] = circles[1];
  assert.ok(+aY - 10 >= by + br, `label top ${+aY - 10} under dot bottom ${by + br} at x ${bx}`);
  // Apart from each other, each label stays beside its own dot.
  const far = C.costScatterSvg({ dots: [dot('model-a', 0.001), dot('model-b', 0.05)], noToolCalls: [] }, fmt);
  const ys2 = [...far.matchAll(/y="([\d.]+)"(?: text-anchor="end")?>model-[ab]</g)].map((m) => +m[1]);
  assert.equal(ys2[0], ys2[1]);
});

// The page's helpers of public/iso.js, stood in for as in test/cost-ui.test.js.
function pageGlobals() {
  Object.assign(global, C, {
    COST_C: { cyan: '#4de8ff', violet: '#8b7bff', pink: '#ff4fd8', orange: '#ff9a3c', muted: '#8f98cc' },
    COST_SERIES: ['#4de8ff'],
    metricTile: ({ label, value, sub }) => `<div class="metric">${label}|${value}|${sub}</div>`,
    panel: (title, meta, body) => `<section><h3>${title}</h3>${meta}${body}</section>`,
    holoEmpty: (text) => `<div class="empty">${text}</div>`,
  });
}
const fits = (html) => [...html.matchAll(/data-cost-fit="([^"]+)"/g)].map((m) => m[1]).sort();

test('fit: the page has a redraw for every chart it names, with the same data', () => {
  pageGlobals();
  const ctx = { measure: 'list', cur: 'USD', fmt, centers: {}, keys: {} };
  const o = { ...month(), budgetsError: null, anomalies: null, anomalyParams: null };
  const draws = U.costChartDraws('overview', o, ctx);
  assert.deepEqual(fits(U.costOverviewHtml(o, ctx)), Object.keys(draws).sort());
  assert.equal(draws.burn(), C.costBurnSvg(o, fmt), 'without a width, the redraw is the first paint');
  assert.deepEqual(viewBox(draws.burn(500)), [500, 200]);

  const unit = [{ day: '2026-10-01', perRequest: 1, perMillionTokens: 2, perThousandToolCalls: 3 }];
  const dot = { model: 'm', perRequest: 1, accuracy: 0.9, requests: 1, toolResults: 1, littleData: false };
  const v = {
    plans: [],
    waterfall: { withoutCache: 1, cacheSaved: 0, usage: 1, planSaved: 0, paid: 1 },
    local: { requests: 0, tokens: 0, models: [] },
    scatter: { dots: [dot], noToolCalls: [] },
    unit,
    accuracyError: null,
  };
  const vd = U.costChartDraws('value', v, ctx);
  assert.deepEqual(fits(U.costValueHtml(v, ctx)), Object.keys(vd).sort());
  for (const k of Object.keys(vd)) assert.match(vd[k](400), new RegExp(`data-cost-fit="${k}"`));
  assert.match(vd['unit:perMillionTokens'](), /stroke="#8b7bff"/, 'each unit line keeps its color');
});

test('fit: costFitCharts redraws a chart at its box width less padding, the chart only, and leaves a fitting one', () => {
  const made = [];
  const svg = (key, drawn, boxWidth) => {
    const s = {
      dataset: { costFit: key },
      viewBox: { baseVal: { width: drawn } },
      parentElement: { clientWidth: boxWidth, pad: '16px' },
      replaceWith(next) {
        s.replaced = next;
      },
    };
    return s;
  };
  const a = svg('burn', 1100, 532);
  const b = svg('spikes', 499, 532); // 532 - 2×16 = 500: within 2 px, kept
  const c = svg('gone', 640, 300); // no redraw for it on this page: kept
  global.getComputedStyle = (el) => ({ paddingLeft: el.pad, paddingRight: el.pad });
  global.document = {
    createElement: () => {
      const t = {
        set innerHTML(html) {
          made.push(html);
          t.html = html;
        },
        content: { querySelector: (sel) => (sel === 'svg' ? { svg: t.html } : null) },
      };
      return t;
    },
  };
  U.COST.draws = { burn: (w) => `<svg w="${w}"></svg><p>note</p>`, spikes: () => 'never' };
  U.costFitCharts({ querySelectorAll: () => [a, b, c] });
  assert.deepEqual(made, ['<svg w="500"></svg><p>note</p>']);
  assert.deepEqual(a.replaced, { svg: '<svg w="500"></svg><p>note</p>' });
  assert.equal(b.replaced, undefined);
  assert.equal(c.replaced, undefined);
  U.costFitCharts(null); // no page body: nothing to do
  delete global.document;
  delete global.getComputedStyle;
  U.COST.draws = {};
});

test('styles: panels keep a gap, tables stay in their panels, the report never widens the page', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const rule = (sel) => {
    const i = css.indexOf(`\n${sel} {`);
    assert.ok(i >= 0, sel);
    return css.slice(i, css.indexOf('}', i));
  };
  assert.match(rule('#cost-body'), /gap: 16px/);
  assert.match(css, /\.cost-deck > div:empty \{\s*display: none;/);
  assert.match(css, /\n\.cost-table td \{\n  white-space: normal;/);
  assert.match(rule('.cost-report'), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule('.cost-rep-tables'), /minmax\(min\(100%, 440px\), 1fr\)/);
  assert.match(rule('.cost-rep-section'), /overflow-x: auto/);
  assert.match(rule('.cost-flow'), /min-width: 600px/);
  assert.match(rule('.cost-card'), /grid-template-rows: minmax\(0, 1fr\) auto/);
});

test('settings: every table sits in its own scroll box', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'costsettings.js'), 'utf8');
  const tables = count(src, /<table /g);
  assert.ok(tables >= 4);
  assert.equal(count(src, /<div class="cost-scroll-x"><table /g), tables);
});
