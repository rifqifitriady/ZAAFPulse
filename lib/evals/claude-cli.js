// The "Claude Code" judge: the owner's own Claude Code CLI, signed in with their Claude account, run once per
// judgment. It is an external judge (the masked text leaves the machine: to Anthropic, or wherever the CLI's own
// environment points it, see destinationOf), so the engine treats it like a gateway provider: chosen only by hand, a
// preview first, the caps after. Each call runs with no tools, no MCP, no settings, no slash commands and no session
// file, in a fresh empty folder that is removed afterwards, and the turn text goes in on stdin, never in argv (argv
// is visible in `ps`).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { maskPii } = require('./pii');
const { configDir } = require('../claude');

const PROVIDER = 'claude-code';
const KIND = 'claude-cli';
const MISSING = 'Claude Code not found: install it, or set ZAAFPULSE_CLAUDE_BIN';
const SIGNED_OUT = 'Claude Code is not signed in';
// The judge's working folders are named so; a session that ran in one is the judge's own and is never judged.
const DIR_PREFIX = 'zaafpulse-judge-';
const DRAIN_MS = 1000; // after the CLI exits, how long a helper may hold the pipes before the group is stopped
const CACHE_MS = 5 * 60e3;
const VERSION_MS = 10e3;
const CALL_MS = 120e3;
const GRACE_MS = 5e3; // SIGTERM, then SIGKILL this much later
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 4096;
const EXTENSION_DIRS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.antigravity-ide', '.antigravity'];
const EXTENSION = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;
const VERSION = /^\d+(?:\.\d+)*$/;
const CLAUDE_VERSION = /(\d+\.\d+(?:\.\d+)*)\s*\(Claude Code\)/;
// Variables a parent Claude Code session, the Agent SDK or VS Code sets for its own children: a session id, an IDE
// or messaging socket and its token, plugin folders, feature switches. The judge is no child of theirs.
const INHERITED = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_AGENT_SDK_/,
  /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|EXECPATH|CHILD_SESSION|PLUGIN_DIRS|EMIT_STARTUP_TIMING|QUESTION_PREVIEW_FORMAT)$/,
  /^CLAUDE_CODE_(IDE|SESSION|MESSAGING)_/,
  /^CLAUDE_CODE_ENABLE_(FUNCTION_HOOKS|SDK_FILE_CHECKPOINTING|TASKS)$/,
  /^VSCODE_/,
];
// An alias (haiku, sonnet, opus) or a full model name. It goes into argv after --model, so a value that starts with
// a dash, or holds anything but name characters, is refused: it could be read as another flag.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,99}$/;

function fail(status, message) {
  const err = new Error(String(message || '').slice(0, 160));
  err.status = status;
  return err;
}
// A message from the CLI may name a file or the account: paths go (as in the trace reasons), personal data is masked.
const scrub = (s) =>
  maskPii(String(s || ''))
    .replace(/(['"`])(?:(?!\1).)*[\\/](?:(?!\1).)*\1/g, '<path>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

// The environment a child gets: the owner's (Claude Code needs HOME and its login, and an API-key or router setup
// must keep working), without the dashboard's own ZAAFPULSE_* settings and without what a parent session or IDE
// set for its own children (INHERITED). CLAUDE_CONFIG_DIR picks the Claude login: it is passed on only as the one
// folder ZAAFPulse reads it as (lib/claude configDir, `~` expanded). A list, a relative or a too-broad value is
// dropped, so the child uses Claude Code's default folder, and said once per value.
const dropped = new Set();
function childEnv(env, { home = os.homedir(), log = (m) => console.warn(m) } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith('ZAAFPULSE_') || INHERITED.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  if (out.CLAUDE_CONFIG_DIR !== undefined) {
    const c = configDir(out, home);
    if (c && c.dir) out.CLAUDE_CONFIG_DIR = c.dir;
    else {
      const raw = String(out.CLAUDE_CONFIG_DIR);
      delete out.CLAUDE_CONFIG_DIR;
      if (c && !dropped.has(raw)) {
        dropped.add(raw);
        log(`Claude Code judge: CLAUDE_CONFIG_DIR is not passed to Claude Code (${c.ignored}); it uses its default.`);
      }
    }
  }
  return out;
}

// Claude Code's own rule for a switch (read from its binary): 1, true, yes and on are on; 0, false, no, off and empty
// are off. Anything else is neither: shown as a question, and a destination of its own.
const ON = new Set(['1', 'true', 'yes', 'on']);
const OFF = new Set(['0', 'false', 'no', 'off', '']);
const flag = (v) => {
  if (v === undefined || v === null) return 'off';
  const x = String(v).trim().toLowerCase();
  return ON.has(x) ? 'on' : OFF.has(x) ? 'off' : 'unknown';
};
const hostOf = (v) => {
  try {
    return new URL(String(v).trim()).host || ''; // no user name or password, no path
  } catch {
    return '';
  }
};
// The ways Claude Code routes its requests (CLAUDE_CODE_USE_* names found in its 2.1.304 binary), in the order they
// are checked here, with the base URL that moves each one and who bills it.
const ROUTES = [
  ['CLAUDE_CODE_USE_BEDROCK', 'AWS Bedrock', 'ANTHROPIC_BEDROCK_BASE_URL', 'AWS'],
  ['CLAUDE_CODE_USE_MANTLE', 'AWS Bedrock (Mantle)', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'AWS'],
  ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI', 'ANTHROPIC_VERTEX_BASE_URL', 'GCP'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry', 'ANTHROPIC_FOUNDRY_BASE_URL', 'Azure'],
  ['CLAUDE_CODE_USE_ANTHROPIC_AWS', 'Claude Platform on AWS', 'ANTHROPIC_AWS_BASE_URL', 'AWS'],
  ['CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'Claude on Google Cloud', 'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'GCP'],
];
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN'];
const BASE_URL = /^ANTHROPIC_[A-Z_]*BASE_URL$/;
// The cloud account and region a route uses, and the Claude config folder (it holds the login, so the account): a
// switch of any is another destination. Only their hash counts.
const ACCOUNT = ['AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'CLAUDE_CONFIG_DIR'];
// Without ANTHROPIC_FOUNDRY_BASE_URL, Foundry's host comes from the resource name.
const foundryHost = (e) => {
  const r = String(e.ANTHROPIC_FOUNDRY_RESOURCE || '').trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(r) ? `${r}.services.ai.azure.com` : '';
};

// Where the CLI sends the text and who pays, from the environment it gets: the first cloud route switched on (with
// the host of its own base URL), else a gateway or the host of ANTHROPIC_BASE_URL, else Anthropic. A cloud bills the
// cloud account; otherwise an API key or token means API billing, and none the Claude login. Managed or policy
// settings of Claude Code can route it too; those are not seen here.
// The token confirms one destination: a short hash of every CLAUDE_CODE_USE_* switch (name and on, off or the odd
// value), the host of every ANTHROPIC_*_BASE_URL (and of the Foundry resource), which keys are present (never their
// values) and the cloud account, region and Claude config folder (hashed, never shown). A preview confirms
// what it showed, and any change asks for a new one.
function destinationOf(env, opts) {
  const e = childEnv(env, opts); // what the child gets: CLAUDE_CONFIG_DIR as the folder it is passed on as, or none
  const odd = [];
  for (const [name] of ROUTES.concat([['CLAUDE_CODE_USE_GATEWAY']])) {
    if (e[name] !== undefined && flag(e[name]) === 'unknown') {
      odd.push(`${name}=${String(e[name]).trim().slice(0, 20).replace(/[^\w.-]/g, '')}?`);
    }
  }
  const route = ROUTES.find(([name]) => flag(e[name]) === 'on');
  let to;
  let billing;
  if (route) {
    let host = e[route[2]] ? hostOf(e[route[2]]) : '';
    if (!host && route[0] === 'CLAUDE_CODE_USE_FOUNDRY') host = foundryHost(e);
    to = host ? `${route[1]} via ${host}` : route[1];
    billing = `your cloud account (${route[3]})`;
  } else {
    if (e.ANTHROPIC_BASE_URL && String(e.ANTHROPIC_BASE_URL).trim()) {
      const by = flag(e.CLAUDE_CODE_USE_GATEWAY) === 'on' ? 'CLAUDE_CODE_USE_GATEWAY' : 'ANTHROPIC_BASE_URL';
      to = `${hostOf(e.ANTHROPIC_BASE_URL) || 'a custom address'} (${by})`;
    } else to = 'Anthropic';
    billing = e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN ? 'API billing' : 'your Claude login';
  }
  if (odd.length) to = `${to} (${odd.join(', ')})`;
  const text = route
    ? `${to}, billed to ${billing}`
    : billing === 'API billing'
      ? `${to}, with API billing`
      : `${to}, through your Claude login`;
  const parts = [];
  for (const k of Object.keys(e).sort()) {
    if (k.startsWith('CLAUDE_CODE_USE_')) {
      const f = flag(e[k]);
      parts.push(`use:${k}=${f === 'unknown' ? `?${String(e[k]).trim()}` : f}`);
    } else if (BASE_URL.test(k) && String(e[k]).trim()) parts.push(`url:${k}=${hostOf(e[k]) || '?'}`);
  }
  if (!e.ANTHROPIC_FOUNDRY_BASE_URL && e.ANTHROPIC_FOUNDRY_RESOURCE) {
    parts.push(`url:ANTHROPIC_FOUNDRY_RESOURCE=${foundryHost(e) || `?${String(e.ANTHROPIC_FOUNDRY_RESOURCE).trim()}`}`);
  }
  for (const k of KEYS) if (e[k]) parts.push(`key:${k}`);
  // The value goes into the hash only; the token shows 10 hex characters of it, never the value.
  for (const k of ACCOUNT) if (e[k] && String(e[k]).trim()) parts.push(`acct:${k}=${String(e[k]).trim()}`);
  // Switched off counts as not set, so `CLAUDE_CODE_USE_BEDROCK=0` is the same destination as no variable at all.
  const input = parts.filter((x) => !x.endsWith('=off')).join('\n');
  const hash = crypto.createHash('sha256').update(input).digest('hex').slice(0, 10);
  return { to, billing, text, token: `${PROVIDER}@${hash}` };
}

// How a working folder is removed. Windows keeps a folder locked for a moment after the process that worked in it
// has gone, so there it is tried a few times.
const removeOpts = (platform) => ({
  recursive: true,
  force: true,
  ...(platform === 'win32' ? { maxRetries: 3, retryDelay: 100 } : {}),
});

// The calls running now, so a shutdown can stop them and remove their folders at once (see stopAll).
const RUNNING = new Set();
let exitHook = false;
function stopRunning() {
  for (const r of [...RUNNING]) r.kill();
}
// The pids of the calls running now, so the running-apps list leaves them out.
const runningPids = () => new Set([...RUNNING].map((r) => r.pid).filter(Boolean));

function createClaude({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  now = Date.now,
  cacheMs = CACHE_MS,
  versionMs = VERSION_MS,
  systemDirs = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'],
  // Where a real node is looked for when this process is the single-file build (its execPath is not node).
  nodeDirs = platform === 'win32'
    ? [env.ProgramFiles && path.win32.join(env.ProgramFiles, 'nodejs')].filter(Boolean)
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
  isSea = () => require('../platform').isSea(),
  log = (m) => console.warn(m),
  removeDir = (dir) => fs.rmSync(dir, removeOpts(platform)),
} = {}) {
  const win = platform === 'win32';
  const childOpts = { home, log };
  const join = win ? path.win32.join : path.posix.join;
  const absolute = win ? path.win32.isAbsolute : path.posix.isAbsolute;
  const exe = win ? 'claude.exe' : 'claude';
  let cache = null; // { at, value: Promise<bin|null> }
  let nodeCache = null; // Promise<string|null>

  const SCRIPT = /\.[cm]?js$/i;
  // On POSIX a binary found on its own that another user could replace is not run: the file and its folder (also of
  // the real file behind a link) must belong to this user or root and must not be writable by everyone. Writable by
  // the group is allowed: it is what umask 002 (Ubuntu's default) gives every install.
  const trusted = (f) => {
    if (win || typeof process.getuid !== 'function') return true;
    const uid = process.getuid();
    try {
      for (const p of new Set([f, fs.realpathSync(f)])) {
        for (const x of [p, path.dirname(p)]) {
          const st = fs.statSync(x);
          if (st.mode & 0o002 || (st.uid !== uid && st.uid !== 0)) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  // A script is run through node, so it only has to exist; anything else must be executable. The binary the owner
  // named in ZAAFPULSE_CLAUDE_BIN is taken as given (`named`); one found on its own must also be trusted.
  const usable = (f, named = false) => {
    try {
      if (!fs.statSync(f).isFile()) return false;
      if (!win && !SCRIPT.test(f)) fs.accessSync(f, fs.constants.X_OK);
      return named || trusted(f);
    } catch {
      return false;
    }
  };
  const pathDirs = () =>
    String(env.PATH || env.Path || '')
      .split(win ? ';' : ':')
      .filter((d) => d && absolute(d)); // a relative entry would depend on the folder the server started in
  const listDir = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };

  // The node that runs a script: this process's own, unless this is the single-file build, whose execPath is
  // ZAAFPulse itself; then a node on PATH or in the usual folders that answers `--version`, or none.
  function nodeBin() {
    if (!isSea()) return Promise.resolve(process.execPath);
    if (nodeCache) return nodeCache;
    const name = win ? 'node.exe' : 'node';
    nodeCache = (async () => {
      for (const d of [...pathDirs(), ...nodeDirs]) {
        const f = join(d, name);
        if (!usable(f)) continue;
        const v = await versionOf({ file: f, args: [] }, /^v\d+\.\d+/);
        if (v) return f;
      }
      return null;
    })();
    return nodeCache;
  }

  // How a file is started without a shell: a script through node, an npm .cmd wrapper through the package it wraps
  // (Windows runs a .cmd only through cmd.exe), anything else as it is.
  async function toBin(file) {
    let script = SCRIPT.test(file) ? file : null;
    if (/\.(cmd|bat)$/i.test(file)) {
      const pkg = join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
      const native = join(pkg, 'bin', 'claude.exe');
      if (usable(native)) return { file: native, args: [] };
      const cli = join(pkg, 'cli.js');
      if (!usable(cli)) return null;
      script = cli;
    }
    if (!script) return { file, args: [] };
    const node = await nodeBin();
    return node ? { file: node, args: [script] } : null;
  }

  // Every place Claude Code is usually installed, in the order they are tried. An IDE extension or the copy that
  // ships with Claude Desktop carries its version in the folder name, and the highest of those wins.
  function candidates() {
    const out = [];
    for (const dir of pathDirs()) {
      out.push(join(dir, exe));
      if (win) out.push(join(dir, 'claude.cmd'));
    }
    if (win) {
      out.push(join(home, '.local', 'bin', 'claude.exe'), join(home, '.claude', 'local', 'claude.exe'));
      if (env.APPDATA) out.push(join(env.APPDATA, 'npm', 'claude.cmd'));
    } else {
      out.push(join(home, '.claude', 'local', 'claude'), join(home, '.local', 'bin', 'claude'));
      for (const d of systemDirs) out.push(join(d, 'claude'));
    }
    const versioned = [];
    for (const d of EXTENSION_DIRS) {
      const root = join(home, d, 'extensions');
      for (const name of listDir(root)) {
        const m = EXTENSION.exec(name);
        if (m) versioned.push({ version: m[1], file: join(root, name, 'resources', 'native-binary', exe) });
      }
    }
    if (platform === 'darwin') {
      const root = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
      for (const v of listDir(root).filter((x) => VERSION.test(x))) {
        for (const h of listDir(join(root, v))) {
          versioned.push({ version: v, file: join(root, v, h, 'claude.app', 'Contents', 'MacOS', 'claude') });
        }
      }
    }
    versioned.sort((a, b) => cmpVersion(b.version, a.version));
    return [...out, ...versioned.map((x) => x.file)];
  }

  // What `--version` printed, matched against `re`, within 10 s; null otherwise.
  function versionOf(bin, re) {
    return new Promise((resolve) => {
      execFile(
        bin.file,
        [...bin.args, '--version'],
        {
          timeout: versionMs,
          killSignal: 'SIGKILL', // a binary that ignores SIGTERM must not hold the search past the time limit
          windowsHide: true,
          env: childEnv(env, childOpts),
          cwd: os.tmpdir(),
          maxBuffer: 64 * 1024,
        },
        (err, stdout) => {
          const m = !err && re.exec(String(stdout));
          resolve(m ? m[1] || m[0] : null);
        },
      );
    });
  }
  // A binary counts once `--version` says it is Claude Code ("2.1.304 (Claude Code)").
  const answers = (bin) => versionOf(bin, CLAUDE_VERSION);

  async function findNow() {
    const forced = typeof env.ZAAFPULSE_CLAUDE_BIN === 'string' ? env.ZAAFPULSE_CLAUDE_BIN.trim() : '';
    // A binary the owner named is the only one tried: a wrong one is reported, not swapped for another install.
    const list = forced ? [forced] : candidates();
    const seen = new Set();
    for (const file of list) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!usable(file, !!forced)) continue;
      const bin = await toBin(file);
      if (!bin) continue;
      const version = await answers(bin);
      if (version) return { ...bin, version };
    }
    return null;
  }

  // The answer (found or not) is kept for 5 minutes, and overlapping callers share one search.
  function find() {
    if (cache && now() - cache.at < cacheMs) return cache.value;
    const entry = { at: now(), value: findNow().catch(() => null) };
    cache = entry;
    return entry.value;
  }
  const available = async () => !!(await find());
  // A binary that no longer starts (removed, replaced) is looked for again on the next call, not in 5 minutes.
  const forget = () => {
    cache = null;
    nodeCache = null;
  };

  // One judgment. Resolves to { text, usage: { input, output, cost }, model }, or throws an error with a status:
  // 0 when nothing answered (timeout, abort, could not start), 401 with `backoff` when the login is gone, 429 for a
  // usage limit, 422 when the model gave no usable answer, 502 when the CLI failed or sent something unreadable.
  // It always settles within timeoutMs + graceMs + 1 s, and the working folder is always removed.
  function run(bin, opts) {
    const { system, user, schema, model, signal } = opts;
    const { timeoutMs = CALL_MS, graceMs = GRACE_MS, maxBytes = MAX_STDOUT } = opts;
    if (!bin || !bin.file) return Promise.reject(fail(0, 'Claude Code not found'));
    if (model && !MODEL_NAME.test(model)) return Promise.reject(fail(400, 'Claude Code model name is not valid'));
    if (signal && signal.aborted) return Promise.reject(fail(0, 'Claude Code call was cancelled'));
    const args = [
      ...bin.args,
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--disallowedTools', // no tools at all; MCP tools are refused once more in case a server is ever loaded
      'mcp__*',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--system-prompt',
      String(system || ''),
      '--json-schema',
      JSON.stringify(schema || {}),
      ...(model ? ['--model', model] : []),
    ];
    // A fresh empty folder, so no CLAUDE.md or project settings are found from the working directory.
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
    } catch {
      return Promise.reject(fail(0, 'Claude Code could not get a working folder'));
    }
    const cleanup = () => {
      try {
        removeDir(dir);
      } catch {
        /* still held (Windows, until the CLI has exited: see 'exit'), or gone; empty and in the temp dir */
      }
    };
    return new Promise((resolve, reject) => {
      let child;
      try {
        // On POSIX the CLI leads its own process group, so a stop reaches every helper it may have started.
        child = spawn(bin.file, args, {
          cwd: dir,
          env: childEnv(env, childOpts),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          detached: !win,
        });
      } catch {
        cleanup();
        forget();
        reject(fail(0, 'Claude Code could not start'));
        return;
      }
      const out = [];
      let outBytes = 0;
      let errText = '';
      let stopped = null; // why the child was stopped: the error the call settles with
      let exited = false;
      let closed = false;
      let exitCode = null;
      let settled = false;
      const timers = [];
      const later = (ms, fn) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        timers.push(t);
      };
      const signalAll = (sig) => {
        if (!win && child.pid) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            /* the group is gone; the child itself may still be there */
          }
        }
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      };
      const entry = {
        pid: child.pid,
        // Synchronous: the group gets SIGKILL and the folder goes now; the call then settles as cancelled.
        kill() {
          stopped = stopped || fail(0, 'Claude Code call was cancelled');
          signalAll('SIGKILL');
          cleanup();
          finish(stopped);
        },
      };
      RUNNING.add(entry);
      if (!exitHook) {
        exitHook = true;
        process.once('exit', stopRunning); // nothing outlives the process that started it
      }
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        RUNNING.delete(entry);
        for (const t of timers) clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
        // A helper that still holds the pipes is stopped, and the streams are let go, so nothing keeps the call open.
        if (!win) signalAll('SIGKILL');
        for (const s of [child.stdin, child.stdout, child.stderr]) s && s.destroy();
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };
      const read = () => {
        if (stopped) return finish(stopped);
        try {
          finish(null, parse(Buffer.concat(out).toString('utf8'), exitCode, errText));
        } catch (e) {
          finish(e);
        }
      };
      const stop = (err) => {
        if (stopped || settled) return;
        stopped = err;
        if (win) child.kill();
        else {
          signalAll('SIGTERM');
          later(graceMs, () => signalAll('SIGKILL'));
        }
        if (exited) finish(stopped); // the CLI is gone already: a helper held the pipes
      };
      // A CLI that has already answered and exited is read, even when the time runs out while a helper holds the pipes.
      later(timeoutMs, () => (exited && !stopped ? read() : stop(fail(0, 'Claude Code timed out'))));
      // The hard bound: whatever holds the pipes or ignores the signals, the call settles.
      later(timeoutMs + graceMs + 1000, () =>
        exited && !stopped ? read() : finish(stopped || fail(0, 'Claude Code timed out')),
      );
      const onAbort = () => stop(fail(0, 'Claude Code call was cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => {
        forget();
        finish(stopped || fail(0, 'Claude Code could not start'));
      });
      child.stdout.on('data', (c) => {
        if (stopped) return;
        outBytes += c.length;
        if (outBytes > maxBytes) return stop(fail(502, 'Claude Code sent too much output'));
        out.push(c);
      });
      child.stderr.on('data', (c) => {
        errText = (errText + c).slice(-MAX_STDERR);
      });
      child.on('exit', (code) => {
        exited = true;
        exitCode = code;
        // Windows frees the folder only now: remove it again, also when the call settled before (a stop, a timeout).
        if (settled) return cleanup();
        if (stopped) return finish(stopped);
        if (closed) return read();
        // The CLI has answered and gone; a helper it started may still hold the pipes. Give the output a moment to
        // arrive, then read what came.
        later(DRAIN_MS, read);
      });
      child.on('close', () => {
        closed = true;
        if (exited) read();
      });
      // The turn text, on stdin only. A child that exits before reading it makes the pipe fail; its exit says why.
      child.stdin.on('error', () => {});
      child.stdin.end(String(user || ''));
    });
  }

  const destination = () => destinationOf(env, childOpts);

  // Stop every running call now (the dashboard is shutting down): SIGKILL to each group, folders removed.
  const stopAll = () => stopRunning();

  return { find, available, run, destination, stopAll };
}

// The CLI's one JSON object, as the judge's text, usage and the model that answered.
function parse(stdout, code, stderr) {
  let j = null;
  const text = stdout.trim();
  try {
    j = JSON.parse(text);
  } catch {
    const last = text.split('\n').filter(Boolean).pop();
    try {
      j = last ? JSON.parse(last) : null;
    } catch {
      j = null;
    }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    if (code !== 0) throw fail(502, `Claude Code failed${stderr.trim() ? `: ${scrub(stderr)}` : ` (exit ${code})`}`);
    throw fail(502, 'Claude Code sent an unreadable answer');
  }
  const why = scrub(typeof j.result === 'string' && j.result ? j.result : j.error || j.subtype || stderr);
  if (j.is_error === true) {
    // A login that is gone (or a key that is refused) fails every call the same way: back off, do not retry each job.
    const auth = j.api_error_status === 401 || j.api_error_status === 403;
    if (auth || /not (signed|logged) in|please run \/login|invalid api key|oauth token (has )?expired/i.test(why)) {
      throw Object.assign(fail(401, SIGNED_OUT), { backoff: true, reason: SIGNED_OUT });
    }
    const status = Number.isInteger(j.api_error_status)
      ? j.api_error_status
      : /usage limit|rate limit|overloaded|\b429\b|\b529\b/i.test(why)
        ? 429
        : 502;
    throw fail(status, `Claude Code: ${why || 'failed'}`);
  }
  if (j.subtype !== 'success') {
    // The model ran out of turns or could not fit the schema: this judgment fails, the CLI itself works.
    throw fail(/^error_max/.test(String(j.subtype)) ? 422 : 502, `Claude Code: ${scrub(j.subtype) || 'failed'}`);
  }
  const so = j.structured_output;
  const out = so && typeof so === 'object' ? JSON.stringify(so) : typeof j.result === 'string' ? j.result : '';
  const u = j.usage && typeof j.usage === 'object' ? j.usage : {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  // The model is the key of modelUsage; with more than one, the one that cost the most did the judging.
  const mu = j.modelUsage && typeof j.modelUsage === 'object' ? Object.entries(j.modelUsage) : [];
  mu.sort((a, b) => n(b[1] && b[1].costUSD) - n(a[1] && a[1].costUSD));
  const model = mu.length && MODEL_NAME.test(mu[0][0]) ? mu[0][0] : null;
  return {
    text: out,
    usage: {
      input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
      output: n(u.output_tokens),
      // The API-equivalent list price of the call, as the CLI works it out; null when it said nothing.
      cost: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null,
    },
    model,
  };
}

module.exports = {
  createClaude,
  childEnv,
  destinationOf,
  removeOpts,
  runningPids,
  PROVIDER,
  KIND,
  MISSING,
  MODEL_NAME,
  DIR_PREFIX,
};
