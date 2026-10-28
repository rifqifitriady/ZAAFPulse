// Cost Control 4b: lib/cost/recommend.js, cheaper models backed by the owner's own Datasets experiments. Pure:
// experiment records and spend in, recommendations and gaps out, no clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/cost/recommend');

const DAY = 86400000;
const NOW = new Date(2026, 9, 28, 12).getTime();
const RANGE = { from: '2026-09-29', to: '2026-10-28' };
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const QWEN = 'qwen3-coder:30b';

const ev = (pass, total) => ({ pass, total, rate: total ? pass / total : null });
// A model's summary as lib/datasets/score.js summarize writes it; `rel` is its relevance evaluator.
const m = (requests, cost, evaluators) => ({ requests, cost, ms: 1000, errors: 0, proposals: 0, evaluators });
const rel = (requests, cost, pass, total = 20) => m(requests, cost, { relevance: ev(pass, total) });
let seq = 0;
const exp = (models, over = {}) => ({
  id: `exp_${String(++seq).padStart(16, '0')}`,
  dataset: 'support-tickets',
  datasetName: 'Support tickets',
  models: Object.keys(models),
  status: 'done',
  stopped: null,
  startedAt: NOW - 2 * DAY - 60000,
  endedAt: NOW - 2 * DAY,
  summary: { models },
  ...over,
});
const run = (experiments, spend, over = {}) => R.recommend({ experiments, spend, ...RANGE, now: NOW, ...over });

test('recommend: a cheaper model as good on the same experiment, with the saving at the last 30 days of spend', () => {
  // Opus 0.1 per example, Sonnet 0.06 (60 %), both 19 of 20.
  const x = exp({ [OPUS]: rel(10, 1, 19), [SONNET]: rel(10, 0.6, 19) });
  const r = run([x], { [OPUS]: 100 });
  assert.deepEqual(r, {
    items: [
      {
        model: OPUS,
        candidate: SONNET,
        local: false,
        spendUSD: 100,
        savingUSD: 40,
        costRatio: 0.6,
        rateA: 0.95,
        rateB: 0.95,
        rowsA: 20,
        rowsB: 20,
        experiment: { id: x.id, dataset: 'support-tickets', datasetName: 'Support tickets', endedAt: NOW - 2 * DAY },
        alsoBackedBy: 0,
        onPlan: false,
      },
    ],
    gaps: [],
    basis: { experiments: 1, ...RANGE },
  });
  assert.equal(run([x], { [OPUS]: 100 }, { onPlan: [OPUS] }).items[0].onPlan, true, 'ran under a plan');
  assert.deepEqual(R.DEFAULTS, {
    maxDropPoints: 5,
    minRows: 20,
    maxCostRatio: 0.8,
    maxAgeDays: 90,
    maxItems: 5,
    maxGaps: 3,
  });
});

test('recommend: exactly 5 points lower, exactly 80 % of the cost and exactly 20 rows each still qualify', () => {
  const pick = (a, b) => run([exp({ [OPUS]: a, [SONNET]: b })], { [OPUS]: 10 }).items.map((i) => i.candidate);
  // Quality: 100 of 100 against 95 (5 points) and 94 (6 points).
  assert.deepEqual(pick(rel(10, 1, 100, 100), rel(10, 0.5, 95, 100)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 100, 100), rel(10, 0.5, 94, 100)), []);
  // Cost: 0.08 against 0.1 (80 %) and 0.081 (81 %).
  assert.deepEqual(pick(rel(10, 1, 20), rel(10, 0.8, 20)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 20), rel(10, 0.81, 20)), []);
  // Rows: 20 each, then 19 for either one.
  assert.deepEqual(pick(rel(10, 1, 20, 20), rel(10, 0.5, 20, 20)), [SONNET]);
  assert.deepEqual(pick(rel(10, 1, 19, 19), rel(10, 0.5, 20, 20)), []);
  assert.deepEqual(pick(rel(10, 1, 20, 20), rel(10, 0.5, 19, 19)), []);
  // A better candidate is fine, however much better.
  assert.deepEqual(pick(rel(10, 1, 10, 20), rel(10, 0.5, 20, 20)), [SONNET]);
});

test('recommend: only the evaluators both models have count; none in common is no evidence', () => {
  const a = m(10, 1, { relevance: ev(20, 20), reference_match: ev(0, 20) });
  const b = m(10, 0.5, { relevance: ev(20, 20) });
  const [r] = run([exp({ [OPUS]: a, [SONNET]: b })], { [OPUS]: 10 }).items;
  assert.deepEqual([r.rateA, r.rowsA, r.rateB, r.rowsB], [1, 20, 1, 20], 'reference_match is Opus-only');
  const apart = run([exp({ [OPUS]: rel(10, 1, 20), [SONNET]: m(10, 0.5, { faithfulness: ev(20, 20) }) })], {
    [OPUS]: 10,
  });
  assert.deepEqual(apart.items, []);
  assert.deepEqual(apart.gaps, [{ model: OPUS, spendUSD: 10, reason: 'no_experiment' }]);
});

test('recommend: stopped, old and unreadable runs and models without requests do not count', () => {
  const models = () => ({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) });
  const spend = { [OPUS]: 10 };
  const none = (xs) => {
    const r = run(xs, spend);
    assert.deepEqual(r.items, []);
    return r;
  };
  for (const stopped of ['cost cap', 'request cap', 'cancelled', 'error'])
    assert.equal(none([exp(models(), { status: 'stopped', stopped })]).basis.experiments, 0, stopped);
  assert.equal(none([exp(models(), { endedAt: NOW - 91 * DAY })]).basis.experiments, 0, 'ended 91 days ago');
  assert.equal(run([exp(models(), { endedAt: NOW - 90 * DAY })], spend).items.length, 1, 'ended 90 days ago');
  for (const bad of [
    null,
    'exp',
    [],
    exp(models(), { endedAt: null }),
    exp(models(), { summary: null }),
    exp(models(), { summary: { models: 'x' } }),
    exp({ [OPUS]: null, [SONNET]: { requests: 10 } }),
    exp({ '': rel(10, 1, 20), '/': rel(10, 0.5, 20) }),
  ])
    assert.equal(none([bad]).basis.experiments, 0, JSON.stringify(bad));
  const idle = none([exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(0, 0, 20) })]);
  assert.equal(idle.basis.experiments, 1);
  assert.deepEqual(idle.gaps, [{ model: OPUS, spendUSD: 10, reason: 'no_experiment' }], 'Sonnet made no request');
});

test('recommend: a local candidate costs nothing; a model that cost nothing in the run is not saved on', () => {
  const [r] = run([exp({ [OPUS]: rel(10, 1, 20), [QWEN]: rel(10, 0, 19) })], { [OPUS]: 30 }).items;
  assert.deepEqual([r.candidate, r.local, r.costRatio, r.savingUSD], [QWEN, true, 0, 30]);
  const free = run([exp({ [OPUS]: rel(10, 0, 20), [QWEN]: rel(10, 0, 20) })], { [OPUS]: 30 });
  assert.deepEqual(free.items, []);
  assert.deepEqual(free.gaps, [{ model: OPUS, spendUSD: 30, reason: 'no_cheaper_match' }]);
});

test('recommend: the largest saving wins, then the best pass rate, then the newest run; the rest back it', () => {
  const older = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.6, 20) }, { endedAt: NOW - 5 * DAY });
  const newer = exp({ [OPUS]: rel(10, 1, 20), [HAIKU]: rel(10, 0.2, 20) }, { endedAt: NOW - DAY });
  const again = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.6, 20) }, { endedAt: NOW - 3 * DAY });
  const [r] = run([older, newer, again], { [OPUS]: 100 }).items;
  assert.deepEqual([r.candidate, r.savingUSD, r.experiment.id, r.alsoBackedBy], [HAIKU, 80, newer.id, 2]);
  // The same cost ratio: the better pass rate, then the newer run.
  const lower = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 19) }, { endedAt: NOW - DAY });
  const higher = exp({ [OPUS]: rel(10, 1, 20), [HAIKU]: rel(10, 0.5, 20) }, { endedAt: NOW - 9 * DAY });
  assert.equal(run([lower, higher], { [OPUS]: 100 }).items[0].candidate, HAIKU);
  const first = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) }, { endedAt: NOW - 9 * DAY });
  const second = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) }, { endedAt: NOW - DAY });
  const [tie] = run([first, second], { [OPUS]: 100 }).items;
  assert.deepEqual([tie.experiment.id, tie.alsoBackedBy], [second.id, 1]);
});

test('recommend: items by saving, at most 5; gaps by spend, at most 3; a capped-out model is no gap', () => {
  const names = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'm-g'];
  const models = { cheap: rel(10, 0, 20) };
  const spend = { 'n-1': 1, 'n-2': 4, 'n-3': 3, 'n-4': 2 };
  names.forEach((n, i) => {
    models[n] = rel(10, 1, 20);
    spend[n] = 10 * (i + 1);
  });
  const r = run([exp(models)], spend);
  assert.deepEqual(
    r.items.map((i) => [i.model, i.savingUSD]),
    [
      ['m-g', 70],
      ['m-f', 60],
      ['m-e', 50],
      ['m-d', 40],
      ['m-c', 30],
    ],
  );
  assert.deepEqual(
    r.gaps.map((g) => [g.model, g.spendUSD, g.reason]),
    [
      ['n-2', 4, 'no_experiment'],
      ['n-3', 3, 'no_experiment'],
      ['n-4', 2, 'no_experiment'],
    ],
    'm-a and m-b are recommended past the cap',
  );
  const few = run([exp(models)], spend, { limits: { maxItems: 2, maxGaps: 1 } });
  assert.deepEqual([few.items.length, few.gaps.length], [2, 1]);
});

test('recommend: both gap reasons, and no gap for a model with no spend or a credit', () => {
  const x = exp({ [OPUS]: rel(10, 1, 20), [QWEN]: rel(10, 0, 12) }); // the local model is far worse
  const r = run([x], { [OPUS]: 100, 'gpt-6.1-sol': 50, 'deepseek-chat': 20, 'llama-3.3-70b': 10, z: 0, c: -5 });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.gaps, [
    { model: OPUS, spendUSD: 100, reason: 'no_cheaper_match' },
    { model: 'gpt-6.1-sol', spendUSD: 50, reason: 'no_experiment' },
    { model: 'deepseek-chat', spendUSD: 20, reason: 'no_experiment' },
  ]);
  assert.deepEqual(run([], { z: 0, c: -5 }), { items: [], gaps: [], basis: { experiments: 0, ...RANGE } });
  assert.deepEqual(R.recommend({ now: NOW }).items, [], 'no input at all');
});

test('recommend: model names are normalized as the ledger does, and two names for one model add up', () => {
  const x = exp({
    'us.anthropic.claude-opus-5-5-v1:0': rel(10, 1, 20),
    'anthropic/claude-haiku-5-5': rel(5, 0.1, 10, 10),
    'claude-haiku-5-5': rel(5, 0.1, 10, 10),
  });
  const r = run([x], { 'Anthropic/Claude-Opus-5-5': 50 });
  assert.deepEqual(
    r.items.map((i) => [i.model, i.candidate, i.rowsB, i.costRatio]),
    [[OPUS, HAIKU, 20, 0.2]],
  );
});

test('recommend: amounts to 8 decimals, rates and the cost ratio to 4', () => {
  const x = exp({ [OPUS]: rel(3, 3, 30, 45), [SONNET]: rel(3, 1, 20, 30) });
  const [r] = run([x], { [OPUS]: 1 / 3 }).items;
  assert.deepEqual(
    [r.spendUSD, r.savingUSD, r.costRatio, r.rateA, r.rateB],
    [0.33333333, 0.22222222, 0.3333, 0.6667, 0.6667],
  );
});

test('spendByModel: usage value per model over the rows, plan rows out, and the models used under a plan', () => {
  const row = (over) => ({ day: '2026-10-20', source: 'claude', model: OPUS, kind: 'chat', listUSD: 1, ...over });
  const rows = [
    row({}),
    row({ day: '2026-10-21', listUSD: 2.5 }),
    { day: '2026-10-21', source: 'claude', model: null, kind: 'plan', listUSD: 0, billedUSD: 6.45 },
    row({ source: 'gateway', model: 'anthropic/claude-sonnet-5-5', listUSD: 0.1 }),
    row({ source: 'gateway', day: '2026-10-21', model: SONNET, listUSD: 0.2 }),
    row({ source: 'judge', model: 'qwen3:8b', listUSD: 0, free: true }),
    row({ model: null, listUSD: 9 }),
    null,
  ];
  assert.deepEqual(R.spendByModel(rows), {
    spend: { [OPUS]: 3.5, [SONNET]: 0.3, 'qwen3:8b': 0 },
    onPlan: [OPUS],
  });
  assert.deepEqual(R.spendByModel(undefined), { spend: {}, onPlan: [] });
});

test('recommend: a missing or non-finite now counts no experiment', () => {
  const x = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20) }, { endedAt: NOW - 200 * DAY });
  for (const now of [undefined, NaN, Infinity, '1'])
    assert.equal(R.recommend({ experiments: [x], spend: { [OPUS]: 10 }, now }).basis.experiments, 0, String(now));
});

test('recommend: a limit that is not a finite number falls back to its default', () => {
  const models = { [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.5, 20), [HAIKU]: rel(10, 0.9, 20) };
  const x = exp(models);
  const base = run([x], { [OPUS]: 10 });
  const bad = { minRows: undefined, maxCostRatio: undefined, maxDropPoints: undefined, maxAgeDays: 'x', maxItems: NaN };
  assert.equal(base.items.length, 1, 'only Sonnet qualifies by default');
  assert.deepEqual(run([x], { [OPUS]: 10 }, { limits: bad }), base);
  assert.deepEqual(run([x], { [OPUS]: 10 }, { limits: { maxItems: undefined } }).items.length, 1);
  assert.equal(R.recommend({ experiments: [], now: NOW, limits: null }).items.length, 0);
});

test('spendByModel: a truthy input that is not an array reads as no rows', () => {
  for (const bad of [{}, 5, 'rows', true, new Set([{}])])
    assert.deepEqual(R.spendByModel(bad), { spend: {}, onPlan: [] });
});

test('recommend: equal displayed cost ratios fall through to the pass rate, not float noise', () => {
  const lower = exp({ [OPUS]: rel(10, 1, 20), [SONNET]: rel(10, 0.7, 19) }, { endedAt: NOW - DAY });
  const higher = exp({ [OPUS]: rel(10, 0.1, 20), [HAIKU]: rel(10, 0.07, 20) }, { endedAt: NOW - 9 * DAY });
  const [r] = run([lower, higher], { [OPUS]: 100 }).items;
  assert.equal(r.candidate, HAIKU, '0.07 / 0.1 and 0.7 / 1 are the same ratio; the better pass rate wins');
});

test('recommend: a negative candidate cost reads as 0, and onPlan matches under a raw name', () => {
  const x = exp({ [OPUS]: rel(10, 1, 20), [QWEN]: rel(10, -3, 20) });
  const [r] = run([x], { [OPUS]: 30 }, { onPlan: ['Anthropic/Claude-Opus-5-5'] }).items;
  assert.deepEqual([r.local, r.costRatio, r.savingUSD, r.onPlan], [true, 0, 30, true]);
});
