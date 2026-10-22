const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
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

test('Linux uses notify-send with fixed flags and the text as separate arguments', async () => {
  const r = recorder();
  const ch = make({ platform: 'linux', spawn: r.spawn });
  await ch.notify(alert(), { title: NASTY });
  const { cmd, args, opts } = r.calls[0];
  assert.equal(cmd, 'notify-send');
  assert.equal(args.length, 3);
  assert.equal(args[0], '--app-name=ZAAFPulse');
  assert.equal(args[1], 'ZAAFPulse: Daily cost');
  assert.ok(args[2].includes('$(rm -rf ~)'));
  assert.ok(!opts || !opts.shell);
});

test('Windows runs a constant script from stdin and hands the text over in the environment', async () => {
  const r = recorder();
  const ch = make({ platform: 'win32', spawn: r.spawn });
  await ch.notify(alert(), { title: NASTY });
  const { cmd, args, opts, stdin } = r.calls[0];
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
  assert.equal(stdin, WINDOWS_SCRIPT);
  assert.match(WINDOWS_SCRIPT, /\$env:ZP_TITLE/);
  assert.match(WINDOWS_SCRIPT, /\$env:ZP_TEXT/);
  assert.match(WINDOWS_SCRIPT, /ToastNotificationManager/);
  assert.match(WINDOWS_SCRIPT, /BalloonTip/);
  assert.equal(opts.env.ZP_TITLE, 'ZAAFPulse: Daily cost');
  assert.ok(opts.env.ZP_TEXT.includes('$(rm -rf ~)'));
  assert.ok(!opts.shell);
  // Nothing alert-specific is in the script text, so nothing can be injected into it.
  assert.ok(!stdin.includes('12.35') && !stdin.includes('rm -rf'));
});

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

test('a webhook that recovers stops retrying; a redirect is not followed', async () => {
  let n = 0;
  const srv = await fakeServer({
    'POST /hook': () => (++n < 3 ? { status: 503 } : { status: 200 }),
    'POST /redir': { status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } },
  });
  try {
    const waits = [];
    const ch = make({
      spawn: recorder().spawn,
      env: { HOOK_URL: `${srv.url}/hook`, REDIR_URL: `${srv.url}/redir` },
      settings: { desktop: false, webhook: { url: { env: 'HOOK_URL' } } },
      sleep: async (ms) => waits.push(ms),
    });
    await ch.notify(alert());
    assert.equal(srv.requests.length, 3);
    assert.deepEqual(waits, [1000, 4000]);
    const redir = make({
      spawn: recorder().spawn,
      env: { REDIR_URL: `${srv.url}/redir` },
      settings: { desktop: false, webhook: { url: { env: 'REDIR_URL' } } },
    });
    const before = srv.requests.length;
    await redir.notify(alert());
    assert.equal(srv.requests.length - before, 4, 'the 302 counts as a failure and is retried, not followed');
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
