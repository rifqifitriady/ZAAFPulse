const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: realSpawn, spawnSync } = require('child_process');
const { createAgentControl, detectDocker, isAgentBinary, sameProcess } = require('../lib/agents/control');

const POSIX = process.platform !== 'win32';
const CLAUDE_ARGS = '/home/u/.local/bin/claude --resume';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const startOf = (upSec) => Math.round((Date.now() - upSec * 1000) / 1000) * 1000;
// A process row as lib/processes gives it; argv as /proc gives it (these test paths have no spaces unless `extra`
// brings an argv of its own).
const row = (pid, args, extra = {}) => ({
  pid,
  cpu: 1,
  rssKB: 1024,
  upSec: 600,
  args,
  argv: args.split(' '),
  ...extra,
});
// The Claude desktop app's Claude Code and its launcher, as ps shows them on macOS ("Application Support" has a space).
const DESKTOP_CLAUDE =
  '/Users/u/Library/Application Support/Claude/claude-code/2.1.308/a93ded4b1b47/claude.app/Contents/MacOS/claude';
const DESKTOP_FLAGS = ['--output-format', 'stream-json', '--verbose'];
const DISCLAIMER = '/Applications/Claude.app/Contents/Helpers/disclaimer';
const CODEX_FW = '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/154.0/Helpers';
const CODEX_HELPERS = [
  [`${CODEX_FW}/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)`, '--type=renderer'],
  [`${CODEX_FW}/Codex (Service).app/Contents/MacOS/Codex (Service)`, '--type=gpu-process'],
  [`${CODEX_FW}/browser_crashpad_handler`, '--monitor-self'],
  ['/Users/u/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'],
];

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
  // The first read (the check before SIGINT) shows the old process; every later read shows a new one on its pid.
  let reads = 0;
  const k = fakeKill();
  const { ctl } = control({
    processes: fakeTable(() => [row(4242, CLAUDE_ARGS, { upSec: reads++ === 0 ? 600 : 0 })]),
    killer: k,
  });
  const out = await ctl.stop({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.ok(reads >= 2);
  assert.equal(out.signal, 'SIGINT');
  assert.equal(out.exited, true);
  assert.deepEqual(k.sent(), [[4242, 'SIGINT']]);
});

test('stop does not hang on a fixed clock: the grace wait runs on the injected sleep, then SIGTERM', async () => {
  const fixed = Date.now();
  const slept = [];
  const k = fakeKill();
  const { ctl } = control({
    processes: fakeTable([row(4242, CLAUDE_ARGS)]),
    killer: k,
    now: () => fixed,
    graceMs: 50,
    pollMs: 20,
    sleep: (ms) => (slept.push(ms), Promise.resolve()),
  });
  const out = await ctl.stop({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.equal(out.signal, 'SIGTERM');
  assert.deepEqual(slept, [20, 20, 10]);
  assert.deepEqual(k.sent(), [
    [4242, 'SIGINT'],
    [4242, 'SIGTERM'],
  ]);
});

test('ESRCH on SIGTERM means the process ended meanwhile: the stop succeeds with exited true', async () => {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (signal === 'SIGTERM') throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    return true;
  };
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), kill });
  const out = await ctl.stop({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.deepEqual([out.ok, out.signal, out.exited], [true, 'SIGINT', true]);
  assert.deepEqual(
    calls.filter(([, s]) => s !== 0),
    [
      [4242, 'SIGINT'],
      [4242, 'SIGTERM'],
    ],
  );
  const last = audit.entries.at(-1);
  assert.deepEqual([last.signal, last.ok], ['SIGTERM', false]);
});

test('if the process table cannot be read after the grace period, exited is null and no SIGTERM is sent', async () => {
  let reads = 0;
  const k = fakeKill();
  const processes = {
    rows: async () => {
      if (reads++ > 0) throw new Error('ps failed');
      return [row(4242, CLAUDE_ARGS)];
    },
  };
  const { ctl } = control({ processes, killer: k });
  const out = await ctl.stop({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.deepEqual([out.ok, out.signal, out.exited], [true, 'SIGINT', null]);
  assert.deepEqual(k.sent(), [[4242, 'SIGINT']]);
});

test('409 and no signal when the process table cannot be read before a signal', async () => {
  const k = fakeKill();
  const processes = {
    rows: async () => {
      throw new Error('ps failed');
    },
  };
  const { ctl, audit } = control({ processes, killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  for (const action of ['pause', 'resume', 'stop']) await rejects(ctl[action](target, { by: 'owner' }), 409);
  assert.deepEqual(k.calls, []);
  assert.deepEqual(
    audit.entries.map((e) => [e.action, e.ok, e.status]),
    [
      ['pause', false, 409],
      ['resume', false, 409],
      ['stop', false, 409],
    ],
  );
});

test('by must be exactly owner or rule: anything else is a 400 with no signal; the audit never says owner by default', async () => {
  const k = fakeKill();
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  const bads = [{ by: 'Rule' }, { by: 'admin' }, { by: '' }, { by: 7 }, {}, { sessionId: 's1' }];
  for (const meta of bads) {
    await rejects(ctl.pause(target, meta), 400);
    await rejects(ctl.resume(target, meta), 400);
    await rejects(ctl.stop(target, meta), 400);
  }
  await rejects(ctl.pause(target, null), 400);
  await rejects(ctl.pause(target), 400);
  assert.deepEqual(k.calls, []);
  assert.ok(audit.entries.every((e) => e.ok === false && e.status === 400));
  // Text is kept as given (short); a non-text or missing value is null. Never 'owner' by default.
  assert.deepEqual(
    bads.map((_, i) => audit.entries[i * 3].by),
    ['Rule', 'admin', '', null, null, null],
  );
  assert.deepEqual(await ctl.paused(), []);
});

test('stopping a paused agent continues it so the pending SIGINT is handled', async () => {
  const k = fakeKill({ exitOn: 'SIGCONT' });
  const { ctl, audit } = control({ processes: fakeTable([row(4242, CLAUDE_ARGS)]), killer: k });
  const target = { pid: 4242, startTime: startOf(600) };
  await ctl.pause(target, { by: 'owner' });
  await ctl.stop(target, { by: 'owner' });
  assert.deepEqual(k.sent(), [
    [4242, 'SIGSTOP'],
    [4242, 'SIGINT'],
    [4242, 'SIGCONT'],
  ]);
  // The SIGCONT is audited too, as a resume noted as part of the stop, in the usual audit shape.
  const cont = audit.entries.find((e) => e.signal === 'SIGCONT');
  assert.deepEqual([cont.action, cont.ok, cont.by, cont.pid, cont.app], ['resume', true, 'owner', 4242, 'claude']);
  assert.ok(cont.note);
  assert.deepEqual(
    audit.entries.map((e) => e.signal),
    ['SIGSTOP', 'SIGINT', 'SIGCONT'],
  );
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
    assert.deepEqual(await ctl.candidates({ cwd: os.tmpdir(), firstTs: Date.now(), source: 'claude' }), []);
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
    row(17, CLAUDE_ARGS, { cwd: work, upSec: 900 }),
  ];
  const k = fakeKill({ gone: new Set([16]) });
  const { ctl } = control({ processes: fakeTable(rows), killer: k });
  const many = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  assert.deepEqual(
    many.map((c) => [c.pid, c.app]),
    [
      [10, 'claude'],
      [17, 'claude'],
    ],
  );
  const codex = await ctl.candidates({ cwd: work, firstTs: first, source: 'codex' });
  assert.deepEqual(
    codex.map((c) => [c.pid, c.app]),
    [[11, 'codex']],
  );
  assert.deepEqual(Object.keys(many[0]).sort(), ['app', 'command', 'cwd', 'pid', 'startTime']);
  assert.equal(many[0].command, CLAUDE_ARGS);
  assert.ok(Math.abs(many[0].startTime - (Date.now() - 600e3)) <= 2000);
  const one = await ctl.candidates({ cwd: other, firstTs: new Date(first).toISOString(), source: 'claude' });
  assert.deepEqual(
    one.map((c) => c.pid),
    [14],
  );
  assert.deepEqual(await ctl.candidates({ cwd: tmp('zp-agent-none-'), firstTs: first, source: 'claude' }), []);
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: 'not a date', source: 'claude' }), []);
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: first }), [], 'no source, no candidate');
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: first, source: 'kiro' }), []);
  assert.deepEqual(await ctl.candidates({}), []);
  assert.deepEqual(k.sent(), []);
  t.after(() => {
    for (const d of [work, other]) fs.rmSync(d, { recursive: true, force: true });
  });
});

test('candidates: only the session app, run from its own binary, never a path that merely says codex', async (t) => {
  const work = tmp('zp-agent-own-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const first = Date.now() - 60e3;
  const rows = [
    row(20, 'node /home/u/code/codex-clone/node_modules/.bin/vite --port 5173', { cwd: work }), // a dev server
    row(21, 'tail -f /home/u/code/codex.log', { cwd: work }),
    row(22, '/usr/bin/vim /home/u/notes/codex', { cwd: work }),
    row(23, CLAUDE_ARGS, { cwd: work }),
  ];
  const { ctl, k } = control({ processes: fakeTable(rows) });
  // The stray processes count as Codex on the live page (lib/processes' broad pattern), but never as a candidate.
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: first, source: 'codex' }), []);
  // A Claude Code session gets its Claude Code process, and no Codex one.
  const claude = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  assert.deepEqual(
    claude.map((c) => [c.pid, c.app]),
    [[23, 'claude']],
  );
  rows.push(row(24, 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', { cwd: work }));
  const codex = await ctl.candidates({ cwd: work, firstTs: first, source: 'codex' });
  assert.deepEqual(
    codex.map((c) => [c.pid, c.app]),
    [[24, 'codex']],
  );
  assert.deepEqual(
    (await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' })).map((c) => c.pid),
    [23],
    'a Codex process is never a candidate of a Claude Code session',
  );
  assert.deepEqual(k.sent(), []);
});

test('isAgentBinary: the program or the script node runs, by its exact name, from argv', () => {
  const words = (x) => (typeof x === 'string' ? x.split(' ') : x);
  const yes = [
    ['claude', 'claude --resume'],
    ['claude', '/home/u/.local/bin/claude'],
    ['claude', '/x/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude --output-format stream-json'],
    ['claude', 'node /usr/local/bin/claude -c'],
    ['claude', 'node --no-warnings /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    ['claude', ['C:\\Users\\u\\.local\\bin\\claude.exe', '--resume']],
    ['claude', [DESKTOP_CLAUDE, ...DESKTOP_FLAGS]],
    ['codex', 'codex'],
    ['codex', ['/opt/homebrew/bin/codex', 'exec', 'fix it']],
    ['codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server'],
    ['codex', '/x/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex'],
    ['codex', '/opt/homebrew/Caskroom/codex/0.5.0/codex-aarch64-apple-darwin'],
    ['codex', 'node /x/node_modules/@openai/codex/bin/codex.js'],
  ];
  const no = [
    ['codex', 'node /home/u/code/codex-clone/node_modules/.bin/vite'],
    ['codex', 'tail -f codex.log'],
    ['codex', '/usr/bin/vim /home/u/codex'],
    ['codex', '/home/u/codex/bin/server --codex'],
    ['codex', 'node scripts/codex.js --watch'], // a codex.js that is not @openai/codex's
    ['codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex-code-mode-host'],
    ['codex', 'claude'],
    ['codex', '/Applications/ChatGPT.app/Contents/Frameworks/Codex'], // what splitting on spaces used to give
    ...CODEX_HELPERS.map((argv) => ['codex', argv]),
    ['claude', '/usr/local/bin/codex'],
    ['claude', 'node /home/u/code/claude-code-clone/server.js'],
    ['claude', '/usr/bin/vim /home/u/claude'],
    ['claude', '/Applications/Claude.app/Contents/MacOS/Claude'], // the desktop app itself
    ['claude', [DISCLAIMER, '--pgroup', '--', DESKTOP_CLAUDE, ...DESKTOP_FLAGS]], // a wrapper, not the agent
    ['claude', 'node'],
    ['kiro', 'kiro-cli'],
    ['claude', ''],
  ];
  for (const [source, x] of yes) assert.equal(isAgentBinary(source, words(x)), true, `${source}: ${x}`);
  for (const [source, x] of no) assert.equal(isAgentBinary(source, words(x)), false, `${source}: ${x}`);
  // Without an argv there is no program to judge: never a candidate.
  assert.equal(isAgentBinary('claude', undefined), false);
  assert.equal(isAgentBinary('claude', 'claude --resume'), false);
});

test('candidates: the Claude desktop app runs Claude Code from a path with a space; it, not its launcher, is the one', async (t) => {
  const work = tmp('zp-agent-desktop-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const first = Date.now() - 60e3;
  const line = (argv) => argv.join(' ');
  const rows = [
    row(40, line([DISCLAIMER, '--pgroup', '--', DESKTOP_CLAUDE, ...DESKTOP_FLAGS]), {
      cwd: work,
      argv: [DISCLAIMER, '--pgroup', '--', DESKTOP_CLAUDE, ...DESKTOP_FLAGS],
    }),
    row(41, line([DESKTOP_CLAUDE, ...DESKTOP_FLAGS]), { cwd: work, argv: [DESKTOP_CLAUDE, ...DESKTOP_FLAGS] }),
  ];
  const { ctl, k } = control({ processes: fakeTable(rows) });
  const claude = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  assert.deepEqual(
    claude.map((c) => [c.pid, c.app]),
    [[41, 'claude-desktop']], // the live page counts it under the app that started it
  );
  // And it can be paused: the pre-signal check accepts it as an AI app process.
  await ctl.pause({ pid: 41, startTime: claude[0].startTime }, { by: 'owner' });
  assert.deepEqual(k.sent(), [[41, 'SIGSTOP']]);
});

test('candidates: the ChatGPT app helpers say Codex in their path, but none is the codex binary', async (t) => {
  const work = tmp('zp-agent-helpers-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const rows = CODEX_HELPERS.map((argv, i) => row(50 + i, argv.join(' '), { cwd: work, argv }));
  const { ctl } = control({ processes: fakeTable(rows) });
  assert.deepEqual(await ctl.candidates({ cwd: work, firstTs: Date.now() - 60e3, source: 'codex' }), []);
  rows.push(row(60, '/opt/homebrew/bin/codex', { cwd: work }));
  assert.deepEqual(
    (await ctl.candidates({ cwd: work, firstTs: Date.now() - 60e3, source: 'codex' })).map((c) => c.pid),
    [60],
  );
});

test('a start time read a second apart is the same process: every reply names it with the first one', async (t) => {
  // ps reports the age in whole seconds, so the start time computed from it moves with the sub-second phase of the
  // clock: 600.4 s and 600.6 s after the start of the epoch, with an age of 599 s, give 1 s and 2 s.
  const work = tmp('zp-agent-start-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  let reads = 0;
  const table = { rows: async () => (reads++, [row(30, CLAUDE_ARGS, { cwd: work, upSec: 599 })]) };
  const { ctl } = control({ processes: table, now: () => 600_400 + 200 * (reads % 2) });
  const first = 10_000;
  const [a] = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  const [b] = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  assert.equal(reads, 2);
  assert.equal(a.startTime, 1000);
  assert.equal(b.startTime, a.startTime, 'the second read is 2000 before it is kept stable');
  await ctl.pause({ pid: 30, startTime: a.startTime }, { by: 'owner' });
  const [p] = await ctl.paused();
  assert.equal(p.startTime, a.startTime);
  const [c] = await ctl.candidates({ cwd: work, firstTs: first, source: 'claude' });
  assert.equal(c.startTime, a.startTime);
  assert.ok(sameProcess(p, { pid: 30, startTime: a.startTime + 1000 }));
  assert.ok(!sameProcess(p, { pid: 30, startTime: a.startTime + 3000 }));
  assert.ok(!sameProcess(p, { pid: 31, startTime: a.startTime }));
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

// The Claude desktop app's launcher and a ChatGPT helper: the live page counts them as Claude Desktop and Codex, but
// neither is the agent's own program.
const WRAPPER = [DISCLAIMER, '--pgroup', '--', DESKTOP_CLAUDE, ...DESKTOP_FLAGS];
const HELPER = CODEX_HELPERS[0];
const DESKTOP = [DESKTOP_CLAUDE, ...DESKTOP_FLAGS];
const argvRow = (pid, argv, extra = {}) => row(pid, argv.join(' '), { argv, ...extra });

test('the pre-signal check refuses a launcher wrapper and an app helper; the agent itself is accepted', async () => {
  const rows = [argvRow(40, WRAPPER), argvRow(50, HELPER), argvRow(41, DESKTOP)];
  const { ctl, audit, k } = control({ processes: fakeTable(rows) });
  for (const pid of [40, 50])
    await assert.rejects(
      ctl.pause({ pid, startTime: startOf(600) }, { by: 'owner' }),
      (e) => e.status === 403 && /not an AI agent/.test(e.message),
    );
  assert.deepEqual(k.calls, []);
  assert.deepEqual(
    audit.entries.map((e) => [e.action, e.pid, e.ok, e.status, e.error]),
    [
      ['pause', 40, false, 403, 'not an AI agent process'],
      ['pause', 50, false, 403, 'not an AI agent process'],
    ],
  );
  const out = await ctl.pause({ pid: 41, startTime: startOf(600) }, { by: 'owner' });
  assert.equal(out.app, 'claude-desktop');
  assert.deepEqual(k.sent(), [[41, 'SIGSTOP']]);
});

test('a process this server paused can be resumed even when its argv cannot be read', async () => {
  let rows = [row(4242, CLAUDE_ARGS)];
  const { ctl, k } = control({ processes: fakeTable(() => rows) });
  const target = { pid: 4242, startTime: startOf(600) };
  await ctl.pause(target, { by: 'owner' });
  rows = [row(4242, CLAUDE_ARGS, { argv: undefined })];
  const out = await ctl.resume(target, { by: 'owner' });
  assert.deepEqual([out.ok, out.action], [true, 'resume']);
  assert.deepEqual(k.sent(), [
    [4242, 'SIGSTOP'],
    [4242, 'SIGCONT'],
  ]);
  // Resumed, it is no longer one we paused: without a readable program it cannot be paused again.
  await assert.rejects(
    ctl.pause(target, { by: 'owner' }),
    (e) => e.status === 403 && /not an AI agent/.test(e.message),
  );
  assert.equal(k.sent().length, 2);
});

test('paused(): after a restart, a stopped wrapper is not listed; a stopped agent binary is', async () => {
  const rows = [argvRow(40, WRAPPER, { stopped: true }), row(4242, CLAUDE_ARGS, { stopped: true })];
  const { ctl } = control({ processes: fakeTable(rows) });
  assert.deepEqual(
    (await ctl.paused()).map((p) => [p.pid, p.app]),
    [[4242, 'claude']],
  );
});

test('the paused list and the pre-signal check read the table without working folders; candidates with them', async (t) => {
  const work = tmp('zp-agent-opts-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const seen = [];
  const processes = { rows: async (opts) => (seen.push(opts), [row(4242, CLAUDE_ARGS, { cwd: work })]) };
  const { ctl } = control({ processes });
  await ctl.paused();
  await ctl.pause({ pid: 4242, startTime: startOf(600) }, { by: 'owner' });
  assert.deepEqual(seen, [{ cwds: false }, { cwds: false }]);
  seen.length = 0;
  assert.equal((await ctl.candidates({ cwd: work, firstTs: Date.now(), source: 'claude' })).length, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0] === undefined || seen[0].cwds === true, 'candidates need the working folders');
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
