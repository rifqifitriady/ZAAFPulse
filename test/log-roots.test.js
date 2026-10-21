// Where Claude Code and Codex logs are read from: CLAUDE_CONFIG_DIR, the XDG folder, ~/.claude, CODEX_HOME.
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
const { emptyLogsNote } = require('../public/overviewview');
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

test('claude roots: CLAUDE_CONFIG_DIR lists several folders, expands ~, and is the only source', () => {
  const home = abs('h', 'me');
  const a = abs('a', 'one');
  const got = claude.roots({ CLAUDE_CONFIG_DIR: `${a}, ~/second ,, ~`, XDG_CONFIG_HOME: abs('x') }, home);
  assert.deepEqual(got, [j(a, 'projects'), j(home, 'second', 'projects'), j(home, 'projects')]);
});

test('claude roots: repeated folders are listed once', () => {
  const home = abs('h', 'me');
  const a = abs('a');
  assert.deepEqual(claude.roots({ CLAUDE_CONFIG_DIR: `${a},${a}${path.sep},${a}` }, home), [j(a, 'projects')]);
  // XDG_CONFIG_HOME=~ makes ~/claude/projects, which differs; ~/.config as XDG folder must not repeat itself
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: j(home, '.config') }, home), claude.roots({}, home));
  assert.deepEqual(claude.roots({ XDG_CONFIG_HOME: home }, home).length, 2);
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

test('claude listFiles walks every CLAUDE_CONFIG_DIR root, and the project name comes from the right root', () => {
  const home = tmp('zp-roots-');
  const c1 = j(home, 'work');
  const c2 = j(home, 'personal');
  const f1 = put(j(c1, 'projects', '-Users-me-alpha', 's1.jsonl'));
  const f2 = put(j(c2, 'projects', '-Users-me-beta', 's2.jsonl'));
  put(j(home, '.claude', 'projects', '-Users-me-ignored', 's3.jsonl')); // not listed: the variable is set
  const env = { CLAUDE_CONFIG_DIR: `${c1},${c2}` };
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
