// The dashboard opener (scripts/open-dashboard.js): it must not add a browser tab on every wake.
const test = require('node:test');
const assert = require('node:assert');
const { createShowDashboard, createWakeWatcher, parseIdleMs, osaError } = require('../scripts/open-dashboard');

const fakes = (osaResults, { chrome = true } = {}) => {
  const calls = { osa: [], open: [], sleeps: [], logs: [] };
  const show = createShowDashboard({
    osa: async (args) => {
      calls.osa.push(args[0]);
      const r = osaResults.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    chromeInstalled: async () => chrome,
    openDefault: (mode) => calls.open.push(mode),
    sleep: async (ms) => calls.sleeps.push(ms),
    log: (...a) => calls.logs.push(a.join(' ')),
  });
  return { show, calls };
};

const osaFailure = () =>
  Object.assign(new Error('Command failed: osascript -e \non findTab(u)\n...'), {
    stderr: "21:40: execution error: Google Chrome got an error: Can't get window 2. (-1728)\n",
  });

test('opener: an existing dashboard tab is focused, nothing is opened', async () => {
  const { show, calls } = fakes(['focused']);
  await show('wake', 'local');
  assert.deepStrictEqual(calls.osa, ['find']);
  assert.deepStrictEqual(calls.open, []);
});

test('opener: a failing AppleScript is tried again and never answered with a new tab', async () => {
  const { show, calls } = fakes([osaFailure(), osaFailure(), osaFailure()]);
  await show('wake', 'local');
  assert.deepStrictEqual(calls.osa, ['find', 'find', 'find']);
  assert.deepStrictEqual(calls.open, [], 'no tab is opened with the default browser');
  assert.deepStrictEqual(calls.sleeps, [5000, 5000]);
  assert.match(calls.logs.at(-1), /failed 3 times, not opening a tab: .*\(-1728\)/);
});

test('opener: AppleScript that works on the second try focuses the tab', async () => {
  const { show, calls } = fakes([osaFailure(), 'focused']);
  await show('wake', 'local');
  assert.deepStrictEqual(calls.osa, ['find', 'find']);
  assert.deepStrictEqual(calls.open, []);
  assert.strictEqual(calls.logs.at(-1), 'wake focused');
});

test('opener: without Chrome the default browser is used, once', async () => {
  const { show, calls } = fakes([osaFailure()], { chrome: false });
  await show('login', 'local');
  assert.deepStrictEqual(calls.open, ['local']);
  assert.deepStrictEqual(calls.sleeps, []);
});

test('opener: a wake with no input (lid closed) shows nothing until the owner is back, then once', async () => {
  let active = false;
  let shown = 0;
  const tick = createWakeWatcher({ isUserActive: async () => active, onWake: async () => shown++, now: 0 });
  // Three maintenance wakes with the lid closed: a long gap each time, no input.
  for (const t of [60e3, 65e3, 1000e3, 1005e3, 2000e3, 2005e3]) await tick(t);
  assert.strictEqual(shown, 0);
  // The lid opens and the owner types.
  active = true;
  await tick(3000e3);
  await tick(3005e3);
  await tick(3010e3);
  assert.strictEqual(shown, 1);
});

test('opener: no gap between ticks is no wake, even with input', async () => {
  let shown = 0;
  const tick = createWakeWatcher({ isUserActive: async () => true, onWake: async () => shown++, now: 0 });
  for (let t = 5e3; t <= 60e3; t += 5e3) await tick(t);
  assert.strictEqual(shown, 0);
});

test('opener: ioreg idle time is read in milliseconds; unreadable output is null', () => {
  assert.strictEqual(parseIdleMs('  |   "HIDIdleTime" = 81042458\n'), 81);
  assert.strictEqual(parseIdleMs('"HIDIdleTime" = 912000000000'), 912000);
  assert.strictEqual(parseIdleMs(''), null);
  assert.strictEqual(parseIdleMs(undefined), null);
});

test("opener: the logged error is osascript's own line, not the script", () => {
  assert.match(osaError(osaFailure()), /^21:40: execution error: .*\(-1728\)$/);
  assert.strictEqual(osaError(new Error('spawn osascript ENOENT')), 'spawn osascript ENOENT');
});
