// Cost Control 4a: the Monitors rule cost_anomaly (lib/monitors/rules.js), its per-day instances in the state store
// (lib/monitors/state.js), the engine's snapshot provider and ended days (lib/monitors/index.js), the routes
// (lib/monitors/api.js) and what the channels carry (lib/monitors/channels.js). The channels' spawn is a recorder and
// the webhook a local fake server: nothing is shown or sent for real. 28 October 2026 is a Wednesday.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { RULES, evaluate } = require('../lib/monitors/rules');
const { createMonitorState } = require('../lib/monitors/state');
const { createMonitors, isEndedSession } = require('../lib/monitors');
const { createChannels } = require('../lib/monitors/channels');
const { createMonitorApi } = require('../lib/monitors/api');
const { fakeServer, secretsFor } = require('./helpers');

const MIN = 60e3;
const T28 = new Date(2026, 9, 28, 15).getTime();
const T29 = new Date(2026, 9, 29, 10).getTime();
const T30 = new Date(2026, 9, 30, 10).getTime();
const RULE = RULES.find((r) => r.id === 'cost_anomaly');
// A measureDay result (lib/cost/anomaly.js), with drivers that name a project and a key.
const fig = (day, spentUSD, expectedUSD, partial = false) => ({
  day,
  partial,
  spentUSD,
  expectedUSD,
  drivers: [
    { dim: 'project', value: '~/secret-project', extraUSD: 9, share: 0.7 },
    { dim: 'keyId', value: 'key_secret', extraUSD: 3, share: 0.2 },
  ],
});
const brief = (r) => [r.instance, r.state, r.value, r.threshold, r.title, r.usual];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-mon-anomaly-'));
function store(clock) {
  const dir = tmp();
  return createMonitorState({
    file: path.join(dir, 'monitors.json'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
    now: () => clock.t,
  });
}

test('the rule: listed with its two parameters, on by default, never pausing', () => {
  assert.deepEqual(
    [RULE.title, RULE.describe, RULE.kind, RULE.params, RULE.defaultOn({}), RULE.mayAutoPause, RULE.remind],
    [
      'Cost anomaly',
      "Today's or yesterday's spend is well above what the same weekday usually costs.",
      'aggregate',
      { ratio: 2, minUSD: 1 },
      true,
      false,
      false,
    ],
  );
});

test('the rule: one instance per day, titled, in USD to the cent; no_data without figures or a snapshot', () => {
  const snap = { costAnomaly: { yesterday: fig('2026-10-27', 3, 2), today: fig('2026-10-28', 18.404, 6.1, true) } };
  assert.deepEqual(evaluate(RULE, {}, snap, T28).map(brief), [
    ['2026-10-27', 'ok', 3, 4, 'Tue 27 Oct', 2],
    ['2026-10-28', 'triggered', 18.4, 12.2, 'Wed 28 Oct (so far)', 6.1],
  ]);
  assert.ok(evaluate(RULE, {}, snap, T28).every((r) => r.sessionId === null && !('drivers' in r)));
  assert.equal(evaluate(RULE, { ratio: 4 }, snap, T28)[1].state, 'ok', 'the owner’s ratio');
  assert.equal(evaluate(RULE, { ratio: 0, minUSD: -1 }, snap, T28)[1].threshold, 12.2, 'not positive: defaults');
  // The threshold is the level the spend must pass: with a small usual amount minUSD sets it, with none minUSD alone.
  const small = { costAnomaly: { yesterday: fig('2026-10-27', 0.5, 0), today: fig('2026-10-28', 0.9, 0.3, true) } };
  assert.deepEqual(evaluate(RULE, {}, small, T28).map(brief), [
    ['2026-10-27', 'ok', 0.5, 1, 'Tue 27 Oct', 0],
    ['2026-10-28', 'ok', 0.9, 1.3, 'Wed 28 Oct (so far)', 0.3],
  ]);
  const gaps = { costAnomaly: { yesterday: null, today: fig('2026-10-27', 18, 6) } };
  assert.deepEqual(evaluate(RULE, {}, gaps, T28).map(brief), [
    ['2026-10-27', 'no_data', null, null, 'Tue 27 Oct', undefined],
    ['2026-10-28', 'no_data', null, null, 'Wed 28 Oct (so far)', undefined],
  ]);
  for (const s of [{}, { costAnomaly: null }])
    assert.deepEqual(evaluate(RULE, {}, s, T28).map(brief), [['all', 'no_data', null, null, undefined, undefined]]);
});

test('one alert per day: the partial check and the whole one share the day’s instance, with no reminder', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (snap) => s.apply('cost_anomaly', evaluate(RULE, {}, snap, clock.t));
  const first = apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) } });
  assert.deepEqual(
    first.map((a) => [a.instance, a.state, a.previous, a.value, a.threshold, a.title, a.usual]),
    [['2026-10-28', 'triggered', null, 18.4, 12.2, 'Wed 28 Oct (so far)', 6.1]],
  );
  clock.t = T28 + 31 * MIN;
  assert.deepEqual(
    apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 19, 6.1) } }),
    [],
  );
  clock.t = T29;
  assert.deepEqual(
    apply({ costAnomaly: { yesterday: fig('2026-10-28', 25, 6.1), today: fig('2026-10-29', 1, 2) } }),
    [],
  );
  assert.equal(s.states().find((e) => e.instance === '2026-10-28').title, 'Wed 28 Oct', 'the whole day now');
  // A rise that only shows on the whole day alerts then, once.
  const c2 = { t: T28 };
  const late = store(c2);
  const at = (snap) => late.apply('cost_anomaly', evaluate(RULE, {}, snap, c2.t));
  assert.deepEqual(at({ costAnomaly: { yesterday: null, today: fig('2026-10-28', 3, 2) } }), []);
  c2.t = T29;
  const whole = at({ costAnomaly: { yesterday: fig('2026-10-28', 9, 2), today: null } });
  assert.deepEqual(
    whole.map((a) => [a.instance, a.state, a.title]),
    [['2026-10-28', 'triggered', 'Wed 28 Oct']],
  );
});

test('a snooze keeps an alert already sent quiet, and sends one it held back once it ends', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (today) =>
    s.apply('cost_anomaly', evaluate(RULE, {}, { costAnomaly: { yesterday: null, today } }, clock.t));
  assert.equal(apply(fig('2026-10-28', 18.4, 6.1)).length, 1);
  s.snooze('cost_anomaly', null, 60 * MIN);
  clock.t = T28 + 61 * MIN;
  assert.deepEqual(apply(fig('2026-10-28', 19, 6.1)), [], 'sent before the snooze: not again');
  const c2 = { t: T28 };
  const held = store(c2);
  held.snooze('cost_anomaly', null, 60 * MIN);
  const hold = (today) =>
    held.apply('cost_anomaly', evaluate(RULE, {}, { costAnomaly: { yesterday: null, today } }, c2.t));
  assert.deepEqual(hold(fig('2026-10-28', 18.4, 6.1)), [], 'snoozed');
  c2.t = T28 + 61 * MIN;
  assert.equal(hold(fig('2026-10-28', 19, 6.1)).length, 1, 'held back: sent once the snooze ends');
  c2.t = T28 + 120 * MIN;
  assert.deepEqual(hold(fig('2026-10-28', 20, 6.1)), []);
});

test('a day past yesterday has ended: off the cards and the counts, pruned by the store a day later', () => {
  const row = (instance, lastSeen = T28) => ({ rule: 'cost_anomaly', instance, lastSeen, state: 'triggered' });
  assert.equal(isEndedSession(row('2026-10-27'), T29), true);
  assert.equal(isEndedSession(row('2026-10-28'), T29), false, 'yesterday is still checked');
  assert.equal(isEndedSession(row('2026-10-29'), T29), false);
  assert.equal(isEndedSession(row('all'), T29), false);
  assert.equal(isEndedSession({ ...row('2026-10-27'), rule: 'accuracy_drop' }, T29), false, 'other rules keep theirs');
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (snap) => s.apply('cost_anomaly', evaluate(RULE, {}, snap, clock.t));
  apply({ costAnomaly: { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) } });
  clock.t = T30;
  const sent = apply({ costAnomaly: { yesterday: fig('2026-10-29', 2, 2), today: fig('2026-10-30', 1, 2) } });
  assert.deepEqual(sent, [], 'no resolution for a day that is over');
  assert.deepEqual(
    s.states().map((e) => e.instance),
    ['2026-10-29', '2026-10-30'],
    'the 27th and 28th were last seen over a day ago',
  );
});

// The engine with a fake index and office, the real state store, and a spy for the channels.
function engine({ costAnomaly, demo = false } = {}) {
  const clock = { t: T28 };
  const state = store(clock);
  const sent = [];
  const logs = [];
  const monitors = createMonitors({
    indexer: { results: () => [] },
    office: { snapshot: () => ({ agents: [] }), demoSnapshot: () => ({ agents: [] }) },
    evals: { summary: () => ({ evaluators: {} }) },
    config: () => ({}),
    state,
    channels: { notify: async (alert) => sent.push(alert) },
    now: () => clock.t,
    log: (m) => logs.push(m),
    demo,
    costAnomaly,
  });
  return { clock, state, sent, logs, monitors };
}

test('engine: the provider’s figures reach the rule after each aggregate pass; counts leave a day that is over', async () => {
  const seen = [];
  const figures = { yesterday: fig('2026-10-27', 2, 2), today: fig('2026-10-28', 18.4, 6.1) };
  const e = engine({
    costAnomaly: (t) => {
      seen.push(t);
      return figures;
    },
  });
  await e.monitors.tickAggregate();
  assert.deepEqual(seen, [T28]);
  assert.deepEqual(
    e.sent.filter((a) => a.rule === 'cost_anomaly').map((a) => [a.instance, a.title, a.usual]),
    [['2026-10-28', 'Wed 28 Oct (so far)', 6.1]],
  );
  assert.equal((await e.monitors.status()).counts.triggered, 1);
  e.clock.t = T30;
  figures.yesterday = fig('2026-10-29', 2, 2);
  figures.today = fig('2026-10-30', 1, 2);
  await e.monitors.tickAggregate();
  const counts = (await e.monitors.status()).counts;
  assert.equal(counts.triggered, 0, 'the 28th is over');
});

test('engine: no provider, or one that throws, is no_data; the demo evaluates but sends nothing', async () => {
  const none = engine();
  await none.monitors.tickAggregate();
  assert.deepEqual(
    none.state
      .states()
      .filter((x) => x.rule === 'cost_anomaly')
      .map((x) => [x.instance, x.state]),
    [['all', 'no_data']],
  );
  const broken = engine({
    costAnomaly: () => {
      throw new Error('ledger unreadable');
    },
  });
  await broken.monitors.tickAggregate();
  assert.ok(broken.logs.some((m) => /could not read the cost anomalies/.test(m)));
  assert.equal(broken.state.states().find((x) => x.rule === 'cost_anomaly').state, 'no_data');
  const demo = engine({ demo: true, costAnomaly: () => ({ yesterday: null, today: fig('2026-10-28', 18.4, 6.1) }) });
  await demo.monitors.tickAggregate();
  assert.equal(demo.state.states().find((x) => x.instance === '2026-10-28').state, 'triggered');
  assert.deepEqual(demo.sent, []);
});

test('routes: the two parameters are bounded; an alert carries its usual amount, never a driver', async () => {
  const clock = { t: T28 };
  const state = store(clock);
  state.apply(
    'cost_anomaly',
    evaluate(RULE, {}, { costAnomaly: { yesterday: null, today: fig('2026-10-28', 18.4, 6.1) } }, T28),
  );
  const api = createMonitorApi({
    state,
    monitors: { status: async () => ({}) },
    channels: {},
    control: {},
    trace: { keyFor: () => null },
    channelSettings: { get: () => ({ desktop: true, webhook: null }) },
    now: () => clock.t,
  });
  const call = (p, method = 'GET', body) =>
    api.route({
      method,
      path: p,
      query: new URLSearchParams(''),
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
    });
  const rules = (await call('/api/monitors')).body.rules;
  const card = rules.find((r) => r.id === 'cost_anomaly');
  assert.deepEqual([card.params, card.state, card.instances.length], [{ ratio: 2, minUSD: 1 }, 'triggered', 2]);
  assert.equal((await call('/api/monitors/cost_anomaly', 'POST', { params: { ratio: 3, minUSD: 0.5 } })).status, 200);
  assert.deepEqual(state.settings('cost_anomaly').params, { ratio: 3, minUSD: 0.5 });
  for (const params of [{ ratio: 1 }, { ratio: 0.5 }, { minUSD: 0 }, { ratio: 101 }])
    assert.equal((await call('/api/monitors/cost_anomaly', 'POST', { params })).status, 400, JSON.stringify(params));
  const alerts = (await call('/api/alerts')).body.alerts;
  const a = alerts.find((x) => x.rule === 'cost_anomaly');
  assert.deepEqual([a.title, a.value, a.threshold, a.usual], ['Wed 28 Oct (so far)', 18.4, 12.2, 6.1]);
  assert.doesNotMatch(JSON.stringify(alerts), /secret|drivers/);
});

test('channels: the desktop and the webhook carry the rule, the change, the numbers and the day, never a driver', async () => {
  const clock = { t: T28 };
  const state = store(clock);
  const snap = { costAnomaly: { yesterday: null, today: fig('2026-10-28', 18.4, 6.1) } };
  const [alert] = state.apply('cost_anomaly', evaluate(RULE, {}, snap, T28));
  assert.doesNotMatch(JSON.stringify(alert), /secret|drivers/, 'the alert itself holds no driver');
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      const child = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end() {} });
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const ch = createChannels({
      spawn,
      secrets: secretsFor({ HOOK_URL: `${srv.url}/hook` }),
      settings: () => ({ desktop: true, webhook: { url: { env: 'HOOK_URL' } } }),
      platform: 'darwin',
      sleep: () => Promise.resolve(),
    });
    await ch.notify(alert, { title: alert.title });
    assert.equal(calls[0].args[6], 'ZAAFPulse: Cost anomaly');
    assert.equal(calls[0].args[7], 'Triggered: 18.4 (limit 12.2)\nWed 28 Oct (so far)');
    assert.deepEqual(srv.requests[0].body, {
      rule: 'cost_anomaly',
      state: 'triggered',
      previous: null,
      value: 18.4,
      threshold: 12.2,
      sessionId: null,
      ts: T28,
    });
    assert.doesNotMatch(JSON.stringify([calls, srv.requests[0].body]), /secret|drivers/);
  } finally {
    await srv.close();
  }
});

test('a snooze does not carry an earlier ok into the resolution hold of a rule without reminders', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const apply = (spent) =>
    s.apply(
      'cost_anomaly',
      evaluate(RULE, {}, { costAnomaly: { yesterday: null, today: fig('2026-10-28', spent, 6.1) } }, clock.t),
    );
  assert.equal(apply(18.4).length, 1);
  clock.t = T28 + MIN;
  assert.deepEqual(apply(1), [], 'ok: the hold starts');
  clock.t = T28 + 2 * MIN;
  s.snooze('cost_anomaly', null, 40 * MIN);
  clock.t = T28 + 30 * MIN;
  assert.deepEqual(apply(19), [], 'triggered again inside the snooze');
  clock.t = T28 + 63 * MIN;
  assert.deepEqual(apply(1), [], 'ok after the snooze: the hold starts afresh, no resolution at once');
  clock.t = T28 + 70 * MIN;
  assert.deepEqual(
    apply(1).map((a) => a.state),
    ['ok'],
    'resolved once the hold has passed',
  );
});

test('a provider that failed once leaves no "all" no_data beside the day instances', () => {
  const clock = { t: T28 };
  const s = store(clock);
  s.apply('cost_anomaly', evaluate(RULE, {}, {}, clock.t));
  assert.deepEqual(
    s.states().map((e) => e.instance),
    ['all'],
  );
  clock.t = T28 + 5 * MIN;
  s.apply(
    'cost_anomaly',
    evaluate(RULE, {}, { costAnomaly: { yesterday: null, today: fig('2026-10-28', 3, 2) } }, clock.t),
  );
  assert.deepEqual(
    s.states().map((e) => e.instance),
    ['2026-10-27', '2026-10-28'],
  );
});

test('an ordinary rule still starts afresh when its snooze ends', () => {
  const clock = { t: T28 };
  const s = store(clock);
  const unsafe = RULES.find((r) => r.id === 'unsafe_content');
  const snap = { signals: [{ kind: 'secret', ts: T28 }] };
  const apply = () => s.apply('unsafe_content', evaluate(unsafe, {}, snap, clock.t));
  assert.equal(apply().length, 1);
  s.snooze('unsafe_content', null, 10 * MIN);
  clock.t = T28 + 5 * MIN;
  assert.deepEqual(apply(), []);
  clock.t = T28 + 11 * MIN;
  assert.equal(apply().length, 1, 'still triggered after the snooze: alerts again, as it always has');
});
