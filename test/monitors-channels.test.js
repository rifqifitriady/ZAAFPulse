const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const { createChannels, WINDOWS_SCRIPT } = require('../lib/monitors/channels');
const { fakeServer, secretsFor } = require('./helpers');

// A spawn that records each call and plays a child that exits cleanly (or fails, or never starts).
function recorder(mode = 'ok') {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    const call = { cmd, args, opts, stdin: '' };
    calls.push(call);
    child.stdin = Object.assign(new EventEmitter(), {
      end(data) {
        call.stdin += data || '';
      },
    });
    child.kill = () => {};
    setImmediate(() =>
      mode === 'enoent' ? child.emit('error', new Error('spawn ENOENT')) : child.emit('close', mode === 'fail' ? 1 : 0),
    );
    return child;
  };
  return { calls, spawn };
}

const alert = (extra = {}) => ({
  id: 'a1',
  ts: 1_700_000_000_000,
  rule: 'daily_cost',
  instance: 'all',
  sessionId: 'sess-123',
  state: 'triggered',
  previous: 'ok',
  value: 12.3456,
  threshold: 10,
  ...extra,
});
const NASTY = `Fix "it" $(rm -rf ~) \`id\` 'x'; & | > <`;
const noWait = () => Promise.resolve();

function make({ platform = 'darwin', settings, spawn, fetchImpl, env = {}, sleep = noWait, logs = [] } = {}) {
  return createChannels({
    spawn,
    fetchImpl,
    secrets: secretsFor(env),
    settings: () => settings || { desktop: true, webhook: null },
    platform,
    sleep,
    log: (m) => logs.push(m),
  });
}

test('macOS passes the title and text as argv after the fixed AppleScript, with no shell', async () => {
  const r = recorder();
  const ch = make({ spawn: r.spawn });
  await ch.notify(alert(), { title: NASTY });
  assert.equal(r.calls.length, 1);
  const { cmd, args, opts } = r.calls[0];
  assert.equal(cmd, 'osascript');
  assert.deepEqual(args.slice(0, 6), [
    '-e',
    'on run argv',
    '-e',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e',
    'end run',
  ]);
  assert.equal(args.length, 8);
  assert.equal(args[6], 'ZAAFPulse: Daily cost');
  assert.match(args[7], /^Triggered: 12\.35 \(limit 10\)/);
  assert.ok(args[7].includes('$(rm -rf ~)'), 'the nasty text is one argv value, untouched');
  assert.ok(!opts || !opts.shell);
});

test('Linux uses notify-send with fixed flags, a -- guard and the text as separate arguments', async () => {
  const r = recorder();
  const ch = make({ platform: 'linux', spawn: r.spawn });
  await ch.notify(alert(), { title: NASTY });
  const { cmd, args, opts } = r.calls[0];
  assert.equal(cmd, 'notify-send');
  assert.equal(args.length, 4);
  assert.equal(args[0], '--app-name=ZAAFPulse');
  assert.equal(args[1], '--', 'nothing after this can be read as an option');
  assert.equal(args[2], 'ZAAFPulse: Daily cost');
  assert.ok(args[3].includes('$(rm -rf ~)'));
  assert.ok(!opts || !opts.shell);
});

test('Linux escapes markup in the title and text, since the notification daemon renders it', async () => {
  const r = recorder();
  const ch = make({ platform: 'linux', spawn: r.spawn });
  await ch.notify(alert(), { title: 'Click <a href="x">here</a> & <b>now</b>' });
  const text = r.calls[0].args[3];
  assert.ok(!text.includes('<a') && !text.includes('<b>'), text);
  assert.ok(text.includes('&lt;a href="x"&gt;here&lt;/a&gt; &amp; &lt;b&gt;now&lt;/b&gt;'), text);
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(text), 'every ampersand is an entity');
  // macOS shows plain text, so nothing is escaped there.
  const mac = recorder();
  await make({ spawn: mac.spawn }).notify(alert(), { title: 'a <b> & c' });
  assert.ok(mac.calls[0].args[7].includes('a <b> & c'));
});

test('Windows runs a constant encoded script, with no stdin, and the text in the environment', async () => {
  const r = recorder();
  const ch = make({ platform: 'win32', spawn: r.spawn });
  const saved = process.env.ZP_DRY_RUN;
  process.env.ZP_DRY_RUN = '1'; // a stray variable of ZAAFPulse's own must not silence the toast
  try {
    await ch.notify(alert(), { title: NASTY });
  } finally {
    if (saved === undefined) delete process.env.ZP_DRY_RUN;
    else process.env.ZP_DRY_RUN = saved;
  }
  const { cmd, args, opts, stdin } = r.calls[0];
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(args.length, 4);
  assert.equal(Buffer.from(args[3], 'base64').toString('utf16le'), WINDOWS_SCRIPT);
  assert.equal(stdin, '', 'nothing is written to stdin');
  assert.equal(opts.stdio, 'ignore');
  assert.match(WINDOWS_SCRIPT, /\$env:ZP_TITLE/);
  assert.match(WINDOWS_SCRIPT, /\$env:ZP_TEXT/);
  assert.match(WINDOWS_SCRIPT, /SecurityElement\]::Escape/);
  assert.match(WINDOWS_SCRIPT, /ZP_DRY_RUN/);
  assert.match(WINDOWS_SCRIPT, /ToastNotificationManager/);
  assert.match(WINDOWS_SCRIPT, /BalloonTip/);
  assert.ok(WINDOWS_SCRIPT.includes('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.equal(opts.env.ZP_TITLE, 'ZAAFPulse: Daily cost');
  assert.ok(opts.env.ZP_TEXT.includes('$(rm -rf ~)'));
  assert.equal(opts.env.ZP_DRY_RUN, undefined);
  assert.ok(!opts.shell);
  const enc = args[3];
  assert.ok(!Buffer.from(enc, 'base64').toString('utf16le').includes('12.35'), 'the alert is not in the script');
});

// The one place a real OS command runs: with ZP_DRY_RUN the script builds and parses the toast XML, prints OK and
// shows nothing. It runs on the windows-latest runner.
test(
  'the real Windows script builds valid toast XML from awkward text without showing anything',
  { skip: process.platform !== 'win32' },
  () => {
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
      {
        env: {
          ...process.env,
          ZP_DRY_RUN: '1',
          ZP_TITLE: `ZAAFPulse: <b>"Cost"</b> & 'x'`,
          ZP_TEXT: `Triggered: 12.35 (limit 10)\n</text><evil a="1"/> & $(whoami) \`id\``,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60e3,
      },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'OK');
  },
);

test('the text holds only the rule title, state, numbers and the masked, clipped session title', async () => {
  const r = recorder();
  const ch = make({ spawn: r.spawn });
  const secret = 'sk-ant-api03-Zq8vK2mXp4Lr7TnB1cYd9WsHf6JgUe3A5oNi0PxR';
  const long = 'x'.repeat(200);
  await ch.notify(alert({ title: `key ${secret} ${long}`, instance: 'INSTANCE-X', previous: 'PREV-X' }));
  const [, text] = [r.calls[0].args[6], r.calls[0].args[7]];
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('INSTANCE-X') && !text.includes('PREV-X') && !text.includes('sess-123'));
  assert.ok(text.length <= 'Triggered: 12.35 (limit 10)\n'.length + 80 + 5, `text too long: ${text.length}`);
  // A resolution, no session title, non-numeric numbers.
  await ch.notify(alert({ state: 'ok', previous: 'triggered', value: 'secret?', threshold: null }));
  const t2 = r.calls[1].args[7];
  assert.match(t2, /^Resolved/);
  assert.ok(!t2.includes('secret?'));
});

test('a spawn failure is logged once and never thrown', async () => {
  const logs = [];
  const ch = make({ spawn: recorder('enoent').spawn, logs });
  await ch.notify(alert());
  assert.equal(logs.length, 1);
  const throwing = make({
    spawn: () => {
      throw new Error('boom');
    },
    logs,
  });
  await throwing.notify(alert());
  assert.equal(logs.length, 2);
  const fail = make({ spawn: recorder('fail').spawn, logs });
  await fail.notify(alert());
  assert.equal(logs.length, 3);
});

test('desktop notifications can be switched off', async () => {
  const r = recorder();
  const ch = make({ spawn: r.spawn, settings: { desktop: false, webhook: null } });
  await ch.notify(alert());
  assert.equal(r.calls.length, 0);
});

test('the webhook body has exactly seven keys and carries no text', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook`, HOOK_HDRS: '{"Authorization":"Bearer tok-123456"}' },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' }, headers: { env: 'HOOK_HDRS' } } },
    });
    await ch.notify(alert({ title: 'My private session', instance: 'x' }), { title: 'My private session' });
    assert.equal(srv.requests.length, 1);
    const req = srv.requests[0];
    assert.deepEqual(Object.keys(req.body).sort(), [
      'previous',
      'rule',
      'sessionId',
      'state',
      'threshold',
      'ts',
      'value',
    ]);
    assert.deepEqual(req.body, {
      rule: 'daily_cost',
      state: 'triggered',
      previous: 'ok',
      value: 12.3456,
      threshold: 10,
      sessionId: 'sess-123',
      ts: 1_700_000_000_000,
    });
    assert.ok(!JSON.stringify(req.body).includes('private'));
    assert.equal(req.headers.authorization, 'Bearer tok-123456');
    assert.match(req.headers['content-type'], /application\/json/);
  } finally {
    await srv.close();
  }
});

// A pause outcome row from the engine (state.note): no state or previous, a code and a reason.
const pauseRow = (extra = {}) => ({
  id: 'n1',
  ts: 1_700_000_000_000,
  rule: 'cost_burn',
  instance: 'sess-123',
  sessionId: 'sess-123',
  value: 6,
  threshold: 5,
  action: 'pause',
  ok: true,
  code: 'paused',
  reason: 'paused',
  ...extra,
});

test('a pause outcome shows fixed words, the numbers and the session title, never its reason text', async () => {
  const r = recorder();
  const ch = make({ spawn: r.spawn });
  await ch.notify(pauseRow(), { title: 'acme-web' });
  await ch.notify(pauseRow({ ok: false, code: 'several', reason: 'could not pause: several candidates' }), {
    title: 'acme-web',
  });
  // An unknown code, with a reason that must not be shown (it could be anything a caller passed).
  await ch.notify(pauseRow({ ok: false, code: 'refused', reason: 'could not pause: /Users/me/SECRET' }));
  await ch.notify(pauseRow({ ok: false, code: 'odd', reason: 'SECRET' }));
  const texts = r.calls.map((c) => c.args[7]);
  assert.deepEqual(
    r.calls.map((c) => c.args[6]),
    Array(4).fill('ZAAFPulse: Cost burn'),
  );
  assert.equal(texts[0], 'Agent paused: 6 (limit 5)\nacme-web');
  assert.equal(texts[1], 'Could not pause the agent: several matching processes: 6 (limit 5)\nacme-web');
  assert.equal(texts[2], 'Could not pause the agent: the process was gone or changed: 6 (limit 5)');
  assert.equal(texts[3], 'Could not pause the agent: 6 (limit 5)');
  for (const t of texts) assert.doesNotMatch(t, /SECRET|\/Users/);
});

test('a pause outcome never goes to the webhook, which keeps its seven-field state changes', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const r = recorder();
    const ch = make({
      spawn: r.spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: true, webhook: { url: { env: 'HOOK_URL' } } },
    });
    const out = await ch.notify(pauseRow(), { title: 'acme-web' });
    assert.deepEqual(out, { desktop: true, webhook: false });
    assert.equal(r.calls.length, 1, 'shown on the desktop');
    assert.equal(srv.requests.length, 0, 'no webhook call');
    await ch.notify(alert());
    assert.equal(srv.requests.length, 1, 'a state change still goes out');
    assert.equal(Object.keys(srv.requests[0].body).length, 7);
  } finally {
    await srv.close();
  }
});

test('a row with another action is not shown either', async () => {
  const r = recorder();
  const ch = make({ spawn: r.spawn });
  await ch.notify(pauseRow({ action: 'other' }));
  assert.equal(r.calls.length, 0);
});

test('a missing value or session still gives seven keys', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
    });
    await ch.notify({
      rule: 'month_projection',
      state: 'ok',
      previous: 'triggered',
      ts: 5,
      junk: 'x',
      instance: 'all',
    });
    assert.deepEqual(srv.requests[0].body, {
      rule: 'month_projection',
      state: 'ok',
      previous: 'triggered',
      value: null,
      threshold: null,
      sessionId: null,
      ts: 5,
    });
  } finally {
    await srv.close();
  }
});

test('a failed webhook is retried three times with the 1 s, 4 s, 16 s backoff, then dropped with one log line', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 500, body: { error: 'down' } } });
  try {
    const waits = [];
    const logs = [];
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
      sleep: async (ms) => waits.push(ms),
      logs,
    });
    await ch.notify(alert());
    assert.equal(srv.requests.length, 4);
    assert.deepEqual(waits, [1000, 4000, 16000]);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes(srv.url), 'the URL is a secret and is not logged');
  } finally {
    await srv.close();
  }
});

test('a webhook that recovers stops retrying', async () => {
  let n = 0;
  const srv = await fakeServer({ 'POST /hook': () => (++n < 3 ? { status: 503 } : { status: 200 }) });
  try {
    const waits = [];
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
      sleep: async (ms) => waits.push(ms),
    });
    await ch.notify(alert());
    assert.equal(srv.requests.length, 3);
    assert.deepEqual(waits, [1000, 4000]);
  } finally {
    await srv.close();
  }
});

test('a redirect is not followed, and it is a configuration error: one try, one log line', async () => {
  let srv;
  srv = await fakeServer({
    'POST /redir': () => ({ status: 302, headers: { location: `${srv.url}/elsewhere` } }),
    'POST /elsewhere': { status: 200 },
  });
  try {
    const waits = [];
    const logs = [];
    const ch = make({
      spawn: recorder().spawn,
      env: { REDIR_URL: `${srv.url}/redir` },
      settings: { desktop: false, webhook: { url: { env: 'REDIR_URL' } } },
      sleep: async (ms) => waits.push(ms),
      logs,
    });
    await ch.notify(alert());
    assert.equal(srv.requests.filter((r) => r.path === '/redir').length, 1);
    assert.equal(srv.requests.filter((r) => r.path === '/elsewhere').length, 0);
    assert.deepEqual(waits, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /redirect/);
  } finally {
    await srv.close();
  }
});

test('the request times out after 10 seconds', async () => {
  let signal;
  const fetchImpl = (_url, init) => {
    signal = init.signal;
    return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  };
  const logs = [];
  const ch = createChannels({
    spawn: recorder().spawn,
    fetchImpl,
    secrets: secretsFor({ HOOK_URL: 'https://hooks.example.com/x' }),
    settings: () => ({ desktop: false, webhook: { url: { env: 'HOOK_URL' } } }),
    platform: 'linux',
    sleep: noWait,
    timeoutMs: 20,
    log: (m) => logs.push(m),
  });
  await ch.notify(alert());
  assert.ok(signal.aborted);
  assert.equal(logs.length, 1);
});

test('only https, or http to loopback, is allowed; other URLs are refused and never fetched', async () => {
  for (const bad of [
    'http://hooks.example.com/x',
    'http://10.0.0.5/x',
    'ftp://hooks.example.com/x',
    'file:///etc/passwd',
    'not a url',
    'https://user:pw@hooks.example.com/x',
    'http://127.0.0.1.evil.com/',
    'http://localhost.evil.com/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    let called = 0;
    const logs = [];
    const ch = createChannels({
      spawn: recorder().spawn,
      fetchImpl: async () => {
        called++;
        return { ok: true };
      },
      secrets: secretsFor({ HOOK_URL: bad }),
      settings: () => ({ desktop: false, webhook: { url: { env: 'HOOK_URL' } } }),
      platform: 'linux',
      sleep: noWait,
      log: (m) => logs.push(m),
    });
    await ch.notify(alert());
    assert.equal(called, 0, bad);
    assert.equal(logs.length, 1, bad);
  }
  for (const good of [
    'https://hooks.example.com/x',
    'http://127.0.0.1:8080/x',
    'http://localhost/x',
    'http://[::1]:9/x',
  ]) {
    const urls = [];
    const ch = createChannels({
      spawn: recorder().spawn,
      fetchImpl: async (u) => {
        urls.push(u);
        return { ok: true, status: 200 };
      },
      secrets: secretsFor({ HOOK_URL: good }),
      settings: () => ({ desktop: false, webhook: { url: { env: 'HOOK_URL' } } }),
      platform: 'linux',
      log: () => {},
    });
    await ch.notify(alert());
    assert.equal(urls.length, 1, good);
  }
});

test('the URL comes from a secret reference; plain text and ZAAFPulse variables are refused', async () => {
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    return { ok: true, status: 200 };
  };
  const mk = (webhook, env, logs = []) =>
    createChannels({
      spawn: recorder().spawn,
      fetchImpl,
      secrets: secretsFor(env),
      settings: () => ({ desktop: false, webhook }),
      platform: 'linux',
      sleep: noWait,
      log: (m) => logs.push(m),
    });
  await mk({ url: { env: 'HOOK_URL' } }, { HOOK_URL: 'https://hooks.example.com/abc' }).notify(alert());
  assert.deepEqual(urls, ['https://hooks.example.com/abc']);
  const logs = [];
  await mk({ url: 'https://hooks.example.com/plain' }, {}, logs).notify(alert());
  await mk(
    { url: { env: 'ZAAFPULSE_ADMIN_PASSWORD' } },
    { ZAAFPULSE_ADMIN_PASSWORD: 'https://x.example/' },
    logs,
  ).notify(alert());
  await mk({ url: { env: 'UNSET' } }, {}, logs).notify(alert());
  assert.equal(urls.length, 1);
  assert.equal(logs.length, 3);
});

test('headers: a JSON object or Name: value lines; bad names or line breaks are refused', async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    seen.push(init.headers);
    return { ok: true, status: 200 };
  };
  const mk = (hdr, logs = []) =>
    createChannels({
      spawn: recorder().spawn,
      fetchImpl,
      secrets: secretsFor({ U: 'https://h.example.com/x', H: hdr }),
      settings: () => ({ desktop: false, webhook: { url: { env: 'U' }, headers: { env: 'H' } } }),
      platform: 'linux',
      sleep: noWait,
      log: (m) => logs.push(m),
    });
  await mk('X-Token: abc123456\nX-Other: 1').notify(alert());
  assert.equal(seen[0]['X-Token'], 'abc123456');
  assert.equal(seen[0]['X-Other'], '1');
  assert.equal(seen[0]['content-type'], 'application/json');
  const logs = [];
  await mk('{"Bad Name":"v"}', logs).notify(alert());
  await mk('{"X-A":"v\\r\\nX-B: injected"}', logs).notify(alert());
  await mk('{"Content-Type":"text/plain"}', logs).notify(alert());
  assert.equal(seen.length, 1);
  assert.equal(logs.length, 3);
});

test('test(kind) sends a sample through one channel and reports the outcome', async () => {
  const r = recorder();
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = make({
      spawn: r.spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: true, webhook: { url: { env: 'HOOK_URL' } } },
    });
    assert.deepEqual(await ch.test('desktop'), { ok: true });
    assert.equal(r.calls.length, 1);
    assert.equal(srv.requests.length, 0);
    assert.deepEqual(await ch.test('webhook'), { ok: true });
    assert.equal(srv.requests.length, 1);
    assert.equal(Object.keys(srv.requests[0].body).length, 7);
    assert.equal(r.calls.length, 1);
    assert.equal((await ch.test('pigeon')).ok, false);
  } finally {
    await srv.close();
  }
  const none = make({ spawn: recorder('enoent').spawn });
  const d = await none.test('desktop');
  assert.equal(d.ok, false);
  assert.ok(d.error);
  assert.equal((await none.test('webhook')).ok, false);
});

test('a failing webhook test reports the failure without waiting through the backoff', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 500 } });
  try {
    const waits = [];
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
      sleep: async (ms) => waits.push(ms),
    });
    const out = await ch.test('webhook');
    assert.equal(out.ok, false);
    assert.match(out.error, /500/);
    assert.equal(srv.requests.length, 1);
    assert.deepEqual(waits, []);
  } finally {
    await srv.close();
  }
});

test('the webhook sends only known rule ids and states; anything else is null', async () => {
  const srv = await fakeServer({ 'POST /hook': { status: 200 } });
  try {
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
    });
    await ch.notify(alert({ rule: 'my secret rule', state: 'free text here', previous: 'no_data' }));
    await ch.notify(alert({ state: 'snoozed', previous: 'ok' }));
    const [a, b] = srv.requests.map((r) => r.body);
    assert.equal(a.rule, null);
    assert.equal(a.state, null);
    assert.equal(a.previous, 'no_data');
    assert.equal(b.rule, 'daily_cost');
    assert.equal(b.state, 'snoozed');
  } finally {
    await srv.close();
  }
});

test('no_data and snoozed alerts skip the desktop notification without a failure log', async () => {
  const r = recorder();
  const logs = [];
  const ch = make({ spawn: r.spawn, logs });
  await ch.notify(alert({ state: 'no_data' }));
  await ch.notify(alert({ state: 'snoozed' }));
  assert.equal(r.calls.length, 0);
  assert.deepEqual(logs, []);
});

test('at most two desktop notifications are in flight; extras are dropped with one hint', async () => {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = null;
    child.kill = () => {};
    calls.push({ cmd, args, child });
    return child;
  };
  const logs = [];
  const ch = make({ spawn, logs });
  const jobs = [];
  for (let i = 0; i < 5; i++) jobs.push(ch.notify(alert()));
  assert.equal(calls.length, 2);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /more alerts/i);
  for (const c of calls) c.child.emit('close', 0);
  await Promise.all(jobs);
  assert.equal(logs.length, 1, 'dropped notifications are not failures');
  // Room again: it shows, and a later burst gets its own hint.
  const next = ch.notify(alert());
  assert.equal(calls.length, 3);
  calls[2].child.emit('close', 0);
  await next;
  const burst = [];
  for (let i = 0; i < 3; i++) burst.push(ch.notify(alert()));
  assert.equal(calls.length, 5);
  assert.equal(logs.length, 2);
  for (const c of calls.slice(3)) c.child.emit('close', 0);
  await Promise.all(burst);
});

test('at most four webhook sends are in flight; up to 50 wait and the oldest beyond that are dropped', async () => {
  const pending = [];
  const sent = [];
  const fetchImpl = (_u, init) => {
    sent.push(JSON.parse(init.body).ts);
    return new Promise((resolve) => pending.push(resolve));
  };
  const logs = [];
  const ch = createChannels({
    spawn: recorder().spawn,
    fetchImpl,
    secrets: secretsFor({ U: 'https://h.example.com/x' }),
    settings: () => ({ desktop: false, webhook: { url: { env: 'U' } } }),
    platform: 'linux',
    sleep: noWait,
    log: (m) => logs.push(m),
  });
  const jobs = [];
  for (let i = 0; i < 56; i++) jobs.push(ch.notify(alert({ ts: i })));
  assert.equal(sent.length, 4);
  while (pending.length) {
    pending.shift()({ ok: true, status: 200 });
    await new Promise((r) => setImmediate(r));
  }
  await Promise.all(jobs);
  assert.equal(sent.length, 54, '4 in flight + 50 queued; two were dropped');
  assert.deepEqual(sent.slice(0, 4), [0, 1, 2, 3]);
  assert.ok(!sent.includes(4) && !sent.includes(5), 'the oldest waiting ones were dropped');
  assert.ok(sent.includes(55));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /dropped/i);
});
