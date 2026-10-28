const test = require('node:test');
const assert = require('node:assert');
const { RULES, evaluate } = require('../lib/monitors/rules');

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MIN = 60e3;
const rule = (id) => RULES.find((r) => r.id === id);
const run = (id, snap, params = {}) => evaluate(rule(id), params, snap, NOW);
const one = (id, snap, params) => {
  const out = run(id, snap, params);
  assert.strictEqual(out.length, 1);
  return out[0];
};
const sess = (over = {}) => ({
  sid: 's1',
  title: 'Fix the build',
  project: 'p',
  state: 'working',
  lastTs: NOW - MIN,
  cost10m: 0,
  toolCallsTurn: 0,
  ...over,
});

test('the rule table is data-driven and complete', () => {
  assert.deepStrictEqual(
    RULES.map((r) => r.id),
    [
      'daily_cost',
      'month_projection',
      'cost_burn',
      'tool_loop',
      'agent_stuck',
      'accuracy_drop',
      'eval_pass_rate',
      'unsafe_content',
      'cost_anomaly',
    ],
  );
  for (const r of RULES) {
    assert.ok(r.title && r.describe, r.id);
    assert.ok(['aggregate', 'live'].includes(r.kind), r.id);
    assert.strictEqual(typeof r.params, 'object', r.id);
    assert.strictEqual(typeof r.defaultOn, 'function', r.id);
    assert.strictEqual(typeof r.mayAutoPause, 'boolean', r.id);
  }
  assert.deepStrictEqual(
    RULES.filter((r) => r.mayAutoPause).map((r) => r.id),
    ['daily_cost', 'cost_burn', 'tool_loop'],
  );
  assert.deepStrictEqual(
    RULES.filter((r) => r.kind === 'live').map((r) => r.id),
    ['cost_burn', 'tool_loop', 'agent_stuck'],
  );
});

test('defaultOn follows the budget and the fixed defaults', () => {
  const on = (id, config) => rule(id).defaultOn(config);
  for (const id of ['daily_cost', 'month_projection']) {
    assert.strictEqual(on(id, { monthlyBudgetUSD: 300 }), true, id);
    assert.strictEqual(on(id, { monthlyBudgetUSD: 0 }), false, id);
    assert.strictEqual(on(id, {}), false, id);
    assert.strictEqual(on(id, undefined), false, id);
    assert.strictEqual(on(id, { monthlyBudgetUSD: 'x' }), false, id);
  }
  const budgeted = new Set(['daily_cost', 'month_projection']);
  const fixed = Object.fromEntries(RULES.filter((r) => !budgeted.has(r.id)).map((r) => [r.id, on(r.id, {})]));
  assert.deepStrictEqual(fixed, {
    cost_burn: false,
    tool_loop: true,
    agent_stuck: false,
    accuracy_drop: true,
    eval_pass_rate: false,
    unsafe_content: true,
    cost_anomaly: true,
  });
  assert.strictEqual(on('cost_burn', { monthlyBudgetUSD: 500 }), false);
});

test('daily_cost: budget / 30 per day, ok below, triggered above, no_data without budget', () => {
  const snap = (cost, monthlyUSD = 300) => ({ budget: { monthlyUSD }, today: { cost } });
  let r = one('daily_cost', snap(9.99));
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.threshold, 10);
  assert.strictEqual(r.value, 9.99);
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(one('daily_cost', snap(10)).state, 'ok');
  r = one('daily_cost', snap(10.01));
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.value, 10.01);
  assert.strictEqual(one('daily_cost', snap(4, 0)).state, 'no_data');
  assert.strictEqual(one('daily_cost', { today: { cost: 4 } }).state, 'no_data');
  assert.strictEqual(one('daily_cost', { budget: { monthlyUSD: 300 } }).state, 'no_data');
  assert.strictEqual(one('daily_cost', {}).state, 'no_data');
  // The owner may set the daily limit directly.
  assert.strictEqual(one('daily_cost', snap(6), { limitUSD: 5 }).state, 'triggered');
  assert.strictEqual(one('daily_cost', snap(6), { limitUSD: 5 }).threshold, 5);
});

test('month_projection: triggered when the projection passes the budget', () => {
  const snap = (projection, monthlyUSD = 300) => ({ budget: { monthlyUSD }, month: { cost: 100, projection } });
  let r = one('month_projection', snap(300));
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.threshold, 300);
  r = one('month_projection', snap(300.5));
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.value, 300.5);
  assert.strictEqual(one('month_projection', snap(900, 0)).state, 'no_data');
  assert.strictEqual(one('month_projection', { budget: { monthlyUSD: 300 }, month: { cost: 1 } }).state, 'no_data');
  assert.strictEqual(one('month_projection', {}).state, 'no_data');
});

// A projection from the first hours of the month is noise: $1 at 00:30 on the 1st projects to about $1,500.
test('month_projection: no_data until three whole days of the month have passed, with the numbers kept', () => {
  const snap = { budget: { monthlyUSD: 1000 }, month: { cost: 1, projection: 1488 } };
  const at = (day, h = 0, m = 0, ms = 0) =>
    evaluate(rule('month_projection'), {}, snap, new Date(2026, 9, day, h, m, 0, ms).getTime())[0];
  for (const r of [at(1, 0, 30), at(2, 12), at(3, 23, 59, 59999)]) {
    assert.strictEqual(r.state, 'no_data');
    assert.strictEqual(r.value, 1488, 'the projection is still shown');
    assert.strictEqual(r.threshold, 1000);
  }
  assert.strictEqual(at(4).state, 'triggered', 'from local midnight at the end of the 3rd');
  assert.strictEqual(at(4).value, 1488);
});

test('cost_burn: one instance per session, over $5 in 10 minutes triggers', () => {
  const snap = { sessions: [sess({ sid: 'a', cost10m: 5 }), sess({ sid: 'b', cost10m: 5.01, title: 'Big job' })] };
  const out = run('cost_burn', snap);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(
    out.map((r) => [r.instance, r.sessionId, r.state]),
    [
      ['a', 'a', 'ok'],
      ['b', 'b', 'triggered'],
    ],
  );
  assert.strictEqual(out[1].value, 5.01);
  assert.strictEqual(out[1].threshold, 5);
  assert.strictEqual(out[1].title, 'Big job');
  assert.strictEqual(run('cost_burn', snap, { maxUSD: 6 })[1].state, 'ok');
  assert.deepStrictEqual(run('cost_burn', { sessions: [] }), []);
  assert.strictEqual(one('cost_burn', {}).state, 'no_data');
  assert.strictEqual(one('cost_burn', {}).sessionId, null);
  const missing = run('cost_burn', { sessions: [sess({ sid: 'c', cost10m: undefined })] });
  assert.strictEqual(missing[0].state, 'no_data');
  assert.strictEqual(missing[0].sessionId, 'c');
});

test('tool_loop: a loop signal in the last 10 minutes, or more than 50 calls in one turn', () => {
  const sessions = [sess({ sid: 'a' }), sess({ sid: 'b', toolCallsTurn: 51 }), sess({ sid: 'c', toolCallsTurn: 50 })];
  const signals = [
    { ts: NOW - 9 * MIN, sid: 'a', kind: 'loop' },
    { ts: NOW - 30 * MIN, sid: 'c', kind: 'loop' }, // too old
    { ts: NOW - MIN, sid: 'c', kind: 'secret' }, // another kind
    { ts: NOW - MIN, sid: 'zzz', kind: 'loop' }, // not a live session
  ];
  const out = run('tool_loop', { sessions, signals });
  assert.deepStrictEqual(
    out.map((r) => [r.sessionId, r.state]),
    [
      ['a', 'triggered'],
      ['b', 'triggered'],
      ['c', 'ok'],
    ],
  );
  assert.strictEqual(out[1].value, 51);
  assert.strictEqual(out[1].threshold, 50);
  assert.strictEqual(run('tool_loop', { sessions, signals: [] }, { maxCalls: 60 })[1].state, 'ok');
  const busy = { sessions: [sess({ toolCallsTurn: 51 })], signals: [] };
  assert.strictEqual(run('tool_loop', busy, { maxCalls: 60 })[0].state, 'ok');
  // Exactly at the window edge is still inside it.
  const loopAt = (ts) => ({ sessions: [sess()], signals: [{ ts, sid: 's1', kind: 'loop' }] });
  assert.strictEqual(run('tool_loop', loopAt(NOW - 10 * MIN))[0].state, 'triggered');
  assert.strictEqual(run('tool_loop', loopAt(NOW - 10 * MIN - 1))[0].state, 'ok');
});

test('tool_loop: no_data only when neither a signal list nor a call count is known', () => {
  assert.strictEqual(one('tool_loop', {}).state, 'no_data');
  const bare = { sid: 's1', title: 't' };
  assert.strictEqual(one('tool_loop', { sessions: [bare] }).state, 'no_data');
  // The call count alone is enough.
  assert.strictEqual(one('tool_loop', { sessions: [sess({ toolCallsTurn: 80 })] }).state, 'triggered');
  // The signal list alone is enough.
  const sigOnly = { sessions: [bare], signals: [{ ts: NOW, sid: 's1', kind: 'loop' }] };
  assert.strictEqual(one('tool_loop', sigOnly).state, 'triggered');
  assert.strictEqual(one('tool_loop', { sessions: [bare], signals: [] }).state, 'ok');
});

test('agent_stuck: working or thinking with no new line for 10 minutes', () => {
  const snap = {
    sessions: [
      sess({ sid: 'a', state: 'working', lastTs: NOW - 10 * MIN }),
      sess({ sid: 'b', state: 'thinking', lastTs: NOW - 10 * MIN - 1 }),
      sess({ sid: 'c', state: 'thinking', lastTs: NOW - 9 * MIN }),
      sess({ sid: 'd', state: 'idle', lastTs: NOW - 60 * MIN }),
      sess({ sid: 'e', state: 'working', lastTs: undefined }),
    ],
  };
  const out = run('agent_stuck', snap);
  assert.deepStrictEqual(
    out.map((r) => [r.sessionId, r.state]),
    [
      ['a', 'ok'],
      ['b', 'triggered'],
      ['c', 'ok'],
      ['d', 'ok'],
      ['e', 'no_data'],
    ],
  );
  assert.strictEqual(out[1].threshold, 10);
  assert.strictEqual(out[1].value, 10); // minutes since the last line, in whole minutes
  assert.strictEqual(run('agent_stuck', snap, { stuckMin: 20 })[1].state, 'ok');
  assert.strictEqual(one('agent_stuck', {}).state, 'no_data');
  assert.deepStrictEqual(run('agent_stuck', { sessions: [] }), []);
});

test('accuracy_drop: more than 5 points below the previous 7 days', () => {
  const snap = (today, prev7) => ({ accuracy: { today, prev7, todayResults: 20, prev7Results: 140 } });
  let r = one('accuracy_drop', snap(0.8, 0.85));
  assert.strictEqual(r.state, 'ok'); // exactly 5 points is not more than 5
  assert.strictEqual(r.threshold, 5);
  assert.strictEqual(r.value, 5);
  assert.strictEqual(one('accuracy_drop', snap(0.85, 0.9)).state, 'ok'); // float noise must not trigger
  r = one('accuracy_drop', snap(0.79, 0.85));
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.value, 6);
  assert.strictEqual(one('accuracy_drop', snap(0.9, 0.85)).state, 'ok');
  assert.strictEqual(one('accuracy_drop', snap(0.7, 0.85), { dropPoints: 20 }).state, 'ok');
  assert.strictEqual(one('accuracy_drop', snap(null, 0.85)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', snap(0.5, null)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', {}).state, 'no_data');
});

// One fault in the morning's first ten results is a ten-point drop: both rates need minSamples results (20).
test('accuracy_drop: no_data until today and the previous 7 days each rest on minSamples results', () => {
  const snap = (todayResults, prev7Results) => ({ accuracy: { today: 0.8, prev7: 0.9, todayResults, prev7Results } });
  assert.strictEqual(one('accuracy_drop', snap(19, 500)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', snap(19, 500)).threshold, 5);
  assert.strictEqual(one('accuracy_drop', snap(20, 500)).state, 'triggered');
  assert.strictEqual(one('accuracy_drop', snap(500, 19)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', snap(500, 20)).state, 'triggered');
  assert.strictEqual(one('accuracy_drop', snap(undefined, undefined)).state, 'no_data', 'counts missing');
  assert.strictEqual(one('accuracy_drop', snap(20, null)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', snap(10, 10), { minSamples: 10 }).state, 'triggered');
  assert.strictEqual(one('accuracy_drop', snap(10, 10), { minSamples: 11 }).state, 'no_data');
  assert.deepStrictEqual(rule('accuracy_drop').params, { dropPoints: 5, minSamples: 20 });
});

test('eval_pass_rate: any evaluator under 80% with enough samples', () => {
  const evals = { a: { pass: 15, total: 20 }, b: { pass: 19, total: 20 } };
  let r = one('eval_pass_rate', { evals });
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.value, 0.75);
  assert.strictEqual(r.threshold, 0.8);
  r = one('eval_pass_rate', { evals: { a: { pass: 16, total: 20 } } });
  assert.strictEqual(r.state, 'ok'); // exactly 80% is not under 80%
  assert.strictEqual(r.value, 0.8);
  // The lowest rate among evaluators with enough samples is reported.
  const spread = { a: { pass: 17, total: 20 }, b: { pass: 10, total: 20 }, c: { pass: 0, total: 5 } };
  r = one('eval_pass_rate', { evals: spread });
  assert.strictEqual(r.value, 0.5);
});

test('eval_pass_rate respects minSamples', () => {
  const evals = { a: { pass: 1, total: 19 } };
  assert.strictEqual(one('eval_pass_rate', { evals }).state, 'no_data');
  assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 1, total: 20 } } }).state, 'triggered');
  assert.strictEqual(one('eval_pass_rate', { evals }, { minSamples: 10 }).state, 'triggered');
  assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 5, total: 5 } } }, { minSamples: 5 }).state, 'ok');
  // An evaluator with too few samples does not hide a healthy one.
  const mixed = { a: { pass: 0, total: 3 }, b: { pass: 20, total: 20 } };
  assert.strictEqual(one('eval_pass_rate', { evals: mixed }).state, 'ok');
  assert.strictEqual(one('eval_pass_rate', { evals: {} }).state, 'no_data');
  assert.strictEqual(one('eval_pass_rate', {}).state, 'no_data');
});

test('unsafe_content: a secret, or an external injection, in the last hour', () => {
  const sig = (kind, over = {}) => ({ ts: NOW - 5 * MIN, sid: 's1', kind, ...over });
  const three = [sig('secret'), sig('secret', { sid: 's2' }), sig('injection', { external: true })];
  let r = one('unsafe_content', { signals: three });
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.value, 3);
  assert.strictEqual(r.threshold, 1);
  assert.strictEqual(r.sessionId, null);
  assert.strictEqual(one('unsafe_content', { signals: [sig('injection', { external: true })] }).value, 1);
  const harmless = [sig('injection'), sig('injection', { external: false }), sig('loop'), sig('error')];
  r = one('unsafe_content', { signals: harmless });
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.value, 0);
  r = one('unsafe_content', { signals: [sig('secret', { ts: NOW - 61 * MIN })] });
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(one('unsafe_content', { signals: [] }).state, 'ok');
  assert.strictEqual(one('unsafe_content', {}).state, 'no_data');
});

test('evaluate tolerates bad parameters and a missing snapshot', () => {
  for (const r of RULES) {
    for (const snap of [undefined, null, {}]) {
      const out = evaluate(r, { garbage: 1 }, snap, NOW);
      assert.ok(out.length >= 1, r.id);
      assert.ok(
        out.every((x) => x.state === 'no_data'),
        r.id,
      );
    }
  }
  // Non-numeric or negative parameters fall back to the defaults.
  const s = { sessions: [sess({ cost10m: 6 })] };
  assert.strictEqual(one('cost_burn', s, { maxUSD: 'abc' }).state, 'triggered');
  assert.strictEqual(one('cost_burn', s, { maxUSD: -1 }).threshold, 5);
  assert.strictEqual(one('cost_burn', s, { maxUSD: '7' }).state, 'ok');
  assert.throws(() => evaluate({ id: 'nope' }, {}, {}, NOW), /unknown rule/i);
});

test('evaluate does not change the snapshot', () => {
  const snap = {
    budget: { monthlyUSD: 300 },
    today: { cost: 12 },
    sessions: [sess({ cost10m: 9, toolCallsTurn: 99 })],
    signals: [{ ts: NOW, sid: 's1', kind: 'loop' }],
    evals: { a: { pass: 1, total: 30 } },
    accuracy: { today: 0.5, prev7: 0.9 },
    month: { cost: 1, projection: 999 },
  };
  const before = JSON.stringify(snap);
  for (const r of RULES) evaluate(r, {}, snap, NOW);
  assert.strictEqual(JSON.stringify(snap), before);
});

test('daily_cost: an explicit limit works without a budget; defaultOn still follows the budget', () => {
  const cost6 = { budget: { monthlyUSD: 0 }, today: { cost: 6 } };
  const r = one('daily_cost', cost6, { limitUSD: 5 });
  assert.strictEqual(r.state, 'triggered');
  assert.strictEqual(r.threshold, 5);
  assert.strictEqual(one('daily_cost', { today: { cost: 6 } }, { limitUSD: 5 }).state, 'triggered');
  assert.strictEqual(one('daily_cost', { today: { cost: 4 } }, { limitUSD: 5 }).state, 'ok');
  // The explicit limit wins over the budget in both directions.
  const small = { budget: { monthlyUSD: 30 }, today: { cost: 4 } };
  assert.strictEqual(one('daily_cost', small, { limitUSD: 5 }).state, 'ok');
  // Neither a limit nor a budget: no data. A limit of 0 means "use the budget".
  assert.strictEqual(one('daily_cost', cost6).state, 'no_data');
  assert.strictEqual(one('daily_cost', cost6, { limitUSD: 0 }).state, 'no_data');
  assert.strictEqual(rule('daily_cost').defaultOn({ monthlyBudgetUSD: 0 }), false);
});

test('negative, NaN and out-of-range numbers give no_data', () => {
  const bad = [-1, NaN, Infinity, '3', null];
  for (const v of bad) {
    const budget = { monthlyUSD: 300 };
    assert.strictEqual(one('daily_cost', { budget, today: { cost: v } }).state, 'no_data', `daily ${v}`);
    assert.strictEqual(one('month_projection', { budget, month: { projection: v } }).state, 'no_data', `proj ${v}`);
    assert.strictEqual(one('cost_burn', { sessions: [sess({ cost10m: v })] }).state, 'no_data', `burn ${v}`);
    assert.strictEqual(one('accuracy_drop', { accuracy: { today: v, prev7: 0.9 } }).state, 'no_data', `acc ${v}`);
    assert.strictEqual(one('accuracy_drop', { accuracy: { today: 0.5, prev7: v } }).state, 'no_data', `prev ${v}`);
    assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: v, total: 30 } } }).state, 'no_data', `pass ${v}`);
    assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 1, total: v } } }).state, 'no_data', `total ${v}`);
  }
  // A budget that is negative or NaN is no budget.
  for (const v of [-300, NaN]) {
    assert.strictEqual(one('daily_cost', { budget: { monthlyUSD: v }, today: { cost: 1 } }).state, 'no_data');
    const proj = { budget: { monthlyUSD: v }, month: { projection: 1 } };
    assert.strictEqual(one('month_projection', proj).state, 'no_data');
  }
  // toolCallsTurn present but bad is bad data; an absent one is unknown but not bad.
  for (const v of [-1, NaN, Infinity, '9']) {
    const out = one('tool_loop', { sessions: [sess({ toolCallsTurn: v })], signals: [] });
    assert.strictEqual(out.state, 'no_data', `calls ${v}`);
  }
  assert.strictEqual(one('tool_loop', { sessions: [{ sid: 'x' }], signals: [] }).state, 'ok');
  // agent_stuck: a NaN or missing time is no data for a busy agent.
  for (const v of [NaN, Infinity, undefined, '5']) {
    assert.strictEqual(one('agent_stuck', { sessions: [sess({ lastTs: v })] }).state, 'no_data', `lastTs ${v}`);
  }
  // unsafe_content ignores signals whose time is bad rather than counting them.
  const sigs = [-1, NaN, undefined].map((ts) => ({ ts, sid: 's1', kind: 'secret' }));
  assert.strictEqual(one('unsafe_content', { signals: sigs }).value, 0);
});

test('accuracy must be between 0 and 1', () => {
  const acc = (today, prev7) => ({ accuracy: { today, prev7, todayResults: 50, prev7Results: 50 } });
  assert.strictEqual(one('accuracy_drop', acc(80, 85)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', acc(0.5, 1.01)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', acc(-0.1, 0.9)).state, 'no_data');
  assert.strictEqual(one('accuracy_drop', acc(0, 1)).state, 'triggered');
  assert.strictEqual(one('accuracy_drop', acc(1, 1)).state, 'ok');
});

test('eval_pass_rate needs 0 <= pass <= total', () => {
  assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 31, total: 30 } } }).state, 'no_data');
  const empty = { evals: { a: { pass: 0, total: 0 } } };
  assert.strictEqual(one('eval_pass_rate', empty, { minSamples: 0 }).state, 'no_data');
  assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 30, total: 30 } } }).state, 'ok');
  assert.strictEqual(one('eval_pass_rate', { evals: { a: { pass: 0, total: 30 } } }).state, 'triggered');
  // A bad entry is ignored; a good one next to it still counts.
  const mixed = { a: { pass: 40, total: 30 }, b: { pass: 10, total: 30 } };
  assert.strictEqual(one('eval_pass_rate', { evals: mixed }).value, 0.333333);
  assert.strictEqual(one('eval_pass_rate', { evals: { a: null, b: 'x' } }).state, 'no_data');
});

test('live rules skip entries without a string sid and keep the first of a repeated sid', () => {
  const sessions = [
    null,
    'x',
    { title: 'no sid', cost10m: 99 },
    { sid: 7, cost10m: 99 },
    sess({ sid: 'a', cost10m: 1 }),
    sess({ sid: 'a', cost10m: 99 }),
    sess({ sid: 'b', cost10m: 9 }),
  ];
  for (const id of ['cost_burn', 'tool_loop', 'agent_stuck']) {
    const out = run(id, { sessions, signals: [] });
    assert.deepStrictEqual(
      out.map((r) => r.instance),
      ['a', 'b'],
      id,
    );
  }
  const burn = run('cost_burn', { sessions });
  assert.deepStrictEqual(
    burn.map((r) => r.state),
    ['ok', 'triggered'],
  );
  assert.deepStrictEqual(run('cost_burn', { sessions: [null, {}] }), []);
});

test('agent_stuck: a missing state is no_data and the age is in exact minutes', () => {
  const out = run('agent_stuck', {
    sessions: [
      sess({ sid: 'a', state: undefined, lastTs: NOW - 99 * MIN }),
      sess({ sid: 'b', state: 7, lastTs: NOW - 99 * MIN }),
      sess({ sid: 'c', state: 'working', lastTs: NOW - 10.04 * MIN }),
      sess({ sid: 'd', state: 'thinking', lastTs: NOW - 12.5 * MIN }),
      sess({ sid: 'e', state: 'working', lastTs: NOW + 5 * MIN }),
    ],
  });
  assert.deepStrictEqual(
    out.map((r) => [r.sessionId, r.state, r.value]),
    [
      ['a', 'no_data', null],
      ['b', 'no_data', null],
      ['c', 'triggered', 10],
      ['d', 'triggered', 12.5],
      ['e', 'ok', 0],
    ],
  );
  assert.strictEqual(run('agent_stuck', { sessions: [sess({ lastTs: NOW - 3.26 * MIN })] })[0].value, 3.3);
});

test('a now that is not a finite number gives no_data from every rule', () => {
  const snap = {
    budget: { monthlyUSD: 300 },
    today: { cost: 99 },
    month: { projection: 999 },
    sessions: [sess({ cost10m: 99, toolCallsTurn: 99 })],
    signals: [{ ts: NOW, sid: 's1', kind: 'secret' }],
    accuracy: { today: 0.1, prev7: 0.9 },
    evals: { a: { pass: 0, total: 30 } },
  };
  for (const now of [NaN, undefined, null, Infinity, '1']) {
    for (const r of RULES) {
      const out = evaluate(r, {}, snap, now);
      assert.ok(out.length >= 1 && out.every((x) => x.state === 'no_data'), `${r.id} ${now}`);
    }
  }
});

test('windowMin and stuckMin must be positive', () => {
  const stuck = { sessions: [sess({ lastTs: NOW - 11 * MIN })] };
  for (const v of [0, -5, NaN, 'abc']) {
    const r = one('agent_stuck', stuck, { stuckMin: v });
    assert.strictEqual(r.threshold, 10, `stuckMin ${v}`);
    assert.strictEqual(r.state, 'triggered');
  }
  assert.strictEqual(one('agent_stuck', stuck, { stuckMin: 15 }).state, 'ok');
  const old = { signals: [{ ts: NOW - 90 * MIN, sid: 's1', kind: 'secret' }] };
  for (const v of [0, -5, NaN]) {
    assert.strictEqual(one('unsafe_content', old, { windowMin: v }).state, 'ok', `windowMin ${v}`);
  }
  assert.strictEqual(one('unsafe_content', old, { windowMin: 120 }).state, 'triggered');
});

test('NaN and negative parameters fall back for every rule', () => {
  for (const r of RULES) {
    for (const bad of [NaN, -1, 'abc', null]) {
      const params = Object.fromEntries(Object.keys(r.params).map((k) => [k, bad]));
      const a = evaluate(r, params, {}, NOW);
      const b = evaluate(r, {}, {}, NOW);
      assert.deepStrictEqual(a, b, `${r.id} ${bad}`);
    }
  }
  const s = { sessions: [sess({ cost10m: 6, toolCallsTurn: 51 })], signals: [] };
  assert.strictEqual(one('cost_burn', s, { maxUSD: NaN }).threshold, 5);
  assert.strictEqual(one('tool_loop', s, { maxCalls: -1 }).threshold, 50);
  assert.strictEqual(one('accuracy_drop', { accuracy: { today: 0.5, prev7: 0.9 } }, { dropPoints: NaN }).threshold, 5);
  const low = { evals: { a: { pass: 1, total: 30 } } };
  assert.strictEqual(one('eval_pass_rate', low, { minPassRate: -1 }).threshold, 0.8);
});
