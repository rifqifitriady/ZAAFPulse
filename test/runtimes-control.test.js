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
const { createRuntimeControl } = require('../lib/runtimes/control');

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
    platform: 'linux',
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
      try {
        process.kill(c.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { ctl, state, started, approvals, audit, spawned, dataDir, port, config, cleanup };
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
  const [row] = await s.ctl.list();
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

test('refusals: unknown, unapproved, server mode, Docker, not installed; each is audited', async (t) => {
  const s = await realSetup({ approve: false });
  t.after(s.cleanup);
  await rejects(s.ctl.start('nope'), 404, /unknown runtime/);
  await rejects(s.ctl.start('fake-rt'), 403, /approve it in Settings first/);
  const [row] = await s.ctl.list();
  assert.equal(row.approved, false);
  assert.equal(row.canStart, false);
  assert.equal(row.reason, 'approve it in Settings first');
  // Approving stores a hash of the command; a changed command asks again.
  assert.deepEqual(await s.ctl.approve('fake-rt'), { approved: true });
  assert.equal(s.approvals.read()['fake-rt'], commandHash(s.config[0]));
  assert.equal((await s.ctl.list())[0].canStart, true);
  s.config[0].command = [...s.config[0].command, '--verbose'];
  assert.equal((await s.ctl.list())[0].approved, false);
  await rejects(s.ctl.approve('ollama'), 400, /preset/);
  await rejects(s.ctl.approve('nope'), 404);
  s.ctl.forget('fake-rt');
  assert.deepEqual(s.approvals.read(), {});
  const server = await realSetup({ extra: { serverMode: true } });
  t.after(server.cleanup);
  await rejects(server.ctl.start('fake-rt'), 403, /off on this server/);
  await rejects(server.ctl.stop({ id: 'fake-rt', pid: 4242, startTime: 1 }), 403, /off on this server/);
  await rejects(server.ctl.approve('fake-rt'), 403);
  const off = (await server.ctl.list())[0];
  assert.equal(off.canStart, false);
  assert.equal(off.reason, 'runtime control is off on this server');
  const docker = await realSetup({ extra: { inDocker: true } });
  t.after(docker.cleanup);
  await rejects(docker.ctl.start('fake-rt'), 403, /off in Docker/);
  const missing = await realSetup();
  t.after(missing.cleanup);
  missing.config[0].command = [path.join(os.tmpdir(), 'zp-no-such-runtime'), '--port', String(missing.port)];
  missing.approvals.write({ 'fake-rt': commandHash(missing.config[0]) });
  await rejects(missing.ctl.start('fake-rt'), 409, /not installed/);
  for (const a of [s, server, docker, missing])
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
function stopSetup({ x = item(), killer = fakeKill(), platform = 'darwin', probe = async () => false, runCode = 0 } = {}) {
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
  assert.deepEqual(winOk.ran, [['taskkill', '/PID', String(SRV.pid)]], 'no /F');
  const winBad = stopSetup({ platform: 'win32', runCode: 128 });
  t.after(winBad.cleanup);
  await rejects(winBad.ctl.stop({ id: 'ollama', ...SRV }), 502, /taskkill/);
  for (const s of [lms, app, svc, winOk]) assert.deepEqual(s.killer.sent(), [], 'no signal when a command stops it');
});
