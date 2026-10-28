// Cost Control 4b: the recommendations in the Value answer of GET /api/cost/view, in-process on the demo ledger. The
// spend is the last 30 days whatever the page's range; a read that fails gives null and the page still renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createCost } = require('../lib/cost');
const { createCostApi } = require('../lib/cost/api');
const V = require('../lib/cost/views');
const { spendByModel } = require('../lib/cost/recommend');
const { costDemo } = require('../lib/demo');
const { dayOf, addDays } = require('../lib/cost/days');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const PATHS = /\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/|\/tmp\/|\/var\/folders\//;
const DAY = 86400000;
const NOW = new Date(2026, 9, 22, 15).getTime(); // a Thursday afternoon
const TODAY = dayOf(NOW);
const FROM30 = addDays(TODAY, -29);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg || `${a} is not ${b}`);

// An experiment as the store lists it: Opus and Sonnet on 24 examples, two evaluators, Sonnet at 60 % of the cost.
const ev = (pass, total) => ({ pass, total, rate: pass / total });
const EXPERIMENT = {
  id: 'exp_00000000000000b1',
  dataset: 'support-tickets',
  datasetName: 'Support tickets',
  models: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5'],
  evaluators: ['reference_match', 'relevance'],
  startedAt: NOW - 3 * DAY - 600000,
  endedAt: NOW - 3 * DAY,
  status: 'done',
  stopped: null,
  examples: 24,
  summary: {
    models: {
      'anthropic/claude-opus-5-5': {
        requests: 24,
        cost: 0.288,
        ms: 2100,
        errors: 0,
        proposals: 0,
        evaluators: { reference_match: ev(23, 24), relevance: ev(24, 24) },
      },
      'anthropic/claude-sonnet-5-5': {
        requests: 24,
        cost: 0.1728,
        ms: 1500,
        errors: 0,
        proposals: 0,
        evaluators: { reference_match: ev(22, 24), relevance: ev(24, 24) },
      },
    },
  },
};

function setup({ experiments, failRead } = {}) {
  const d = costDemo(NOW);
  const real = createCost({ demo: d, getSettings: () => d.settings, home: HOME, now: () => NOW, nocase: false });
  const reads = [];
  // The cost object with its budgetRows watched; `failRead(range)` true makes that read throw.
  const cost = {
    ...real,
    budgetRows: (range) => {
      reads.push(range);
      if (failRead && failRead(range)) throw new Error(`ledger unreadable at ${path.join(HOME, '.data', 'cost')}`);
      return real.budgetRows(range);
    },
  };
  const api = createCostApi({
    cost,
    settings: { get: () => d.settings, save: () => {} },
    home: HOME,
    now: () => NOW,
    ...(experiments ? { experiments } : {}),
  });
  const bodies = [];
  const get = async (query) => {
    const r = await api.route({ method: 'GET', path: '/api/cost/view', query: new URLSearchParams(query) });
    bodies.push(JSON.stringify(r.body));
    return r;
  };
  return { get, reads, real, bodies };
}

test('views.value passes the recommendations through; none given is null', () => {
  const rec = { items: [], gaps: [], basis: { experiments: 0, from: FROM30, to: TODAY } };
  const range = { rows: [], from: FROM30, to: TODAY };
  assert.equal(V.value({ ...range, recommendations: rec }).recommendations, rec);
  assert.equal(V.value({ ...range, recommendations: null }).recommendations, null);
  assert.equal(V.value(range).recommendations, null);
});

test('cost view: Value recommends from the experiments and the last 30 days of usage value', async () => {
  const s = setup({ experiments: () => [EXPERIMENT] });
  const r = await s.get('page=value');
  assert.equal(r.status, 200);
  const rec = r.body.recommendations;
  assert.deepEqual(rec.basis, { experiments: 1, from: FROM30, to: TODAY });
  const { spend } = spendByModel(s.real.budgetRows({ from: FROM30, to: TODAY }).rows);
  assert.equal(rec.items.length, 1);
  const [item] = rec.items;
  assert.deepEqual(
    [item.model, item.candidate, item.local, item.costRatio, item.rateA, item.rateB, item.rowsA, item.rowsB],
    [OPUS, SONNET, false, 0.6, 0.9792, 0.9583, 48, 48],
  );
  assert.equal(item.spendUSD, spend[OPUS], 'usage value, plan rows left out');
  near(item.savingUSD, spend[OPUS] * 0.4);
  assert.equal(item.onPlan, true, 'Claude Code is on a plan in the demo');
  assert.deepEqual(item.experiment, {
    id: EXPERIMENT.id,
    dataset: 'support-tickets',
    datasetName: 'Support tickets',
    endedAt: EXPERIMENT.endedAt,
  });
  // Sonnet met Opus with enough rows, but Opus is no cheaper; the others never ran in an experiment.
  const gaps = Object.fromEntries(rec.gaps.map((g) => [g.model, g.reason]));
  assert.equal(gaps[SONNET], 'no_cheaper_match');
  assert.ok(rec.gaps.length === 3 && rec.gaps.every((g) => g.spendUSD > 0 && g.model !== OPUS));
  for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
});

test('cost view: the 30 days of spend do not follow the page range', async () => {
  const s = setup({ experiments: () => [EXPERIMENT] });
  const week = (await s.get(`page=value&from=${addDays(TODAY, -6)}&to=${TODAY}`)).body;
  const august = (await s.get('page=value&from=2026-08-01&to=2026-08-31')).body;
  assert.deepEqual(week.recommendations, august.recommendations);
  assert.deepEqual(august.recommendations.basis, { experiments: 1, from: FROM30, to: TODAY });
  assert.ok(august.recommendations.items.length === 1, 'August has no rows, the last 30 days do');
  assert.deepEqual(s.reads.filter((x) => x.from === FROM30 && x.to === TODAY).length, 2, 'one read per answer');
});

test('cost view: a failed read gives null recommendations and the page still renders', async () => {
  const from = addDays(TODAY, -6);
  const failing = [
    setup({
      experiments: () => {
        throw new Error('experiments unreadable');
      },
    }),
    setup({ experiments: () => [EXPERIMENT], failRead: (range) => range.from === FROM30 }),
  ];
  for (const s of failing) {
    const r = await s.get(`page=value&from=${from}&to=${TODAY}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.recommendations, null);
    assert.ok(r.body.plans.length > 0 && r.body.unit.length === 7, 'the rest of the page');
    for (const b of s.bodies) assert.doesNotMatch(b, PATHS);
  }
  const o = await setup().get('page=overview');
  assert.equal(Object.hasOwn(o.body, 'recommendations'), false, 'the Value page only');
});

test('cost view: with no experiment provider, no recommendation and the top 3 spenders as gaps', async () => {
  const r = (await setup().get('page=value')).body.recommendations;
  assert.deepEqual(r.items, []);
  assert.equal(r.basis.experiments, 0);
  assert.equal(r.gaps.length, 3);
  assert.ok(r.gaps.every((g) => g.reason === 'no_experiment'));
  assert.ok(r.gaps[0].spendUSD >= r.gaps[1].spendUSD && r.gaps[1].spendUSD >= r.gaps[2].spendUSD);
});
test('cost view: the route passes a finite now, so recent experiments count', async () => {
  const s = setup({ experiments: () => [EXPERIMENT] });
  const r = (await s.get('page=value')).body.recommendations;
  assert.equal(r.basis.experiments, 1, 'recommend counts no experiment without a finite now');
  assert.equal(r.items.length, 1);
});
