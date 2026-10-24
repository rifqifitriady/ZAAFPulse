const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { entries } = require('../lib/runtimes/registry');
const {
  createRuntimeState,
  jsonFile,
  probe,
  findBin,
  parseLaunchctlList,
  systemUnit,
} = require('../lib/runtimes/state');

const NOW = 1_800_000_000_000;
const startOf = (upSec) => Math.round((NOW - upSec * 1000) / 1000) * 1000;
const row = (pid, ppid, args, upSec = 600) => ({ pid, ppid, cpu: 0, rssKB: 1024, upSec, args });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const exe = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  return f;
};
const QWEN = { id: 'qwen-local', name: 'Qwen', command: ['llama-server', '--port', '8081'], port: 8081 };

// A state over synthetic rows: nothing on PATH, no app or brew folders, no health answers unless `answers` says so.
function stateOf(rows, opts = {}) {
  let launchctlCalls = 0;
  const st = createRuntimeState({
    processes: { rows: async () => (typeof rows === 'function' ? rows() : rows) },
    entries: () => entries(opts.config || []),
    started: { read: () => opts.started || {} },
    env: { PATH: '' },
    platform: opts.platform || 'darwin',
    home: '/nonexistent-home',
    binDirs: [],
    appDirs: [],
    brewPrefixes: [],
    launchctl: async () => {
      launchctlCalls++;
      return opts.jobs || new Map();
    },
    readCgroup: opts.readCgroup || (() => ''),
    probe: async (url) => (opts.answers || []).includes(url),
    now: () => NOW,
    ...opts.extra,
  });
  return { st, launchctlCalls: () => launchctlCalls };
}
const byId = (list) => Object.fromEntries(list.map((x) => [x.entry.id, x]));

test('a server started by the Ollama app: how is app, its runner and llama-server count as children', async () => {
  const rows = [
    row(500, 1, '/Applications/Ollama.app/Contents/MacOS/Ollama'),
    row(501, 500, '/Applications/Ollama.app/Contents/Resources/ollama serve', 590),
    row(502, 501, '/Applications/Ollama.app/Contents/Resources/ollama runner --model /x/blob --port 50123', 30),
    row(503, 501, '/Applications/Ollama.app/Contents/Resources/llama-server --model /x/blob --port 50124', 20),
  ];
  const { st } = stateOf(rows, { answers: ['http://127.0.0.1:11434/api/version'] });
  const x = byId(await st.list());
  assert.equal(x.ollama.running, true);
  assert.equal(x.ollama.healthy, true);
  assert.equal(x.ollama.how, 'app');
  assert.equal(x.ollama.pid, 501);
  assert.equal(x.ollama.startTime, startOf(590));
  assert.equal(x.ollama.children, 2);
  assert.equal(x.llamacpp.running, false, "Ollama's llama-server is its child, not a llama.cpp server");
});

test('a server launchd runs as homebrew.mxcl.ollama is a brew service', async () => {
  const brew = tmp('zp-rt-brew-');
  const brewBin = exe(path.join(brew, 'bin'), 'brew');
  const rows = [row(601, 1, '/opt/homebrew/opt/ollama/bin/ollama serve')];
  const jobs = new Map([['homebrew.mxcl.ollama', 601]]);
  const { st } = stateOf(rows, { jobs, extra: { brewPrefixes: [brew] } });
  const o = byId(await st.list()).ollama;
  assert.equal(o.how, 'service');
  assert.equal(o.brewBin, brewBin);
  assert.equal(o.healthy, false, 'running but not answering');
  // Another job's pid, or none, is not a service.
  const other = stateOf(rows, { jobs: new Map([['homebrew.mxcl.ollama', 999]]) });
  assert.equal(byId(await other.st.list()).ollama.how, 'process');
  fs.rmSync(brew, { recursive: true, force: true });
});

test('a server ZAAFPulse started is zaafpulse, by pid and start time; a reused pid is not', async () => {
  const rows = [row(701, 1, '/opt/homebrew/bin/ollama serve')];
  const mine = stateOf(rows, { started: { ollama: { pid: 701, startTime: startOf(600) + 1000 } } });
  assert.equal(byId(await mine.st.list()).ollama.how, 'zaafpulse');
  assert.equal(mine.launchctlCalls(), 0, 'launchd is not asked about our own server');
  const reused = stateOf(rows, { started: { ollama: { pid: 701, startTime: startOf(600) - 60000 } } });
  assert.equal(byId(await reused.st.list()).ollama.how, 'process');
});

test('a server run from a shell is a process; the oldest of two servers is the one listed', async () => {
  const rows = [
    row(800, 1, '-zsh'),
    row(802, 800, '/usr/local/bin/ollama serve', 100),
    row(801, 800, '/usr/local/bin/ollama serve', 900),
  ];
  const o = byId((await stateOf(rows).st.list())).ollama;
  assert.equal(o.how, 'process');
  assert.equal(o.pid, 801);
});

test('a server ZAAFPulse started is chosen over an older foreign server of the same runtime', async () => {
  const rows = [row(710, 1, '/usr/local/bin/ollama serve', 900), row(711, 1, '/usr/local/bin/ollama serve', 100)];
  const { st } = stateOf(rows, { started: { ollama: { pid: 711, startTime: startOf(100) } } });
  const o = byId(await st.list()).ollama;
  assert.equal(o.pid, 711);
  assert.equal(o.how, 'zaafpulse');
});

test('launchctl is not asked when the parent pid is not 1', async () => {
  const rows = [row(1, 0, '/sbin/launchd'), row(720, 800, '/opt/homebrew/bin/ollama serve'), row(800, 1, '-zsh')];
  const jobs = new Map([['homebrew.mxcl.ollama', 720]]);
  const x = stateOf(rows, { jobs });
  assert.equal(byId(await x.st.list()).ollama.how, 'process');
  assert.equal(x.launchctlCalls(), 0);
});

test('app is judged by the program, not by a path somewhere in the arguments', async () => {
  const note = '--note /Applications/Ollama.app/Contents/MacOS/x';
  const plain = stateOf([row(730, 1, `/usr/local/bin/ollama serve ${note}`)]);
  assert.equal(byId(await plain.st.list()).ollama.how, 'process');
  const argv = { ...row(731, 1, `/usr/local/bin/ollama serve ${note}`), argv: ['/usr/local/bin/ollama', 'serve', '--note', '/Applications/Ollama.app/Contents/MacOS/x'] };
  assert.equal(byId(await stateOf([argv]).st.list()).ollama.how, 'process');
  // The app's own program above the server still counts, with or without argv.
  const app = row(732, 1, '/Applications/Ollama.app/Contents/MacOS/Ollama');
  const srv = row(733, 732, '/usr/local/bin/ollama serve');
  assert.equal(byId(await stateOf([app, srv]).st.list()).ollama.how, 'app');
  const withArgv = [{ ...app, argv: ['/Applications/Ollama.app/Contents/MacOS/Ollama'] }, srv];
  assert.equal(byId(await stateOf(withArgv).st.list()).ollama.how, 'app');
});

test('a runtime that answers its health URL with no matching process has no how and no pid', async () => {
  const apps = tmp('zp-rt-lms-');
  fs.mkdirSync(path.join(apps, 'LM Studio.app'));
  const st = stateOf([], { answers: ['http://127.0.0.1:1234/v1/models'], extra: { appDirs: [apps] } }).st;
  const x = byId(await st.list()).lmstudio;
  fs.rmSync(apps, { recursive: true, force: true });
  assert.equal(x.running, true);
  assert.equal(x.how, null);
  assert.equal(x.pid, null);
});

test('Linux: a systemd system unit is "system"; a user unit or a terminal is a process', async () => {
  const rows = [row(901, 1, '/usr/local/bin/ollama serve')];
  const sys = stateOf(rows, { platform: 'linux', readCgroup: () => '0::/system.slice/ollama.service\n' });
  assert.equal(byId(await sys.st.list()).ollama.how, 'system');
  const user = stateOf(rows, {
    platform: 'linux',
    readCgroup: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/ollama.service\n',
  });
  assert.equal(byId(await user.st.list()).ollama.how, 'process');
  const gone = stateOf(rows, {
    platform: 'linux',
    readCgroup: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(byId(await gone.st.list()).ollama.how, 'process');
});

test('an owner entry claims the llama-server on its port; another port stays the llama.cpp preset', async () => {
  const rows = [
    row(1001, 1, '/opt/homebrew/bin/llama-server -m /m/qwen.gguf --port 8081'),
    row(1002, 1, '/opt/homebrew/bin/llama-server -m /m/other.gguf --port 9090'),
  ];
  const x = byId(await stateOf(rows, { config: [QWEN] }).st.list());
  assert.equal(x['qwen-local'].pid, 1001);
  assert.equal(x.llamacpp.pid, 1002);
  assert.equal(x.llamacpp.running, true);
});

test('LM Studio counts as running only while its health URL answers', async () => {
  const rows = [row(1101, 1, '/Applications/LM Studio.app/Contents/MacOS/LM Studio')];
  const off = byId(await stateOf(rows).st.list()).lmstudio;
  assert.equal(off.running, false, 'the app is open, the server is off');
  assert.equal(off.pid, null);
  const on = byId(await stateOf(rows, { answers: ['http://127.0.0.1:1234/v1/models'] }).st.list()).lmstudio;
  assert.equal(on.running, true);
  assert.equal(on.how, 'app');
  assert.equal(on.pid, 1101);
});

// POSIX paths and executable bits: the Windows CI skips it.
test('installed from a fake PATH, fake app folders and a fake Homebrew; the start argv uses what was found', { skip: process.platform === 'win32' }, async () => {
  const bin = tmp('zp-rt-bin-');
  const ollama = exe(bin, 'ollama');
  exe(bin, 'llama-server');
  const apps = tmp('zp-rt-apps-');
  fs.mkdirSync(path.join(apps, 'Jan.app'));
  fs.mkdirSync(path.join(apps, 'Ollama.app'));
  const brew = tmp('zp-rt-brew-');
  fs.mkdirSync(path.join(brew, 'opt', 'localai'), { recursive: true });
  const { st } = stateOf([], {
    config: [QWEN],
    extra: { env: { PATH: bin }, appDirs: [apps], brewPrefixes: [brew] },
  });
  const x = byId(await st.list());
  assert.equal(x.ollama.installed, true);
  assert.deepEqual(x.ollama.startArgv, [ollama, 'serve'], 'the program beats opening the app');
  assert.equal(x.jan.installed, true);
  assert.deepEqual(x.jan.startArgv, ['/usr/bin/open', '-a', path.join(apps, 'Jan.app')]);
  assert.equal(x.localai.installed, true, 'the Homebrew formula is there');
  assert.equal(x.localai.startArgv, null, 'but its program is not on PATH');
  assert.equal(x.lmstudio.installed, false);
  assert.equal(x.llamacpp.installed, true);
  assert.equal(x.llamacpp.startArgv, null, 'needs an owner entry with a model path');
  assert.deepEqual(x['qwen-local'].startArgv, [path.join(bin, 'llama-server'), '--port', '8081']);
  for (const d of [bin, apps, brew]) fs.rmSync(d, { recursive: true, force: true });
});

test('one(id) reads one runtime; an unreadable table says so and nothing runs', async () => {
  const rows = [row(1201, 1, '/usr/local/bin/ollama serve')];
  const { st } = stateOf(rows);
  assert.equal((await st.one('ollama')).pid, 1201);
  assert.equal(await st.one('nope'), null);
  const broken = stateOf(() => {
    throw new Error('ps failed');
  });
  const o = await broken.st.one('ollama');
  assert.equal(o.running, false);
  assert.equal(o.tableError, 'the process table could not be read');
});

test('findBin: absolute paths as given, PATH then the usual folders, never a relative path', () => {
  const d = tmp('zp-rt-find-');
  const f = exe(d, 'tool');
  fs.writeFileSync(path.join(d, 'plain'), 'x', { mode: 0o644 });
  if (process.platform !== 'win32') {
    assert.equal(findBin(f, { platform: 'darwin' }), f);
    assert.equal(findBin('tool', { env: { PATH: d }, platform: 'darwin', dirs: [] }), f);
    assert.equal(findBin('tool', { env: { PATH: '' }, platform: 'darwin', dirs: [d] }), f);
    assert.equal(findBin('plain', { env: { PATH: d }, platform: 'darwin', dirs: [] }), null, 'not executable');
  }
  assert.equal(findBin('./tool', { env: { PATH: d }, dirs: [] }), null);
  assert.equal(findBin('missing', { env: { PATH: d }, dirs: [] }), null);
  assert.equal(findBin('', {}), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('findBin: a binary writable by everyone, or in such a folder, is not found; an owner path is taken as given', { skip: process.platform === 'win32' }, () => {
  const bad = tmp('zp-rt-bad-');
  const f = exe(bad, 'tool');
  fs.chmodSync(f, 0o777);
  const open = tmp('zp-rt-open-');
  const g = exe(open, 'tool');
  fs.chmodSync(open, 0o777);
  const ok = tmp('zp-rt-ok-');
  const h = exe(ok, 'tool');
  const opts = (d) => ({ env: { PATH: d }, platform: 'darwin', dirs: [] });
  assert.equal(findBin('tool', opts(bad)), null);
  assert.equal(findBin('tool', opts(open)), null);
  assert.equal(findBin('tool', { env: { PATH: '' }, platform: 'darwin', dirs: [bad] }), null, 'the usual folders too');
  assert.equal(findBin('tool', opts(`${bad}:${ok}`)), h, 'the next trusted match is used');
  assert.equal(findBin(f, { platform: 'darwin' }), f, 'an absolute program is as the owner gave it');
  assert.equal(findBin(g, { platform: 'darwin' }), g);
  for (const d of [bad, open, ok]) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('parseLaunchctlList and systemUnit', () => {
  const jobs = parseLaunchctlList('PID\tStatus\tLabel\n601\t0\thomebrew.mxcl.ollama\n-\t0\thomebrew.mxcl.redis\n');
  assert.deepEqual([...jobs], [['homebrew.mxcl.ollama', 601]]);
  assert.equal(systemUnit('0::/system.slice/ollama.service\n'), 'ollama.service');
  assert.equal(systemUnit('12:pids:/system.slice/local-ai.service\n0::/system.slice/local-ai.service'), 'local-ai.service');
  assert.equal(systemUnit('0::/user.slice/user-1000.slice/session-2.scope\n'), null);
  assert.equal(systemUnit(''), null);
});

test('jsonFile: mode 0600, written whole, an unreadable file reads as {}', () => {
  const d = tmp('zp-rt-json-');
  const f = jsonFile(path.join(d, 'runtimes', 'started.json'));
  assert.deepEqual(f.read(), {});
  f.write({ ollama: { pid: 5, startTime: 1 } });
  assert.deepEqual(f.read(), { ollama: { pid: 5, startTime: 1 } });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  // A stale, world-readable temp file (or a link in its place) is not reused.
  const stale = `${f.file}.${process.pid}.tmp`;
  const other = path.join(d, 'other');
  fs.writeFileSync(other, 'keep');
  fs.writeFileSync(stale, 'old', { mode: 0o644 });
  fs.rmSync(stale);
  fs.symlinkSync(other, stale);
  f.write({ a: 1 });
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep', 'a link at the temp path is not written through');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  fs.writeFileSync(f.file, '[1,2]');
  assert.deepEqual(f.read(), {});
  fs.rmSync(d, { recursive: true, force: true });
});

test('probe: an answer below 500 within the time counts; 503, a closed port and silence do not', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return; // never answers
    res.writeHead(req.url === '/busy' ? 503 : 200);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probe(`${base}/api/version`), true);
  assert.equal(await probe(`${base}/busy`), false);
  const t = Date.now();
  assert.equal(await probe(`${base}/hang`, 200), false);
  assert.ok(Date.now() - t < 1000);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  assert.equal(await probe(`${base}/api/version`), false);
});

// ---- the desktop apps (kind 'app'): installed from a fake app folder, running from fake rows ----
test('an app is installed from a fake app folder; Kiro.app wins over Kiro CLI.app; Start opens the bundle found', { skip: process.platform === 'win32' }, async () => {
  const apps = tmp('zp-rt-apps-');
  for (const b of ['Claude.app', 'Kiro CLI.app', 'Kiro.app']) fs.mkdirSync(path.join(apps, b));
  const { st } = stateOf([], { extra: { appDirs: [apps] } });
  const x = byId(await st.list());
  assert.equal(x['claude-desktop'].installed, true);
  assert.deepEqual(x['claude-desktop'].startArgv, ['/usr/bin/open', '-a', path.join(apps, 'Claude.app')]);
  assert.equal(x['claude-desktop'].running, false);
  assert.equal(x['claude-desktop'].healthy, false);
  assert.equal(x.chatgpt.installed, false);
  assert.equal(x.chatgpt.startArgv, null);
  assert.deepEqual(x.kiro.startArgv, ['/usr/bin/open', '-a', path.join(apps, 'Kiro.app')], 'Kiro.app first');
  fs.rmSync(path.join(apps, 'Kiro.app'), { recursive: true });
  const y = byId(await st.list());
  assert.deepEqual(y.kiro.startArgv, ['/usr/bin/open', '-a', path.join(apps, 'Kiro CLI.app')], 'else Kiro CLI.app');
  // A second app folder: the bundle order decides, not the folder order.
  const home = tmp('zp-rt-home-apps-');
  fs.mkdirSync(path.join(home, 'Kiro.app'));
  const both = stateOf([], { extra: { appDirs: [apps, home] } });
  assert.deepEqual(byId(await both.st.list()).kiro.startArgv, ['/usr/bin/open', '-a', path.join(home, 'Kiro.app')]);
  // Off macOS no app is installed.
  const linux = stateOf([], { platform: 'linux', extra: { appDirs: [apps] } });
  assert.equal(byId(await linux.st.list())['claude-desktop'].installed, false);
  for (const d of [apps, home]) fs.rmSync(d, { recursive: true, force: true });
});

test('an app runs while its main process is there: healthy equals running, its helpers are children, no health URL is asked', async () => {
  const asked = [];
  const rows = [
    row(84551, 1, '/Applications/Claude.app/Contents/MacOS/Claude', 900),
    row(84581, 84551, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility'),
    row(59799, 84551, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer'),
    row(3224, 1, '/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop', 300),
    row(4000, 1, '/Users/u/.local/bin/kiro-cli chat'),
  ];
  const { st } = stateOf(rows, { extra: { probe: async (u) => (asked.push(u), false) } });
  const x = byId(await st.list());
  const c = x['claude-desktop'];
  assert.equal(c.running, true);
  assert.equal(c.healthy, true, 'no health URL: healthy is running');
  assert.equal(c.how, 'app');
  assert.equal(c.appBundle, 'Claude.app');
  assert.equal(c.pid, 84551);
  assert.equal(c.startTime, startOf(900));
  assert.equal(c.children, 2);
  const k = x.kiro;
  assert.equal(k.running, true);
  assert.equal(k.pid, 3224, 'the app, not a kiro-cli session');
  assert.equal(k.how, 'app');
  assert.equal(k.appBundle, 'Kiro CLI.app', 'the bundle the running process is from');
  assert.equal(x.chatgpt.running, false);
  assert.equal(x.chatgpt.healthy, false);
  assert.equal(x.chatgpt.appBundle, null);
  assert.deepEqual(asked.filter((u) => !/^http:\/\/127\.0\.0\.1:(11434|1234|1337|8080)\//.test(u)), [], 'only model servers are probed');
});

// A desktop app sits at the top of a large process tree: a shell inside Claude Desktop that runs `ollama serve` must not
// make Ollama Claude Desktop's child. A row that is itself a runtime's server is only absorbed by the same runtime.
test('a model server started from inside a desktop app is its own runtime, not the app child', async () => {
  const rows = [
    row(100, 1, '/Applications/Claude.app/Contents/MacOS/Claude', 900),
    row(110, 100, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility'),
    row(120, 110, '/bin/zsh -l'),
    row(130, 120, '/opt/homebrew/bin/ollama serve', 60),
  ];
  const { st } = stateOf(rows);
  const x = byId(await st.list());
  assert.equal(x.ollama.running, true);
  assert.equal(x.ollama.pid, 130);
  assert.equal(x['claude-desktop'].running, true);
  assert.equal(x['claude-desktop'].children, 2, 'the helper and the shell, not the Ollama server');
});

test('Antigravity IDE.app (exe Electron) is Antigravity, and comes before Antigravity.app', async () => {
  const rows = [row(3290, 1, '/Applications/Antigravity IDE.app/Contents/MacOS/Electron', 900)];
  const { st } = stateOf(rows);
  const a = byId(await st.list()).antigravity;
  assert.equal(a.running, true);
  assert.equal(a.pid, 3290);
  assert.equal(a.appBundle, 'Antigravity IDE.app');
});
