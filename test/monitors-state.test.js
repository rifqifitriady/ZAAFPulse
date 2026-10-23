const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonitorState } = require('../lib/monitors/state');

const MIN = 60e3;
const HOUR = 60 * MIN;
const dirs = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'monitors-state-'));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// A state over fresh files with a clock the test moves by hand.
function make(opts = {}) {
  const dir = opts.dir || tmpDir();
  const clock = { t: 1_700_000_000_000 };
  const files = { file: path.join(dir, 'data', 'monitors.json'), alertsFile: path.join(dir, 'data', 'alerts.jsonl') };
  const build = (extra = {}) => createMonitorState({ ...files, now: () => clock.t, ...opts, ...extra });
  return { clock, files, state: build(), build };
}
const agg = (state, value = 1, extra = {}) => ({
  instance: 'all',
  sessionId: null,
  state,
  value,
  threshold: 10,
  ...extra,
});
const live = (sid, state, value = 1, extra = {}) => ({
  instance: sid,
  sessionId: sid,
  state,
  value,
  threshold: 5,
  ...extra,
});
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

test('an alert is raised only when the state changes', () => {
  const { state, clock } = make();
  assert.deepEqual(state.apply('daily_cost', [agg('ok')]), [], 'first sight of ok is silent');
  assert.deepEqual(state.apply('daily_cost', [agg('ok')]), []);
  const [up] = state.apply('daily_cost', [agg('triggered', 12)]);
  assert.match(up.id, /^[0-9a-f]{16}$/);
  assert.equal(up.rule, 'daily_cost');
  assert.equal(up.instance, 'all');
  assert.equal(up.sessionId, null);
  assert.equal(up.state, 'triggered');
  assert.equal(up.previous, 'ok');
  assert.equal(up.value, 12);
  assert.equal(up.threshold, 10);
  assert.equal(typeof up.ts, 'number');
  assert.deepEqual(state.apply('daily_cost', [agg('triggered', 13)]), [], 'still triggered, no repeat');
  assert.deepEqual(state.apply('daily_cost', [agg('ok', 2)]), [], 'the resolution is held while ok is young');
  clock.t += 5 * MIN;
  const [down] = state.apply('daily_cost', [agg('ok', 2)]);
  assert.equal(down.state, 'ok');
  assert.equal(down.previous, 'triggered');
  assert.deepEqual(state.apply('daily_cost', [agg('ok')]), []);
});

test('a first sight that is already triggered raises an alert with no previous state', () => {
  const { state } = make();
  const [a] = state.apply('daily_cost', [agg('triggered', 12)]);
  assert.equal(a.state, 'triggered');
  assert.equal(a.previous, null);
});

test('alert ids are random and the record carries the masked title but nothing else', () => {
  const { state } = make();
  const a = state.apply('tool_loop', [live('s1', 'triggered', 60, { title: 'Fix the login' })]);
  const b = state.apply('tool_loop', [live('s2', 'triggered', 70)]);
  assert.notEqual(a[0].id, b[0].id);
  assert.equal(a[0].title, 'Fix the login');
  assert.equal('title' in b[0], false);
  const long = state.apply('tool_loop', [live('s3', 'triggered', 70, { title: 'x'.repeat(200) })]);
  assert.equal(long[0].title.length, 80);
  assert.deepEqual(Object.keys(b[0]).sort(), [
    'id',
    'instance',
    'previous',
    'rule',
    'sessionId',
    'state',
    'threshold',
    'ts',
    'value',
  ]);
});

test('a triggered instance re-alerts at most every 30 minutes', () => {
  const { state, clock } = make();
  assert.equal(state.apply('cost_burn', [live('s1', 'triggered', 9)]).length, 1);
  clock.t += 29 * MIN + 59e3;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'triggered', 9)]), []);
  clock.t += 1e3;
  const [again] = state.apply('cost_burn', [live('s1', 'triggered', 11)]);
  assert.equal(again.state, 'triggered');
  assert.equal(again.previous, 'triggered');
  assert.equal(again.value, 11);
  clock.t += 10 * MIN;
  const quiet = state.apply('cost_burn', [live('s1', 'triggered', 11)]);
  assert.deepEqual(quiet, [], 'the spacing restarts at the last alert');
});

test('instances of one live rule are tracked apart', () => {
  const { state } = make();
  const first = state.apply('cost_burn', [live('s1', 'triggered'), live('s2', 'ok')]);
  assert.deepEqual(
    first.map((a) => a.instance),
    ['s1'],
  );
  const second = state.apply('cost_burn', [live('s1', 'triggered'), live('s2', 'triggered')]);
  assert.deepEqual(
    second.map((a) => a.instance),
    ['s2'],
  );
  assert.equal(state.states().length, 2);
});

test('no_data neither alerts nor resolves, and the first trigger after it alerts', () => {
  const { state, clock } = make();
  state.apply('agent_stuck', [live('s1', 'ok')]);
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'no_data', null)]), []);
  assert.equal(state.states()[0].state, 'no_data');
  const [a] = state.apply('agent_stuck', [live('s1', 'triggered', 12)]);
  assert.equal(a.previous, 'no_data');
  // Data goes missing while an alert is open: not resolved by that, but resolved when it is ok again.
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'no_data', null)]), []);
  clock.t += HOUR;
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'ok', 1)]), [], 'held');
  clock.t += 5 * MIN;
  const [r] = state.apply('agent_stuck', [live('s1', 'ok', 1)]);
  assert.equal(r.state, 'ok');
  assert.equal(r.previous, 'triggered');
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'no_data', null)]), []);
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'ok', 1)]), [], 'no open alert, so nothing to resolve');
});

test('a source that flaps between triggered and no_data does not re-alert inside the spacing', () => {
  const { state, clock } = make();
  assert.equal(state.apply('agent_stuck', [live('s1', 'triggered', 12)]).length, 1);
  clock.t += MIN;
  state.apply('agent_stuck', [live('s1', 'no_data', null)]);
  clock.t += MIN;
  assert.deepEqual(state.apply('agent_stuck', [live('s1', 'triggered', 12)]), []);
  clock.t += 30 * MIN;
  state.apply('agent_stuck', [live('s1', 'no_data', null)]);
  assert.equal(state.apply('agent_stuck', [live('s1', 'triggered', 12)]).length, 1);
});

test('a live rule that returns only an all/no_data result changes nothing', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok')]);
  const before = JSON.stringify(state.states());
  clock.t += 2 * HOUR;
  assert.deepEqual(state.apply('cost_burn', [agg('no_data', null)]), []);
  assert.deepEqual(state.apply('cost_burn', []), []);
  assert.equal(JSON.stringify(state.states()), before);
  // The next real result still sees s1 as triggered, so there is no new alert for it.
  const next = state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok')]);
  assert.deepEqual(
    next.map((a) => a.instance),
    ['s1'],
  );
});

test('an aggregate rule keeps its single no_data result as data', () => {
  const { state } = make();
  state.apply('daily_cost', [agg('ok')]);
  state.apply('daily_cost', [agg('no_data', null)]);
  assert.equal(state.states()[0].state, 'no_data');
});

test('an instance missing from a later result is neither resolved nor dropped at once', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok')]);
  clock.t += HOUR;
  assert.deepEqual(state.apply('cost_burn', [live('s2', 'ok')]), []);
  assert.deepEqual(
    state
      .states()
      .map((s) => [s.instance, s.state])
      .sort(),
    [
      ['s1', 'triggered'],
      ['s2', 'ok'],
    ],
  );
});

test('instances not seen for 24 hours are pruned', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('gone', 'triggered', 9), live('stays', 'ok')]);
  clock.t += 24 * HOUR - 1;
  state.apply('cost_burn', [live('stays', 'ok')]);
  assert.equal(state.states().length, 2, 'just under 24 h');
  clock.t += 2;
  state.apply('cost_burn', [live('stays', 'ok')]);
  assert.deepEqual(
    state.states().map((s) => s.instance),
    ['stays'],
  );
  // Pruned means forgotten: the same session coming back is a first sight.
  assert.equal(state.apply('cost_burn', [live('gone', 'triggered', 9)])[0].previous, null);
  // Pruning is across rules.
  state.apply('daily_cost', [agg('ok')]);
  clock.t += 25 * HOUR;
  state.apply('tool_loop', [live('x', 'ok')]);
  assert.deepEqual(
    state.states().map((s) => s.rule),
    ['tool_loop'],
  );
});

test('snooze for an hour silences an instance, then it is evaluated afresh', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'ok'), live('s2', 'ok')]);
  state.snooze('cost_burn', 's1', HOUR);
  assert.equal(state.states().find((s) => s.instance === 's1').state, 'snoozed');
  assert.equal(state.states().find((s) => s.instance === 's2').state, 'ok');
  clock.t += 30 * MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok')]), [], 'silenced');
  assert.equal(state.states().find((s) => s.instance === 's1').state, 'snoozed');
  assert.equal(state.apply('cost_burn', [live('s2', 'triggered', 9)]).length, 1, 'others are not silenced');
  clock.t += 30 * MIN;
  const [a] = state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'triggered', 9)]);
  assert.equal(a.instance, 's1', 'the snooze is over and the trigger counts as new');
  assert.equal(a.previous, null);
  assert.equal(state.states().find((s) => s.instance === 's1').state, 'triggered');
});

test('an instance that is fine when the snooze ends stays quiet', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  state.snooze('cost_burn', 's1', HOUR);
  clock.t += 2 * HOUR;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok')]), []);
});

test('snoozing a rule with a null instance covers its present and future instances', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'ok')]);
  state.apply('daily_cost', [agg('ok')]);
  state.snooze('cost_burn', null, 24 * HOUR);
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'triggered', 9), live('new', 'triggered', 9)]), []);
  assert.deepEqual(
    state
      .states()
      .filter((s) => s.rule === 'cost_burn')
      .map((s) => s.state),
    ['snoozed', 'snoozed'],
  );
  assert.equal(state.apply('daily_cost', [agg('triggered', 12)]).length, 1, 'other rules are unaffected');
  clock.t += 24 * HOUR;
  assert.equal(state.apply('cost_burn', [live('s1', 'triggered', 9)]).length, 1);
});

test('a snooze can be set before the instance is first seen, and cleared with zero', () => {
  const { state } = make();
  state.snooze('cost_burn', 'later', HOUR);
  assert.deepEqual(state.apply('cost_burn', [live('later', 'triggered', 9)]), []);
  state.snooze('cost_burn', 'later', 0);
  assert.equal(state.apply('cost_burn', [live('later', 'triggered', 9)]).length, 1);
});

test('snooze rejects an unknown rule and a bad duration', () => {
  const { state } = make();
  assert.throws(() => state.snooze('nope', null, HOUR), { status: 400 });
  assert.throws(() => state.snooze('cost_burn', null, 'soon'), { status: 400 });
  assert.throws(() => state.snooze('cost_burn', null, -1), { status: 400 });
  assert.throws(() => state.snooze('cost_burn', 5, HOUR), { status: 400 });
});

test('apply rejects an unknown rule and skips malformed results', () => {
  const { state } = make();
  assert.throws(() => state.apply('nope', []), /Unknown rule/);
  assert.deepEqual(state.apply('cost_burn', null), []);
  const odd = [
    null,
    7,
    { instance: 5, state: 'triggered' },
    { instance: 's', state: 'weird' },
    live('ok1', 'triggered', NaN),
  ];
  const out = state.apply('cost_burn', odd);
  assert.equal(out.length, 1);
  assert.equal(out[0].instance, 'ok1');
  assert.equal(out[0].value, null);
});

test('state, snoozes and alerts survive a restart without re-firing', () => {
  const { state, clock, build, files } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok'), live('s3', 'ok')]);
  state.snooze('cost_burn', 's3', 3 * HOUR);
  const alertsBefore = state.alerts({});
  const again = build();
  assert.deepEqual(again.states(), state.states());
  clock.t += MIN;
  const quiet = again.apply('cost_burn', [live('s1', 'triggered', 9), live('s2', 'ok'), live('s3', 'triggered', 9)]);
  assert.deepEqual(quiet, []);
  assert.deepEqual(again.alerts({}), alertsBefore);
  assert.equal(JSON.parse(fs.readFileSync(files.file, 'utf8')).states.length, 3);
  clock.t += 30 * MIN;
  const due = again.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(due.length, 1, 'the spacing counts from before the restart');
});

test('settings default from the rule and the injected config, and persist', () => {
  let config = { monthlyBudgetUSD: 0 };
  const { state, build } = make({ config: () => config });
  assert.deepEqual(state.settings('daily_cost'), { enabled: false, params: {}, autoPause: false });
  assert.equal(state.settings('tool_loop').enabled, true);
  assert.equal(state.settings('cost_burn').enabled, false);
  config = { monthlyBudgetUSD: 300 };
  assert.equal(state.settings('daily_cost').enabled, true, 'the default follows the config');
  const saved = state.setSettings('cost_burn', { enabled: true, params: { maxUSD: 8 }, autoPause: true });
  assert.deepEqual(saved, { enabled: true, params: { maxUSD: 8 }, autoPause: true });
  state.setSettings('daily_cost', { enabled: false });
  assert.equal(state.settings('daily_cost').enabled, false, 'an explicit choice beats the default');
  const again = build({ config: () => config });
  assert.deepEqual(again.settings('cost_burn'), { enabled: true, params: { maxUSD: 8 }, autoPause: true });
  assert.equal(again.settings('daily_cost').enabled, false);
  // Fields left out keep their stored value.
  again.setSettings('cost_burn', { enabled: false });
  assert.deepEqual(again.settings('cost_burn'), { enabled: false, params: { maxUSD: 8 }, autoPause: true });
  // A returned object is a copy.
  again.settings('cost_burn').params.maxUSD = 1;
  assert.equal(again.settings('cost_burn').params.maxUSD, 8);
});

test('settings reject bad input', () => {
  const { state } = make();
  assert.throws(() => state.setSettings('nope', {}), { status: 400 });
  assert.throws(() => state.settings('nope'), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { enabled: 'yes' }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { autoPause: 1 }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { params: { bogus: 1 } }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { params: { maxUSD: -1 } }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { params: { maxUSD: 'a lot' } }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', { params: [] }), { status: 400 });
  assert.throws(() => state.setSettings('cost_burn', null), { status: 400 });
  // Only the three cost rules may pause an agent.
  for (const id of ['month_projection', 'agent_stuck', 'accuracy_drop', 'eval_pass_rate', 'unsafe_content']) {
    assert.throws(() => state.setSettings(id, { autoPause: true }), { status: 400 }, id);
  }
  for (const id of ['daily_cost', 'cost_burn', 'tool_loop']) {
    assert.equal(state.setSettings(id, { autoPause: true }).autoPause, true, id);
  }
  // A null parameter goes back to the rule's default.
  state.setSettings('cost_burn', { params: { maxUSD: 9 } });
  assert.deepEqual(state.setSettings('cost_burn', { params: { maxUSD: null } }).params, {});
});

test('autoPause in an edited file is ignored for a rule that may not pause', () => {
  const { state, files, build } = make();
  state.setSettings('cost_burn', { enabled: true });
  const j = JSON.parse(fs.readFileSync(files.file, 'utf8'));
  j.settings.agent_stuck = { enabled: true, params: {}, autoPause: true };
  fs.writeFileSync(files.file, JSON.stringify(j));
  assert.equal(build().settings('agent_stuck').autoPause, false);
});

test('alerts come newest first, filtered by since and limited', () => {
  const { state, clock } = make();
  for (let i = 0; i < 5; i++) {
    state.apply('cost_burn', [live('s' + i, 'triggered', i)]);
    clock.t += 1000;
  }
  const all = state.alerts({});
  assert.deepEqual(
    all.map((a) => a.instance),
    ['s4', 's3', 's2', 's1', 's0'],
  );
  assert.deepEqual(
    state.alerts({ limit: 2 }).map((a) => a.instance),
    ['s4', 's3'],
  );
  const since = all[2].ts;
  assert.deepEqual(
    state.alerts({ since }).map((a) => a.instance),
    ['s4', 's3'],
  );
  assert.deepEqual(state.alerts().length, 5);
  assert.equal(state.alerts({ limit: 'many' }).length, 5, 'a bad limit falls back');
});

test('the alerts file is capped by compacting to the newest', () => {
  const { state, files, clock } = make({ maxAlerts: 5 });
  for (let i = 0; i < 12; i++) {
    state.apply('cost_burn', [live('s' + i, 'triggered', i)]);
    clock.t += 1000;
    assert.ok(lines(files.alertsFile).length <= 5);
  }
  assert.deepEqual(
    lines(files.alertsFile).map((l) => JSON.parse(l).instance),
    ['s7', 's8', 's9', 's10', 's11'],
  );
  assert.deepEqual(
    state.alerts({}).map((a) => a.instance),
    ['s11', 's10', 's9', 's8', 's7'],
  );
  // One apply that raises more alerts than the cap keeps the newest.
  const many = Array.from({ length: 9 }, (_, i) => live('b' + i, 'triggered', i));
  assert.equal(state.apply('tool_loop', many).length, 9, 'every alert is still returned to send');
  assert.equal(lines(files.alertsFile).length, 5);
});

test('the default cap is 2000', () => {
  const { state, files } = make();
  const batch = Array.from({ length: 2005 }, (_, i) => live('s' + i, 'triggered', i));
  state.apply('cost_burn', batch);
  assert.equal(lines(files.alertsFile).length, 2000);
  assert.equal(state.alerts({ limit: 5000 }).length, 2000);
});

test('a torn last line in the alerts file is skipped and the next alert starts on its own line', () => {
  const { state, files, clock } = make();
  state.apply('cost_burn', [live('s0', 'triggered')]);
  fs.appendFileSync(files.alertsFile, '{"id":"torn","ru');
  const again = createMonitorState({ ...files, now: () => clock.t });
  assert.equal(again.alerts({}).length, 1);
  again.apply('cost_burn', [live('s1', 'triggered')]);
  assert.deepEqual(
    again.alerts({}).map((a) => a.instance),
    ['s1', 's0'],
  );
  assert.equal(createMonitorState({ ...files, now: () => clock.t }).alerts({}).length, 2);
});

test('a corrupt or foreign state file starts empty instead of throwing', (t) => {
  t.mock.method(console, 'warn', () => {});
  const { files, build } = make();
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  for (const text of ['{nope', '[]', '"x"', '{"states":7,"snoozes":[],"settings":3}', '']) {
    fs.writeFileSync(files.file, text);
    const s = build();
    assert.deepEqual(s.states(), []);
    assert.equal(s.settings('tool_loop').enabled, true);
  }
  // Entries with the wrong shape are dropped, good ones kept.
  fs.writeFileSync(
    files.file,
    JSON.stringify({
      states: [
        { rule: 'cost_burn', instance: 's1', state: 'ok', lastSeen: 1 },
        { rule: 5 },
        null,
        { rule: 'cost_burn', instance: 's2', state: 'bogus' },
      ],
    }),
  );
  assert.deepEqual(
    build()
      .states()
      .map((s) => s.instance),
    ['s1'],
  );
});

test('a failed write does not lose the alert', (t) => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where a folder is expected');
  const warn = t.mock.method(console, 'warn', () => {});
  const state = createMonitorState({
    file: path.join(blocker, 'monitors.json'),
    alertsFile: path.join(blocker, 'alerts.jsonl'),
    now: () => 1_700_000_000_000,
  });
  const out = state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(out.length, 1);
  assert.equal(state.states()[0].state, 'triggered');
  assert.ok(warn.mock.callCount() >= 1);
});

test('the state and alerts files are mode 0600', { skip: process.platform === 'win32' }, () => {
  const { state, files } = make();
  state.apply('cost_burn', [live('s1', 'triggered')]);
  state.setSettings('cost_burn', { enabled: true });
  state.snooze('cost_burn', 's1', HOUR);
  for (const f of [files.file, files.alertsFile]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
  // Later rewrites keep the mode, and no temp file is left behind.
  state.apply('cost_burn', [live('s1', 'ok')]);
  assert.equal(fs.statSync(files.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(files.file)).sort(), ['alerts.jsonl', 'monitors.json']);
  // A file left loose by an older build is tightened on the next write.
  fs.chmodSync(files.file, 0o644);
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(fs.statSync(files.file).mode & 0o777, 0o600);
});

test("parameter names are the rule's own keys, not inherited ones", () => {
  const { state, files, build } = make();
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => state.setSettings('cost_burn', { params: { [name]: 1 } }), { status: 400 }, name);
  }
  // JSON.parse makes __proto__ a real own key, which is how it would arrive from a request body.
  for (const body of ['{"__proto__":{"maxUSD":1}}', '{"__proto__":1}']) {
    assert.throws(() => state.setSettings('cost_burn', { params: JSON.parse(body) }), { status: 400 }, body);
  }
  assert.deepEqual(state.settings('cost_burn').params, {});
  assert.equal({}.maxUSD, undefined, 'Object.prototype is untouched');
  // The same names in an edited file are dropped on load.
  state.setSettings('cost_burn', { enabled: true });
  const j = JSON.parse(fs.readFileSync(files.file, 'utf8'));
  j.settings.cost_burn.params = JSON.parse('{"constructor":1,"toString":2,"__proto__":3,"maxUSD":7}');
  fs.writeFileSync(files.file, JSON.stringify(j));
  assert.deepEqual(build().settings('cost_burn').params, { maxUSD: 7 });
});

test('a value hovering at its threshold gives only the first trigger alert', () => {
  const { state, clock } = make();
  const sent = [];
  // Alternates every evaluation for 10 minutes, one evaluation a minute.
  for (let i = 0; i <= 10; i++) {
    sent.push(...state.apply('cost_burn', [live('s1', i % 2 === 0 ? 'triggered' : 'ok', 5)]));
    clock.t += MIN;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, 'triggered');
  assert.equal(state.states()[0].state, 'triggered');
});

test('a re-trigger inside the hold keeps the original alert and its 30 minute reminder spacing', () => {
  const { state, clock } = make();
  assert.equal(state.apply('cost_burn', [live('s1', 'triggered', 9)]).length, 1);
  clock.t += 10 * MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok', 1)]), []);
  clock.t += 4 * MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok', 1)]), [], '4 minutes of ok is not enough');
  clock.t += 1 * MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'triggered', 9)]), [], 'no resolution and no new trigger');
  // The hold started again from scratch: a later ok must last 5 minutes from its own start.
  clock.t += MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok', 1)]), []);
  clock.t += 4 * MIN;
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok', 1)]), []);
  // Back to triggered 30 minutes after the original alert: the reminder is due, with previous 'triggered'.
  clock.t += 15 * MIN;
  const [again] = state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(again.state, 'triggered');
  assert.equal(again.previous, 'triggered');
});

test('five minutes of ok gives one resolution, and a later trigger is a new incident', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  clock.t += MIN;
  const sent = [];
  for (let i = 0; i < 8; i++) {
    sent.push(...state.apply('cost_burn', [live('s1', 'ok', 1)]));
    clock.t += MIN;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state, 'ok');
  assert.equal(sent[0].previous, 'triggered');
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'ok', 1)]), []);
  const [fresh] = state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(fresh.state, 'triggered');
  assert.equal(fresh.previous, 'ok');
});

test('the pending resolution survives a restart', () => {
  const { state, clock, build } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  clock.t += MIN;
  state.apply('cost_burn', [live('s1', 'ok', 1)]);
  clock.t += 3 * MIN;
  const again = build();
  assert.deepEqual(again.apply('cost_burn', [live('s1', 'ok', 1)]), [], 'only 3 minutes of ok so far');
  clock.t += 2 * MIN;
  const [r] = build().apply('cost_burn', [live('s1', 'ok', 1)]);
  assert.equal(r.state, 'ok', 'the ok period counts from before the restart');
});

test('a failed snooze save puts the snoozed flags back too', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = tmpDir();
  const file = path.join(dir, 'monitors.json');
  const state = createMonitorState({ file, alertsFile: path.join(dir, 'a.jsonl'), now: () => 1_700_000_000_000 });
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  // Make the next write fail: a directory where the temp file must go.
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => state.snooze('cost_burn', 's1', HOUR));
  assert.equal(state.states()[0].state, 'triggered');
  fs.rmdirSync(`${file}.tmp`);
  // The flag was restored, so a later apply after the (never stored) snooze is not treated as a snooze end.
  assert.deepEqual(state.apply('cost_burn', [live('s1', 'triggered', 9)]), [], 'still the same open alert');
});

test('an unreadable state file warns once and is kept aside before the first write', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const clockT = 1_700_000_000_000;
  const { files, build } = make({ now: () => clockT });
  fs.mkdirSync(path.dirname(files.file), { recursive: true });
  fs.writeFileSync(files.file, '{"settings": {"cost_burn": {"enabled": tru');
  const s = build({ now: () => clockT });
  s.states();
  s.settings('cost_burn');
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(path.dirname(files.file)), ['monitors.json']);
  s.setSettings('cost_burn', { enabled: true });
  const names = fs.readdirSync(path.dirname(files.file)).sort();
  assert.deepEqual(names, ['monitors.json', `monitors.json.corrupt-${clockT}`]);
  const kept = fs.readFileSync(path.join(path.dirname(files.file), names[1]), 'utf8');
  assert.equal(kept, '{"settings": {"cost_burn": {"enabled": tru');
  assert.equal(JSON.parse(fs.readFileSync(files.file, 'utf8')).settings.cost_burn.enabled, true);
  // A missing file is the normal first start: no warning, nothing set aside.
  const clean = make();
  clean.state.states();
  clean.state.setSettings('cost_burn', { enabled: true });
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(path.dirname(clean.files.file)), ['monitors.json']);
});

test('an unexpired snooze outlives the pruning of its instance', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('gone', 'ok'), live('stays', 'ok')]);
  state.snooze('cost_burn', 'gone', 48 * HOUR);
  clock.t += 25 * HOUR;
  state.apply('cost_burn', [live('stays', 'ok')]);
  assert.deepEqual(
    state.states().map((s) => s.instance),
    ['stays'],
    'the entry is pruned',
  );
  assert.deepEqual(state.apply('cost_burn', [live('gone', 'triggered', 9)]), [], 'but the snooze still holds');
  assert.equal(state.states().find((s) => s.instance === 'gone').state, 'snoozed');
  clock.t += 24 * HOUR;
  assert.equal(state.apply('cost_burn', [live('gone', 'triggered', 9)]).length, 1, 'and ends on time');
});

test('only the newest maxAlerts rows are kept when the alerts file is loaded', () => {
  const { files, build } = make({ maxAlerts: 5 });
  fs.mkdirSync(path.dirname(files.alertsFile), { recursive: true });
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: 'a' + i, ts: 1000 + i, rule: 'cost_burn' }));
  fs.writeFileSync(files.alertsFile, rows.map((r) => JSON.stringify(r) + '\n').join(''));
  const s = build({ maxAlerts: 5 });
  assert.deepEqual(
    s.alerts({ limit: 100 }).map((a) => a.id),
    ['a7', 'a6', 'a5', 'a4', 'a3'],
  );
  assert.equal(lines(files.alertsFile).length, 5);
});

// M-T5-2: the auto-pause mark through a snooze. A short ok blip is not a resolution, so the episode stays acted on;
// only an ok held for the resolution hold ends it.
test('a short ok blip inside a snooze keeps the acted-on mark; the episode is not pending again after it', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(state.markActed('cost_burn', 's1'), true);
  state.snooze('cost_burn', 's1', HOUR);
  clock.t += 10 * MIN;
  state.apply('cost_burn', [live('s1', 'ok')]);
  clock.t += 2 * MIN; // less than RESOLVE_HOLD_MS
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  clock.t += HOUR; // the snooze is over, the instance is still triggered
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(state.states().find((s) => s.instance === 's1').state, 'triggered');
  assert.deepEqual(state.pending('cost_burn'), [], 'the mark is kept');
});

test('an ok held for the resolution hold inside a snooze ends the episode; the next trigger is pending', () => {
  const { state, clock } = make();
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.equal(state.markActed('cost_burn', 's1'), true);
  state.snooze('cost_burn', 's1', HOUR);
  clock.t += 10 * MIN;
  state.apply('cost_burn', [live('s1', 'ok')]);
  clock.t += 5 * MIN; // RESOLVE_HOLD_MS
  state.apply('cost_burn', [live('s1', 'ok')]);
  clock.t += HOUR;
  state.apply('cost_burn', [live('s1', 'triggered', 9)]);
  assert.deepEqual(
    state.pending('cost_burn').map((p) => p.instance),
    ['s1'],
  );
});
