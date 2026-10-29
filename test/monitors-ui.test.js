// The bell, the alerts drawer, Settings → Monitors and the agent controls: pure helpers in public/monitorsview.js,
// without a browser, and an audit of that file for HTML built from alert, session or process text (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  alertLine,
  unreadCount,
  pauseBanner,
  pausedWithRule,
  candidateLabel,
  monParamValue,
  monAgentNote,
  monActionError,
  monSameProc,
  pausedEntryFor,
  monWriteHtml,
  monAlertsBody,
  monAgentHtml,
  monAfterAction,
  monParamShown,
  monRuleCard,
} = require('../public/monitorsview');

// The page's esc() lives in public/app.js; the helpers that build markup call it, so the tests give them the same one.
global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const SRC = path.join(__dirname, '..', 'public', 'monitorsview.js');
const RULES = [
  { id: 'daily_cost', title: 'Daily cost' },
  { id: 'cost_burn', title: 'Cost burn' },
  { id: 'tool_loop', title: 'Tool loop' },
  { id: 'eval_pass_rate', title: 'Evaluator pass rate' },
  { id: 'agent_stuck', title: 'Agent stuck' },
];
const KEY = 'claude.c61b377ceeb3a9f140df4ebb8ccd1667';
const change = (fields) => ({
  id: 'a1',
  ts: 1000,
  rule: 'cost_burn',
  ruleTitle: 'Cost burn',
  instance: 'x',
  sessionKey: KEY,
  title: 'tokoku-web',
  value: 6.8,
  threshold: 5,
  state: 'triggered',
  previous: 'ok',
  ...fields,
});

test('alertLine: a trigger names the rule, the change, value against threshold, the session and its trace link', () => {
  const l = alertLine(change(), RULES);
  assert.equal(l.kind, 'change');
  assert.equal(l.title, 'Cost burn');
  assert.equal(l.change, 'Triggered');
  assert.equal(l.tone, 'bad');
  assert.match(l.measure, /\$6\.80/);
  assert.match(l.measure, /\$5\.00/);
  assert.equal(l.session, 'tokoku-web');
  assert.equal(l.href, `#trace?key=${KEY}`);
  assert.equal(l.ts, 1000);
});

test('alertLine: resolved, other state changes and an alert without a session', () => {
  const ok = alertLine(change({ state: 'ok', previous: 'triggered', sessionKey: null, title: null }), RULES);
  assert.equal(ok.change, 'Resolved');
  assert.equal(ok.tone, 'good');
  assert.equal(ok.href, null);
  assert.equal(ok.session, null);
  const nd = alertLine(change({ state: 'no_data', previous: 'ok' }), RULES);
  assert.equal(nd.change, 'OK → No data');
  assert.equal(nd.tone, 'muted');
  // A rule title from the row wins; without one the rules list names it; without both, the id.
  assert.equal(alertLine(change({ ruleTitle: null, rule: 'daily_cost' }), RULES).title, 'Daily cost');
  assert.equal(alertLine(change({ ruleTitle: null, rule: 'new_rule' }), []).title, 'new_rule');
});

test('alertLine: the measure follows the rule', () => {
  const m = (rule, value, threshold) => alertLine(change({ rule, ruleTitle: null, value, threshold }), RULES).measure;
  assert.match(m('daily_cost', 18.4, 1000 / 30), /\$18\.40.*\$33\.33/);
  assert.match(m('tool_loop', 3, 1), /3 loop signals/);
  assert.match(m('tool_loop', 1, 1), /1 loop signal\b/);
  assert.match(m('tool_loop', 72, 50), /72 tool calls.*50/);
  assert.match(m('eval_pass_rate', 0.72, 0.8), /72%.*80%/);
  assert.match(m('agent_stuck', 12.5, 10), /12\.5 min.*10 min/);
  assert.equal(m('cost_burn', null, null), '');
  assert.match(m('cost_burn', null, 5), /\$5\.00/);
});

test('alertLine: an automatic pause is its own kind of line, worded from its code', () => {
  const pause = { ...change(), state: undefined, previous: undefined, action: 'pause', ok: true, code: 'paused' };
  delete pause.state;
  delete pause.previous;
  const l = alertLine(pause, RULES);
  assert.equal(l.kind, 'pause');
  assert.equal(l.change, 'Paused the agent');
  assert.equal(l.tone, 'warn');
  assert.equal(l.href, `#trace?key=${KEY}`);
  const none = alertLine({ ...pause, ok: false, code: 'none' }, RULES);
  assert.equal(none.kind, 'pause');
  assert.equal(none.tone, 'bad');
  assert.match(none.change, /^Could not pause the agent: no matching process/);
  assert.match(alertLine({ ...pause, ok: false, code: 'several' }, RULES).change, /several/);
  assert.match(alertLine({ ...pause, ok: false, code: 'windows' }, RULES).change, /Windows/);
  assert.equal(alertLine({ ...pause, ok: false, code: 'weird<b>' }, RULES).change, 'Could not pause the agent');
});

test('alertLine: "no candidate" while agent control is off says why, not "no matching process"', () => {
  const none = { ...change(), action: 'pause', ok: false, code: 'none' };
  delete none.state;
  delete none.previous;
  const docker = alertLine(none, RULES, { available: false, pause: true, reason: 'docker' });
  assert.equal(docker.change, 'Could not pause the agent: agent control is off in Docker');
  const server = alertLine(none, RULES, { available: false, pause: true, reason: 'server' });
  assert.equal(server.change, 'Could not pause the agent: agent control is off on this server');
  assert.match(alertLine(none, RULES, { available: true, pause: true, reason: null }).change, /no matching process/);
  assert.match(alertLine(none, RULES).change, /no matching process/, 'without a status, the code as it is');
  // Other codes keep their own words; an off server changes only "none".
  assert.match(
    alertLine({ ...none, code: 'several' }, RULES, { available: false, reason: 'docker' }).change,
    /several/,
  );
  assert.equal(
    alertLine({ ...none, ok: true, code: 'paused' }, RULES, { available: false }).change,
    'Paused the agent',
  );
});

test('alertLine: odd input gives text, never markup or a foreign link', () => {
  const l = alertLine(
    change({ title: 'a\u0000b<img src=x>'.repeat(30), sessionKey: 'javascript:alert(1)', ruleTitle: '<b>x</b>' }),
    RULES,
  );
  assert.equal(l.href, null);
  assert.ok(l.session.length <= 80);
  assert.ok(!/[\u0000-\u001f]/.test(l.session));
  assert.equal(l.title, '<b>x</b>', 'kept as text; the page escapes it');
  assert.equal(alertLine(null, RULES), null);
  assert.equal(alertLine({ ts: 'x' }, RULES).ts, null);
  assert.equal(alertLine(change({ value: 'NaN', threshold: {} }), RULES).measure, '');
});

test('unreadCount: alerts newer than the last read time', () => {
  const alerts = [{ ts: 5 }, { ts: 10 }, { ts: 20 }, { ts: null }, null];
  assert.equal(unreadCount(alerts, 0), 3);
  assert.equal(unreadCount(alerts, 10), 1);
  assert.equal(unreadCount(alerts, '10'), 1, 'localStorage gives text');
  assert.equal(unreadCount(alerts, 'garbage'), 3);
  assert.equal(unreadCount(alerts, null), 3);
  assert.equal(unreadCount(alerts, 99), 0);
  assert.equal(unreadCount(null, 0), 0);
});

test('pauseBanner: by a rule, by the owner, or found stopped', () => {
  const p = { pid: 48213, startTime: 1, app: 'claude', by: 'rule', rule: 'cost_burn', since: 9, sessionKey: KEY };
  const b = pauseBanner(p, RULES);
  assert.equal(b.text, 'Paused because Cost burn');
  assert.equal(b.who, 'Claude Code · pid 48213');
  assert.equal(b.href, `#trace?key=${KEY}`);
  assert.equal(pauseBanner({ ...p, rule: undefined }, RULES).text, 'Paused by a monitor');
  assert.equal(pauseBanner({ ...p, by: 'owner', rule: undefined }, RULES).text, 'Paused by you');
  assert.match(pauseBanner({ ...p, by: null, rule: undefined, sessionKey: null }, RULES).text, /^Paused/);
  assert.equal(pauseBanner({ ...p, sessionKey: null }, RULES).href, null);
  assert.equal(pauseBanner({ ...p, app: 'mystery' }, RULES).who, 'mystery · pid 48213');
  assert.equal(pauseBanner(null, RULES), null);
  assert.equal(pauseBanner({ pid: 'x' }, RULES), null);
});

test('pausedWithRule: the rule comes from the latest successful pause alert of the same session', () => {
  const paused = [
    { pid: 1, startTime: 1, app: 'claude', by: 'rule', since: 100, sessionKey: KEY },
    { pid: 2, startTime: 1, app: 'codex', by: 'owner', since: 100, sessionKey: 'codex.x' },
  ];
  const alerts = [
    { ts: 101, rule: 'tool_loop', action: 'pause', ok: false, code: 'none', sessionKey: KEY },
    { ts: 99, rule: 'cost_burn', action: 'pause', ok: true, code: 'paused', sessionKey: KEY },
    { ts: 50, rule: 'daily_cost', action: 'pause', ok: true, code: 'paused', sessionKey: KEY },
    { ts: 98, rule: 'cost_burn', state: 'triggered', sessionKey: 'codex.x' },
  ];
  const out = pausedWithRule(paused, alerts);
  assert.equal(out[0].rule, 'cost_burn');
  assert.equal(out[1].rule, undefined, 'the owner paused it');
  assert.deepEqual(pausedWithRule(null, alerts), []);
  assert.equal(pausedWithRule(paused, null)[0].rule, undefined);
});

test('candidateLabel: app and pid, command, folder and start time, as text', () => {
  const c = { pid: 48213, startTime: 1792654990000, app: 'claude', cwd: '~/code/tokoku-web', command: 'claude -c' };
  const l = candidateLabel(c, () => '14:03');
  assert.equal(l.head, 'Claude Code · pid 48213');
  assert.equal(l.command, 'claude -c');
  assert.equal(l.cwd, '~/code/tokoku-web');
  assert.equal(l.started, 'started 14:03');
  assert.equal(l.paused, false);
  assert.equal(l.text, 'Claude Code · pid 48213 · ~/code/tokoku-web · started 14:03');
  const odd = candidateLabel({ pid: 7, app: 'codex', cwd: null, command: 'a\u0007b'.repeat(200), paused: true });
  assert.equal(odd.cwd, 'folder unknown');
  assert.equal(odd.started, '');
  assert.equal(odd.paused, true);
  assert.ok(odd.command.length <= 200 && !/[\u0000-\u001f]/.test(odd.command));
  assert.equal(candidateLabel(null), null);
});

test('monParamValue: form text to a rule parameter', () => {
  assert.deepEqual(monParamValue('maxUSD', ''), { value: null });
  assert.deepEqual(monParamValue('maxUSD', ' 7.5 '), { value: 7.5 });
  assert.deepEqual(monParamValue('minPassRate', '80'), { value: 0.8 }, 'the form shows a percentage');
  assert.ok(monParamValue('maxCalls', 'abc').error);
  assert.ok(monParamValue('maxCalls', '-1').error);
});

test('monAgentNote: why there is no control, worded for the owner', () => {
  assert.match(monAgentNote({ available: false }), /server mode|password/);
  assert.match(monAgentNote({ available: false, off: 'server' }), /server mode|password/);
  assert.match(monAgentNote({ available: false, off: 'docker' }), /Docker/);
  assert.doesNotMatch(monAgentNote({ available: false, off: 'docker' }), /server mode/);
  assert.match(monAgentNote({ available: true, pause: false }), /Windows/);
  assert.match(monAgentNote({ available: true, pause: true, reason: 'not-indexed' }), /index/);
  assert.match(monAgentNote({ available: true, pause: true, reason: 'unsupported' }), /Claude Code and Codex/);
  assert.match(monAgentNote({ available: true, pause: true, candidates: 0 }), /No running agent/);
  assert.equal(monAgentNote({ available: true, pause: true, candidates: 1 }), '');
});

test('monActionError: every status becomes text, 502 says to close the app by hand', () => {
  assert.match(monActionError({ status: 502, message: 'taskkill exited 128', hint: 'Close it.' }), /Close it\./);
  assert.match(monActionError({ status: 409, message: 'the process is gone' }), /the process is gone/i);
  assert.match(monActionError({ status: 403, message: 'agent control is off in Docker' }), /Docker/);
  assert.match(monActionError({ status: 500 }), /could not/i);
  assert.match(monActionError({}), /could not/i);
});

test('monitorsview.js builds no HTML from alert, session or process text without esc() (S1)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  // A bare ${x.field} of text that came from the server must go through esc(); numbers and our own words may not.
  const CONTENT =
    /\.(title|session|change|measure|text|head|who|command|cwd|started|name|message|error|msg|problem|describe|reason|hint|key|sessionKey|href)$/;
  const bare = [...src.matchAll(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g)].map((m) => m[1]).filter((e) => CONTENT.test(e));
  assert.deepEqual(bare, [], 'content interpolated without esc()');
  // innerHTML is only ever given a string built by this file's helpers, never a message or a field straight away.
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.doesNotMatch(m[1], /message|error|\.title|\.command|\.cwd/, `innerHTML = ${m[1]}`);
  assert.doesNotMatch(src, /insertAdjacentHTML|outerHTML\s*=|document\.write/);
});

// A start time comes from an age in whole seconds, so the same process can come back a second off between reads.
test('monSameProc and pausedEntryFor: a start time a second apart is the same paused process', () => {
  const cand = { pid: 4242, startTime: 1_000_000, app: 'claude', paused: false };
  const paused = [{ pid: 4242, startTime: 1_001_000, app: 'claude', by: 'owner' }];
  assert.equal(monSameProc(cand, paused[0]), true);
  assert.equal(monSameProc(cand, { ...paused[0], startTime: 998_000 }), true, 'within 2 s either way');
  assert.equal(monSameProc(cand, { ...paused[0], startTime: 1_002_001 }), false);
  assert.equal(monSameProc(cand, { ...paused[0], pid: 4243 }), false);
  assert.equal(monSameProc(cand, { pid: 4242 }), false, 'no start time');
  assert.equal(monSameProc(null, cand), false);
  assert.equal(pausedEntryFor(cand, paused).by, 'owner');
  assert.equal(pausedEntryFor(cand, [{ ...paused[0], startTime: 1_005_000 }]), null);
  assert.equal(pausedEntryFor({ ...cand, paused: true }, []).pid, 4242, 'the candidate says so itself');
  assert.equal(pausedEntryFor(null, paused), null);
});

// A repaint rewrites the drawer or the trace panel every few seconds; keyboard focus must survive it (M-T7-1).
test('monWriteHtml: writes only changed HTML, and gives focus back to the same control after a write', () => {
  const active = { getAttribute: (n) => (n === 'data-mon-act' ? 'stop' : null) };
  const target = {
    calls: 0,
    focus() {
      this.calls++;
    },
  };
  let html = '';
  let writes = 0;
  const el = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v) {
      html = v;
      writes++;
    },
    contains: (x) => x === active,
    querySelector: (sel) => (sel === '[data-mon-act="stop"]' ? target : null),
  };
  const saved = global.document;
  global.document = { activeElement: active };
  try {
    monWriteHtml(el, '<button data-mon-act="stop">Stop</button>');
    monWriteHtml(el, '<button data-mon-act="stop">Stop</button>');
    assert.equal(writes, 1, 'the same HTML is not written again');
    target.calls = 0;
    monWriteHtml(el, '<span>Stopping…</span><button data-mon-act="stop">Stop</button>');
    assert.equal(writes, 2);
    assert.equal(target.calls, 1, 'focus goes back to the new Stop button');
  } finally {
    if (saved === undefined) delete global.document;
    else global.document = saved;
  }
});

// A failed poll used to leave "Reading the alerts…" up for good (M-T7-2).
test('monAlertsBody: a failed first read and a failed refresh say so', () => {
  const first = monAlertsBody({ alerts: [], loaded: false, error: 'boom', readAt: null });
  assert.match(first, /Could not read the alerts: boom\. Trying again every 15 s\./);
  const later = monAlertsBody({ alerts: [], loaded: true, error: 'boom', readAt: Date.UTC(2026, 9, 22, 9, 5) });
  assert.match(later, /Could not refresh the alerts \(boom\)/);
  assert.match(later, /These are the alerts read at \d\d:\d\d\./);
  assert.doesNotMatch(monAlertsBody({ alerts: [], loaded: true, error: '', readAt: 1 }), /Could not/);
  assert.match(monAlertsBody({ alerts: [], loaded: false, error: '', readAt: null }), /Reading the alerts/);
  assert.match(monAlertsBody({ alerts: [], loaded: false, error: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/, 'as text');
});

// The trace explorer said nothing when a session had no process; it now says why, except for gateway sessions (M-T7-3).
test('monAgentHtml inline: why a session has no agent process, and quiet for sessions that have none', () => {
  const t = (reason) => ({ loading: false, off: false, error: '', cands: [], canPause: true, reason, busy: '' });
  assert.match(monAgentHtml(t('not-indexed'), 'inline'), /not in the index yet/);
  assert.match(monAgentHtml(t('none'), 'inline'), /No running agent process matches/);
  assert.match(monAgentHtml(t(null), 'inline'), /No running agent process matches/);
  assert.equal(monAgentHtml(t('unsupported'), 'inline'), '');
  assert.equal(
    monAgentHtml({ ...t('unsupported'), canPause: false }, 'inline'),
    '',
    'a gateway session on Windows too',
  );
});

// A Stop whose process was still there (SIGTERM sent, or not checked) took the process off the list (M-T7-4).
test('monAfterAction: a stop removes the process only when it exited; a demo answer changes nothing', () => {
  const run = (action, r) => {
    const c = { pid: 9, startTime: 1, paused: false };
    const t = { cands: [c, { pid: 10, startTime: 1 }] };
    monAfterAction(t, c, action, r);
    return { t, c };
  };
  assert.equal(run('stop', { exited: false }).t.cands.length, 2, 'still running after SIGTERM');
  assert.equal(run('stop', { exited: null }).t.cands.length, 2, 'could not be checked');
  assert.deepEqual(
    run('stop', { exited: true }).t.cands.map((x) => x.pid),
    [10],
  );
  assert.equal(run('stop', { demo: true, exited: true }).t.cands.length, 2);
  assert.equal(run('pause', {}).c.paused, true);
  assert.equal(run('pause', { demo: true }).c.paused, false);
  const resumed = run('resume', {}).c;
  assert.equal(resumed.paused, false);
  // The server continues a paused process (SIGCONT) before it handles the interrupt, so one a Stop did not end runs.
  const stopPaused = (r) => {
    const c = { pid: 9, startTime: 1, paused: true };
    monAfterAction({ cands: [c] }, c, 'stop', r);
    return c.paused;
  };
  assert.equal(stopPaused({ signal: 'SIGTERM', exited: false }), false, 'asked to quit and still running');
  assert.equal(stopPaused({ signal: 'SIGINT', exited: null }), false, 'not checked, but continued');
  assert.equal(stopPaused({ demo: true, exited: false }), true, 'a demo answer changes nothing');
});

// A refused parameter stayed in the input as if saved (M-T7-5); it goes back to what the card shows for the saved rule.
test('monParamShown: the saved value as the input shows it', () => {
  assert.equal(monParamShown({ params: { minPassRate: 0.8 } }, 'minPassRate'), '80');
  assert.equal(monParamShown({ params: { minPassRate: 0.755 } }, 'minPassRate'), '75.5');
  assert.equal(monParamShown({ params: { maxUSD: 7.5 } }, 'maxUSD'), '7.5');
  assert.equal(monParamShown({ params: { maxUSD: null } }, 'maxUSD'), '', 'the default: empty, with a placeholder');
  assert.equal(monParamShown({}, 'maxUSD'), '');
  assert.equal(monParamShown(null, 'maxUSD'), '');
});

// maxCalls is not measured, so it has no input that looks like it works (M-T5-4).
test('monRuleCard: tool_loop has no maxCalls input and says the call count is not measured', () => {
  const rule = {
    id: 'tool_loop',
    title: 'Tool loop',
    describe: 'A session loops',
    enabled: true,
    state: 'ok',
    kind: 'live',
    instances: [],
    params: { maxCalls: null },
    defaults: { maxCalls: 50 },
    mayAutoPause: true,
  };
  const html = monRuleCard(rule, { pause: true });
  assert.doesNotMatch(html, /data-mon-param="maxCalls"/);
  assert.match(html, /not measured yet/);
  const cost = monRuleCard(
    { ...rule, id: 'cost_burn', title: 'Cost burn', params: { maxUSD: 5 }, defaults: { maxUSD: 5 } },
    { pause: true },
  );
  assert.match(cost, /data-mon-param="maxUSD"/, 'other parameters keep their input');
  assert.doesNotMatch(cost, /not measured yet/);
});

test('monAgentNote: control off without sign-in names ZAAFPULSE_AUTH=none', () => {
  const s = monAgentNote({ available: false, off: 'no-sign-in' });
  assert.match(s, /ZAAFPULSE_AUTH=none/);
  assert.match(s, /without sign-in/);
  assert.doesNotMatch(s, /server mode/);
  const none = { ...change(), action: 'pause', ok: false, code: 'none' };
  delete none.state;
  delete none.previous;
  assert.equal(
    alertLine(none, RULES, { available: false, reason: 'no-sign-in' }).change,
    'Could not pause the agent: agent control is off without a dashboard sign-in',
  );
});

test('monParamValue: the rule parameters keep the server bounds', () => {
  assert.equal(
    monParamValue('ratio', '1').error,
    'Times the usual amount: above 1, up to 100, or leave it empty for the default',
  );
  assert.deepEqual(monParamValue('ratio', '2'), { value: 2 });
  assert.ok(monParamValue('ratio', '100.5').error);
  assert.deepEqual(monParamValue('ratio', '100'), { value: 100 });
  assert.equal(
    monParamValue('minUSD', '0').error,
    'Minimum rise (USD): above 0, up to 1,000,000, or leave it empty for the default',
  );
  assert.deepEqual(monParamValue('minUSD', '0.5'), { value: 0.5 });
  assert.equal(
    monParamValue('stuckMin', '0').error,
    'Minutes without a log line: above 0, up to 1,440, or leave it empty for the default',
  );
  assert.deepEqual(monParamValue('limitUSD', '0'), { value: 0 });
});

test('monRuleCard: the number inputs carry the bounds', () => {
  const html = monRuleCard(
    {
      id: 'cost_anomaly',
      title: 'Cost anomaly',
      enabled: true,
      state: 'ok',
      defaults: { ratio: 3, minUSD: 5 },
      params: {},
      instances: [],
    },
    {},
  );
  assert.match(
    html,
    /data-mon-param="ratio"[^>]*min="1"[^>]*max="100"|min="1"[^>]*max="100"[^>]*data-mon-param="ratio"/,
  );
  assert.match(html, /max="1000000"/);
});

test('monParamValue: bounds with separators and the hint to leave it empty', () => {
  const e = monParamValue('minUSD', '2000000').error;
  assert.match(e, /up to 1,000,000/);
  assert.match(e, /or leave it empty for the default/);
});
