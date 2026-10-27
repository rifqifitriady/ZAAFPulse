// Cost Control 3a: the Breakdown and Value pages of lib/cost/views.js, and the Datasets pass rates per model.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/cost/views');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);
const tokens = (over = {}) => ({ in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over });
const row = (over = {}) => ({
  day: '2026-10-01',
  source: 'gateway',
  provider: 'openrouter',
  model: 'deepseek-chat',
  project: null,
  center: 'platform',
  keyId: 'key_a',
  agent: null,
  kind: 'chat',
  requests: 1,
  tokens: tokens({ in: 900, out: 100 }),
  listUSD: 1,
  billedUSD: 1,
  priceVersion: 1,
  unpriced: false,
  free: false,
  ...over,
});
const planRow = (day, billedUSD, source = 'claude') => ({
  ...row({ day, source, provider: null, model: null, center: null, keyId: null, kind: 'plan', requests: 0 }),
  tokens: tokens(),
  plan: 'Claude Max',
  listUSD: 0,
  billedUSD,
});
const RANGE = { from: '2026-10-01', to: '2026-10-07' };

test('breakdown flow: top 6 per column plus Other; plan fees flow from their source into Plan fee', () => {
  const rows = [];
  // Eight models on one provider: the two smallest join Other in the model column.
  for (let i = 1; i <= 8; i++) rows.push(row({ model: `m${i}`, listUSD: i, billedUSD: i }));
  rows.push(row({ source: 'claude', provider: 'anthropic', model: 'm8', center: null, listUSD: 4, billedUSD: 0 }));
  rows.push(planRow('2026-10-01', 6.5));
  const list = V.breakdown({ rows, ...RANGE });
  const models = list.flow.nodes.filter((n) => n.col === 2);
  assert.deepEqual(
    models.map((n) => [n.key, n.value]),
    [
      ['m8', 12],
      ['m7', 7],
      ['m6', 6],
      ['m5', 5],
      ['m4', 4],
      ['m3', 3],
      ['__other', 3],
    ],
  );
  assert.equal(list.flow.nodes.find((n) => n.id === 'center:unassigned').value, 4, 'no center is Unassigned');
  assert.equal(
    list.flow.nodes.some((n) => n.key === '__plan'),
    false,
    'usage value has no plan fee',
  );
  assert.equal(list.total, 40);
  const paid = V.breakdown({ rows, ...RANGE, measure: 'billed' });
  const fee = paid.flow.links.find((l) => l.target === 'provider:__plan');
  assert.deepEqual(fee, { source: 'source:claude', target: 'provider:__plan', value: 6.5 });
  assert.equal(
    paid.flow.nodes.some((n) => n.id === 'provider:anthropic'),
    false,
    'a row billed 0 draws nothing',
  );
  assert.equal(paid.planFee, 6.5);
  assert.equal(paid.total, 36 + 6.5);
  for (const l of paid.flow.links) assert.ok(l.value > 0);
});

test('breakdown treemap: one block per project in its center, height by spend per request, capped at 40', () => {
  const rows = [
    row({ source: 'claude', project: '~/acme-web', center: 'acme', listUSD: 6, requests: 2 }),
    row({ source: 'claude', project: '~/acme-web', center: 'acme', listUSD: 2, requests: 2, day: '2026-10-02' }),
    row({ source: 'codex', project: '~/lab', center: 'research', listUSD: 2, requests: 10 }),
    row({ project: null, center: 'acme', listUSD: 10, requests: 1 }),
  ];
  const t = V.breakdown({ rows, ...RANGE }).treemap;
  assert.deepEqual(
    t.map((c) => [c.center, c.spend, c.blocks.map((b) => [b.project, b.spend, b.perRequest])]),
    [
      [
        'acme',
        18,
        [
          [null, 10, 10],
          ['~/acme-web', 8, 2],
        ],
      ],
      ['research', 2, [['~/lab', 2, 0.2]]],
    ],
  );
  near(t[0].blocks[1].share, 8 / 20);
  const many = [];
  for (let i = 0; i < 50; i++) many.push(row({ project: `~/p${i}`, center: i % 2 ? 'a' : 'b', listUSD: 100 - i }));
  const capped = V.breakdown({ rows: many, ...RANGE }).treemap;
  const blocks = capped.flatMap((c) => c.blocks);
  assert.equal(blocks.length, 40, 'the Other blocks count toward the 40');
  const others = blocks.filter((b) => b.project === '__other');
  assert.deepEqual(others.map((b) => b.center).sort(), ['a', 'b']);
  assert.equal(
    others.reduce((a, b) => a + b.projects, 0),
    12,
  );
  near(
    blocks.reduce((a, b) => a + b.spend, 0),
    many.reduce((a, r) => a + r.listUSD, 0),
  );
});

test('breakdown calendar: weeks by weekday, 5 quantile steps over the non-zero days, empty days at level 0', () => {
  // 2026-10-01 is a Thursday.
  const rows = [1, 2, 3, 4, 5, 6].map((v, i) => row({ day: `2026-10-0${i + 1}`, listUSD: v, model: `m${v}` }));
  const cal = V.breakdown({ rows, from: '2026-10-01', to: '2026-10-08' }).calendar;
  assert.deepEqual(cal.steps, [2, 3, 4, 5]);
  assert.deepEqual(
    cal.days.map((d) => [d.day, d.week, d.weekday, d.level]),
    [
      ['2026-10-01', 0, 3, 1],
      ['2026-10-02', 0, 4, 1],
      ['2026-10-03', 0, 5, 2],
      ['2026-10-04', 0, 6, 3],
      ['2026-10-05', 1, 0, 4],
      ['2026-10-06', 1, 1, 5],
      ['2026-10-07', 1, 2, 0],
      ['2026-10-08', 1, 3, 0],
    ],
  );
  assert.equal(cal.days[5].topModel, 'm6');
  assert.equal(cal.days[6].topModel, null);
  assert.deepEqual(V.breakdown({ rows: [], ...RANGE }).calendar.steps, []);
});

test('breakdown: converted per day, a day without a rate in USD and named', () => {
  const rows = [row({ listUSD: 2 }), row({ day: '2026-10-02', listUSD: 3 })];
  const b = V.breakdown({ rows, ...RANGE, rateOf: (d) => (d === '2026-10-01' ? 100 : null) });
  assert.equal(b.total, 203);
  assert.deepEqual(b.missingRate, ['2026-10-02']);
});

test('value: plan value against its fee, with the multiplier; below 1 when the plan cost more', () => {
  const rows = [
    row({ source: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', listUSD: 41, billedUSD: 0 }),
    planRow('2026-10-01', 10),
    row({ source: 'codex', provider: 'openai', model: 'gpt-6.1-sol', listUSD: 3, billedUSD: 0 }),
    planRow('2026-10-01', 5, 'codex'),
    row({ source: 'claude', day: '2026-10-09', listUSD: 99 }), // outside the range
  ];
  const v = V.value({ rows, ...RANGE });
  assert.deepEqual(v.plans, [
    { source: 'claude', plan: 'Claude Max', days: 1, value: 41, fee: 10, multiplier: 4.1 },
    { source: 'codex', plan: 'Claude Max', days: 1, value: 3, fee: 5, multiplier: 0.6 },
  ]);
});

test('value: the waterfall steps add up to what was paid; free rows add no money', () => {
  const rows = [
    row({ source: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', listUSD: 40, billedUSD: 0 }),
    planRow('2026-10-01', 10),
    row({ listUSD: 5, billedUSD: 5 }),
    row({ source: 'judge', provider: 'ollama', model: 'qwen3:8b', listUSD: 0, billedUSD: 0, free: true, requests: 20 }),
  ];
  const cacheSaved = (r) => (r.model === 'claude-opus-5-5' ? 8 : r.free ? 99 : 0);
  const w = V.value({ rows, ...RANGE, cacheSaved: (r) => (r.free ? 0 : cacheSaved(r)) }).waterfall;
  assert.deepEqual(w, { withoutCache: 53, cacheSaved: 8, usage: 45, planSaved: 30, paid: 15 });
  near(w.withoutCache - w.cacheSaved - w.planSaved, w.paid);
  const dearer = V.value({
    rows: [row({ listUSD: 1, billedUSD: 0, source: 'claude' }), planRow('2026-10-01', 3)],
    ...RANGE,
  });
  assert.equal(dearer.waterfall.planSaved, -2, 'a plan that cost more is a step up');
});

test('value: local models show requests and tokens only', () => {
  const rows = [
    row({
      source: 'judge',
      provider: 'ollama',
      model: 'qwen3:8b',
      free: true,
      listUSD: 0,
      requests: 20,
      tokens: tokens({ in: 1500, out: 60 }),
    }),
    row({
      source: 'judge',
      provider: 'ollama',
      model: 'qwen3:8b',
      free: true,
      listUSD: 0,
      requests: 5,
      day: '2026-10-02',
      tokens: tokens({ in: 10 }),
    }),
    row({ listUSD: 1 }),
  ];
  const l = V.value({ rows, ...RANGE }).local;
  assert.deepEqual(l, {
    requests: 25,
    tokens: 1570,
    models: [{ model: 'qwen3:8b', source: 'judge', requests: 25, tokens: 1570 }],
  });
});

test('value: the scatter has a dot per measured model, hollow under 50 results, pass rates in the tooltip', () => {
  const rows = [
    row({ source: 'claude', model: 'claude-opus-5-5', listUSD: 10, requests: 4 }),
    row({ source: 'codex', model: 'gpt-6.1-sol', listUSD: 2, requests: 8 }),
    row({ model: 'deepseek-chat', listUSD: 1, requests: 50 }),
    row({ model: 'idle-model', listUSD: 0, requests: 0 }),
  ];
  const accuracy = {
    'claude-opus-5-5': { results: 200, modelFailures: 4, accuracy: 0.98, daily: {} },
    'gpt-6.1-sol': { results: 12, modelFailures: 0, accuracy: 1, daily: {} },
    'not-in-the-ledger': { results: 900, modelFailures: 0, accuracy: 1, daily: {} },
  };
  const passRates = { 'claude-opus-5-5': { pass: 3, total: 4, rate: 0.75 } };
  const s = V.value({ rows, ...RANGE, accuracy, passRates }).scatter;
  assert.deepEqual(
    s.dots.map((d) => [d.model, d.perRequest, d.accuracy, d.toolResults, d.littleData, d.passRate && d.passRate.rate]),
    [
      ['claude-opus-5-5', 2.5, 0.98, 200, false, 0.75],
      ['gpt-6.1-sol', 0.25, 1, 12, true, null],
    ],
  );
  assert.deepEqual(s.noToolCalls, [{ model: 'deepseek-chat', requests: 50, spend: 1 }]);
});

test('value: unit-cost lines per day, with a gap where the denominator is missing', () => {
  const rows = [
    row({
      source: 'claude',
      model: 'claude-opus-5-5',
      listUSD: 6,
      requests: 3,
      tokens: tokens({ in: 1e6, cacheRead: 1e6 }),
    }),
    row({ listUSD: 2, requests: 1, tokens: tokens({ in: 0 }) }),
    row({ day: '2026-10-02', listUSD: 0, requests: 0, tokens: tokens() }),
  ];
  const accuracy = { 'claude-opus-5-5': { results: 3000, daily: { '2026-10-01': { results: 3000, ok: 2000 } } } };
  const u = V.value({ rows, ...RANGE, accuracy }).unit;
  assert.equal(u.length, 7);
  assert.deepEqual(u[0], { day: '2026-10-01', perRequest: 2, perMillionTokens: 4, perThousandToolCalls: 3 });
  assert.deepEqual(u[1], { day: '2026-10-02', perRequest: null, perMillionTokens: null, perThousandToolCalls: null });
});

test('passRates: experiments that ended in the range, summed over their evaluators, names normalized', () => {
  const at = (d, h = 12) => new Date(2026, 9, d, h).getTime();
  const rec = (endedAt, models) => ({
    endedAt,
    summary: {
      models: Object.fromEntries(
        Object.entries(models).map(([m, evs]) => [
          m,
          { evaluators: Object.fromEntries(evs.map(([pass, total], i) => [`e${i}`, { pass, total }])) },
        ]),
      ),
    },
  });
  const records = [
    rec(at(2), {
      'anthropic/claude-haiku-5-5': [
        [1, 2],
        [2, 2],
      ],
      'ollama/qwen3-coder:30b': [[0, 0]],
    }),
    rec(at(5), { 'claude-haiku-5-5': [[1, 1]] }),
    rec(at(20), { 'claude-haiku-5-5': [[0, 9]] }), // ended outside the range
    { endedAt: null },
    null,
  ];
  assert.deepEqual(V.passRates(records, RANGE), { 'claude-haiku-5-5': { pass: 4, total: 5, rate: 0.8 } });
});

test('breakdown and value: data-derived names like __proto__ and toString neither crash nor pollute', () => {
  const rows = ['__proto__', 'toString', 'constructor'].map((n, i) =>
    row({
      source: n,
      provider: n,
      model: n,
      center: n,
      project: n,
      listUSD: i + 1,
      requests: 2,
      free: i === 2,
    }),
  );
  const accuracy = Object.fromEntries([['toString', { results: 60, accuracy: 0.5, daily: {} }]]);
  const b = V.breakdown({ rows, ...RANGE });
  assert.equal(b.total, 6);
  assert.equal(b.flow.nodes.filter((n) => n.col === 2).length, 3);
  assert.deepEqual(b.treemap.map((c) => c.center).sort(), ['__proto__', 'constructor', 'toString']);
  const v = V.value({ rows, ...RANGE, accuracy, passRates: V.passRates([], RANGE) });
  assert.deepEqual(
    v.scatter.dots.map((d) => d.model),
    ['toString'],
  );
  assert.equal(v.scatter.noToolCalls.length, 2);
  assert.equal(v.local.models[0].model, 'constructor');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(b.flow.links), Array.prototype);
});

test('hostile names from parsed JSON come out as own keys and leave the prototypes alone', () => {
  const before = Object.prototype.toString;
  const at = new Date(2026, 9, 2, 12).getTime();
  const ev = '{"evaluators":{"e":{"pass":1,"total":2}}}';
  const records = [JSON.parse(`{"endedAt":${at},"summary":{"models":{"__proto__":${ev},"toString":${ev}}}}`)];
  const pr = V.passRates(records, RANGE);
  assert.ok(Object.hasOwn(pr, '__proto__'));
  assert.ok(Object.hasOwn(pr, 'tostring'));
  const acc = '{"results":60,"accuracy":0.5,"daily":{}}';
  const accuracy = JSON.parse(`{"__proto__":${acc},"tostring":${acc}}`);
  const rows = ['__proto__', 'tostring'].map((m) => row({ model: m, listUSD: 1, requests: 1 }));
  const v = V.value({ rows, ...RANGE, accuracy, passRates: pr });
  assert.deepEqual(v.scatter.dots.map((d) => d.model).sort(), ['__proto__', 'tostring']);
  assert.ok(v.scatter.dots.every((d) => d.passRate && d.passRate.total === 2));
  assert.equal(Object.prototype.toString, before);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal({}.pass, undefined);
});

test('breakdown treemap: more than 40 centers fold into one global Other, at most 40 blocks', () => {
  const rows = [];
  for (let i = 0; i < 45; i++)
    for (let j = 0; j < 2; j++)
      rows.push(
        row({ center: `c${String(i).padStart(2, '0')}`, project: `~/p${j}`, listUSD: 100 - i + (j ? 0 : 0.5) }),
      );
  const t = V.breakdown({ rows, ...RANGE }).treemap;
  const blocks = t.flatMap((c) => c.blocks);
  assert.ok(blocks.length <= 40);
  assert.ok(
    blocks.some((b) => b.project && b.project !== '__other'),
    'a real project shows',
  );
  const g = blocks.filter((b) => b.center === '__other');
  assert.equal(g.length, 1);
  assert.equal(g[0].project, '__other');
  assert.equal(g[0].projects, 2 * (45 - 38));
  near(
    blocks.reduce((a, b) => a + b.spend, 0),
    rows.reduce((a, r) => a + r.listUSD, 0),
  );
  for (const b of blocks) assert.equal(b.share, Math.round(b.share * 1e4) / 1e4);
});

test('breakdown flow: a link or node whose rounded value is 0 is dropped', () => {
  const f = V.breakdown({ rows: [row({ listUSD: 0.00001 }), row({ model: 'big', listUSD: 5 })], ...RANGE }).flow;
  assert.ok(f.links.every((l) => l.value > 0));
  assert.equal(
    f.nodes.some((n) => n.key === 'deepseek-chat'),
    false,
  );
  assert.ok(f.nodes.every((n) => n.value > 0));
});

test("value: the plan label is the latest day's; a local model is reported per source", () => {
  const rows = [
    { ...planRow('2026-10-01', 10), plan: 'Claude Pro' },
    { ...planRow('2026-10-03', 10), plan: 'Claude Max' },
    { ...planRow('2026-10-02', 10), plan: 'Claude Mid' },
    row({ source: 'judge', provider: 'ollama', model: 'q', free: true, listUSD: 0, requests: 2 }),
    row({ source: 'gateway', provider: 'ollama', model: 'q', free: true, listUSD: 0, requests: 3 }),
  ];
  const v = V.value({ rows, ...RANGE });
  assert.equal(v.plans[0].plan, 'Claude Max');
  assert.deepEqual(
    v.local.models.map((m) => [m.model, m.source, m.requests]),
    [
      ['q', 'gateway', 3],
      ['q', 'judge', 2],
    ],
  );
});

test('breakdown and value: missingRate lists only days where something was counted in USD', () => {
  const rows = [row({ listUSD: 0, billedUSD: 0 }), row({ day: '2026-10-02', listUSD: 3 })];
  const rateOf = () => null;
  assert.deepEqual(V.breakdown({ rows, ...RANGE, rateOf }).missingRate, ['2026-10-02']);
  assert.deepEqual(V.value({ rows, ...RANGE, rateOf }).missingRate, ['2026-10-02']);
});
