// The "Claude Code" judge: the owner's own Claude Code CLI, signed in with their Claude account, run once per
// judgment. It is an external judge (the masked text goes to Anthropic), so the engine treats it like a gateway
// provider: chosen only by hand, a preview first, the caps after. Each call runs with no tools, no MCP, no settings,
// no slash commands and no session file, in a fresh empty folder that is removed afterwards, and the turn text goes
// in on stdin, never in argv (argv is visible in `ps`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { maskPii } = require('./pii');

const PROVIDER = 'claude-code';
const KIND = 'claude-cli';
const MISSING = 'Claude Code not found: install it, or set ZAAFPULSE_CLAUDE_BIN';
const CACHE_MS = 5 * 60e3;
const VERSION_MS = 10e3;
const CALL_MS = 120e3;
const GRACE_MS = 5e3; // SIGTERM, then SIGKILL this much later
const MAX_STDOUT = 1024 * 1024;
const MAX_STDERR = 4096;
const EXTENSION_DIRS = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.antigravity-ide', '.antigravity'];
const EXTENSION = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;
const VERSION = /^\d+(?:\.\d+)*$/;
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

// The environment a child gets: the owner's (Claude Code needs HOME and its login), without the dashboard's own
// ZAAFPULSE_* settings, and without the marker that makes Claude Code refuse to start inside another session.
// ZAAFPulse reads CLAUDE_CONFIG_DIR as a comma-separated list of log folders; Claude Code takes one folder, the first.
function childEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (k.startsWith('ZAAFPULSE_') || k === 'CLAUDECODE') continue;
    out[k] = v;
  }
  if (typeof out.CLAUDE_CONFIG_DIR === 'string' && out.CLAUDE_CONFIG_DIR.includes(',')) {
    out.CLAUDE_CONFIG_DIR = out.CLAUDE_CONFIG_DIR.split(',')[0].trim();
  }
  return out;
}

function createClaude({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  now = Date.now,
  cacheMs = CACHE_MS,
  versionMs = VERSION_MS,
  systemDirs = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin'],
} = {}) {
  const win = platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const exe = win ? 'claude.exe' : 'claude';
  let cache = null; // { at, value: Promise<bin|null> }

  const SCRIPT = /\.[cm]?js$/i;
  // A script is run through this Node, so it only has to exist; anything else must be executable.
  const usable = (f) => {
    try {
      if (!fs.statSync(f).isFile()) return false;
      if (!win && !SCRIPT.test(f)) fs.accessSync(f, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const listDir = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };

  // How a file is started without a shell: a script through this Node, an npm .cmd wrapper through the package it
  // wraps (Windows runs a .cmd only through cmd.exe), anything else as it is.
  function toBin(file) {
    if (SCRIPT.test(file)) return { file: process.execPath, args: [file] };
    if (/\.(cmd|bat)$/i.test(file)) {
      const pkg = join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code');
      const native = join(pkg, 'bin', 'claude.exe');
      if (fs.existsSync(native)) return { file: native, args: [] };
      const cli = join(pkg, 'cli.js');
      return fs.existsSync(cli) ? { file: process.execPath, args: [cli] } : null;
    }
    return { file, args: [] };
  }

  // Every place Claude Code is usually installed, in the order they are tried. An IDE extension or the copy that
  // ships with Claude Desktop carries its version in the folder name, and the highest of those wins.
  function candidates() {
    const out = [];
    const pathVar = env.PATH || env.Path || '';
    for (const dir of pathVar.split(win ? ';' : ':').filter(Boolean)) {
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

  // A binary counts once `--version` answers with a version within 10 s.
  function answers(bin) {
    return new Promise((resolve) => {
      execFile(
        bin.file,
        [...bin.args, '--version'],
        { timeout: versionMs, windowsHide: true, env: childEnv(env), cwd: os.tmpdir(), maxBuffer: 64 * 1024 },
        (err, stdout) => {
          const m = !err && /\d+\.\d+(?:\.\d+)*/.exec(String(stdout));
          resolve(m ? m[0] : null);
        },
      );
    });
  }

  async function findNow() {
    const forced = typeof env.ZAAFPULSE_CLAUDE_BIN === 'string' ? env.ZAAFPULSE_CLAUDE_BIN.trim() : '';
    // A binary the owner named is the only one tried: a wrong one is reported, not swapped for another install.
    const list = forced ? [forced] : candidates();
    const seen = new Set();
    for (const file of list) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!usable(file)) continue;
      const bin = toBin(file);
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

  // One judgment. Resolves to { text, usage: { input, output, cost }, model }, or throws an error with a status:
  // 0 when nothing answered (timeout, abort, could not start), 429 for a usage limit, 422 when the model gave no
  // usable answer, 502 when the CLI failed or sent something unreadable.
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
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaafpulse-judge-'));
    } catch {
      return Promise.reject(fail(0, 'Claude Code could not get a working folder'));
    }
    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the folder is empty and in the temp dir; a leftover is harmless */
      }
    };
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin.file, args, {
          cwd: dir,
          env: childEnv(env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        cleanup();
        reject(fail(0, 'Claude Code could not start'));
        return;
      }
      const out = [];
      let outBytes = 0;
      let errText = '';
      let stopped = null; // why the child was stopped: an error to throw once it has exited
      let killer = null;
      let settled = false;
      const stop = (err) => {
        if (stopped) return;
        stopped = err;
        if (win) {
          child.kill();
          return;
        }
        child.kill('SIGTERM');
        killer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        killer.unref?.();
      };
      const timer = setTimeout(() => stop(fail(0, 'Claude Code timed out')), timeoutMs);
      timer.unref?.();
      const onAbort = () => stop(fail(0, 'Claude Code call was cancelled'));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killer);
        if (signal) signal.removeEventListener('abort', onAbort);
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };
      child.on('error', () => finish(stopped || fail(0, 'Claude Code could not start')));
      child.stdout.on('data', (c) => {
        if (stopped) return;
        outBytes += c.length;
        if (outBytes > maxBytes) return stop(fail(502, 'Claude Code sent too much output'));
        out.push(c);
      });
      child.stderr.on('data', (c) => {
        errText = (errText + c).slice(-MAX_STDERR);
      });
      child.on('close', (code) => {
        if (stopped) return finish(stopped);
        try {
          finish(null, parse(Buffer.concat(out).toString('utf8'), code, errText));
        } catch (e) {
          finish(e);
        }
      });
      // The turn text, on stdin only. A child that exits before reading it makes the pipe fail; its exit says why.
      child.stdin.on('error', () => {});
      child.stdin.end(String(user || ''));
    });
  }

  return { find, available, run };
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

module.exports = { createClaude, childEnv, PROVIDER, KIND, MISSING, MODEL_NAME };
