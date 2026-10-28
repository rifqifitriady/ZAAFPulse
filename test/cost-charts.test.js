// Cost Control charts (public/costcharts.js), Overview and Breakdown: the SVG builders run in Node on the data of
// lib/cost/views.js, and an audit of the file for names from the server put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const V = require('../lib/cost/views');

// The page's esc() lives in public/app.js; the builders call it, so the tests give them the same one.
global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const C = require('../public/costcharts');

const SRC = path.join(__dirname, '..', 'public', 'costcharts.js');
const fmt = (v) => `$${Number(v || 0).toFixed(2)}`;
const EVIL = '<img src=x onerror=alert(1)>';
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'claude',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  project: '~/acme-web',
  center: 'platform',
  kind: 'chat',
  requests: 1,
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  listUSD: 1,
  billedUSD: 1,
  ...over,
});
const count = (s, re) => (s.match(re) || []).length;

test('helpers: a nice axis top, a day label without a Date, a path broken at a gap', () => {
  assert.deepEqual([C.costNiceMax(0), C.costNiceMax(7.2), C.costNiceMax(1234)], [1, 8, 1500]);
  assert.equal(C.costDayLabel('2026-10-05'), '5 Oct');
  assert.equal(
    C.costPath([
      [0, 1],
      [1, null],
      [2, 3],
      [3, 4],
    ]),
    'M0.0,1.0M2.0,3.0L3.0,4.0',
  );
});

test('burn-down: actual line, forecast, band only past the third day, budget lines named as text', () => {
  const rows = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [{ id: 'b', name: EVIL, scope: 'global', period: 'month', amount: 100, currency: 'USD' }];
  const svg = C.costBurnSvg(V.overview({ rows, today: '2026-10-05', budgets }), fmt);
  assert.equal(count(svg, /class="cost-band"/g), 1);
  assert.equal(count(svg, /class="cost-line"/g), 1);
  assert.match(svg, /&lt;img src=x onerror=alert\(1\)&gt; · \$100\.00/);
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /class="cost-today"/);
  assert.match(
    svg,
    />\$150\.00</,
    'the scale follows the band top (104.5 × 1.1, rounded up), the budget fits under it',
  );
  assert.equal(count(svg, /cost-pinned/g), 0);
  const early = C.costBurnSvg(V.overview({ rows: rows.slice(0, 2), today: '2026-10-02' }), fmt);
  assert.equal(count(early, /class="cost-band"/g), 0);
  assert.match(early, /early in the month/);
});

test('burn-down: a budget over twice the band top is pinned at the top edge and keeps the curve readable', () => {
  const rows = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [
    { id: 'big', name: 'Big', scope: 'global', period: 'month', amount: 1000, currency: 'USD' },
    { id: 'near', name: 'Near', scope: 'global', period: 'month', amount: 200, currency: 'USD' },
  ];
  const svg = C.costBurnSvg(V.overview({ rows, today: '2026-10-05', budgets }), fmt);
  assert.equal(count(svg, /class="cost-fade cost-pinned"/g), 1);
  assert.match(svg, />↑ Budget \$1000\.00</);
  assert.match(svg, /data-tip="Monthly budget · Big · \$1000\.00 · above this scale"/);
  assert.match(svg, />Near · \$200\.00</, '200 is within twice the band top (104.5): drawn as a line');
  assert.match(svg, />\$250\.00</, 'the axis tops at the nearer budget × 1.1, not at 1,000');
  const early = C.costBurnSvg(V.overview({ rows: rows.slice(0, 2), today: '2026-10-02', budgets }), fmt);
  // Without a band the forecast's end (1.5 × 31 = 46.5) sets the reach: both budgets are over twice it.
  assert.equal(count(early, /class="cost-fade cost-pinned"/g), 2);
});

test('burn-down: right-skewed spend keeps the forecast end inside the scale and a budget under it in scale', () => {
  // Six known days at a mean of 2.5, five of them at 0.4 of it: the band's top ratio (0.4) is raised to 1,
  // so the band ends at the forecast's end.
  const rows = [1, 1, 1, 1, 1, 10, 1].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const budgets = [{ id: 'b', name: 'B', scope: 'global', period: 'month', amount: 120, currency: 'USD' }];
  const o = V.overview({ rows, today: '2026-10-07', budgets });
  assert.ok(o.forecast.projected <= o.forecast.high, 'the band never ends under the forecast');
  const svg = C.costBurnSvg(o, fmt);
  assert.equal(count(svg, /cost-pinned/g), 0, 'the $120 budget is drawn as a line');
  assert.match(svg, />B · \$120\.00</);
  const d = svg.match(/<path class="cost-fade" d="([^"]*)" fill="none" stroke="#8b7bff"/)[1];
  const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ys.length > 2 && Math.min(...ys) > 14 + 0.5, 'the forecast is never clamped to the top margin');
  const top = Number([...svg.matchAll(/>\$(\d+)\.00</g)].map((m) => m[1]).sort((a, b) => b - a)[0]);
  assert.ok(top >= o.forecast.projected, 'the axis covers the projected total');
});

test('chart roles: the flow is a labelled group, image charts are labelled images', () => {
  const b = V.breakdown({ rows: [row()], from: '2026-10-01', to: '2026-10-07' });
  const flow = C.costFlowSvg(b.flow, { fmt, label: (c, k) => k });
  assert.match(flow, /role="group" aria-label="Cost flow"/);
  assert.doesNotMatch(flow, /role="img"/);
  assert.match(C.costCalendarSvg(b.calendar, fmt), /role="img" aria-label="Spend calendar"/);
  const o = V.overview({ rows: [row()], today: '2026-10-02' });
  assert.match(C.costBurnSvg(o, fmt), /role="img" aria-label="Burn-down"/);
  assert.match(C.costSpikeSvg(o.spikes, fmt), /role="img" aria-label="Daily spend"/);
});

test('burn-down: the axis reaches a forecast end above the band top, however it came about', () => {
  const rows = [1, 2, 3, 4, 10].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  const o = V.overview({ rows, today: '2026-10-05' });
  const skewed = { ...o, forecast: { ...o.forecast, projected: 400, low: 60, high: 100 } };
  const top = (svg) => Number([...svg.matchAll(/>\$(\d+)\.00</g)].map((m) => m[1]).sort((a, b) => b - a)[0]);
  assert.ok(top(C.costBurnSvg(skewed, fmt)) >= 400, 'the scale covers the projected total, not just the band');
});

test('spike line: one marker per spike, its tooltip with the baseline and the top model', () => {
  const history = Array.from({ length: 29 }, (_, i) =>
    row({ day: `2026-09-${String(i + 2).padStart(2, '0')}`, listUSD: 0.2 }),
  );
  const rows = [row({ listUSD: 0.5 }), row({ day: '2026-10-02', listUSD: 3, model: EVIL })];
  const o = V.overview({ rows, history, today: '2026-10-02' });
  const svg = C.costSpikeSvg(o.spikes, fmt);
  assert.equal(count(svg, /class="cost-spike"/g), 1);
  assert.match(svg, /data-tip="2 Oct · \$3\.00 · baseline \$0\.20 · spike · top model &lt;img/);
  assert.doesNotMatch(svg, /<img/);
  // A ledger that starts on the 1st: no baseline yet, so no dashed segment and no marker.
  const young = C.costSpikeSvg(V.overview({ rows: [row({ listUSD: 9 })], today: '2026-10-02' }).spikes, fmt);
  assert.match(young, /<path class="cost-fade" d="" /);
  assert.match(young, /data-tip="1 Oct · \$9\.00 · no baseline yet · top model claude-opus-5-5"/);
  assert.equal(count(young, /class="cost-spike"/g), 0);
});

test('rings: percent capped on the ring with a pink overflow arc; no data dashed; linked to the card', () => {
  const over = C.costRingSvg(125, 'exceeded');
  assert.match(over, />125%</);
  assert.equal(count(over, /<circle/g), 3, 'track, arc, overflow');
  assert.match(over, /stroke="#ff4fd8" stroke-width="2.4"/);
  const none = C.costRingSvg(null, 'none');
  assert.match(none, /stroke-dasharray="3 4"/);
  assert.match(none, />—</);
  assert.equal(count(C.costRingSvg(0, 'ok'), /<circle/g), 1, 'nothing to draw at 0 %');
  assert.equal(C.COST_TONE.warn, '#ff9a3c');
  const html = C.costRingsHtml(
    [{ id: 'team-1', name: EVIL, state: 'warn_80', tone: 'warn', percent: 85, projected: false }],
    3,
  );
  assert.match(html, /href="#cost\/budgets\?focus=team-1"/);
  assert.match(html, /\+ 3 more/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(C.costRingsHtml([], 0), '');
});

test('flow: nodes per column, a band per link, Other and Plan fee not filterable, names escaped', () => {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push(row({ model: i === 8 ? EVIL : `m${i}`, listUSD: i, billedUSD: i }));
  rows.push({
    ...row({ provider: null, model: null, center: null, kind: 'plan', requests: 0, listUSD: 0 }),
    billedUSD: 5,
  });
  const b = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07', measure: 'billed' });
  const svg = C.costFlowSvg(b.flow, {
    fmt,
    label: (col, key) => (key === '__other' ? 'Other' : key === '__plan' ? 'Plan fee' : key),
  });
  assert.equal(count(svg, /class="cost-link/g), b.flow.links.length);
  assert.equal(count(svg, /class="cost-node/g), b.flow.nodes.length);
  assert.match(svg, /data-cost-node="model:m7"/);
  assert.doesNotMatch(svg, /data-cost-node="model:__other"/);
  assert.doesNotMatch(svg, /data-cost-node="provider:__plan"/);
  assert.match(svg, />Plan fee</);
  assert.doesNotMatch(svg, /<img/);
});

test('flow: Other, Unknown and Plan fee are not filters (no button role, no tabindex, said in the tooltip); Unassigned is', () => {
  const rows = [];
  for (let i = 1; i <= 8; i++) rows.push(row({ model: `m${i}`, listUSD: i, billedUSD: i }));
  rows.push(row({ provider: null, model: null, center: 'unassigned', listUSD: 3, billedUSD: 3 }));
  rows.push({
    ...row({ provider: null, model: null, center: null, kind: 'plan', requests: 0, listUSD: 0 }),
    billedUSD: 5,
  });
  const b = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07', measure: 'billed' });
  const names = { __other: 'Other', __plan: 'Plan fee', __none: 'Unknown' };
  const svg = C.costFlowSvg(b.flow, { fmt, label: (col, key) => names[key] || key });
  const nodes = [...svg.matchAll(/<g class="cost-node[^>]*>/g)].map((m) => m[0]);
  const fake = b.flow.nodes.filter((n) => n.key in names);
  assert.ok(
    ['__other', '__plan', '__none'].every((k) => fake.some((n) => n.key === k)),
    'all three kinds are drawn',
  );
  assert.equal(nodes.length, b.flow.nodes.length);
  for (const g of nodes) {
    const tip = /data-tip="([^"]*)"/.exec(g)[1];
    const fakeNode = /^(Other|Plan fee|Unknown) · /.test(tip);
    assert.equal(/role="button"|tabindex|data-cost-node|cost-click/.test(g), !fakeNode, g);
    assert.equal(tip.endsWith(' (not filterable)'), fakeNode, tip);
  }
  assert.match(svg, /data-cost-node="center:unassigned" role="button" tabindex="0"/);
});

test('calendar: a fixed-size cell per day, empty days outlined, each month named once', () => {
  const rows = [row({ day: '2026-09-30', listUSD: 2 }), row({ day: '2026-10-02', listUSD: 4 })];
  const b = V.breakdown({ rows, from: '2026-09-28', to: '2026-10-11' });
  const svg = C.costCalendarSvg(b.calendar, fmt);
  assert.equal(count(svg, /class="cost-cell"/g), 14);
  assert.match(svg, /^<svg class="cost-chart cost-calendar" viewBox="0 0 96 218" width="96" height="218"/);
  assert.equal(count(svg, /stroke="rgba\(120,140,255,\.22\)"/g), 12, 'the twelve empty days');
  assert.equal(count(svg, />Sep</g), 1);
  assert.equal(count(svg, />Oct</g), 1);
  assert.match(svg, /data-tip="2 Oct · \$4\.00 · top model claude-opus-5-5"/);
});

test('treemap layout: center strips by share, blocks by share of their center, height by spend per request', () => {
  const rows = [
    row({ project: '~/a', center: 'acme', listUSD: 6, requests: 6 }),
    row({ project: '~/b', center: 'acme', listUSD: 2, requests: 1 }),
    row({ project: '~/c', center: 'lab', listUSD: 2, requests: 4 }),
  ];
  const blocks = C.costTreemapLayout(V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07' }).treemap);
  assert.deepEqual(
    blocks.map((x) => [x.center, x.project]),
    [
      ['acme', '~/a'],
      ['acme', '~/b'],
      ['lab', '~/c'],
    ],
  );
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
  near(blocks[0].w + 0.1, 11.2 * 0.8);
  near(blocks[2].w + 0.1, 11.2 * 0.2);
  near(blocks[0].d + 0.1, 4.4 * 0.75);
  near(blocks[1].h, 2.8, 'the dearest per request is the tallest');
  near(blocks[0].h, 0.2 + 2.6 * 0.5);
  for (const x of blocks) assert.ok(x.x >= -5.6 && x.x + x.w <= 5.6 && x.z >= -2.2 && x.z + x.d <= 2.2);
  assert.notEqual(blocks[0].color, blocks[2].color);
  assert.deepEqual(C.costTreemapLayout([]), []);
});

test('treemap: the global Other block (more than 39 centers) is named "Other centers"', () => {
  const rows = [];
  for (let i = 1; i <= 45; i++) rows.push(row({ center: `c${i}`, project: `~/p${i}`, listUSD: i, requests: i }));
  const tm = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-07' }).treemap;
  const blocks = C.costTreemapLayout(tm);
  const other = blocks.filter((b) => b.center === '__other');
  assert.equal(other.length, 1);
  assert.ok(other[0].w > 0 && other[0].d > 0);
  const text = C.costTreemapText(other[0], { fmt, label: (col, key) => key });
  assert.match(text, /^Other centers · Other \(\d+ projects\) · \$/);
  assert.match(C.costTreemapText(blocks[0], { fmt, label: (col, key) => key }), /^c\d+ · ~\/p\d+ · \$/);
});

test('costcharts.js builds no markup from server names without esc() (S1) and loads in Node', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const CONTENT =
    /\.(name|reason|project|model|center|provider|source|plan|label|title|text|error|message|id|key|day|topModel)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write|\son[a-z]+=/);
  for (const [name] of src.matchAll(/^(?:const|let|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(name.split(/\s+/).pop(), /^(?:cost|COST)/, `${name}: every top-level name starts with cost`);
});

// Fix round 1 (Task 7 review): a y-axis label is right-anchored at the left margin; the margin grows to fit the
// longest one, so "IDR 20,000" is not cut off at the chart's left edge. Width estimate: 0.62 em at 10.5 px per glyph.
test('axis labels: the left margin fits the longest tick label in any currency', () => {
  const idr = (v) => `IDR ${Math.round(v).toLocaleString('en')}`;
  const GLYPH = 0.62 * 10.5;
  const fits = (svg, name) => {
    const ticks = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end">([^<]*)<\/text>/g)];
    assert.ok(ticks.length >= 5, `${name}: axis labels found`);
    for (const [, x, label] of ticks) assert.ok(Number(x) - label.length * GLYPH >= 0, `${name}: "${label}" at ${x}`);
  };
  const spikes = ['2026-10-01', '2026-10-02'].map((day, i) => ({
    day,
    spend: 18000 + i,
    baseline: null,
    spike: false,
    topModel: null,
  }));
  fits(C.costSpikeSvg(spikes, idr), 'spikes');
  const rows = [9000, 12000, 15000, 11000].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v }));
  fits(C.costBurnSvg(V.overview({ rows, today: '2026-10-04' }), idr), 'burn-down');
  const w = { withoutCache: 912000, cacheSaved: 12000, usage: 900000, planSaved: 100000, paid: 800000 };
  fits(C.costWaterfallSvg(w, idr), 'waterfall');
  const unit = ['2026-10-01', '2026-10-02'].map((day) => ({ day, perRequest: 23456, perMillionTokens: null }));
  fits(C.costUnitSvg(unit, 'perRequest', idr, '#fff'), 'unit');
  // Short labels keep the drawn margin.
  const small = C.costSpikeSvg(
    spikes.map((s) => ({ ...s, spend: 3 })),
    fmt,
  );
  assert.match(small, /<text x="54" y="[\d.]+" text-anchor="end">\$3\.00</);
});
