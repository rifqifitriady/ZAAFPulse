const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: realSpawn } = require('child_process');
const { entries, commandHash } = require('../lib/runtimes/registry');
const { createRuntimeState, jsonFile } = require('../lib/runtimes/state');
const { createRuntimeControl, OFF_TEXT } = require('../lib/runtimes/control');

const POSIX = process.platform !== 'win32';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// The fake runtime lives in a temp folder: a path under the repository would read as ZAAFPulse's own process.
const FAKE_SRC = `const http = require('http');
const [port, mode] = process.argv.slice(2);
console.log('loading model from /Users/someone/models/qwen.gguf');
console.log('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456');
if (mode === '--fail') { console.error('error: address already in use'); process.exit(3); }
const server = http.createServer((req, res) => {
  if (mode === '--silent') return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"version":"0.0.0"}');
});
server.listen(Number(port), '127.0.0.1');
process.on('SIGINT', () => { server.close(); process.exit(0); });
setTimeout(() => process.exit(0), 60000); // never outlives a failed test by long
`;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const recorder = () => {
  const lines = [];
  return { lines, record: (e) => lines.push(e) };
};
const rejects = (p, status, re) =>
  assert.rejects(p, (e) => e.status === status && (!re || re.test(e.message)) && !/[\\/]Users[\\/]/.test(e.message));

// A real start against the fake runtime: the process table is the children this test spawned.
async function realSetup({ mode, approve = true, healthWaitMs = 10000, extra = {} } = {}) {
  const dir = tmp('zp-rt-ctl-');
  const fake = path.join(dir, 'fake-runtime.js');
  fs.writeFileSync(fake, FAKE_SRC);
  const port = await freePort();
  const config = [
    { id: 'fake-rt', name: 'Fake runtime', command: [process.execPath, fake, String(port), ...(mode ? [mode] : [])], port },
  ];
  const dataDir = path.join(dir, '.data');
  const started = jsonFile(path.join(dataDir, 'runtimes', 'started.json'));
  const approvals = jsonFile(path.join(dataDir, 'runtimes', 'approved.json'));
  if (approve) approvals.write({ 'fake-rt': commandHash(config[0]) });
  const spawned = [];
  const spawn = (...a) => {
    const c = realSpawn(...a);
    c.spawnedAt = Date.now();
    spawned.push(c);
    return c;
  };
  const table = {
    rows: async () =>
      spawned
        .filter((c) => c.pid && c.exitCode === null && c.signalCode === null)
        .map((c) => ({
          pid: c.pid,
          ppid: process.pid,
          cpu: 0,
          rssKB: 0,
          upSec: Math.round((Date.now() - c.spawnedAt) / 1000),
          args: c.spawnargs.join(' '),
        })),
  };
  // Nothing from this machine: no PATH, no app or Homebrew folders, so only the fake runtime is installed.
  const state = createRuntimeState({
    processes: table,
    entries: () => entries(config),
    started,
    env: { PATH: '' },
    binDirs: [],
    appDirs: [],
    brewPrefixes: [],
    // The path rules of this machine (the fake runtime is node at its real path), without macOS app or launchd lookups.
    platform: POSIX ? 'linux' : 'win32',
    readCgroup: () => '',
  });
  const audit = recorder();
  const ctl = createRuntimeControl({
    state,
    entries: () => entries(config),
    dataDir,
    started,
    approvals,
    audit,
    spawn,
    inDocker: false,
    healthWaitMs,
    pollMs: 50,
    graceMs: 2000,
    stopWaitMs: 5000,
    ...extra,
  });
  const cleanup = () => {
    for (const c of spawned) {
      if (c.exitCode !== null || c.signalCode !== null) continue; // never signal a pid that may be reused
      try {
        process.kill(c.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    // On Windows a server that was just sent SIGTERM still holds its working folder and log open for a moment:
    // removing the folder then fails with EPERM or EBUSY, which rmSync retries.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  // The fake runtime's row (off macOS the desktop apps are listed too, with "macOS only").
  const row = async () => (await ctl.list()).find((r) => r.id === 'fake-rt');
  return { ctl, row, state, started, approvals, audit, spawned, dataDir, port, config, cleanup };
}

test('start detaches the server, records it, waits for health; stop sends SIGINT and it exits', async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const r = await s.ctl.start('fake-rt');
  assert.deepEqual(r, { state: 'running' });
  const child = s.spawned[0];
  assert.equal(child.spawnargs[0], process.execPath);
  const rec = s.started.read()['fake-rt'];
  assert.equal(rec.pid, child.pid);
  const log = path.join(s.dataDir, 'runtimes', 'fake-rt.log');
  assert.ok(fs.existsSync(log));
  if (POSIX) assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  const row = await s.row();
  assert.equal(row.id, 'fake-rt');
  assert.equal(row.running, true);
  assert.equal(row.healthy, true);
  assert.equal(row.how, 'zaafpulse');
  assert.equal(row.canStop, true);
  assert.equal(row.canStart, false);
  await rejects(s.ctl.start('fake-rt'), 409, /already running/);
  assert.deepEqual(
    s.audit.lines.map((l) => [l.kind, l.action, l.id, l.ok]),
    [
      ['runtime', 'start', 'fake-rt', true],
      ['runtime', 'start', 'fake-rt', false],
    ],
  );
  if (!POSIX) return; // Windows stops with taskkill, covered with a fake below
  const stopped = await s.ctl.stop({ id: 'fake-rt', pid: row.pid, startTime: row.startTime });
  assert.deepEqual(stopped, { state: 'stopped' });
  assert.deepEqual(s.started.read(), {});
  const stopLine = s.audit.lines.find((l) => l.action === 'stop');
  assert.equal(stopLine.signal, 'SIGINT');
  assert.equal(stopLine.how, 'zaafpulse');
});

test('the spawn: no shell, detached, stdin ignored, output to the log, the data folder as working folder', async (t) => {
  const calls = [];
  const s = await realSetup({
    extra: {
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        const c = new EventEmitter();
        c.pid = 4321;
        c.unref = () => {};
        process.nextTick(() => c.emit('spawn'));
        return c;
      },
      probe: async () => true,
    },
  });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.start('fake-rt'), { state: 'running' });
  const [{ cmd, args, opts }] = calls;
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, s.config[0].command.slice(1));
  assert.equal(opts.shell, false);
  assert.equal(opts.detached, true);
  assert.equal(opts.cwd, s.dataDir);
  assert.equal(opts.stdio[0], 'ignore');
  assert.equal(typeof opts.stdio[1], 'number');
  assert.equal(opts.stdio[1], opts.stdio[2]);
});

test('a start that never answers reports starting, with the log masked and without paths', async (t) => {
  const s = await realSetup({ mode: '--silent', healthWaitMs: 400 });
  t.after(s.cleanup);
  const r = await s.ctl.start('fake-rt');
  assert.equal(r.state, 'starting');
  assert.equal(r.note, 'started, not answering yet');
  const text = r.log.join('\n');
  assert.match(text, /loading model from \[path\]/);
  assert.match(text, /OpenAI API key hidden/);
  assert.doesNotMatch(text, /sk-proj-|\/Users\/someone/);
});

test('a command that exits with an error is a 502 with the masked log', async (t) => {
  const s = await realSetup({ mode: '--fail' });
  t.after(s.cleanup);
  await assert.rejects(s.ctl.start('fake-rt'), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.message, 'the command exited with code 3');
    assert.ok(e.log.some((l) => /address already in use/.test(l)));
    assert.ok(!e.log.join('\n').includes('/Users/someone'));
    return true;
  });
  assert.equal(s.audit.lines.at(-1).status, 502);
});

test('a command that cannot be spawned is a 502', async (t) => {
  const s = await realSetup({
    extra: {
      spawn: () => {
        const c = new EventEmitter();
        process.nextTick(() => c.emit('error', Object.assign(new Error('spawn /x ENOENT'), { code: 'ENOENT' })));
        return c;
      },
    },
  });
  t.after(s.cleanup);
  await rejects(s.ctl.start('fake-rt'), 502, /^the command could not start$/);
  assert.deepEqual(s.started.read(), {});
});

test('refusals: unknown, unapproved, server mode, no sign-in, Docker, not installed; each is audited', async (t) => {
  const s = await realSetup({ approve: false });
  t.after(s.cleanup);
  await rejects(s.ctl.start('nope'), 404, /unknown runtime/);
  await rejects(s.ctl.start('fake-rt'), 403, /approve it in Settings first/);
  const row = await s.row();
  assert.equal(row.approved, false);
  assert.equal(row.canStart, false);
  assert.equal(row.reason, 'approve it in Settings first');
  // Approving stores a hash of the command; a changed command asks again.
  assert.deepEqual(await s.ctl.approve('fake-rt'), { approved: true });
  assert.equal(s.approvals.read()['fake-rt'], commandHash(s.config[0]));
  assert.equal((await s.row()).canStart, true);
  s.config[0].command = [...s.config[0].command, '--verbose'];
  assert.equal((await s.row()).approved, false);
  await rejects(s.ctl.approve('ollama'), 400, /preset/);
  await rejects(s.ctl.approve('nope'), 404);
  s.ctl.forget('fake-rt');
  assert.deepEqual(s.approvals.read(), {});
  const server = await realSetup({ extra: { serverMode: true } });
  t.after(server.cleanup);
  await rejects(server.ctl.start('fake-rt'), 403, /off on this server/);
  await rejects(server.ctl.stop({ id: 'fake-rt', pid: 4242, startTime: 1 }), 403, /off on this server/);
  await rejects(server.ctl.approve('fake-rt'), 403);
  const off = (await server.row());
  assert.equal(off.canStart, false);
  assert.equal(off.reason, 'runtime control is off on this server');
  // Without sign-in the reason is kept, so the card does not say "on this server" on a laptop.
  const none = await realSetup({ extra: { serverMode: 'no-sign-in' } });
  t.after(none.cleanup);
  assert.equal(none.ctl.offReason(), 'no-sign-in');
  await rejects(none.ctl.start('fake-rt'), 403, /without sign-in/);
  await rejects(none.ctl.stop({ id: 'fake-rt', pid: 4242, startTime: 1 }), 403, /without sign-in/);
  await rejects(none.ctl.approve('fake-rt'), 403, /without sign-in/);
  assert.equal((await none.row()).reason, OFF_TEXT['no-sign-in']);
  assert.equal(server.ctl.offReason(), 'server');
  const docker = await realSetup({ extra: { inDocker: true } });
  t.after(docker.cleanup);
  await rejects(docker.ctl.start('fake-rt'), 403, /off in Docker/);
  const missing = await realSetup();
  t.after(missing.cleanup);
  missing.config[0].command = [path.join(os.tmpdir(), 'zp-no-such-runtime'), '--port', String(missing.port)];
  missing.approvals.write({ 'fake-rt': commandHash(missing.config[0]) });
  await rejects(missing.ctl.start('fake-rt'), 409, /not installed/);
  for (const a of [s, server, none, docker, missing])
    for (const l of a.audit.lines) {
      assert.equal(l.kind, 'runtime');
      assert.equal(l.by, 'owner');
    }
  assert.ok(s.audit.lines.filter((l) => l.ok === false).length >= 4);
});

// ---- stop, with a fake state and a kill that records every call ----
function fakeKill({ exitOn = null, gone = new Set() } = {}) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (gone.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    if (signal === exitOn) gone.add(pid);
    return true;
  };
  return { calls, kill, sent: () => calls.filter(([, s]) => s !== 0).map(([, s]) => s) };
}
const OLLAMA = entries([]).find((e) => e.id === 'ollama');
const LMSTUDIO = entries([]).find((e) => e.id === 'lmstudio');
const SRV = { pid: 5150, startTime: 1_790_000_000_000 };
const item = (over = {}) => ({
  entry: OLLAMA,
  installed: true,
  bin: '/opt/homebrew/bin/ollama',
  app: null,
  startArgv: ['/opt/homebrew/bin/ollama', 'serve'],
  stopArgv: null,
  brewBin: null,
  running: true,
  healthy: true,
  how: 'process',
  ...SRV,
  children: 1,
  tableError: null,
  ...over,
});
function stopSetup({ x = item(), killer = fakeKill(), platform = 'darwin', probe = async () => false, runCode = 0, extra = {} } = {}) {
  const ran = [];
  const audit = recorder();
  const dir = tmp('zp-rt-stop-');
  const ctl = createRuntimeControl({
    state: { one: async () => x, list: async () => [x] },
    entries: () => entries([]),
    dataDir: dir,
    audit,
    kill: killer.kill,
    spawn: (cmd, args) => {
      ran.push([cmd, ...args]);
      const c = new EventEmitter();
      process.nextTick(() => c.emit('close', runCode));
      return c;
    },
    probe,
    platform,
    inDocker: false,
    graceMs: 40,
    stopWaitMs: 120,
    pollMs: 5,
    ...extra,
  });
  return { ctl, ran, audit, killer, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('stop: SIGINT, then SIGTERM after the grace when the same process is still there; never SIGKILL', async (t) => {
  const s = stopSetup();
  t.after(s.cleanup);
  const r = await s.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(r, { state: 'stopping', note: 'still shutting down' }, 'the fake process never exits');
  assert.deepEqual(s.killer.sent(), ['SIGINT', 'SIGTERM']);
  assert.ok(!s.killer.calls.some(([, sig]) => sig === 'SIGKILL'));
  assert.deepEqual(
    s.audit.lines.map((l) => [l.action, l.ok, l.signal]),
    [
      ['stop', true, 'SIGINT'],
      ['stop', true, 'SIGTERM'],
    ],
  );
  const quick = stopSetup({ killer: fakeKill({ exitOn: 'SIGINT' }) });
  t.after(quick.cleanup);
  assert.deepEqual(await quick.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
  assert.deepEqual(quick.killer.sent(), ['SIGINT']);
});

test('stop: a changed pid or start time, a stopped server, a system unit and a bad target are refused', async (t) => {
  const s = stopSetup();
  t.after(s.cleanup);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid + 1, startTime: SRV.startTime }), 409, /the process changed; refresh/);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid, startTime: SRV.startTime + 5000 }), 409, /process changed/);
  await rejects(s.ctl.stop({ id: 'ollama', pid: 1, startTime: SRV.startTime }), 400);
  await rejects(s.ctl.stop({ id: 'ollama', pid: SRV.pid }), 400);
  assert.deepEqual(s.killer.sent(), []);
  const idle = stopSetup({ x: item({ running: false, pid: null, startTime: null, how: null }) });
  t.after(idle.cleanup);
  await rejects(idle.ctl.stop({ id: 'ollama', ...SRV }), 409, /already stopped/);
  const sys = stopSetup({ x: item({ how: 'system' }) });
  t.after(sys.cleanup);
  await rejects(sys.ctl.stop({ id: 'ollama', ...SRV }), 409, /managed by the system/);
  const none = stopSetup({ x: null });
  t.after(none.cleanup);
  await rejects(none.ctl.stop({ id: 'nope', ...SRV }), 404);
  assert.ok(s.audit.lines.every((l) => l.ok === false && l.kind === 'runtime'));
});

test('stop follows how the server runs: own stop command, quit the app, brew services, taskkill', async (t) => {
  const lms = stopSetup({
    x: item({ entry: LMSTUDIO, how: 'app', stopArgv: ['/Users/u/.lmstudio/bin/lms', 'server', 'stop'] }),
  });
  t.after(lms.cleanup);
  assert.deepEqual(await lms.ctl.stop({ id: 'lmstudio', ...SRV }), { state: 'stopped' }, 'the health URL went quiet');
  assert.deepEqual(lms.ran, [['/Users/u/.lmstudio/bin/lms', 'server', 'stop']]);
  const app = stopSetup({ x: item({ how: 'app' }), killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(app.cleanup);
  assert.deepEqual(await app.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
  assert.deepEqual(app.ran, [['/usr/bin/osascript', '-e', 'quit app "Ollama"']]);
  const svc = stopSetup({ x: item({ how: 'service', brewBin: '/opt/homebrew/bin/brew' }), killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(svc.cleanup);
  await svc.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(svc.ran, [['/opt/homebrew/bin/brew', 'services', 'stop', 'ollama']]);
  const winOk = stopSetup({ platform: 'win32', killer: fakeKill({ gone: new Set([SRV.pid]) }) });
  t.after(winOk.cleanup);
  await winOk.ctl.stop({ id: 'ollama', ...SRV });
  assert.deepEqual(winOk.ran, [[path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), '/PID', String(SRV.pid)]], 'absolute path, no /F');
  const winBad = stopSetup({ platform: 'win32', runCode: 128 });
  t.after(winBad.cleanup);
  await rejects(winBad.ctl.stop({ id: 'ollama', ...SRV }), 502, /taskkill/);
  for (const s of [lms, app, svc, winOk]) assert.deepEqual(s.killer.sent(), [], 'no signal when a command stops it');
});

// ---- review fixes ----
test('stop refuses an unapproved owner entry, audited, without any signal; the list offers no stop', async (t) => {
  const owner = { id: 'sshd-ish', name: 'Owner entry', command: ['/usr/sbin/sshd'], port: 2222 };
  const x = item({ entry: entries([owner]).find((e) => e.id === 'sshd-ish') });
  const s = stopSetup({ x });
  t.after(s.cleanup);
  await rejects(s.ctl.stop({ id: 'sshd-ish', ...SRV }), 403, /approve it in Settings first/);
  assert.deepEqual(s.killer.calls, []);
  assert.deepEqual(s.audit.lines.map((l) => [l.action, l.ok, l.status]), [['stop', false, 403]]);
  const [row] = await s.ctl.list();
  assert.equal(row.canStop, false);
  assert.equal(row.reason, 'approve it in Settings first');
});

test('two concurrent stops for one id: the second is a 409, audited', async (t) => {
  const s = stopSetup({ killer: fakeKill({ exitOn: 'SIGINT' }) });
  t.after(s.cleanup);
  const first = s.ctl.stop({ id: 'ollama', ...SRV });
  const second = s.ctl.stop({ id: 'ollama', ...SRV });
  await rejects(second, 409, /^a stop is still in progress; try again shortly$/);
  assert.deepEqual(await first, { state: 'stopped' });
  assert.deepEqual(s.killer.sent(), ['SIGINT']);
  assert.ok(s.audit.lines.some((l) => l.ok === false && l.status === 409));
  // the guard is released afterwards
  const later = await s.ctl.stop({ id: 'ollama', ...SRV }).then(() => null, (e) => e);
  assert.notEqual(later && later.status, 409, 'not stuck in progress');
});

test('a start that is still running makes a second start a 409 that names the start', async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const first = s.ctl.start('fake-rt');
  await rejects(s.ctl.start('fake-rt'), 409, /^a start is still in progress; try again shortly$/);
  assert.deepEqual(await first, { state: 'running' });
});

test('stop commands run with the same environment as the started runtime', async (t) => {
  process.env.ZAAFPULSE_TEST_SECRET = 'hunter2';
  t.after(() => delete process.env.ZAAFPULSE_TEST_SECRET);
  const seen = [];
  const dir = tmp('zp-rt-stopenv-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctl = createRuntimeControl({
    state: { one: async () => item({ stopArgv: ['/x/lms', 'server', 'stop'], entry: LMSTUDIO, how: 'app' }), list: async () => [] },
    dataDir: dir,
    audit: recorder(),
    spawn: (cmd, args, opts) => {
      seen.push(opts.env);
      const c = new EventEmitter();
      process.nextTick(() => c.emit('close', 0));
      return c;
    },
    probe: async () => false,
    inDocker: false,
    graceMs: 20,
    stopWaitMs: 40,
    pollMs: 5,
  });
  await ctl.stop({ id: 'lmstudio', ...SRV });
  assert.equal(seen.length, 1);
  assert.ok(!Object.keys(seen[0]).some((k) => k.startsWith('ZAAFPULSE_')));
});

test('an unexpected failure inside stop or approve is audited with status 500 and rethrown', async (t) => {
  const dir = tmp('zp-rt-500-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = recorder();
  const boom = () => {
    throw new Error('disk on fire at /Users/x');
  };
  const ctl = createRuntimeControl({
    state: { one: boom, list: boom },
    entries: () => entries([{ id: 'mine', name: 'Mine', command: ['/bin/true'], port: 9 }]),
    dataDir: dir,
    approvals: { read: () => ({}), write: boom },
    audit,
    inDocker: false,
  });
  await assert.rejects(ctl.stop({ id: 'ollama', ...SRV }), /disk on fire/);
  await assert.rejects(ctl.start('ollama'), /disk on fire/);
  await assert.rejects(ctl.approve('mine'), /disk on fire/);
  assert.deepEqual(audit.lines.map((l) => [l.action, l.ok, l.status, l.error]), [
    ['stop', false, 500, 'internal error'],
    ['start', false, 500, 'internal error'],
    ['approve', false, 500, 'internal error'],
  ]);
});

test('a symlinked log is not written through, not read through, and a start is refused', { skip: !POSIX }, async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const victim = path.join(s.dataDir, 'victim.txt');
  fs.mkdirSync(path.join(s.dataDir, 'runtimes'), { recursive: true });
  fs.writeFileSync(victim, 'secret line\n');
  fs.symlinkSync(victim, path.join(s.dataDir, 'runtimes', 'fake-rt.log'));
  assert.deepEqual(s.ctl.logTail('fake-rt'), [], 'not read through');
  await rejects(s.ctl.start('fake-rt'), 502, /log file is not a regular file/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'secret line\n', 'not written through');
  assert.equal(s.spawned.length, 0);
  assert.equal(s.audit.lines.at(-1).status, 502);
});

test('a FIFO at the log path is never opened: logTail returns at once', { skip: !POSIX, timeout: 2000 }, async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const log = path.join(s.dataDir, 'runtimes', 'fake-rt.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const made = require('child_process').spawnSync('mkfifo', [log]);
  if (made.error || made.status !== 0) return t.skip('mkfifo is not available');
  assert.deepEqual(s.ctl.logTail('fake-rt'), [], 'no hang on a FIFO');
});

test('a hard-linked log is not read, and a start is refused', { skip: !POSIX }, async (t) => {
  const s = await realSetup();
  t.after(s.cleanup);
  const victim = path.join(s.dataDir, 'victim.txt');
  const log = path.join(s.dataDir, 'runtimes', 'fake-rt.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(victim, 'secret line\n');
  fs.linkSync(victim, log);
  assert.deepEqual(s.ctl.logTail('fake-rt'), [], 'not read');
  await rejects(s.ctl.start('fake-rt'), 502, /log file is not a regular file/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'secret line\n', 'not written');
  assert.equal(s.spawned.length, 0);
});

test('only a direct server start is recorded; a failed start leaves no record', async (t) => {
  const mk = (extra) =>
    realSetup({
      extra: {
        probe: async () => true,
        spawn: () => {
          const c = new EventEmitter();
          c.pid = 4321;
          c.unref = () => {};
          process.nextTick(() => c.emit('spawn'));
          return c;
        },
        ...extra,
      },
    });
  const direct = await mk();
  t.after(direct.cleanup);
  await direct.ctl.start('fake-rt');
  assert.equal(direct.started.read()['fake-rt'].pid, 4321);
  const launcher = await mk({
    state: {
      one: async () => item({ entry: LMSTUDIO, running: false, pid: null, startTime: null, how: null, startArgv: ['/x/lms', 'server', 'start'], stopArgv: ['/x/lms', 'server', 'stop'] }),
    },
  });
  t.after(launcher.cleanup);
  await launcher.ctl.start('lmstudio');
  assert.deepEqual(launcher.started.read(), {});
  const open = await mk({
    state: { one: async () => item({ running: false, pid: null, startTime: null, how: null, startArgv: ['/usr/bin/open', '-a', '/Applications/Ollama.app'] }) },
  });
  t.after(open.cleanup);
  await open.ctl.start('ollama');
  assert.deepEqual(open.started.read(), {});
  const bad = await realSetup({ mode: '--fail' });
  t.after(bad.cleanup);
  await rejects(bad.ctl.start('fake-rt'), 502, /exited with code 3/);
  assert.deepEqual(bad.started.read(), {});
});

test('ZAAFPULSE_* is not passed on to a started runtime', { skip: !POSIX }, async (t) => {
  process.env.ZAAFPULSE_TEST_SECRET = 'hunter2';
  t.after(() => delete process.env.ZAAFPULSE_TEST_SECRET);
  const seen = [];
  const s = await realSetup({
    extra: {
      probe: async () => true,
      spawn: (cmd, args, opts) => {
        seen.push(opts.env);
        const c = new EventEmitter();
        c.pid = 4321;
        c.unref = () => {};
        process.nextTick(() => c.emit('spawn'));
        return c;
      },
    },
  });
  t.after(s.cleanup);
  await s.ctl.start('fake-rt');
  assert.ok(seen[0].PATH !== undefined || process.env.PATH === undefined);
  assert.ok(!Object.keys(seen[0]).some((k) => k.startsWith('ZAAFPULSE_')));
});

test('a stop command that never exits resolves as a failure after its own timer', async (t) => {
  const dir = tmp('zp-rt-hang-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const killed = [];
  const ctl = createRuntimeControl({
    state: { one: async () => item({ stopArgv: ['/x/ollama', 'stop'] }), list: async () => [] },
    dataDir: dir,
    audit: recorder(),
    spawn: () => Object.assign(new EventEmitter(), { kill: () => killed.push('SIGTERM') }), // never closes
    inDocker: false,
    commandTimeoutMs: 30,
  });
  await rejects(ctl.stop({ id: 'ollama', ...SRV }), 502, /stop command failed/);
  assert.deepEqual(killed, ['SIGTERM']);
});

// ---- the models a runtime last had loaded (lib/runtimes/models.js), with a fake memory ----
function fakeModels({ observe = async () => ['llama3.2:3b'], names = ['llama3.2:3b'], status = null, all = false } = {}) {
  const calls = [];
  return {
    calls,
    supports: (id) => all || id === 'ollama' || id === 'lmstudio',
    observe: (x) => (calls.push(['observe', x.entry.id]), observe(x)),
    reload: (x) => (calls.push(['reload', x]), names),
    cancel: (id) => calls.push(['cancel', id]),
    remembered: (id) => (id === 'ollama' ? ['llama3.2:3b', 'qwen3:8b'] : []),
    status: (id) => (id === 'ollama' ? status : null),
  };
}

test('stop observes the loaded models first, then cancels a reload, then signals', async (t) => {
  const killer = fakeKill({ exitOn: 'SIGINT' });
  const seen = [];
  const models = fakeModels({ observe: async () => (seen.push(killer.calls.length), ['a']) });
  const s = stopSetup({ killer, extra: { models } });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
  assert.deepEqual(seen, [0], 'nothing was signalled before the observe');
  assert.deepEqual(models.calls, [
    ['observe', 'ollama'],
    ['cancel', 'ollama'],
  ]);
  assert.deepEqual(killer.sent(), ['SIGINT']);
  // A stop command (LM Studio's lms server stop) also runs after the observe.
  const ran = [];
  const lmsModels = fakeModels({ observe: async () => (ran.push(lms.ran.length), []) });
  const lms = stopSetup({
    x: item({ entry: LMSTUDIO, how: 'app', stopArgv: ['/x/lms', 'server', 'stop'] }),
    extra: { models: lmsModels },
  });
  t.after(lms.cleanup);
  await lms.ctl.stop({ id: 'lmstudio', ...SRV });
  assert.deepEqual(ran, [0]);
  assert.deepEqual(lms.ran, [['/x/lms', 'server', 'stop']]);
  assert.deepEqual(lmsModels.calls.map((c) => c[0]), ['observe', 'cancel']);
});

test('a rejecting, throwing or hanging observe never blocks or fails the stop', async (t) => {
  for (const observe of [
    async () => {
      throw new Error('no /Users/x');
    },
    () => {
      throw new Error('sync');
    },
    () => new Promise(() => {}), // never answers: the cap ends the wait
  ]) {
    const models = fakeModels({ observe });
    const s = stopSetup({ killer: fakeKill({ exitOn: 'SIGINT' }), extra: { models, observeTimeoutMs: 30 } });
    t.after(s.cleanup);
    const t0 = Date.now();
    assert.deepEqual(await s.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopped' });
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(s.killer.sent(), ['SIGINT']);
    assert.ok(s.audit.lines.every((l) => l.ok === true), 'no failure is audited');
  }
});

test('stop of an unsupported runtime or a refused stop does not observe', async (t) => {
  const models = fakeModels();
  const jan = stopSetup({
    x: item({ entry: entries([]).find((e) => e.id === 'jan') }),
    killer: fakeKill({ exitOn: 'SIGINT' }),
    extra: { models },
  });
  t.after(jan.cleanup);
  await jan.ctl.stop({ id: 'jan', ...SRV });
  const refused = stopSetup({ extra: { models } });
  t.after(refused.cleanup);
  await rejects(refused.ctl.stop({ id: 'ollama', pid: SRV.pid + 1, startTime: SRV.startTime }), 409);
  assert.deepEqual(models.calls, []);
});

// A start of a preset with a fake spawn: `one` answers each item in turn (before the start, then after it answered).
function startSetup({ items, models, probe = async () => true, healthWaitMs = 1000, extra = {} }) {
  const dir = tmp('zp-rt-reload-');
  const audit = recorder();
  let n = 0;
  const ctl = createRuntimeControl({
    state: {
      one: async () => {
        const x = items[Math.min(n++, items.length - 1)];
        if (x instanceof Error) throw x;
        return x;
      },
      list: async () => items.filter((x) => !(x instanceof Error)),
    },
    entries: () => entries([]),
    dataDir: dir,
    audit,
    spawn: () => {
      const c = new EventEmitter();
      c.pid = 4321;
      c.unref = () => {};
      process.nextTick(() => c.emit('spawn'));
      return c;
    },
    probe,
    inDocker: false,
    healthWaitMs,
    pollMs: 10,
    models,
    ...extra,
  });
  return { ctl, audit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const stoppedOllama = () => item({ running: false, healthy: false, pid: null, startTime: null, how: null });

test('a start that answers running reloads with the item read after the server answered', async (t) => {
  const after = item({ how: 'zaafpulse', bin: '/after/ollama' });
  const models = fakeModels();
  const s = startSetup({ items: [stoppedOllama(), after], models });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.start('ollama'), { state: 'running', reloading: ['llama3.2:3b'] });
  assert.deepEqual(models.calls, [['reload', after]]);
  // Nothing remembered: the answer has no `reloading`.
  const none = startSetup({ items: [stoppedOllama(), after], models: fakeModels({ names: [] }) });
  t.after(none.cleanup);
  assert.deepEqual(await none.ctl.start('ollama'), { state: 'running' });
});

test('a start that answers starting, or of an owner entry, does not reload', async (t) => {
  const models = fakeModels({ all: true });
  const slow = startSetup({ items: [stoppedOllama()], models, probe: async () => false, healthWaitMs: 50 });
  t.after(slow.cleanup);
  assert.equal((await slow.ctl.start('ollama')).state, 'starting');
  const s = await realSetup({
    extra: {
      models,
      probe: async () => true,
      spawn: () => {
        const c = new EventEmitter();
        c.pid = 4321;
        c.unref = () => {};
        process.nextTick(() => c.emit('spawn'));
        return c;
      },
    },
  });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.start('fake-rt'), { state: 'running' });
  assert.deepEqual(models.calls, []);
});

test('a reload that cannot begin leaves the start answer as running', async (t) => {
  const throwing = fakeModels();
  throwing.reload = () => {
    throw new Error('boom');
  };
  const a = startSetup({ items: [stoppedOllama(), item()], models: throwing });
  t.after(a.cleanup);
  assert.deepEqual(await a.ctl.start('ollama'), { state: 'running' });
  const models = fakeModels();
  const b = startSetup({ items: [stoppedOllama(), new Error('table')], models });
  t.after(b.cleanup);
  assert.deepEqual(await b.ctl.start('ollama'), { state: 'running' });
  assert.deepEqual(models.calls, []);
  for (const s of [a, b]) assert.ok(!s.audit.lines.some((l) => l.ok === false));
});

test('list rows carry models for Ollama and LM Studio, null otherwise; status only while running', async (t) => {
  const status = { loading: true, loaded: ['llama3.2:3b'], failed: [{ name: 'qwen3:8b', error: 'not found' }] };
  const lmsItem = item({ entry: LMSTUDIO, running: false, pid: null, startTime: null, how: null });
  const janItem = item({ entry: entries([]).find((e) => e.id === 'jan') });
  const mk = (x, models) => {
    const dir = tmp('zp-rt-view-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return createRuntimeControl({ state: { list: async () => x }, dataDir: dir, audit: recorder(), inDocker: false, models });
  };
  const rows = await mk([item(), lmsItem, janItem], fakeModels({ status })).list();
  assert.deepEqual(rows.map((r) => [r.id, r.models]), [
    ['ollama', { remembered: ['llama3.2:3b', 'qwen3:8b'], ...status, current: null }],
    ['lmstudio', { remembered: [], loading: false, loaded: [], failed: [], current: null }],
    ['jan', null],
  ]);
  const [stopped] = await mk([stoppedOllama()], fakeModels({ status })).list();
  assert.deepEqual(stopped.models, {
    remembered: ['llama3.2:3b', 'qwen3:8b'],
    loading: false,
    loaded: [],
    failed: [],
    current: null,
  });
  // What is loaded now comes from the memory's last read, and only while the runtime runs.
  const withCurrent = { ...fakeModels({ status }), current: (id) => (id === 'ollama' ? ['llama3.2:3b'] : null) };
  assert.deepEqual((await mk([item()], withCurrent).list())[0].models.current, ['llama3.2:3b']);
  assert.equal((await mk([stoppedOllama()], withCurrent).list())[0].models.current, null);
  const [without] = await mk([item()]).list();
  assert.equal(without.models, null, 'no memory given: null');
});

test('reloaded writes one audit line with counts and no names', async (t) => {
  const s = stopSetup();
  t.after(s.cleanup);
  s.ctl.reloaded('ollama', { loaded: ['llama3.2:3b', 'qwen3:8b'], failed: [{ name: 'gemma3', error: 'not found' }] });
  s.ctl.reloaded('lmstudio', { loaded: ['q'], failed: [], cancelled: true });
  s.ctl.reloaded('ollama', null);
  const lines = s.audit.lines.map(({ ts, ...l }) => l);
  assert.deepEqual(lines, [
    { kind: 'runtime', action: 'reload', id: 'ollama', by: 'owner', ok: false, loaded: 2, failed: 1 },
    { kind: 'runtime', action: 'reload', id: 'lmstudio', by: 'owner', ok: true, loaded: 1, failed: 0, cancelled: true },
    { kind: 'runtime', action: 'reload', id: 'ollama', by: 'owner', ok: true, loaded: 0, failed: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(s.audit.lines), /llama3|qwen3|gemma|not found/);
});

// ---- the desktop apps (kind 'app'): nothing real is opened, quit or signalled ----
const APP = (id) => entries([]).find((e) => e.id === id);
const APP_PID = { pid: 84551, startTime: 1_790_000_100_000 };
const appItem = (over = {}) =>
  item({
    entry: APP('claude-desktop'),
    bin: null,
    app: '/Applications/Claude.app',
    appBundle: 'Claude.app',
    startArgv: ['/usr/bin/open', '-a', '/Applications/Claude.app'],
    how: 'app',
    ...APP_PID,
    children: 3,
    ...over,
  });
const APP_WAITS = { appQuitWaitMs: 60, appTermWaitMs: 40, appKillWaitMs: 20, appOpenWaitMs: 60 };
// A stop of an app: `reads` are what the state answers in turn (the first is the find before the stop; the last one
// repeats); `quits` makes the fake osascript end the process; every kill and command is recorded with its time.
function appStopSetup({ reads = [appItem()], killer = fakeKill(), quits = false, runCode = 0, platform = 'darwin', extra = {} } = {}) {
  const ran = [];
  const audit = recorder();
  const dir = tmp('zp-rt-app-');
  let n = 0;
  const t0 = Date.now();
  const at = [];
  const ctl = createRuntimeControl({
    state: {
      one: async () => {
        const x = reads[Math.min(n++, reads.length - 1)];
        if (x instanceof Error) throw x;
        return x;
      },
      list: async () => [reads[0]],
    },
    entries: () => entries([]),
    dataDir: dir,
    audit,
    kill: (pid, signal) => {
      if (signal !== 0) at.push([signal, Date.now() - t0]);
      return killer.kill(pid, signal);
    },
    spawn: (cmd, args) => {
      ran.push([cmd, ...args]);
      at.push([cmd, Date.now() - t0]);
      if (quits) killer.gone.add(APP_PID.pid);
      const c = new EventEmitter();
      process.nextTick(() => c.emit('close', runCode));
      return c;
    },
    probe: async () => {
      throw new Error('an app has no health URL');
    },
    platform,
    inDocker: false,
    pollMs: 5,
    ...APP_WAITS,
    ...extra,
  });
  return { ctl, ran, audit, killer, at, reads: () => n, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function fakeKillApp(opts) {
  const gone = (opts && opts.gone) || new Set();
  return { ...fakeKill({ ...opts, gone }), gone };
}
const QUIT_CLAUDE = ['/usr/bin/osascript', '-e', 'quit app "Claude"'];

test('app stop: the quit command first; an app that quits in time gets no signal', async (t) => {
  const s = appStopSetup({ killer: fakeKillApp(), quits: true });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.stop({ id: 'claude-desktop', ...APP_PID }), { state: 'stopped' });
  assert.deepEqual(s.ran, [QUIT_CLAUDE]);
  assert.deepEqual(s.killer.sent(), [], 'no signal');
  assert.deepEqual(
    s.audit.lines.map((l) => [l.action, l.ok, l.id, l.method, l.signal, l.forced]),
    [['stop', true, 'claude-desktop', 'app', undefined, undefined]],
  );
  assert.equal(s.audit.lines[0].pid, APP_PID.pid);
  assert.equal(s.audit.lines[0].startTime, APP_PID.startTime);
});

test('app stop: Kiro CLI.app is quit by its own name, from the bundle the process runs from', async (t) => {
  const kiro = appItem({ entry: APP('kiro'), appBundle: 'Kiro CLI.app', app: '/Applications/Kiro.app' });
  const s = appStopSetup({ reads: [kiro], killer: fakeKillApp(), quits: true });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.stop({ id: 'kiro', ...APP_PID }), { state: 'stopped' });
  assert.deepEqual(s.ran, [['/usr/bin/osascript', '-e', 'quit app "Kiro CLI"']]);
});

test('app stop: SIGTERM after the quit wait, then SIGKILL after the term wait, each to the same process; then stopping', async (t) => {
  const s = appStopSetup({ killer: fakeKillApp() });
  t.after(s.cleanup);
  const r = await s.ctl.stop({ id: 'claude-desktop', ...APP_PID });
  assert.deepEqual(r, { state: 'stopping', note: 'still shutting down' }, 'the fake app never exits');
  assert.deepEqual(s.ran, [QUIT_CLAUDE]);
  assert.deepEqual(s.killer.sent(), ['SIGTERM', 'SIGKILL']);
  assert.ok(s.killer.calls.filter(([, sig]) => sig !== 0).every(([pid]) => pid === APP_PID.pid));
  const when = Object.fromEntries(s.at.map(([what, ms]) => [what, ms]));
  assert.ok(when.SIGTERM - when['/usr/bin/osascript'] >= APP_WAITS.appQuitWaitMs - 5, `SIGTERM waited: ${JSON.stringify(s.at)}`);
  assert.ok(when.SIGKILL - when.SIGTERM >= APP_WAITS.appTermWaitMs - 5, `SIGKILL waited: ${JSON.stringify(s.at)}`);
  assert.equal(s.reads(), 3, 'the find, then one read before each signal');
  assert.deepEqual(
    s.audit.lines.map((l) => [l.action, l.ok, l.method, l.signal, l.forced]),
    [
      ['stop', true, 'app', undefined, undefined],
      ['stop', true, 'signal', 'SIGTERM', true],
      ['stop', true, 'signal', 'SIGKILL', true],
    ],
  );
  for (const l of s.audit.lines) {
    assert.equal(l.kind, 'runtime');
    assert.equal(l.pid, APP_PID.pid);
    assert.equal(l.startTime, APP_PID.startTime);
    assert.doesNotMatch(JSON.stringify(l), /Applications|osascript/, 'no path or command in an audit line');
  }
  // It ends on SIGTERM: no SIGKILL.
  const term = appStopSetup({ killer: fakeKillApp({ exitOn: 'SIGTERM' }) });
  t.after(term.cleanup);
  assert.deepEqual(await term.ctl.stop({ id: 'claude-desktop', ...APP_PID }), { state: 'stopped' });
  assert.deepEqual(term.killer.sent(), ['SIGTERM']);
  // It ends on SIGKILL.
  const killed = appStopSetup({ killer: fakeKillApp({ exitOn: 'SIGKILL' }) });
  t.after(killed.cleanup);
  assert.deepEqual(await killed.ctl.stop({ id: 'claude-desktop', ...APP_PID }), { state: 'stopped' });
  assert.deepEqual(killed.killer.sent(), ['SIGTERM', 'SIGKILL']);
});

test('app stop: a changed pid or start time, a gone process or an unreadable table before a signal sends nothing', async (t) => {
  const cases = [
    ['another pid before SIGTERM', [appItem(), appItem({ pid: APP_PID.pid + 1 })], [], { state: 'stopped' }],
    ['another start before SIGTERM', [appItem(), appItem({ startTime: APP_PID.startTime + 60000 })], [], { state: 'stopped' }],
    ['gone before SIGTERM', [appItem(), appItem({ running: false, pid: null, startTime: null })], [], { state: 'stopped' }],
    ['no row before SIGTERM', [appItem(), null], [], { state: 'stopped' }],
    ['table unreadable before SIGTERM', [appItem(), appItem({ tableError: 'the process table could not be read' })], [], { state: 'stopping', note: 'still shutting down' }],
    ['read throws before SIGTERM', [appItem(), new Error('ps failed')], [], { state: 'stopping', note: 'still shutting down' }],
    ['another pid before SIGKILL', [appItem(), appItem(), appItem({ pid: APP_PID.pid + 1 })], ['SIGTERM'], { state: 'stopped' }],
    ['another start before SIGKILL', [appItem(), appItem(), appItem({ startTime: APP_PID.startTime - 60000 })], ['SIGTERM'], { state: 'stopped' }],
    ['table unreadable before SIGKILL', [appItem(), appItem(), appItem({ tableError: 'x' })], ['SIGTERM'], { state: 'stopping', note: 'still shutting down' }],
  ];
  for (const [name, reads, sent, answer] of cases) {
    const s = appStopSetup({ reads, killer: fakeKillApp() });
    t.after(s.cleanup);
    assert.deepEqual(await s.ctl.stop({ id: 'claude-desktop', ...APP_PID }), answer, name);
    assert.deepEqual(s.killer.sent(), sent, name);
  }
});

test('app stop: the usual refusals hold (pid and start time, already stopped, busy, control off)', async (t) => {
  const s = appStopSetup({ killer: fakeKillApp() });
  t.after(s.cleanup);
  await rejects(s.ctl.stop({ id: 'claude-desktop', pid: APP_PID.pid }), 400);
  await rejects(s.ctl.stop({ id: 'claude-desktop', pid: APP_PID.pid + 1, startTime: APP_PID.startTime }), 409, /process changed/);
  const idle = appStopSetup({ reads: [appItem({ running: false, healthy: false, pid: null, startTime: null, how: null })] });
  t.after(idle.cleanup);
  await rejects(idle.ctl.stop({ id: 'claude-desktop', ...APP_PID }), 409, /already stopped/);
  const off = appStopSetup({ extra: { serverMode: true } });
  t.after(off.cleanup);
  await rejects(off.ctl.stop({ id: 'claude-desktop', ...APP_PID }), 403, /off on this server/);
  for (const x of [s, idle, off]) {
    assert.deepEqual(x.ran, []);
    assert.deepEqual(x.killer.sent(), []);
    assert.ok(x.audit.lines.every((l) => l.ok === false));
  }
  const busy = appStopSetup({ killer: fakeKillApp() });
  t.after(busy.cleanup);
  const first = busy.ctl.stop({ id: 'claude-desktop', ...APP_PID });
  await rejects(busy.ctl.stop({ id: 'claude-desktop', ...APP_PID }), 409, /a stop is still in progress/);
  await first;
});

test('app stop: a quit command that fails is audited, and the stop goes on to SIGTERM', async (t) => {
  const s = appStopSetup({ killer: fakeKillApp({ exitOn: 'SIGTERM' }), runCode: 1 });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.stop({ id: 'claude-desktop', ...APP_PID }), { state: 'stopped' });
  assert.deepEqual(s.killer.sent(), ['SIGTERM']);
  assert.deepEqual(
    s.audit.lines.map((l) => [l.ok, l.method, l.signal || null, l.error || null]),
    [
      [false, 'app', null, 'the quit command failed'],
      [true, 'signal', 'SIGTERM', null],
    ],
  );
});

test('a model server never gets SIGKILL: not by signals, not when it runs inside its app', async (t) => {
  // Ollama run from a shell that never exits: SIGINT, SIGTERM, then it is left alone, with the app waits short.
  const shell = stopSetup({ extra: APP_WAITS });
  t.after(shell.cleanup);
  assert.deepEqual(await shell.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopping', note: 'still shutting down' });
  assert.deepEqual(shell.killer.sent(), ['SIGINT', 'SIGTERM']);
  // Ollama inside Ollama.app that never quits: the quit command only, no signal at all.
  const inApp = stopSetup({ x: item({ how: 'app', appBundle: 'Ollama.app' }), extra: APP_WAITS });
  t.after(inApp.cleanup);
  assert.deepEqual(await inApp.ctl.stop({ id: 'ollama', ...SRV }), { state: 'stopping', note: 'still shutting down' });
  assert.deepEqual(inApp.ran, [['/usr/bin/osascript', '-e', 'quit app "Ollama"']]);
  assert.deepEqual(inApp.killer.sent(), []);
  for (const s of [shell, inApp]) assert.ok(!s.killer.calls.some(([, sig]) => sig === 'SIGKILL'));
});

test('app start: opens the app, waits for the main process (no health URL), answers running or opening', async (t) => {
  const closed = appItem({ running: false, healthy: false, pid: null, startTime: null, how: null, appBundle: null });
  const probes = [];
  const probe = async (u) => (probes.push(u), true);
  const mac = { ...APP_WAITS, platform: 'darwin' };
  const up = startSetup({ items: [closed, closed, closed, appItem()], probe, extra: mac });
  t.after(up.cleanup);
  assert.deepEqual(await up.ctl.start('claude-desktop'), { state: 'running' });
  const never = startSetup({ items: [closed], probe, extra: mac });
  t.after(never.cleanup);
  assert.deepEqual(await never.ctl.start('claude-desktop'), { state: 'starting', note: 'opening, not up yet' });
  assert.deepEqual(probes, [], 'no health URL is asked');
  assert.deepEqual(
    up.audit.lines.map((l) => [l.action, l.ok, l.id]),
    [['start', true, 'claude-desktop']],
  );
  assert.doesNotMatch(JSON.stringify(up.audit.lines), /Applications/);
  // Already open: refused.
  const open = startSetup({ items: [appItem()], extra: mac });
  t.after(open.cleanup);
  await rejects(open.ctl.start('claude-desktop'), 409, /already running/);
});

test('apps off macOS: listed with "macOS only", no Start or Stop, and both refused without running anything', async (t) => {
  const absent = appItem({ installed: false, running: false, healthy: false, pid: null, startTime: null, how: null, app: null, appBundle: null, startArgv: null });
  const s = appStopSetup({ reads: [absent], platform: 'linux', killer: fakeKillApp() });
  t.after(s.cleanup);
  const [row] = await s.ctl.list();
  assert.equal(row.id, 'claude-desktop');
  assert.equal(row.kind, 'app');
  assert.equal(row.canStart, false);
  assert.equal(row.canStop, false);
  assert.equal(row.reason, 'macOS only');
  await rejects(s.ctl.start('claude-desktop'), 409, /^macOS only$/);
  await rejects(s.ctl.stop({ id: 'claude-desktop', ...APP_PID }), 409, /^macOS only$/);
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.killer.sent(), []);
  assert.deepEqual(s.audit.lines.map((l) => [l.action, l.ok, l.status, l.error]), [
    ['start', false, 409, 'macOS only'],
    ['stop', false, 409, 'macOS only'],
  ]);
  // On macOS an app that is not installed is not listed, like a model server.
  const mac = appStopSetup({ reads: [absent] });
  t.after(mac.cleanup);
  assert.deepEqual(await mac.ctl.list(), []);
});

test('list rows carry kind: app for the desktop apps, server for the model servers', async (t) => {
  const s = appStopSetup();
  t.after(s.cleanup);
  const [row] = await s.ctl.list();
  assert.equal(row.kind, 'app');
  assert.equal(row.canStop, true);
  assert.equal(row.reason, null);
  assert.equal(row.models, null, 'no model memory for an app');
  assert.doesNotMatch(JSON.stringify(row), /Applications|Claude\.app/, 'no path, no bundle');
  const m = stopSetup();
  t.after(m.cleanup);
  assert.equal((await m.ctl.list())[0].kind, 'server');
});

test('app stop: a signal that is not permitted is audited and answers stopping, with no SIGKILL after it', async (t) => {
  const calls = [];
  const killer = {
    calls,
    gone: new Set(),
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === 'SIGTERM') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return true;
    },
    sent: () => calls.filter(([, s]) => s !== 0).map(([, s]) => s),
  };
  const s = appStopSetup({ killer });
  t.after(s.cleanup);
  assert.deepEqual(await s.ctl.stop({ id: 'claude-desktop', ...APP_PID }), { state: 'stopping', note: 'still shutting down' });
  assert.deepEqual(killer.sent(), ['SIGTERM'], 'tried once, nothing after');
  assert.deepEqual(
    s.audit.lines.map((l) => [l.ok, l.method, l.signal || null, l.status || null]),
    [
      [true, 'app', null, null],
      [false, 'signal', 'SIGTERM', 403],
    ],
  );
});
