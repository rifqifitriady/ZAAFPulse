// test/budgets-monitors.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createMonitorState } = require('../lib/monitors/state');
const { createChannels } = require('../lib/monitors/channels');
const { createMonitorApi } = require('../lib/monitors/api');
const { RULES, BUDGET_RULE, ruleById, isBudgetState } = require('../lib/monitors/rules');
const { fakeServer, secretsFor } = require('./helpers');

const T0 = 1_800_000_000_000;
const HOUR = 3600e3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-budgets-monitors-'));
function store(dir = tmp()) {
  const clock = { t: T0 };
  const make = () =>
    createMonitorState({
      file: path.join(dir, 'monitors.json'),
      alertsFile: path.join(dir, 'alerts.jsonl'),
      now: () => clock.t,
      config: () => ({}),
    });
  return { s: make(), make, clock, dir };
}
const res = (over = {}) => ({
  instance: 'team',
  state: 'ok',
  projected: false,
  periodKey: 'month:2026-10-01',
  period: 'month',
  value: 10,
  threshold: null,
  title: 'Team',
  ...over,
});
const brief = (a) => [a.state, a.previous, a.projected];

test('the budget rule sits beside the eight fixed rules', () => {
  assert.equal(RULES.length, 8);
  assert.equal(
    RULES.some((r) => r.id === 'budget'),
    false,
  );
  assert.equal(ruleById('budget'), BUDGET_RULE);
  assert.equal(ruleById('daily_cost').id, 'daily_cost');
  assert.equal(ruleById('nope'), null);
  for (const s of ['ok', 'exceeded', 'no_data', 'warn_50', 'warn_8']) assert.equal(isBudgetState(s), true, s);
  for (const s of ['triggered', 'warn_100', 'warn_0', 'warn_x', 'snoozed', ''])
    assert.equal(isBudgetState(s), false, s);
});

test('applyBudgets: an alert on each change of state, none on repeats or no_data', () => {
  const { s, clock } = store();
  assert.deepEqual(s.applyBudgets([res()]), [], 'first seen at ok: quiet');
  const a = s.applyBudgets([res({ state: 'warn_50', value: 55, threshold: 50 })]);
  assert.equal(a.length, 1);
  const { id, ts, ...rest } = a[0];
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(ts, T0);
  assert.deepEqual(rest, {
    rule: 'budget',
    instance: 'team',
    sessionId: null,
    state: 'warn_50',
    previous: 'ok',
    value: 55,
    threshold: 50,
    period: 'month',
    projected: false,
    title: 'Team',
  });
  clock.t += HOUR;
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', value: 60, threshold: 50 })]), [], 'no reminder');
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', value: 104, threshold: 100 })]).map(brief), [
    ['exceeded', 'warn_50', false],
  ]);
  assert.deepEqual(s.applyBudgets([res({ state: 'no_data', value: null })]), []);
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', value: 106 })]), [], 'back from no_data at the same state');
  assert.deepEqual(
    s.applyBudgets([res({ state: 'warn_80', value: 90, threshold: 80 })]).map(brief),
    [['warn_80', 'exceeded', false]],
    'the amount was raised',
  );
  assert.equal(s.alerts({ limit: 10 }).filter((x) => x.rule === 'budget').length, 3);
  const fresh = store().s;
  assert.deepEqual(
    fresh.applyBudgets([res({ state: 'warn_80' })]).map(brief),
    [['warn_80', 'ok', false]],
    'first seen above a level',
  );
});

test('applyBudgets: the projection alerts when it starts to pass the amount, and never beside exceeded', () => {
  const { s } = store();
  s.applyBudgets([res({ state: 'warn_50' })]);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: true })]).map(brief), [
    ['warn_50', 'warn_50', true],
  ]);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: true })]), []);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', projected: false })]), [], 'falling back is quiet');
  assert.equal(s.applyBudgets([res({ state: 'warn_50', projected: true })]).length, 1);
  assert.deepEqual(s.applyBudgets([res({ state: 'exceeded', projected: true })]).map(brief), [
    ['exceeded', 'warn_50', false],
  ]);
});

test('applyBudgets: a new period starts at ok without an alert, and may alert again from there', () => {
  const { s } = store();
  s.applyBudgets([res({ state: 'exceeded' })]);
  assert.deepEqual(s.applyBudgets([res({ periodKey: 'month:2026-11-01' })]), [], 'reset without an alert');
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_50', periodKey: 'month:2026-11-01' })]).map(brief), [
    ['warn_50', 'ok', false],
  ]);
  const b = store().s;
  b.applyBudgets([res({ state: 'exceeded' })]);
  assert.deepEqual(
    b.applyBudgets([res({ state: 'warn_80', periodKey: 'month:2026-11-01' })]).map(brief),
    [['warn_80', 'ok', false]],
    'a new period that opens above a level alerts from ok',
  );
});

test('applyBudgets: retire with the list, keep without it; snooze is quiet; the state survives a restart', () => {
  const { s, make, clock } = store();
  s.applyBudgets([res(), res({ instance: 'lab', title: 'Lab' })]);
  s.snooze('budget', 'lab', HOUR);
  s.applyBudgets([res()], { retire: false });
  assert.ok(
    s.states().some((e) => e.instance === 'lab'),
    'kept while the list did not read in full',
  );
  s.applyBudgets([res()]);
  assert.ok(!s.states().some((e) => e.instance === 'lab'), 'gone with its budget');
  assert.equal(s.applyBudgets([res(), res({ instance: 'lab', state: 'warn_50' })]).length, 1, 'its snooze went too');
  s.snooze('budget', 'team', HOUR);
  assert.deepEqual(s.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]), []);
  assert.equal(s.states().find((e) => e.instance === 'team').state, 'snoozed');
  clock.t += 2 * HOUR;
  assert.deepEqual(
    s.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]),
    [],
    'tracked while snoozed',
  );
  const again = make();
  assert.deepEqual(
    again.applyBudgets([res({ state: 'warn_80' }), res({ instance: 'lab', state: 'warn_50' })]),
    [],
    'after a restart',
  );
  clock.t += 2 * 86400e3;
  again.apply('unsafe_content', [{ instance: 'all', sessionId: null, state: 'ok', value: 0, threshold: 1 }]);
  assert.ok(
    again.states().some((e) => e.rule === 'budget'),
    'the day-old prune leaves budgets alone',
  );
});

test('pendingBudgets and markActed: once per period, never on no data', () => {
  const { s, make } = store();
  s.applyBudgets([res({ state: 'warn_50' })]);
  assert.deepEqual(s.pendingBudgets(), []);
  assert.equal(s.markActed('budget', 'team'), false, 'only an exceeded budget');
  s.applyBudgets([res({ state: 'exceeded', value: 120, threshold: 100 })]);
  assert.deepEqual(
    s.pendingBudgets().map((p) => [p.instance, p.sessionId, p.value, p.title]),
    [['team', null, 120, 'Team']],
  );
  assert.equal(s.markActed('budget', 'team'), true);
  assert.equal(s.markActed('budget', 'team'), false, 'once');
  assert.deepEqual(make().pendingBudgets(), [], 'the mark is saved');
  s.applyBudgets([res({ state: 'exceeded', value: 130 })]);
  assert.deepEqual(s.pendingBudgets(), [], 'still this period');
  s.applyBudgets([res({ state: 'exceeded', periodKey: 'month:2026-11-01' })]);
  assert.deepEqual(
    s.pendingBudgets().map((p) => p.instance),
    ['team'],
    'a new period may pause again',
  );
  s.applyBudgets([res({ state: 'no_data', periodKey: 'month:2026-11-01' })]);
  assert.deepEqual(s.pendingBudgets(), [], 'never on no data');
});

test('a saved budget entry with a bad state is dropped on load', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'monitors.json'),
    JSON.stringify({
      version: 1,
      states: [
        { rule: 'budget', instance: 'x', state: 'warn_x' },
        { rule: 'budget', instance: 'y', state: 'warn_80', period: 'month:2026-10-01' },
      ],
    }),
  );
  const { s } = store(dir);
  assert.deepEqual(
    s.states().map((e) => [e.instance, e.state]),
    [['y', 'warn_80']],
  );
});

// ---- channels ----
function recorder() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    calls.push({ cmd, args, opts });
    child.stdin = Object.assign(new EventEmitter(), { end() {} });
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { calls, spawn };
}
const budgetAlert = (over = {}) => ({
  id: 'b1',
  ts: 1_700_000_000_000,
  rule: 'budget',
  instance: 'team',
  sessionId: null,
  state: 'warn_80',
  previous: 'warn_50',
  value: 82.4,
  threshold: 80,
  title: 'Team',
  period: 'month',
  projected: false,
  ...over,
});

test('channels: a budget alert on the desktop names the level, the share and the period; the name is the second line', async () => {
  const text = async (a) => {
    const r = recorder();
    const ch = createChannels({
      spawn: r.spawn,
      secrets: secretsFor(),
      settings: () => ({ desktop: true, webhook: null }),
      platform: 'darwin',
    });
    await ch.notify(a, { title: a.title });
    return r.calls[0] && [r.calls[0].args[6], r.calls[0].args[7]];
  };
  assert.deepEqual(await text(budgetAlert()), [
    'ZAAFPulse: Budget',
    'Passed 80 %: 82 % of the budget this month\nTeam',
  ]);
  assert.equal(
    (await text(budgetAlert({ state: 'exceeded', value: 104 })))[1],
    'Budget used up: 104 % of the budget this month\nTeam',
  );
  assert.equal(
    (await text(budgetAlert({ state: 'ok', previous: 'exceeded', value: 40, period: 'week' })))[1],
    'Back under its levels: 40 % of the budget this week\nTeam',
  );
  assert.equal(
    (await text(budgetAlert({ state: 'warn_50', previous: 'exceeded', value: 60, period: 'day' })))[1],
    'Back to 50 %: 60 % of the budget today\nTeam',
  );
  assert.equal(
    (await text(budgetAlert({ state: 'warn_50', previous: 'warn_50', projected: true, value: 60 })))[1],
    'Projected to pass the budget: 60 % of the budget this month\nTeam',
  );
});

test('channels: the webhook gets the seven fields with the budget state, and never the budget name', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = createChannels({
      spawn: recorder().spawn,
      secrets: secretsFor({ HOOK_URL: `${srv.url}/hook` }),
      settings: () => ({ desktop: false, webhook: { url: { env: 'HOOK_URL' } } }),
    });
    await ch.notify(budgetAlert({ title: 'Secret project budget' }), { title: 'Secret project budget' });
    assert.deepEqual(srv.requests[0].body, {
      rule: 'budget',
      state: 'warn_80',
      previous: 'warn_50',
      value: 82.4,
      threshold: 80,
      sessionId: null,
      ts: 1_700_000_000_000,
    });
    assert.ok(!JSON.stringify(srv.requests[0].body).includes('Secret'));
  } finally {
    await srv.close();
  }
});

// ---- the alerts API ----
function api({ retired = [] } = {}) {
  const dir = tmp();
  const state = createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => T0,
    config: () => ({ monthlyBudgetUSD: 300 }),
  });
  const a = createMonitorApi({
    state,
    monitors: { status: async () => ({ lastAggregate: 1, lastLive: 2, paused: [] }) },
    channels: { test: async () => ({ ok: true }) },
    control: { paused: async () => [] },
    trace: {
      keyFor: () => null,
      sourceOf: () => {
        throw Object.assign(new Error('unknown session'), { status: 404 });
      },
    },
    channelSettings: { get: () => ({ desktop: true, webhook: null }), save: () => {} },
    resolveSecret: () => undefined,
    inDocker: false,
    home: '/Users/owner',
    retired,
    now: () => T0,
  });
  const call = async (p, { method = 'GET', body } = {}) => {
    const u = new URL(p, 'http://x');
    return a.route({
      method,
      path: u.pathname,
      query: u.searchParams,
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body ?? {}),
    });
  };
  return { state, call };
}

test('alerts API: a budget row has its title, the budget name, the period and the projection; the instance is opaque', async () => {
  const { state, call } = api();
  state.applyBudgets([res()]);
  state.applyBudgets([res({ state: 'warn_80', value: 84.2, threshold: 80, projected: true })]);
  const [row] = (await call('/api/alerts')).body.alerts;
  assert.deepEqual(
    { ...row, id: null, instance: null },
    {
      id: null,
      ts: T0,
      rule: 'budget',
      ruleTitle: 'Budget',
      instance: null,
      sessionKey: null,
      title: 'Team',
      value: 84.2,
      threshold: 80,
      period: 'month',
      projected: true,
      state: 'warn_80',
      previous: 'ok',
    },
  );
  assert.match(row.instance, /^[0-9a-f]{20}$/);
  const st = (await call('/api/monitors/status')).body;
  assert.deepEqual(
    st.counts,
    { ok: 0, triggered: 0, no_data: 0, snoozed: 0 },
    'budgets are not monitor rules in the counts',
  );
});

test('alerts API: retired rules are left out, and a change to one is refused', async () => {
  const { call } = api({ retired: ['daily_cost', 'month_projection'] });
  const ids = (await call('/api/monitors')).body.rules.map((r) => r.id);
  assert.deepEqual(ids, ['cost_burn', 'tool_loop', 'agent_stuck', 'accuracy_drop', 'eval_pass_rate', 'unsafe_content']);
  const r = await call('/api/monitors/daily_cost', { method: 'POST', body: { enabled: true } });
  assert.equal(r.status, 410);
  assert.match(r.body.error, /replaced by budgets/);
  assert.equal((await api().call('/api/monitors')).body.rules.length, 8, 'without the option nothing changes');
});
