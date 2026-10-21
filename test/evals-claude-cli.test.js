// The Claude Code judge: finding the CLI and running one judgment, always against a fake `claude` (a Node script)
// in a temp folder. The real binary is never started here.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaude, childEnv } = require('../lib/evals/claude-cli');
const { fakeClaude } = require('./helpers');

const POSIX = process.platform !== 'win32';
const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p = 'zp-claude-') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
const SCHEMA = {
  type: 'object',
  properties: { label: { type: 'string', enum: ['relevant', 'off-topic'] }, explanation: { type: 'string' } },
  required: ['label', 'explanation'],
  additionalProperties: false,
};
const FLAGS = [
  '-p',
  '--output-format',
  'json',
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--setting-sources',
  '',
  '--system-prompt',
  'SYSTEM TEXT',
  '--json-schema',
  JSON.stringify(SCHEMA),
];
const USER = 'USER TURN TEXT that must never be in argv';
const readLog = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A fake claude named by ZAAFPULSE_CLAUDE_BIN, a log outside its working folder, and an empty PATH and HOME.
function rig(mode = 'ok', extra = {}) {
  const bin = fakeClaude(tmp('zp-claude-bin-'));
  const log = path.join(tmp('zp-claude-log-'), 'runs.jsonl');
  const env = {
    PATH: process.env.PATH,
    ZAAFPULSE_CLAUDE_BIN: bin,
    ZAAFPULSE_ADMIN_PASSWORD: 'not-for-the-child',
    CLAUDECODE: '1',
    FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_LOG: log,
    ...extra,
  };
  const claude = createClaude({ env, home: tmp('zp-claude-home-'), systemDirs: [] });
  return { bin, log, env, claude, runs: () => readLog(log).filter((r) => !r.version) };
}
const judge = (t, opts = {}) =>
  t.claude.find().then((bin) => t.claude.run(bin, { system: 'SYSTEM TEXT', user: USER, schema: SCHEMA, ...opts }));

test('discovery: ZAAFPULSE_CLAUDE_BIN wins, and a named binary is never swapped for another install', async () => {
  const t = rig();
  const bin = await t.claude.find();
  assert.ok(bin, 'found');
  assert.equal(bin.version, '2.1.302');
  assert.ok(bin.file === t.bin || bin.args.includes(t.bin), 'the named fake');
  assert.equal(await t.claude.available(), true);

  // A home with an extension install, and the env var pointing at nothing: still not found.
  const home = tmp('zp-claude-home-');
  const extension = path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-9.9.9');
  if (POSIX) fakeClaude(path.join(extension, 'resources', 'native-binary'));
  const none = createClaude({ env: { ZAAFPULSE_CLAUDE_BIN: path.join(home, 'missing') }, home, systemDirs: [] });
  assert.equal(await none.find(), null);
  assert.equal(await none.available(), false);

  // One that exits without a version does not count.
  const mute = rig('noversion');
  assert.equal(await mute.claude.find(), null);
});

test('discovery: nothing installed means not found', async () => {
  const c = createClaude({ env: { PATH: '' }, home: tmp('zp-claude-home-'), systemDirs: [] });
  assert.equal(await c.find(), null);
});

test('discovery: PATH comes before the install folders', { skip: !POSIX }, async () => {
  const home = tmp('zp-claude-home-');
  const onPath = fakeClaude(tmp('zp-claude-path-'));
  fakeClaude(path.join(home, '.local', 'bin'));
  const env = { PATH: path.dirname(onPath) };
  assert.equal((await createClaude({ env, home, systemDirs: [] }).find()).file, onPath);
  const local = (await createClaude({ env: { PATH: '' }, home, systemDirs: [] }).find()).file;
  assert.equal(local, path.join(home, '.local', 'bin', 'claude'));
});

test('discovery: the highest version wins among IDE extensions and Claude Desktop', { skip: !POSIX }, async () => {
  const home = tmp('zp-claude-home-');
  const ext = (root, name) => fakeClaude(path.join(home, root, 'extensions', name, 'resources', 'native-binary'));
  ext('.vscode', 'anthropic.claude-code-2.1.9-darwin-arm64');
  ext('.cursor', 'anthropic.claude-code-2.1.10-darwin-arm64');
  const best = ext('.antigravity-ide', 'anthropic.claude-code-2.1.302-darwin-arm64');
  ext('.windsurf', 'some.other-extension-9.9.9');
  const desktop = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const desk = (v, h) => fakeClaude(path.join(desktop, v, h, 'claude.app', 'Contents', 'MacOS'));
  desk('2.1.299', 'abc123');
  const env = { PATH: '' };
  assert.equal((await createClaude({ env, home, systemDirs: [], platform: 'darwin' }).find()).file, best);

  // A newer Desktop copy beats the extensions; one that does not answer is passed over.
  const newer = desk('2.2.0', 'def456');
  assert.equal((await createClaude({ env, home, systemDirs: [], platform: 'darwin' }).find()).file, newer);
  fs.writeFileSync(newer, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal((await createClaude({ env, home, systemDirs: [], platform: 'darwin' }).find()).file, best);
  // Claude Desktop's folder is a macOS one only.
  assert.equal((await createClaude({ env, home, systemDirs: [], platform: 'linux' }).find()).file, best);
});

test('discovery: the answer is kept for 5 minutes', async () => {
  const clock = { t: 1e12 };
  const t = rig();
  const c = createClaude({ env: t.env, home: tmp(), systemDirs: [], now: () => clock.t });
  await Promise.all([c.find(), c.find()]);
  await c.find();
  const versions = () => readLog(t.log).filter((r) => r.version).length;
  assert.equal(versions(), 1, 'one --version for overlapping and later calls');
  clock.t += 5 * 60e3 + 1;
  await c.find();
  assert.equal(versions(), 2);
});

test('call: argv holds exactly the flags, no --bare and no turn text; the text arrives on stdin', async () => {
  const t = rig();
  const r = await judge(t);
  const [run] = t.runs();
  assert.deepEqual(run.argv, FLAGS, 'no --model when none was chosen');
  assert.ok(!run.argv.includes('--bare'), '--bare would turn off the Claude login');
  assert.ok(!run.argv.some((a) => a.includes('USER TURN TEXT')));
  assert.equal(run.stdin, USER);
  assert.deepEqual(run.vars, [], 'no CLAUDECODE marker and none of the dashboard variables reach the child');
  assert.deepEqual(JSON.parse(r.text), { label: 'relevant', explanation: 'fake verdict' });

  await judge(t, { model: 'haiku' });
  assert.deepEqual(t.runs()[1].argv, [...FLAGS, '--model', 'haiku']);
});

test('call: it runs in a fresh empty folder that is gone afterwards', async () => {
  const t = rig();
  await judge(t);
  await judge(t);
  const [a, b] = t.runs();
  assert.deepEqual(a.entries, []);
  assert.notEqual(fs.realpathSync(os.tmpdir()), a.cwd);
  assert.notEqual(a.cwd, b.cwd, 'a new folder each call');
  assert.equal(fs.existsSync(a.cwd), false);
  assert.equal(fs.existsSync(b.cwd), false);
});

test('call: structured_output, or result alone, is the text; usage, cost and model are reported', async () => {
  const t = rig();
  const r = await judge(t);
  assert.deepEqual(r.usage, { input: 1602, output: 40, cost: 0.0005 });
  assert.equal(r.model, 'claude-haiku-5-5', 'the model that cost the most');

  const res = await judge(rig('result'));
  assert.deepEqual(JSON.parse(res.text), { label: 'relevant', explanation: 'fake verdict' });

  const none = await judge(rig('nocost'));
  assert.equal(none.usage.cost, null, 'no cost reported is unknown, never free');
});

test('call: an error answer throws with a status and a short message, without paths or the account', async () => {
  for (const [mode, status] of [
    ['error', 502],
    ['limit', 429],
    ['maxturns', 422],
    ['crash', 502],
    ['garbage', 502],
  ]) {
    const t = rig(mode);
    await assert.rejects(judge(t), (e) => {
      assert.equal(e.status, status, mode);
      assert.ok(e.message.length <= 160);
      assert.doesNotMatch(e.message, /\/Users\/|someone@example|secret/, mode);
      return true;
    });
    for (const run of t.runs()) assert.equal(fs.existsSync(run.cwd), false, `${mode}: folder removed`);
  }
  // A model name that could pass for a flag is refused before anything starts.
  const t = rig();
  await assert.rejects(judge(t, { model: '--dangerously-skip-permissions' }), (e) => e.status === 400);
  assert.equal(t.runs().length, 0);
});

test('call: a slow CLI is stopped at the timeout, and SIGKILL follows a SIGTERM it ignores', async () => {
  const t = rig('hang');
  const started = Date.now();
  await assert.rejects(judge(t, { timeoutMs: 300 }), (e) => e.status === 0 && /timed out/.test(e.message));
  const [run] = t.runs();
  assert.equal(alive(run.pid), false, 'the child is gone');
  assert.equal(fs.existsSync(run.cwd), false);
  assert.ok(Date.now() - started < 5000);

  if (POSIX) {
    const s = rig('stubborn');
    await assert.rejects(judge(s, { timeoutMs: 300, graceMs: 300 }), (e) => e.status === 0);
    assert.equal(alive(s.runs()[0].pid), false, 'killed after the grace period');
  }
});

test('call: an AbortSignal stops the child', async () => {
  const t = rig('hang');
  const ctl = new AbortController();
  // Cancelled once the child is running and has read its stdin.
  const poll = setInterval(() => t.runs().length && ctl.abort(), 20);
  try {
    await assert.rejects(judge(t, { signal: ctl.signal }), (e) => e.status === 0 && /cancelled/.test(e.message));
  } finally {
    clearInterval(poll);
  }
  assert.equal(alive(t.runs()[0].pid), false);
  assert.equal(fs.existsSync(t.runs()[0].cwd), false);
  // A signal that is already aborted starts nothing.
  const u = rig();
  await assert.rejects(judge(u, { signal: AbortSignal.abort() }), (e) => e.status === 0);
  assert.equal(u.runs().length, 0);
});

test('call: more than the output cap is refused', async () => {
  const t = rig('flood');
  await assert.rejects(judge(t), (e) => e.status === 502 && /too much output/.test(e.message));
  const s = rig('ok');
  await assert.rejects(judge(s, { maxBytes: 50 }), (e) => /too much output/.test(e.message));
});

test('call: the child gets the owner environment, without the dashboard settings, and one Claude config folder', () => {
  const env = { HOME: '/h', PATH: '/bin', CLAUDECODE: '1', ZAAFPULSE_AUTH: 'x', CLAUDE_CONFIG_DIR: '/a/one,/a/two' };
  assert.deepEqual(childEnv(env), { HOME: '/h', PATH: '/bin', CLAUDE_CONFIG_DIR: '/a/one' });
  assert.deepEqual(childEnv({ CLAUDE_CONFIG_DIR: '/a/only' }), { CLAUDE_CONFIG_DIR: '/a/only' });
});
