// Where Claude Code and Codex logs are read from: ZAAFPULSE_CLAUDE_DIRS, CLAUDE_CONFIG_DIR, the XDG folder, ~/.claude,
// CODEX_HOME.
// Roots take an injected env and home, so no test depends on this machine's variables.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const claude = require('../lib/claude');
const codex = require('../lib/codex');
const { createContent } = require('../lib/trace/content');
const { describeRoots } = require('../lib/logroots');
const { emptyLogsNote, liveNoteStep } = require('../public/overviewview');
const { NO_JUDGE_PORTS } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const j = (...p) => path.join(...p);
const abs = (...p) => path.resolve(path.sep, ...p); // an absolute path on this OS (with a drive letter on Windows)
const put = (file, text = '{"type":"x"}\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

test('claude roots: default order is the XDG folder, then ~/.claude', () => {
  const home = abs('h', 'me');
  assert.deepEqual(claude.roots({}, home), [j(home, '.config', 'claude', 'projects'), j(home, '.claude', 'projects')]);
});

test('claude roots: XDG_CONFIG_HOME replaces ~/.config, a relative one is ignored', () => {
  const home = abs('h', 'me');
  const xdg = abs('x', 'cfg');
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: xdg }, home), [
    j(xdg, 'claude', 'projects'),
    j(home, '.claude', 'projects'),
  ]);
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: 'rel/cfg' }, home), claude.roots({}, home));
});

test('claude roots: ZAAFPULSE_CLAUDE_DIRS lists several folders, expands ~, and is the only source', () => {
  const home = abs('h', 'me');
  const a = abs('a', 'one');
  const env = { ZAAFPULSE_CLAUDE_DIRS: `${a}, ~/second ,, ~/Documents`, XDG_CONFIG_HOME: abs('x') };
  const got = claude.roots(env, home);
  assert.deepEqual(got, [j(a, 'projects'), j(home, 'second', 'projects'), j(home, 'Documents', 'projects')]);
});

test('claude roots: repeated folders are listed once', () => {
  const home = abs('h', 'me');
  const a = abs('a');
  assert.deepEqual(claude.roots({ ZAAFPULSE_CLAUDE_DIRS: `${a},${a}${path.sep},${a}` }, home), [j(a, 'projects')]);
  // XDG_CONFIG_HOME=~ makes ~/claude/projects, which differs; ~/.config as XDG folder must not repeat itself
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: j(home, '.config') }, home), claude.roots({}, home));
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: home }, home).length, 2);
});

test('claude roots: CLAUDE_CONFIG_DIR is one folder, as Claude Code reads it, and then the only source', () => {
  const home = abs('h', 'me');
  const env = { CLAUDE_CONFIG_DIR: ' ~/work-claude ', XDG_CONFIG_HOME: abs('x') };
  assert.deepEqual(claude.rootInfo(env, home), [{ path: j(home, 'work-claude', 'projects') }]);
  assert.deepEqual(claude.roots({ CLAUDE_CONFIG_DIR: abs('a') }, home), [j(abs('a'), 'projects')]);
  // An empty value is not set: the usual folders are read.
  assert.deepEqual(claude.roots({ CLAUDE_CONFIG_DIR: '  ' }, home), claude.roots({}, home));
  // Too broad or relative is ignored with the same reasons as any folder.
  assert.deepEqual(claude.rootInfo({ CLAUDE_CONFIG_DIR: '~' }, home), [
    { path: j(home, 'projects'), ignored: 'too broad' },
  ]);
  assert.deepEqual(claude.rootInfo({ CLAUDE_CONFIG_DIR: 'rel' }, home), [{ path: 'rel', ignored: 'not absolute' }]);
});

test('claude roots: a comma in CLAUDE_CONFIG_DIR is ignored and points at ZAAFPULSE_CLAUDE_DIRS', () => {
  const home = abs('h', 'me');
  const value = `${abs('a')},${abs('b')}`;
  assert.deepEqual(claude.rootInfo({ CLAUDE_CONFIG_DIR: value }, home), [
    { path: value, ignored: 'one folder only; use ZAAFPULSE_CLAUDE_DIRS for several' },
  ]);
  assert.deepEqual(claude.roots({ CLAUDE_CONFIG_DIR: value }, home), [], 'nothing is read, not even the defaults');
  const shown = describeRoots({ claude: claude.rootInfo({ CLAUDE_CONFIG_DIR: value }, home) }, {}, home);
  assert.equal(shown[0].ignored, 'one folder only; use ZAAFPULSE_CLAUDE_DIRS for several');
});

test('claude roots: ZAAFPULSE_CLAUDE_DIRS first, then CLAUDE_CONFIG_DIR, then the XDG folder and ~/.claude', () => {
  const home = abs('h', 'me');
  const many = { ZAAFPULSE_CLAUDE_DIRS: `${abs('l1')},${abs('l2')}` };
  const one = { CLAUDE_CONFIG_DIR: abs('one') };
  assert.deepEqual(claude.roots({ ...many, ...one }, home), [j(abs('l1'), 'projects'), j(abs('l2'), 'projects')]);
  assert.deepEqual(claude.roots({ ...one, ZAAFPULSE_CLAUDE_DIRS: ' , ' }, home), [j(abs('one'), 'projects')]);
  assert.deepEqual(claude.roots({ ...one }, home), [j(abs('one'), 'projects')]);
  assert.deepEqual(claude.roots({}, home), [j(home, '.config', 'claude', 'projects'), j(home, '.claude', 'projects')]);
});

test('roots: a folder that is a link to the home folder is as broad as the home folder', (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows');
  const home = tmp('zp-roots-');
  const elsewhere = tmp('zp-roots-link-');
  // CLAUDE_CONFIG_DIR=<link to ~>: its projects folder is really ~/projects.
  fs.symlinkSync(home, j(elsewhere, 'to-home'), 'dir');
  fs.mkdirSync(j(home, 'projects'));
  assert.deepEqual(claude.rootInfo({ CLAUDE_CONFIG_DIR: j(elsewhere, 'to-home') }, home), [
    { path: j(elsewhere, 'to-home', 'projects'), ignored: 'too broad' },
  ]);
  // A projects folder that is itself a link to ~ is refused too.
  fs.mkdirSync(j(elsewhere, 'cfg'));
  fs.symlinkSync(home, j(elsewhere, 'cfg', 'projects'), 'dir');
  assert.deepEqual(claude.roots({ ZAAFPULSE_CLAUDE_DIRS: j(elsewhere, 'cfg') }, home), []);
  fs.symlinkSync(fs.realpathSync(os.tmpdir()), j(elsewhere, 'cx'), 'dir');
  assert.deepEqual(codex.rootInfo({ CODEX_HOME: j(elsewhere, 'cx') }, home)[0].ignored, undefined, 'a real folder');
  fs.rmSync(elsewhere, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('claude roots: a root at the top of a drive or directly in the home folder is ignored as too broad', () => {
  const home = abs('h', 'me');
  const info = claude.rootInfo({ ZAAFPULSE_CLAUDE_DIRS: `${abs()},~,${home},~/Documents,${abs('ok')}` }, home);
  assert.deepEqual(info, [
    { path: abs('projects'), ignored: 'too broad' },
    { path: j(home, 'projects'), ignored: 'too broad' },
    { path: j(home, 'projects'), ignored: 'too broad' },
    { path: j(home, 'Documents', 'projects') }, // a folder inside the home is fine: ~/Documents/projects
    { path: abs('ok', 'projects') },
  ]);
  assert.deepEqual(claude.roots({ ZAAFPULSE_CLAUDE_DIRS: `${abs()},~` }, home), [], 'nothing is read from them');
  assert.deepEqual(codex.rootInfo({ CODEX_HOME: abs() }, home), [{ path: abs('sessions'), ignored: 'too broad' }]);
  assert.deepEqual(codex.roots({ CODEX_HOME: home }, home), []);
});

test('roots: a relative Claude folder or CODEX_HOME is ignored, never resolved against the working folder', () => {
  const home = abs('h', 'me');
  assert.deepEqual(claude.rootInfo({ ZAAFPULSE_CLAUDE_DIRS: `rel/dir,${abs('ok')}` }, home), [
    { path: 'rel/dir', ignored: 'not absolute' },
    { path: abs('ok', 'projects') },
  ]);
  assert.deepEqual(claude.roots({ CLAUDE_CONFIG_DIR: '../x' }, home), []);
  assert.deepEqual(codex.rootInfo({ CODEX_HOME: 'cx' }, home), [{ path: 'cx', ignored: 'not absolute' }]);
  assert.deepEqual(codex.roots({ CODEX_HOME: 'cx' }, home), []);
  assert.deepEqual(codex.listFiles({ CODEX_HOME: 'cx' }, home), []);
});

test('ignored roots are listed by describeRoots with their reason and hold no files', () => {
  const home = abs('h', 'me');
  const info = claude.rootInfo({ ZAAFPULSE_CLAUDE_DIRS: `~,rel` }, home);
  assert.deepEqual(describeRoots({ claude: info }, { [j(home, 'projects', 'x.jsonl')]: { source: 'claude' } }, home), [
    { tool: 'claude', path: '~/projects', exists: false, files: 0, ignored: 'too broad' },
    { tool: 'claude', path: 'rel', exists: false, files: 0, ignored: 'not absolute' },
  ]);
});

test('roots: a root that is a link to an earlier root is listed once, and its files are not counted twice', (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows');
  const home = tmp('zp-roots-');
  const a = put(j(home, '.claude', 'projects', '-p', 's1.jsonl'));
  fs.mkdirSync(j(home, '.config'), { recursive: true });
  fs.symlinkSync(j(home, '.claude'), j(home, '.config', 'claude')); // ~/.config/claude -> ~/.claude
  assert.deepEqual(claude.roots({}, home), [j(home, '.config', 'claude', 'projects')], 'the first spelling is kept');
  const b = j(home, '.config', 'claude', 'projects', '-p', 's1.jsonl');
  assert.deepEqual(claude.listFiles({}, home), [b]);
  assert.equal(fs.realpathSync(a), fs.realpathSync(b));
  // Separate roots (ZAAFPULSE_CLAUDE_DIRS) reaching the same files through a link do not double-list them either.
  const env = { ZAAFPULSE_CLAUDE_DIRS: `${j(home, '.claude')},${j(home, 'alias')}` };
  fs.mkdirSync(j(home, 'alias'));
  fs.symlinkSync(j(home, '.claude', 'projects'), j(home, 'alias', 'projects'), 'dir');
  assert.equal(claude.listFiles(env, home).length, 1);
});

test('installed apps: Claude Code counts as installed when any resolved log folder exists', () => {
  const processes = require('../lib/processes');
  const home = tmp('zp-roots-');
  put(j(home, 'work', 'projects', '-p', 's.jsonl'));
  const saved = { ...process.env };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CLAUDE_CONFIG_DIR = j(home, 'work');
    delete process.env.CODEX_HOME;
    const got = processes.installed();
    assert.ok(got.includes('claude'));
    assert.ok(!got.includes('codex'));
  } finally {
    for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
});

test('codex roots: CODEX_HOME/sessions when set, else ~/.codex/sessions', () => {
  const home = abs('h', 'me');
  assert.deepEqual(codex.roots({}, home), [j(home, '.codex', 'sessions')]);
  assert.deepEqual(codex.roots({ CODEX_HOME: '~/cx' }, home), [j(home, 'cx', 'sessions')]);
  assert.deepEqual(codex.roots({ CODEX_HOME: '  ' }, home), [j(home, '.codex', 'sessions')]);
});

test('ROOT is the first existing root, else the legacy folder', () => {
  const home = tmp('zp-roots-');
  assert.equal(claude.firstRoot({}, home), j(home, '.claude', 'projects'));
  put(j(home, '.config', 'claude', 'projects', 'p', 's.jsonl'));
  assert.equal(claude.firstRoot({}, home), j(home, '.config', 'claude', 'projects'));
  assert.equal(codex.firstRoot({}, home), j(home, '.codex', 'sessions'));
  assert.ok(Array.isArray(claude.ROOTS) && typeof claude.ROOT === 'string');
  assert.ok(Array.isArray(codex.ROOTS) && typeof codex.ROOT === 'string');
});

test('claude listFiles finds logs in the XDG folder and ~/.claude together', () => {
  const home = tmp('zp-roots-');
  const a = put(j(home, '.config', 'claude', 'projects', '-Users-me-app', 's1.jsonl'));
  const b = put(j(home, '.claude', 'projects', '-Users-me-old', 's2.jsonl'));
  put(j(home, '.claude', 'projects', '-Users-me-old', 'notes.txt'));
  assert.deepEqual(claude.listFiles({}, home).sort(), [a, b].sort());
});

test('claude listFiles walks every ZAAFPULSE_CLAUDE_DIRS root, and the project name comes from the right root', () => {
  const home = tmp('zp-roots-');
  const c1 = j(home, 'work');
  const c2 = j(home, 'personal');
  const f1 = put(j(c1, 'projects', '-Users-me-alpha', 's1.jsonl'));
  const f2 = put(j(c2, 'projects', '-Users-me-beta', 's2.jsonl'));
  put(j(home, '.claude', 'projects', '-Users-me-ignored', 's3.jsonl')); // not listed: the variable is set
  const env = { ZAAFPULSE_CLAUDE_DIRS: `${c1},${c2}` };
  assert.deepEqual(claude.listFiles(env, home).sort(), [f1, f2].sort());
  assert.equal(claude.projectFromDir(f1, env, home), '/Users/me/alpha');
  assert.equal(claude.projectFromDir(f2, env, home), '/Users/me/beta');
});

test('codex listFiles reads CODEX_HOME/sessions', () => {
  const home = tmp('zp-roots-');
  const f = put(j(home, 'cx', 'sessions', '2026', '10', '21', 'rollout-1.jsonl'));
  assert.deepEqual(codex.listFiles({ CODEX_HOME: j(home, 'cx') }, home), [f]);
  assert.deepEqual(codex.listFiles({}, home), []);
});

test('trace content serves only .jsonl files, even inside a root', async () => {
  const home = tmp('zp-roots-');
  const log = put(j(home, '.claude', 'projects', 'p', 's.jsonl'));
  const other = put(j(home, '.claude', 'projects', 'p', 'notes.txt'), 'private notes\n');
  const c = createContent({ roots: claude.roots({}, home) });
  assert.ok((await c.read({ f: log, s: 0, e: 5, k: 'raw' })).text);
  await assert.rejects(c.read({ f: other, s: 0, e: 5, k: 'raw' }), { status: 403, message: /not a log file/ });
  if (process.platform !== 'win32') {
    const link = j(home, '.claude', 'projects', 'p', 'link.jsonl');
    fs.symlinkSync(other, link);
    await assert.rejects(c.read({ f: link, s: 0, e: 5, k: 'raw' }), { status: 403 });
  }
});

test('trace content reads from every resolved root and refuses everything else with 403', async () => {
  const home = tmp('zp-roots-');
  const inXdg = put(j(home, '.config', 'claude', 'projects', 'p', 's.jsonl'));
  const outside = put(j(tmp('zp-outside-'), 's.jsonl'));
  const c = createContent({ roots: [...claude.roots({}, home), ...codex.roots({}, home)] });
  const r = await c.read({ f: inXdg, s: 0, e: 5, k: 'raw' });
  assert.ok(r && typeof r.text === 'string');
  await assert.rejects(c.read({ f: outside, s: 0, e: 4, k: 'raw' }), { status: 403 });
});

test('describeRoots: ~ paths, existence and the number of indexed files per root', () => {
  const home = tmp('zp-roots-');
  const a = put(j(home, '.claude', 'projects', 'p', 's.jsonl'));
  const b = put(j(home, '.claude', 'projects', 'p', 't.jsonl'));
  const files = {
    [a]: { source: 'claude' },
    [b]: { source: 'claude' },
    [j(home, 'elsewhere', 'x.jsonl')]: { source: 'codex' },
  };
  const got = describeRoots({ claude: claude.roots({}, home), codex: codex.roots({}, home) }, files, home);
  assert.deepEqual(got, [
    { tool: 'claude', path: '~/.config/claude/projects', exists: false, files: 0 },
    { tool: 'claude', path: '~/.claude/projects', exists: true, files: 2 },
    { tool: 'codex', path: '~/.codex/sessions', exists: false, files: 0 },
  ]);
});

// ---- the dashboard ----

const MISSING = [
  { tool: 'claude', path: '~/.claude/projects', exists: false, files: 0 },
  { tool: 'claude', path: '~/.config/claude/projects', exists: false, files: 0 },
  { tool: 'codex', path: '~/.codex/sessions', exists: false, files: 0 },
];
const IDLE = { indexing: false, done: 0, total: 0, lastScan: 1 };

test('emptyLogsNote: names every folder it looked in and how to point at another one', () => {
  const t = emptyLogsNote(MISSING, IDLE, 0);
  assert.match(t, /^No Claude Code or Codex logs found\./);
  assert.match(t, /~\/\.claude\/projects \(missing\) · ~\/\.config\/claude\/projects \(missing\) · ~\/\.codex\/sessions \(missing\)/);
  assert.match(t, /CLAUDE_CONFIG_DIR or CODEX_HOME before starting ZAAFPulse/);
  assert.match(t, /Claude Desktop, ChatGPT and other chat apps keep no readable logs; they show as apps only\./);
});

test('emptyLogsNote: shows the first index instead of zeros, and nothing once there are sessions or logs', () => {
  assert.equal(
    emptyLogsNote(MISSING, { indexing: true, done: 12, total: 40, lastScan: null }, 0),
    'Indexing your logs… 12/40 files',
  );
  assert.equal(emptyLogsNote(MISSING, { indexing: true, done: 0, total: 0, lastScan: null }, 0), 'Indexing your logs…');
  assert.equal(emptyLogsNote(MISSING, { indexing: true, done: 1, total: 40 }, 5), '');
  assert.equal(emptyLogsNote(MISSING, IDLE, 5), '');
  assert.equal(emptyLogsNote(MISSING, { indexing: false, lastScan: null }, 0), '', 'not scanned yet');
  assert.equal(emptyLogsNote(undefined, IDLE, 0), '', 'no diagnostics loaded');
  const found = [{ tool: 'claude', path: '~/.claude/projects', exists: true, files: 3 }];
  assert.equal(emptyLogsNote(found, IDLE, 0), '', 'logs exist; the range is only quiet');
});

test('emptyLogsNote: an ignored folder says why', () => {
  const t = emptyLogsNote([{ tool: 'claude', path: '~/projects', exists: false, files: 0, ignored: 'too broad' }], IDLE, 0);
  assert.match(t, /~\/projects \(ignored: too broad\)/);
});

test('emptyLogsNote: output is plain text built from the given values (the page escapes it)', () => {
  const t = emptyLogsNote([{ tool: 'claude', path: '<img src=x>', exists: true, files: 0 }], IDLE, 0);
  assert.match(t, /<img src=x> \(empty\)/);
  assert.equal(typeof t, 'string');
});

// ---- the API and the doctor command ----

const freePort = () => 6100 + Math.floor(Math.random() * 800);

async function withServer(env, fn) {
  const data = tmp('zp-roots-api-');
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = freePort();
    const child = spawn(process.execPath, [j(ROOT, 'server.js')], {
      env: {
        ...process.env,
        ZAAFPULSE_AUTH: 'none',
        ZAAFPULSE_CONTENT: '',
        DEMO: '',
        CLAUDE_CONFIG_DIR: '',
        ZAAFPULSE_CLAUDE_DIRS: '',
        CODEX_HOME: '',
        XDG_CONFIG_HOME: '',
        ...NO_JUDGE_PORTS,
        ...env,
        ZAAFPULSE_PORT: String(port),
        ZAAFPULSE_DATA: data,
        HOME: data,
        USERPROFILE: data,
      },
      stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 80 && !exited; i++) {
        try {
          await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
          await new Promise((r) => setTimeout(r, 200));
          if (!exited) return await fn({ base, data });
          break;
        } catch (err) {
          if (err.name === 'AssertionError') throw err;
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    } finally {
      if (!exited) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill();
        await gone;
      }
      fs.rmSync(data, { recursive: true, force: true });
    }
  }
  throw new Error('could not start server.js');
}

test('GET /api/live carries logRoots with ~ paths, existence and file counts', async () => {
  // The server's HOME is its data folder, so the logs are seeded there once it is up.
  await withServer({}, async ({ base, data: home }) => {
    put(j(home, '.config', 'claude', 'projects', '-p', 's.jsonl'));
    await fetch(`${base}/api/rescan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    let live;
    for (let i = 0; i < 40; i++) {
      live = await (await fetch(`${base}/api/live`)).json();
      if (live.logRoots.some((r) => r.files === 1)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual(live.logRoots, [
      { tool: 'claude', path: '~/.config/claude/projects', exists: true, files: 1 },
      { tool: 'claude', path: '~/.claude/projects', exists: false, files: 0 },
      { tool: 'codex', path: '~/.codex/sessions', exists: false, files: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(live.logRoots), /\/Users\/|\/tmp\/|\/var\/|[A-Za-z]:\\/);
  });
});

test('doctor lists the roots, counts and the data folder from a temp HOME and exits 0', async () => {
  const home = tmp('zp-roots-doc-');
  put(j(home, '.config', 'claude', 'projects', '-p', 's.jsonl'), 'SECRET-TRANSCRIPT-TEXT\n');
  put(j(home, 'cx', 'sessions', '2026', 'r.jsonl'));
  const r = spawnSync(process.execPath, [j(ROOT, 'bin', 'zaafpulse.js'), 'doctor'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ZAAFPULSE_DATA: j(home, 'data'),
      ZAAFPULSE_PORT: '9',
      CLAUDE_CONFIG_DIR: '',
      ZAAFPULSE_CLAUDE_DIRS: '',
      CODEX_HOME: j(home, 'cx'),
      XDG_CONFIG_HOME: '',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /~\/\.config\/claude\/projects\s+1 \.jsonl file\n/);
  assert.match(r.stdout, /~\/\.claude\/projects\s+missing/);
  assert.match(r.stdout, /~\/cx\/sessions\s+1 \.jsonl file\n/);
  assert.match(r.stdout, /CODEX_HOME\s+set/);
  assert.match(r.stdout, /CLAUDE_CONFIG_DIR\s+not set/);
  assert.match(r.stdout, /newest/i);
  assert.match(r.stdout, /Data folder/);
  assert.match(r.stdout, /not (running|answering)/i);
  assert.doesNotMatch(r.stdout, /SECRET-TRANSCRIPT-TEXT/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor shows ignored folders with the reason and does not read them', () => {
  const home = tmp('zp-roots-doc-');
  put(j(home, 'projects', 'x', 's.jsonl')); // ~/projects would be read if a folder of ~ were accepted
  const r = spawnSync(process.execPath, [j(ROOT, 'bin', 'zaafpulse.js'), 'doctor'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ZAAFPULSE_DATA: j(home, 'data'),
      ZAAFPULSE_PORT: '9',
      CLAUDE_CONFIG_DIR: '',
      ZAAFPULSE_CLAUDE_DIRS: `${home},relative/dir`,
      CODEX_HOME: '',
      XDG_CONFIG_HOME: '',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /~\/projects\s+ignored: too broad/);
  assert.match(r.stdout, /relative\/dir\s+ignored: not absolute/);
  assert.match(r.stdout, /Claude Code\s+no logs found/);
  assert.match(r.stdout, /ZAAFPULSE_CLAUDE_DIRS\s+set/, 'the list variable is named too');
  fs.rmSync(home, { recursive: true, force: true });
});

test('docs: one CLAUDE_CONFIG_DIR folder, the list in ZAAFPULSE_CLAUDE_DIRS, and the explorer points at both', () => {
  const doc = (f) => fs.readFileSync(j(ROOT, f), 'utf8');
  const install = doc('docs/install.md');
  assert.doesNotMatch(install, /export CLAUDE_CONFIG_DIR=[^\n]*,/, 'no comma list for Claude Code’s own variable');
  assert.match(install, /\| `ZAAFPULSE_CLAUDE_DIRS` \|/);
  assert.match(install, /one folder only; use ZAAFPULSE_CLAUDE_DIRS for several/);
  const readme = doc('README.md');
  assert.doesNotMatch(readme, /each folder in `CLAUDE_CONFIG_DIR` \(comma-separated/);
  assert.match(readme, /`ZAAFPULSE_CLAUDE_DIRS`[^\n]*when it is set; otherwise from `\$CLAUDE_CONFIG_DIR\/projects`/);
  const explorer = doc('docs/explorer.md');
  assert.doesNotMatch(explorer, /not honoured/);
  const old = /Text is read from `~\/\.claude\/projects` and `~\/\.codex\/sessions`\s+and nowhere else/;
  assert.doesNotMatch(explorer, old);
  assert.match(explorer, /install\.md#where-the-logs-are-read-from/);
  assert.match(explorer, /403 "not a\s+log file"/);
  assert.match(explorer, /savedOutput/);
});

test('Overview: the live poll redraws the note as indexing goes on and reloads the summary once, when it ends', () => {
  const going = 'Indexing your logs… 12/40 files';
  assert.equal(liveNoteStep(going, 'Indexing your logs… 13/40 files', false), 'render', 'progress: redraw only');
  assert.equal(liveNoteStep(going, going, false), null);
  assert.equal(liveNoteStep(going, '', true), 'summary', 'the index finished: the numbers are new');
  assert.equal(liveNoteStep('', '', true), null, 'no note: the minute poll is enough');
  assert.equal(liveNoteStep('No Claude Code or Codex logs found.', '', false), 'render');
  const app = fs.readFileSync(j(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /liveNoteStep\(/);
  assert.doesNotMatch(app, /overviewNote\(state\.data\) !== state\.logNote/, 'no summary reload per progress step');
});
