const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: realSpawn, spawnSync } = require('child_process');
const { createAgentControl, detectDocker } = require('../lib/agents/control');

const POSIX = process.platform !== 'win32';
const CLAUDE_ARGS = '/home/u/.local/bin/claude --resume';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const startOf = (upSec) => Math.round((Date.now() - upSec * 1000) / 1000) * 1000;
const row = (pid, args, extra = {}) => ({ pid, cpu: 1, rssKB: 1024, upSec: 600, args, ...extra });

// A kill that records every call and never signals anything. `gone` pids throw ESRCH, `denied` ones EPERM; a pid
// that gets the `exitOn` signal is gone from then on.
function fakeKill({ gone = new Set(), denied = new Set(), exitOn = null } = {}) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    const code = gone.has(pid) ? 'ESRCH' : denied.has(pid) ? 'EPERM' : null;
    if (code) throw Object.assign(new Error(code), { code });
    if (signal === exitOn) gone.add(pid);
    return true;
  };
  return { calls, kill, gone, sent: () => calls.filter(([, s]) => s !== 0) };
}
const recorder = () => {
  const entries = [];
  return { entries, record: (e) => entries.push(e) };
};
const fakeTable = (list) => ({ rows: async () => (typeof list === 'function' ? list() : list) });
const control = (opts = {}) => {
  const audit = recorder();
  const k = opts.killer || fakeKill();
  // POSIX unless a test says otherwise, so the same checks run on the Windows CI too (nothing here signals for real).
  const ctl = createAgentControl({
    platform: 'linux',
    inDocker: false,
    graceMs: 50,
    pollMs: 5,
    audit,
    kill: k.kill,
    ...opts,
  });
  return { ctl, audit, k };
};
const rejects = (p, status) => assert.rejects(p, (e) => e.status === status && typeof e.message === 'string');

test('pause, resume and stop a verified agent with SIGSTOP, SIGCONT and SIGINT; the audit has each action', async () => {
  const k = fakeKill({ exitOn: 'SIGINT' });
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  const meta = { sessionId: 's1', by: 'owner' };
  const paused = await ctl.pause(target, meta);
  assert.deepEqual(paused, { ok: true, action: 'pause', pid: 4242, startTime: target.startTime, app: 'claude' });
  assert.deepEqual(
    (await ctl.paused()).map((p) => [p.pid, p.app, p.sessionId, p.by]),
    [[4242, 'claude', 's1', 'owner']],
  );
  await ctl.resume(target, meta);
  assert.deepEqual(await ctl.paused(), []);
  const stopped = await ctl.stop(target, meta);
  assert.equal(stopped.signal, 'SIGINT');
  assert.equal(stopped.exited, true);
  assert.deepEqual(k.sent(), [
    [4242, 'SIGSTOP'],
    [4242, 'SIGCONT'],
    [4242, 'SIGINT'],
  ]);
  assert.deepEqual(
    audit.entries.map((e) => [e.action, e.signal, e.ok]),
    [
      ['pause', 'SIGSTOP', true],
      ['resume', 'SIGCONT', true],
      ['stop', 'SIGINT', true],
    ],
  );
  const e = audit.entries[0];
  assert.deepEqual(Object.keys(e).sort(), [
    'action',
    'app',
    'by',
    'ok',
    'pid',
    'sessionId',
    'signal',
    'startTime',
    'ts',
  ]);
  assert.equal(e.sessionId, 's1');
  assert.equal(e.by, 'owner');
  assert.ok(Math.abs(e.ts - Date.now()) < 5000);
});

test('a process still alive after the grace period gets SIGTERM, never SIGKILL', async () => {
  const k = fakeKill();
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const out = await ctl.stop({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.equal(out.signal, 'SIGTERM');
  assert.deepEqual(k.sent(), [
    [4242, 'SIGINT'],
    [4242, 'SIGTERM'],
  ]);
  assert.ok(!k.calls.some(([, s]) => s === 'SIGKILL'));
  assert.deepEqual(
    audit.entries.map((e) => e.signal),
    ['SIGINT', 'SIGTERM'],
  );
});

test('no SIGTERM when the pid was reused by another process during the grace period', async () => {
  let up = 600;
  const k = fakeKill();
  const { ctl } = control({ processes: fakeTable(() => [row(4242, CLAUDE_ARGS, { upSec: up })]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  const p = ctl.stop(target, { by: 'owner' });
  up = 0; // the old process ended and a new one took its pid
  const out = await p;
  assert.equal(out.signal, 'SIGINT');
  assert.deepEqual(k.sent(), [[4242, 'SIGINT']]);
});

test('stopping a paused agent continues it so the pending SIGINT is handled', async () => {
  const k = fakeKill({ exitOn: 'SIGINT' });
  const { ctl } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  await ctl.pause(target, { by: 'owner' });
  await ctl.stop(target, { by: 'owner' });
  assert.deepEqual(k.sent(), [
    [4242, 'SIGSTOP'],
    [4242, 'SIGINT'],
    [4242, 'SIGCONT'],
  ]);
});

test('refusals: gone, wrong start time, not an agent, ZAAFPulse itself, bad target; each one audited', async () => {
  const rows = [
    row(4242, CLAUDE_ARGS),
    row(77, '/usr/bin/vim notes.txt'),
    row(78, 'node /home/u/ai-command-center/server.js claude'),
    row(process.pid, 'node claude-code'),
  ];
  const k = fakeKill();
  const { ctl, audit } = control({ processes: fakeTable(rows), killer: k });
  const meta = { sessionId: 's1', by: 'owner' };
  await rejects(ctl.pause({ pid: 4243, startTime: startOf(600) }, meta), 409);
  await rejects(ctl.pause({ pid: 4242, startTime: startOf(600) - 60e3 }, meta), 409);
  await rejects(ctl.stop({ pid: 4242, startTime: startOf(600) + 5000 }, meta), 409);
  await rejects(ctl.pause({ pid: 77, startTime: startOf(600) }, meta), 403);
  await rejects(ctl.stop({ pid: 78, startTime: startOf(600) }, meta), 403);
  await rejects(ctl.stop({ pid: process.pid, startTime: startOf(600) }, meta), 403);
  for (const bad of [null, {}, { pid: 0, startTime: 1 }, { pid: -1, startTime: 1 }, { pid: 1, startTime: 1 }])
    await rejects(ctl.stop(bad, meta), 400);
  await rejects(ctl.pause({ pid: '4242', startTime: startOf(600) }, meta), 400);
  assert.deepEqual(k.sent(), []);
  assert.equal(audit.entries.length, 12);
  assert.ok(audit.entries.every((e) => e.ok === false && e.status >= 400 && e.error && e.by === 'owner'));
  assert.deepEqual(
    audit.entries.slice(0, 6).map((e) => [e.action, e.status]),
    [
      ['pause', 409],
      ['pause', 409],
      ['stop', 409],
      ['pause', 403],
      ['stop', 403],
      ['stop', 403],
    ],
  );
});

test('a signal that fails is a refusal: ESRCH is 409, EPERM is 403', async () => {
  const k = fakeKill({ gone: new Set([4242]), denied: new Set([4243]) });
  const rows = [row(4242, CLAUDE_ARGS), row(4243, CLAUDE_ARGS)];
  const { ctl, audit } = control({ processes: fakeTable(rows), killer: k });
  await rejects(ctl.pause({ pid: 4242, startTime: startOf(600) }, { by: 'owner' }), 409);
  await rejects(ctl.pause({ pid: 4243, startTime: startOf(600) }, { by: 'owner' }), 403);
  assert.deepEqual(await ctl.paused(), []);
  assert.deepEqual(
    audit.entries.map((e) => [e.ok, e.status, e.signal]),
    [
      [false, 409, 'SIGSTOP'],
      [false, 403, 'SIGSTOP'],
    ],
  );
});

test('server mode and Docker refuse every action and list no candidates', async () => {
  const rows = [row(4242, CLAUDE_ARGS, { cwd: os.tmpdir() })];
  const target = { pid: 4242, startTime: startOf(600) };
  for (const opts of [{ serverMode: true }, { inDocker: true }, { inDocker: () => true }]) {
    const k = fakeKill();
    const { ctl, audit } = control({ processes: fakeTable(rows), killer: k, ...opts });
    await rejects(ctl.pause(target, { by: 'owner' }), 403);
    await rejects(ctl.resume(target, { by: 'owner' }), 403);
    await rejects(ctl.stop(target, { by: 'owner' }), 403);
    assert.deepEqual(await ctl.candidates({ cwd: os.tmpdir(), firstTs: Date.now() }), []);
    assert.deepEqual(k.sent(), []);
    assert.equal(audit.entries.length, 3);
  }
});

test('Docker is detected from /.dockerenv or the init cgroups', () => {
  const fsLike = (files) => ({
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
  });
  assert.equal(detectDocker(fsLike({ '/.dockerenv': '' })), true);
  assert.equal(detectDocker(fsLike({ '/proc/1/cgroup': '0::/system.slice/containerd.service\n' })), true);
  assert.equal(detectDocker(fsLike({ '/proc/1/cgroup': '12:pids:/docker/abc\n' })), true);
  assert.equal(detectDocker(fsLike({ '/proc/1/cgroup': '0::/init.scope\n' })), false);
  assert.equal(detectDocker(fsLike({})), false);
});

test('a rule may only pause, and only for the rules that allow it', async () => {
  const k = fakeKill();
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  await rejects(ctl.pause(target, { sessionId: 's1', rule: 'accuracy_drop', by: 'rule' }), 403);
  await rejects(ctl.resume(target, { sessionId: 's1', rule: 'tool_loop', by: 'rule' }), 403);
  await rejects(ctl.stop(target, { sessionId: 's1', rule: 'tool_loop', by: 'rule' }), 403);
  assert.deepEqual(k.sent(), []);
  for (const rule of ['cost_burn', 'tool_loop', 'daily_cost'])
    await ctl.pause(target, { sessionId: 's1', rule, by: 'rule' });
  assert.equal(k.sent().length, 3);
  const last = audit.entries.at(-1);
  assert.deepEqual([last.action, last.rule, last.by, last.ok], ['pause', 'daily_cost', 'rule', true]);
  assert.equal((await ctl.paused())[0].by, 'rule');
});

test('Windows: no pause or resume (501); stop is taskkill /PID n without /F', async () => {
  const spawns = [];
  let exitCode = 0;
  const spawn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', exitCode));
    return child;
  };
  const win = row(4242, '"C:\\Users\\u\\.local\\bin\\claude.exe" --continue');
  const k = fakeKill();
  const { ctl, audit } = control({ processes: fakeTable([win]), killer: k, platform: 'win32', spawn });
  const target = { pid: 4242, startTime: startOf(600) };
  await rejects(ctl.pause(target, { by: 'owner' }), 501);
  await rejects(ctl.resume(target, { by: 'owner' }), 501);
  const out = await ctl.stop(target, { sessionId: 's1', by: 'owner' });
  assert.deepEqual([out.ok, out.action, out.pid, out.app, out.signal], [true, 'stop', 4242, 'claude', 'taskkill']);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, 'taskkill');
  assert.deepEqual(spawns[0].args, ['/PID', '4242']);
  assert.ok(!spawns[0].args.some((a) => /^\/F$/i.test(a)));
  assert.ok(!spawns[0].opts || !spawns[0].opts.shell);
  assert.deepEqual(k.sent(), []);
  exitCode = 128; // the app declined to close
  await rejects(ctl.stop(target, { by: 'owner' }), 502);
  assert.deepEqual(
    audit.entries.map((e) => [e.action, e.ok, e.status || null]),
    [
      ['pause', false, 501],
      ['resume', false, 501],
      ['stop', true, null],
      ['stop', false, 502],
    ],
  );
});

test('candidates: one, many or none, by real working folder and a start before the first line', async (t) => {
  const work = tmp('zp-agent-work-');
  const other = tmp('zp-agent-other-');
  let link = work;
  if (POSIX) {
    link = path.join(tmp('zp-agent-link-'), 'w');
    fs.symlinkSync(work, link, 'dir');
  }
  const first = Date.now() - 60e3; // the session's first line, a minute ago
  const rows = [
    row(10, CLAUDE_ARGS, { cwd: work, upSec: 600 }),
    row(11, '/usr/bin/codex exec', { cwd: link, upSec: 300 }),
    row(12, CLAUDE_ARGS, { cwd: work, upSec: 10 }), // started after the first line
    row(13, '/usr/bin/vim x', { cwd: work, upSec: 600 }), // not an agent
    row(14, CLAUDE_ARGS, { cwd: other, upSec: 600 }), // another folder
    row(15, CLAUDE_ARGS, { upSec: 600 }), // cwd unknown
    row(16, CLAUDE_ARGS, { cwd: work, upSec: 600 }), // ended since the table was read
  ];
  const k = fakeKill({ gone: new Set([16]) });
  const { ctl } = control({ processes: fakeTable(rows), killer: k });
  const many = await ctl.candidates({ cwd: work, firstTs: first });
  assert.deepEqual(
    many.map((c) => [c.pid, c.app]),
    [
      [10, 'claude'],
      [11, 'codex'],
    ],
  );
  assert.deepEqual(Object.keys(many[0]).sort(), ['app', 'command', 'cwd', 'pid', 'startTime']);
  assert.equal(many[0].command, CLAUDE_ARGS);
  assert.ok(Math.abs(many[0].startTime - (Date.now() - 600e3)) <= 2000);
  const one = await ctl.candidates({ cwd: other, firstTs: new Date(first).toISOString() });
  assert.deepEqual(
    one.map((c) => c.pid),
    [14],
  );
  assert.deepEqual(await ctl.candidates({ cwd: tmp('zp-agent-none-'), firstTs: first }), []);
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: 'not a date' }), []);
  assert.deepEqual(await ctl.candidates({}), []);
  assert.deepEqual(k.sent(), []);
  t.after(() => {
    for (const d of [work, other]) fs.rmSync(d, { recursive: true, force: true });
  });
});

test('paused(): after a restart, agents the OS reports as stopped are listed again; gone ones are dropped', async () => {
  let rows = [
    row(4242, CLAUDE_ARGS, { stopped: true }),
    row(4243, CLAUDE_ARGS),
    row(55, '/bin/sleep 9', { stopped: true }),
  ];
  const { ctl } = control({ processes: fakeTable(() => rows) });
  assert.deepEqual(
    (await ctl.paused()).map((p) => [p.pid, p.app, p.by]),
    [[4242, 'claude', null]],
  );
  await ctl.pause({ pid: 4243, startTime: startOf(600) }, { sessionId: 's2', by: 'owner' });
  rows = [row(4242, CLAUDE_ARGS, { stopped: true }), row(4243, CLAUDE_ARGS, { stopped: true })];
  assert.deepEqual((await ctl.paused()).map((p) => [p.pid, p.sessionId]).sort(), [
    [4242, null],
    [4243, 's2'],
  ]);
  rows = [row(4242, CLAUDE_ARGS, { stopped: false })]; // 4243 ended, 4242 continued from elsewhere
  assert.deepEqual(await ctl.paused(), []);
});

test('the default audit log is agent-audit.jsonl in the data folder, mode 0600', async () => {
  const dir = tmp('zp-agent-audit-');
  const ctl = createAgentControl({
    processes: fakeTable([row(4242, CLAUDE_ARGS)]),
    kill: fakeKill().kill,
    platform: 'linux',
    inDocker: false,
    dataDir: dir,
  });
  await rejects(ctl.pause({ pid: 4242, startTime: startOf(600) - 60e3 }, { sessionId: 's1', by: 'owner' }), 409);
  const file = path.join(dir, 'agent-audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    lines.map((e) => [e.action, e.pid, e.status, e.sessionId]),
    [['pause', 4242, 409, 's1']],
  );
  if (POSIX) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Real signals, only ever to children this test spawned. The process table is faked to show the child with a Claude
// Code command line, so nothing else on the machine can match.
const sleepers = [];
function sleeper(code = 'setInterval(() => {}, 1000)') {
  const child = realSpawn(process.execPath, ['-e', `${code}; console.log('ready')`], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  sleepers.push(child);
  const born = Date.now();
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve) => child.stdout.once('data', resolve));
  const rows = async () =>
    child.exitCode === null && child.signalCode === null
      ? [row(child.pid, CLAUDE_ARGS, { upSec: Math.round((Date.now() - born) / 1000) })]
      : [];
  return { child, born, exited, ready, processes: { rows } };
}
const stat = (pid) => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}
test.after(() => {
  for (const c of sleepers) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); // test teardown only
});

test('real child: pause stops it, resume continues it, stop ends it with SIGINT', { skip: !POSIX }, async () => {
  const s = sleeper();
  await s.ready;
  const audit = recorder();
  const ctl = createAgentControl({ processes: s.processes, audit, inDocker: false, graceMs: 3000 });
  const target = { pid: s.child.pid, startTime: Math.round(s.born / 1000) * 1000 };
  await ctl.pause(target, { sessionId: 's1', by: 'owner' });
  assert.ok(await waitFor(() => stat(s.child.pid).includes('T')), `stat after pause: ${stat(s.child.pid)}`);
  await ctl.resume(target, { sessionId: 's1', by: 'owner' });
  assert.ok(await waitFor(() => !stat(s.child.pid).includes('T')), `stat after resume: ${stat(s.child.pid)}`);
  const out = await ctl.stop(target, { sessionId: 's1', by: 'owner' });
  assert.deepEqual(await s.exited, { code: null, signal: 'SIGINT' });
  assert.deepEqual([out.signal, out.exited], ['SIGINT', true]);
  assert.deepEqual(
    audit.entries.map((e) => e.signal),
    ['SIGSTOP', 'SIGCONT', 'SIGINT'],
  );
});

test('real child: a paused child still ends on stop', { skip: !POSIX }, async () => {
  const s = sleeper();
  await s.ready;
  const ctl = createAgentControl({ processes: s.processes, audit: recorder(), inDocker: false, graceMs: 3000 });
  const target = { pid: s.child.pid, startTime: Math.round(s.born / 1000) * 1000 };
  await ctl.pause(target, { by: 'owner' });
  assert.ok(await waitFor(() => stat(s.child.pid).includes('T')));
  await ctl.stop(target, { by: 'owner' });
  assert.equal((await s.exited).signal, 'SIGINT');
});

test('real child: a child that ignores SIGINT gets SIGTERM after the grace period', { skip: !POSIX }, async () => {
  const s = sleeper("process.on('SIGINT', () => {}); setInterval(() => {}, 1000)");
  await s.ready;
  const audit = recorder();
  const ctl = createAgentControl({ processes: s.processes, audit, inDocker: false, graceMs: 300 });
  const out = await ctl.stop({ pid: s.child.pid, startTime: Math.round(s.born / 1000) * 1000 }, { by: 'owner' });
  assert.equal(out.signal, 'SIGTERM');
  assert.deepEqual(await s.exited, { code: null, signal: 'SIGTERM' });
  assert.deepEqual(
    audit.entries.map((e) => e.signal),
    ['SIGINT', 'SIGTERM'],
  );
});
