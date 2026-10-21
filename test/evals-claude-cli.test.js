// The Claude Code judge: finding the CLI and running one judgment, always against a fake `claude` (a Node script)
// in a temp folder. The real binary is never started here.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaude, childEnv, destinationOf, removeOpts } = require('../lib/evals/claude-cli');
const { fakeClaude, winEnv } = require('./helpers');

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
  '--disallowedTools',
  'mcp__*',
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A fake claude named by ZAAFPULSE_CLAUDE_BIN, a log outside its working folder, and an empty PATH and HOME.
function rig(mode = 'ok', extra = {}, opts = {}) {
  const bin = fakeClaude(tmp('zp-claude-bin-'));
  const log = path.join(tmp('zp-claude-log-'), 'runs.jsonl');
  const env = {
    ...winEnv(),
    PATH: process.env.PATH,
    ZAAFPULSE_CLAUDE_BIN: bin,
    ZAAFPULSE_ADMIN_PASSWORD: 'not-for-the-child',
    CLAUDECODE: '1',
    FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_LOG: log,
    ...extra,
  };
  const claude = createClaude({ env, home: tmp('zp-claude-home-'), systemDirs: [], ...opts });
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

test('call: the child gets the owner environment, without the dashboard settings', () => {
  const env = { HOME: '/h', PATH: '/bin', CLAUDECODE: '1', ZAAFPULSE_AUTH: 'x', ZAAFPULSE_CLAUDE_DIRS: '/a,/b' };
  assert.deepEqual(childEnv(env), { HOME: '/h', PATH: '/bin' });
});

test('call: CLAUDE_CONFIG_DIR reaches the child only as one valid folder; others are dropped, logged once', () => {
  const home = path.resolve(path.sep, 'h', 'me');
  const one = path.resolve(path.sep, 'a', 'one');
  const logs = [];
  const opts = { home, log: (m) => logs.push(m) };
  assert.deepEqual(childEnv({ CLAUDE_CONFIG_DIR: one }, opts), { CLAUDE_CONFIG_DIR: one });
  // The same folder ZAAFPulse reads its logs from: ~ is the home folder.
  assert.deepEqual(childEnv({ CLAUDE_CONFIG_DIR: '~/work' }, opts), { CLAUDE_CONFIG_DIR: path.join(home, 'work') });
  assert.deepEqual(logs, []);
  const two = `${one},${path.resolve(path.sep, 'a', 'two')}`;
  for (const bad of [two, 'relative/dir', '~', path.parse(home).root]) {
    assert.deepEqual(childEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: bad }, opts), { PATH: '/bin' }, bad);
  }
  assert.equal(logs.length, 4, 'one line per value');
  assert.match(logs[0], /CLAUDE_CONFIG_DIR is not passed to Claude Code \(one folder only; use ZAAFPULSE_CLAUDE_DIRS/);
  childEnv({ CLAUDE_CONFIG_DIR: two }, opts);
  destinationOf({ CLAUDE_CONFIG_DIR: two }, opts);
  assert.equal(logs.length, 4, 'not again for the same value');
  // The judge itself runs with the dropped variable gone.
  assert.deepEqual(childEnv({ CLAUDE_CONFIG_DIR: '' }, opts), {});
});

test('destination: the Claude config folder picks the login, so another folder is another destination', () => {
  const home = path.resolve(path.sep, 'h', 'me');
  const a = destinationOf({ CLAUDE_CONFIG_DIR: path.join(home, 'work') }, { home });
  const b = destinationOf({ CLAUDE_CONFIG_DIR: path.join(home, 'personal') }, { home });
  const none = destinationOf({}, { home });
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.token, none.token);
  assert.equal(destinationOf({ CLAUDE_CONFIG_DIR: '~/work' }, { home }).token, a.token, 'the folder the child gets');
  // A value the child never gets (dropped) is the same destination as none.
  assert.equal(destinationOf({ CLAUDE_CONFIG_DIR: 'rel' }, { home, log() {} }).token, none.token);
  assert.doesNotMatch(JSON.stringify(a), /work/, 'the folder is hashed, never shown');
});

// ---- review fixes ----
test('call: a helper that keeps the pipes open cannot hold the call past its timeout', { skip: !POSIX }, async () => {
  const t = rig('orphan');
  const started = Date.now();
  const timedOut = (e) => e.status === 0 && /timed out/.test(e.message);
  await assert.rejects(judge(t, { timeoutMs: 300, graceMs: 300 }), timedOut);
  const took = Date.now() - started;
  assert.ok(took < 3000, `settled after ${took} ms`);
  const recs = readLog(t.log);
  const run = recs.find((r) => r.argv);
  const helper = recs.find((r) => r.helper);
  assert.equal(alive(run.pid), false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(helper.helper), false, 'the whole process group is stopped');
  assert.equal(fs.existsSync(run.cwd), false);
});

test('call: an answer is read once the CLI exits, even while a helper holds the pipes', { skip: !POSIX }, async () => {
  const t = rig('orphan-answer');
  const started = Date.now();
  const r = await judge(t, { timeoutMs: 20000 });
  assert.ok(Date.now() - started < 5000);
  assert.deepEqual(JSON.parse(r.text), { label: 'relevant', explanation: 'fake verdict' });
  const helper = readLog(t.log).find((x) => x.helper);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(helper.helper), false);
  assert.equal(fs.existsSync(t.runs()[0].cwd), false);
});

test('destination: where the text goes and who pays, from the environment the CLI gets', () => {
  const d = (env) => destinationOf(env);
  assert.deepEqual(
    { to: d({}).to, billing: d({}).billing, text: d({}).text },
    { to: 'Anthropic', billing: 'your Claude login', text: 'Anthropic, through your Claude login' },
  );
  const url = 'https://' + ['user', 'pw'].join(':') + '@gw.example.com:8443/v1';
  assert.equal(d({ ANTHROPIC_BASE_URL: url }).to, 'gw.example.com:8443 (ANTHROPIC_BASE_URL)');
  assert.equal(d({ ANTHROPIC_BASE_URL: 'not a url' }).to, 'a custom address (ANTHROPIC_BASE_URL)');
  // Each cloud, with its own gateway URL's host when one is set, billed to that cloud account.
  const AWS = 'your cloud account (AWS)';
  const GCP = 'your cloud account (GCP)';
  const AZURE = 'your cloud account (Azure)';
  const via = 'via gw.example.com:8443';
  const cases = [
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, 'AWS Bedrock', AWS],
    [{ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: url }, `AWS Bedrock ${via}`, AWS],
    [{ CLAUDE_CODE_USE_MANTLE: 'yes' }, 'AWS Bedrock (Mantle)', AWS],
    [{ CLAUDE_CODE_USE_VERTEX: 'TRUE' }, 'Google Vertex AI', GCP],
    [{ CLAUDE_CODE_USE_VERTEX: 'on', ANTHROPIC_VERTEX_BASE_URL: url }, `Google Vertex AI ${via}`, GCP],
    [{ CLAUDE_CODE_USE_FOUNDRY: '1' }, 'Microsoft Foundry', AZURE],
    [{ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: url }, `Microsoft Foundry ${via}`, AZURE],
    [{ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }, 'Claude Platform on AWS', AWS],
    [{ CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1' }, 'Claude on Google Cloud', GCP],
  ];
  for (const [env, to, billing] of cases) {
    assert.equal(d(env).to, to, JSON.stringify(env));
    assert.equal(d(env).billing, billing, JSON.stringify(env));
    assert.equal(d(env).text, `${to}, billed to ${billing}`);
  }
  const gateway = d({ CLAUDE_CODE_USE_GATEWAY: '1', ANTHROPIC_BASE_URL: url });
  assert.equal(gateway.to, 'gw.example.com:8443 (CLAUDE_CODE_USE_GATEWAY)');
  // Claude Code's own rule: 1, true, yes, on are on; 0, false, no, off and empty are off.
  for (const off of ['0', 'false', 'No', 'off', '']) {
    assert.equal(d({ CLAUDE_CODE_USE_BEDROCK: off }).to, 'Anthropic', off);
  }
  // Anything else is shown as a question and is a destination of its own.
  assert.equal(d({ CLAUDE_CODE_USE_BEDROCK: 'maybe' }).to, 'Anthropic (CLAUDE_CODE_USE_BEDROCK=maybe?)');
  assert.notEqual(d({ CLAUDE_CODE_USE_BEDROCK: 'maybe' }).token, d({}).token);
  const key = ['sk', 'test', 'x'].join('-');
  assert.equal(d({ ANTHROPIC_API_KEY: key }).billing, 'API billing');
  assert.equal(d({ ANTHROPIC_AUTH_TOKEN: key }).text, 'Anthropic, with API billing');
  assert.equal(d({ ZAAFPULSE_X: '1', ANTHROPIC_API_KEY: '' }).billing, 'your Claude login');
  assert.deepEqual(createClaude({ env: { ANTHROPIC_API_KEY: key } }).destination(), d({ ANTHROPIC_API_KEY: key }));
});

test('destination: the token changes with every routing variable, never with a key value', () => {
  const t = (env) => destinationOf(env).token;
  const base = t({});
  assert.match(base, /^claude-code@[0-9a-f]{10}$/);
  assert.equal(base, t({ HOME: '/elsewhere', PATH: '/bin' }), 'other variables do not matter');
  const host = (h) => `https://${h}/v1`;
  const vars = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_GATEWAY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_CCR_V2',
    'CLAUDE_CODE_USE_SOMETHING_NEW',
  ];
  const seen = new Set([base]);
  for (const v of vars) {
    const on = t({ [v]: '1' });
    assert.notEqual(on, base, v);
    seen.add(on);
    assert.equal(t({ [v]: 'true' }), on, `${v}: the same "on"`);
  }
  const urls = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_AWS_BASE_URL',
    'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  ];
  for (const v of urls) {
    const a = t({ [v]: host('a.example.com') });
    assert.notEqual(a, base, v);
    assert.notEqual(t({ [v]: host('b.example.com') }), a, `${v}: another host`);
    assert.equal(t({ [v]: 'https://a.example.com/other/path' }), a, `${v}: the host counts, not the path`);
    seen.add(a);
  }
  const k1 = ['sk', 'one'].join('-');
  const k2 = ['sk', 'two'].join('-');
  const keys = ['API_KEY', 'AUTH_TOKEN', 'FOUNDRY_API_KEY', 'FOUNDRY_AUTH_TOKEN'].map((k) => `ANTHROPIC_${k}`);
  for (const v of keys) {
    assert.notEqual(t({ [v]: k1 }), base, `${v} present`);
    assert.equal(t({ [v]: k1 }), t({ [v]: k2 }), `${v}: its value is never part of it`);
  }
  assert.equal(seen.size, 1 + vars.length + urls.length, 'each variable gives a token of its own');
});

test('call: session and IDE variables of a parent Claude Code or VS Code never reach the child', async () => {
  const names = [
    'CLAUDECODE',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_IDE_HOST_OVERRIDE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_PLUGIN_DIRS',
    'VSCODE_IPC_HOOK',
    'VSCODE_GIT_IPC_HANDLE',
    'CLAUDE_CODE_USE_BEDROCK',
    'ANTHROPIC_BASE_URL',
  ];
  const extra = Object.fromEntries(names.map((n) => [n, 'x']));
  const t = rig('echo-env', { ...extra, FAKE_CLAUDE_ECHO: names.join(',') });
  await judge(t);
  const echo = readLog(t.log).find((r) => r.echo).echo;
  for (const n of names.slice(0, -2)) assert.equal(echo[n], null, n);
  assert.equal(echo.CLAUDE_CODE_USE_BEDROCK, 'x', 'what picks the destination is kept');
  assert.equal(echo.ANTHROPIC_BASE_URL, 'x');
});

test('discovery: --version must say "(Claude Code)"', async () => {
  assert.equal(await rig('plainversion').claude.find(), null);
});

test('discovery: in the single-file build a script runs through a real node, or is skipped', async () => {
  const t = rig();
  const sea = { home: tmp(), systemDirs: [], nodeDirs: [], isSea: () => true };
  const none = createClaude({ env: { ...t.env, PATH: '' }, ...sea });
  const script = fakeClaude(tmp('zp-claude-js-'), 'claude.js');
  const noNode = createClaude({
    env: { ZAAFPULSE_CLAUDE_BIN: script, PATH: '' },
    home: tmp(),
    systemDirs: [],
    nodeDirs: [],
    isSea: () => true,
  });
  assert.equal(await noNode.find(), null, 'no node: the script cannot run');
  if (POSIX) {
    // A POSIX executable is started as it is, never through process.execPath.
    assert.equal((await none.find()).file, t.bin);
    const nodeDir = tmp('zp-claude-node-');
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    const withNode = createClaude({
      env: { ZAAFPULSE_CLAUDE_BIN: script, PATH: nodeDir },
      home: tmp(),
      systemDirs: [],
      nodeDirs: [],
      isSea: () => true,
    });
    const bin = await withNode.find();
    assert.equal(bin.file, path.join(nodeDir, 'node'));
    assert.deepEqual(bin.args, [script]);
  }
});

test('discovery: only absolute PATH entries, and no found binary that anyone can write', { skip: !POSIX }, async () => {
  const dir = tmp('zp-claude-rel-');
  fakeClaude(dir);
  const rel = path.relative(process.cwd(), dir);
  assert.equal(await createClaude({ env: { PATH: rel }, home: tmp(), systemDirs: [] }).find(), null);
  assert.ok(await createClaude({ env: { PATH: dir }, home: tmp(), systemDirs: [] }).find());

  const loose = tmp('zp-claude-loose-');
  const f = fakeClaude(loose);
  const onPath = () => createClaude({ env: { PATH: loose }, home: tmp(), systemDirs: [] }).find();
  // Group-writable is normal under umask 002 (Ubuntu's default): a file of this user is found.
  fs.chmodSync(f, 0o775);
  fs.chmodSync(loose, 0o775);
  assert.equal((await onPath()).file, f, 'group-writable file and folder');
  // Writable by anyone: passed over.
  fs.chmodSync(f, 0o777);
  assert.equal(await onPath(), null, 'other-writable file');
  fs.chmodSync(f, 0o755);
  fs.chmodSync(loose, 0o777);
  assert.equal(await onPath(), null, 'other-writable folder');
  fs.chmodSync(loose, 0o755);
});

test('discovery: ZAAFPULSE_CLAUDE_BIN is trusted as the owner set it', { skip: !POSIX }, async () => {
  const dir = tmp('zp-claude-named-');
  const f = fakeClaude(dir);
  fs.chmodSync(f, 0o775);
  fs.chmodSync(dir, 0o775);
  assert.equal((await createClaude({ env: { ZAAFPULSE_CLAUDE_BIN: f } }).find()).file, f, 'group-writable');
  // It must still exist and be executable.
  fs.chmodSync(f, 0o664);
  assert.equal(await createClaude({ env: { ZAAFPULSE_CLAUDE_BIN: f } }).find(), null, 'not executable');
  fs.chmodSync(f, 0o755);
});

test('discovery: a binary that cannot be started any more is looked for again at once', async () => {
  const t = rig();
  const bin = await t.claude.find();
  fs.rmSync(path.dirname(t.bin), { recursive: true, force: true });
  await assert.rejects(t.claude.run(bin, { system: 's', user: 'u', schema: SCHEMA }), (e) => e.status === 0);
  assert.equal(await t.claude.find(), null, 'not the cached answer from before');
});

test('discovery: a script run through node that is gone is looked for again, not started', async () => {
  // As on Windows, where the fake (and an npm .cmd's cli.js) runs as `node <script>`: node itself still starts.
  const t = rig('ok', { ZAAFPULSE_CLAUDE_BIN: '' });
  const script = fakeClaude(tmp('zp-claude-js-'), 'claude.js');
  const c = createClaude({ env: { ...t.env, ZAAFPULSE_CLAUDE_BIN: script }, home: tmp(), systemDirs: [] });
  const bin = await c.find();
  assert.deepEqual(bin.args, [script], 'mapped to node');
  const versions = () => readLog(t.log).filter((r) => r.version).length;
  const before = versions();
  fs.rmSync(script);
  await assert.rejects(c.run(bin, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
    assert.equal(e.status, 0);
    assert.equal(e.message, 'Claude Code could not start');
    return true;
  });
  assert.equal(t.runs().length, 0, 'nothing was started');
  assert.equal(await c.find(), null, 'searched again: the script is gone');
  assert.equal(versions(), before, 'and no --version of a missing file');
});

test('call: node failing to load the mapped script clears the cached answer', async () => {
  const t = rig();
  const c = createClaude({ env: t.env, home: tmp(), systemDirs: [] });
  assert.ok(await c.find());
  const versions = () => readLog(t.log).filter((r) => r.version).length;
  const before = versions();
  // A script that is there when it is checked but that node cannot load (it went between the check and the start).
  const broken = path.join(tmp('zp-claude-broken-'), 'cli.js');
  fs.writeFileSync(broken, "require('./part-that-is-gone');\n");
  const bin = { file: process.execPath, args: [broken] };
  await assert.rejects(c.run(bin, { system: 's', user: 'u', schema: SCHEMA }), (e) => {
    assert.equal(e.status, 0);
    assert.equal(e.message, 'Claude Code could not start');
    return true;
  });
  assert.ok(await c.find(), 'still found: the named binary is fine');
  assert.equal(versions(), before + 1, 'looked for again instead of the cached answer');
});

test('call: an answer that says the login is gone backs off as "not signed in"', async () => {
  await assert.rejects(judge(rig('signedout')), (e) => {
    assert.equal(e.status, 401);
    assert.equal(e.backoff, true);
    assert.equal(e.message, 'Claude Code is not signed in');
    return true;
  });
});

test('call: a timeout during the drain still reads the answer the CLI gave', { skip: !POSIX }, async () => {
  const t = rig('orphan-answer');
  const r = await judge(t, { timeoutMs: 700, graceMs: 200 });
  assert.deepEqual(JSON.parse(r.text), { label: 'relevant', explanation: 'fake verdict' });
});

test('stopAll: a running call is killed and its folder removed at once', async () => {
  const t = rig('hang');
  const bin = await t.claude.find();
  const p = t.claude.run(bin, { system: 's', user: 'u', schema: SCHEMA });
  for (let i = 0; i < 150 && !t.runs().length; i++) await new Promise((r) => setTimeout(r, 20));
  const [run] = t.runs();
  t.claude.stopAll();
  // Windows lets a working folder go only once its process has exited: there it is gone after the exit.
  if (POSIX) assert.equal(fs.existsSync(run.cwd), false, 'removed before stopAll returns');
  await assert.rejects(p, (e) => e.status === 0);
  for (let i = 0; i < 100 && (alive(run.pid) || fs.existsSync(run.cwd)); i++) await sleep(50);
  assert.equal(alive(run.pid), false);
  assert.equal(fs.existsSync(run.cwd), false);
});

test('stopAll: a folder the OS still holds while the CLI runs is removed once the CLI has exited', async () => {
  // As on Windows: the folder cannot be removed while the process that has it as its working folder is alive.
  let t = null;
  const tries = [];
  const removeDir = (d) => {
    const run = t && t.runs()[0];
    const busy = !!run && alive(run.pid);
    tries.push(busy);
    if (busy) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    fs.rmSync(d, { recursive: true, force: true });
  };
  t = rig('hang', {}, { removeDir });
  const bin = await t.claude.find();
  const p = t.claude.run(bin, { system: 's', user: 'u', schema: SCHEMA });
  for (let i = 0; i < 150 && !t.runs().length; i++) await sleep(20);
  const [run] = t.runs();
  // Whether the folder is still held when the call settles depends on the OS (Windows may release it at once);
  // what counts is the outcome: no throw, and once the CLI has exited the folder is gone.
  assert.doesNotThrow(() => t.claude.stopAll());
  await assert.rejects(p, (e) => e.status === 0);
  for (let i = 0; i < 100 && (alive(run.pid) || fs.existsSync(run.cwd)); i++) await sleep(30);
  assert.equal(alive(run.pid), false);
  assert.equal(fs.existsSync(run.cwd), false, 'removed once the CLI has exited');
  assert.equal(tries[tries.length - 1], false, 'the last try found it free');
});

test('cleanup: on Windows the folder is removed with retries, elsewhere at once', () => {
  assert.deepEqual(removeOpts('win32'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  assert.deepEqual(removeOpts('darwin'), { recursive: true, force: true });
});

test('test rig: a child with its own env still gets what Windows needs to start', () => {
  // TEMP and TMP keep their real values: os.tmpdir() reads them, and the rig makes its folders there.
  const saved = { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT };
  try {
    Object.assign(process.env, { SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE' });
    const { env } = rig();
    for (const k of ['SystemRoot', 'PATHEXT', 'TEMP', 'TMP']) assert.equal(env[k], process.env[k], k);
    const present = ['PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].filter((k) => process.env[k] !== undefined);
    assert.deepEqual(Object.keys(winEnv()).sort(), present.sort());
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('discovery: a --version that ignores SIGTERM is killed at the time limit', { skip: !POSIX }, async () => {
  const t = rig('stubborn-version', {}, { versionMs: 300 });
  const started = Date.now();
  assert.equal(await t.claude.find(), null);
  assert.ok(Date.now() - started < 3000, `settled in ${Date.now() - started} ms`);
  const v = readLog(t.log).find((r) => r.version && r.pid);
  assert.ok(v, 'the fake was started');
  for (let i = 0; i < 40 && alive(v.pid); i++) await sleep(25);
  assert.equal(alive(v.pid), false, 'SIGKILL, not a SIGTERM it ignores');
});

test('destination: a Foundry resource without a base URL is its Azure host, shown and fingerprinted', () => {
  const on = { CLAUDE_CODE_USE_FOUNDRY: '1' };
  const a = destinationOf({ ...on, ANTHROPIC_FOUNDRY_RESOURCE: 'my-res' });
  assert.equal(a.to, 'Microsoft Foundry via my-res.services.ai.azure.com');
  assert.notEqual(a.token, destinationOf(on).token);
  assert.notEqual(a.token, destinationOf({ ...on, ANTHROPIC_FOUNDRY_RESOURCE: 'other-res' }).token);
  // The base URL wins when both are set.
  const url = 'https://gw.example.com/x';
  const b = destinationOf({ ...on, ANTHROPIC_FOUNDRY_RESOURCE: 'my-res', ANTHROPIC_FOUNDRY_BASE_URL: url });
  assert.equal(b.to, 'Microsoft Foundry via gw.example.com');
  // A resource name that is not a plain name is not shown as one.
  assert.equal(destinationOf({ ...on, ANTHROPIC_FOUNDRY_RESOURCE: 'a/b c' }).to, 'Microsoft Foundry');
});

test('destination: a switch of cloud account or region asks for a new preview, its value never shown', () => {
  const base = destinationOf({ CLAUDE_CODE_USE_BEDROCK: '1' });
  for (const v of ['AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION']) {
    const one = destinationOf({ CLAUDE_CODE_USE_BEDROCK: '1', [v]: 'secret-acct-1' });
    const two = destinationOf({ CLAUDE_CODE_USE_BEDROCK: '1', [v]: 'secret-acct-2' });
    assert.notEqual(one.token, base.token, v);
    assert.notEqual(one.token, two.token, `${v}: another value`);
    assert.doesNotMatch(JSON.stringify(one), /secret-acct/, `${v}: not in the label or the token`);
  }
});

test('docs: what can move the Claude Code call but is not in the fingerprint, and the folder that is', () => {
  const evals = fs.readFileSync(path.join(__dirname, '..', 'docs', 'evals.md'), 'utf8');
  for (const v of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'ANTHROPIC_MODEL']) assert.match(evals, new RegExp(v), v);
  assert.match(evals, /\*\*Not in the hash\.\*\*/);
  assert.match(evals, /the Claude config folder the CLI gets \(`CLAUDE_CONFIG_DIR`/);
  assert.doesNotMatch(evals, /Claude Code gets the first/);
  assert.match(evals, /user-level\s+`~\/\.claude\/CLAUDE\.md`[\s\S]{0,120}has not been checked/);
});
