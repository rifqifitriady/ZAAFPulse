#!/usr/bin/env node
// zaafpulse: start, set up and manage ZAAFPulse on macOS, Linux and Windows.
//   zaafpulse [start] [--host 0.0.0.0] [--port 4777] [--data DIR] [--demo] [--open]
//   zaafpulse set-password            admin password for server mode (asked twice, or --stdin)
//   zaafpulse service install|uninstall|status|restart [--system] [--host H] [--port P]
//   zaafpulse eval --judge --session <id> [--source claude|codex] [--data DIR] [--json]   judge one session locally
//   zaafpulse status | open | doctor | mcp | register-mcp <client|all> [--remove] | version
const fs = require('fs');
const path = require('path');
const http = require('http');
const platform = require('../lib/platform');
const pkg = require('../package.json');

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['--host', '--port', '--data', '--session', '--source']; // every other flag is a switch
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return VALUE_FLAGS.includes(`--${name}`) ? argv[i + 1] : true;
};
const positional = argv.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(argv[i - 1]));
const cmd =
  argv.includes('--help') || argv.includes('-h')
    ? 'help'
    : argv.includes('--version')
      ? 'version'
      : positional[0] || 'start';

// Flags become the same environment variables the server and the service files use.
if (flag('host')) process.env.ZAAFPULSE_HOST = String(flag('host'));
if (flag('port')) process.env.ZAAFPULSE_PORT = String(flag('port'));
if (flag('data')) process.env.ZAAFPULSE_DATA = path.resolve(platform.expandHome(String(flag('data'))));
const port = () => Number(process.env.ZAAFPULSE_PORT || process.env.PORT) || 4777;
// As root on Linux the service is the system one (installed with --system); otherwise the user's.
const systemMode = () =>
  !!flag('system') || (platform.OS === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0);
const localUrl = () => `http://127.0.0.1:${port()}`;

// The AI clients register-mcp knows, from the script itself so this list never goes stale.
const mcpClients = () => Object.keys(require('../scripts/register-mcp').clients());

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function ping(url = `${localUrl()}/api/session`) {
  return new Promise((resolve) => {
    const r = http.get(url, { timeout: 2000, headers: { host: '127.0.0.1' } }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => {
      r.destroy();
      resolve(false);
    });
  });
}

// Reads a line without echoing it (for passwords); --stdin reads it from a pipe instead.
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let d = '';
      process.stdin.on('data', (c) => {
        d += c;
      });
      process.stdin.on('end', () => resolve(d.split(/\r?\n/)[0]));
      return;
    }
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const on = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', on);
        process.stdout.write('\n');
        resolve(s);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
      else s += ch;
    };
    stdin.on('data', on);
  });
}

const commands = {
  async start() {
    if (flag('demo')) {
      process.env.DEMO = '1';
      process.env.ZAAFPULSE_PORT ||= '4778';
    }
    // The same as `zaafpulse open` once the server answers, so local sign-in lands signed in.
    if (flag('open')) setTimeout(() => commands.open(), 1500);
    require('../server.js');
  },
  mcp() {
    require('../mcp.js');
  },
  async 'set-password'() {
    const { setPassword } = require('../lib/auth');
    const pw = await askHidden('New admin password (10+ characters): ');
    if (process.stdin.isTTY && (await askHidden('Again: ')) !== pw) die('The passwords do not match.');
    const dir = platform.dataDir();
    try {
      const file = setPassword(dir, pw);
      // A root-run CLI writes for the service user that owns the data folder (Linux system install).
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        const st = fs.statSync(dir);
        fs.chownSync(file, st.uid, st.gid);
        fs.chownSync(path.dirname(file), st.uid, st.gid);
      }
      console.log(`Saved (scrypt hash) in ${file}. Restart ZAAFPulse if it is running: zaafpulse service restart`);
    } catch (err) {
      die(err.message);
    }
  },
  async service() {
    const svc = require('../lib/service');
    const sub = positional[1] || 'status';
    const system = systemMode();
    try {
      if (sub === 'install') {
        svc.install({ system });
        const up = await waitUp();
        console.log(
          up
            ? `ZAAFPulse is running: ${localUrl()}`
            : 'Installed. It may take a few seconds to start; check with `zaafpulse status`.',
        );
      } else if (sub === 'uninstall' || sub === 'remove') svc.uninstall({ system });
      else if (sub === 'restart')
        console.log(svc.restart({ system }) ? 'Restarted.' : 'Could not restart (is the service installed?).');
      else console.log(`Service: ${svc.status({ system })}`);
    } catch (err) {
      die(err.message);
    }
  },
  async status() {
    const up = await ping();
    let svc = '?';
    try {
      svc = require('../lib/service').status({ system: systemMode() });
    } catch {
      /* unsupported */
    }
    console.log(
      `ZAAFPulse ${pkg.version} · ${up ? `running at ${localUrl()}` : `not answering on port ${port()}`} · service: ${svc}`,
    );
    process.exitCode = up ? 0 : 3;
  },
  async open() {
    // Local sign-in mode: a one-time code in the private data folder proves we are the owner. The code goes
    // into a private file that forwards the browser, and only that file's path is put on a command line.
    const url = `http://localhost:${port()}`;
    const mode = await new Promise((resolve) => {
      http
        .get(`${localUrl()}/api/session`, { timeout: 2000, headers: { host: '127.0.0.1' } }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () =>
            resolve(
              (() => {
                try {
                  return JSON.parse(d).mode;
                } catch {
                  return null;
                }
              })(),
            ),
          );
        })
        .on('timeout', function () {
          this.destroy(); // a port that never answers is not our server
        })
        .on('error', () => resolve(null));
    });
    const ok =
      mode === 'local'
        ? await openFile(require('../lib/auth').localLoginPage(platform.dataDir(), url))
        : await platform.openUrl(url);
    if (!ok)
      console.log(
        mode === 'local'
          ? `No desktop found. Open ${url} in a browser on this machine, then run \`zaafpulse open\` from a desktop session.`
          : `Open ${url} in a browser (no desktop found).`,
      );
  },
  async doctor() {
    const { defaultStore } = require('../lib/secret-store');
    const os = require('os');
    const home = os.homedir();
    const rows = [];
    const add = (k, v, ok = true) => rows.push(`${ok ? '✓' : '·'} ${k.padEnd(16)} ${v}`);
    add('ZAAFPulse', `${pkg.version}${platform.isSea() ? ' (single-file build)' : ''}`);
    add('OS', `${platform.OS_LABEL} ${os.release()} ${process.arch}`);
    const major = Number(process.versions.node.split('.')[0]);
    add('Node.js', process.versions.node, major >= 18);
    add('Data folder', platform.dataDir());
    let store;
    try {
      store = defaultStore();
      add('Secret store', store.label);
    } catch (err) {
      add('Secret store', err.message, false);
    }
    add(
      'Claude Code',
      fs.existsSync(path.join(home, '.claude', 'projects')) ? '~/.claude/projects found' : 'no logs on this machine',
      fs.existsSync(path.join(home, '.claude', 'projects')),
    );
    add(
      'Codex',
      fs.existsSync(path.join(home, '.codex', 'sessions')) ? '~/.codex/sessions found' : 'no logs on this machine',
      fs.existsSync(path.join(home, '.codex', 'sessions')),
    );
    const vaults = platform.registeredVaults();
    add(
      'Obsidian',
      vaults.length ? `${vaults.length} vault(s)` : 'not found (set a path in Settings)',
      vaults.length > 0,
    );
    add('Server', (await ping()) ? `answering at ${localUrl()}` : `not running on port ${port()}`, await ping());
    let svc = '?';
    try {
      svc = require('../lib/service').status({ system: systemMode() });
    } catch (err) {
      svc = err.message;
    }
    add('Service', svc, svc === 'running');
    console.log(rows.join('\n'));
  },
  'register-mcp'() {
    const target = positional[1];
    if (!target) die(`usage: zaafpulse register-mcp <${mcpClients().join('|')}|all> [--remove]`, 2);
    try {
      require('../scripts/register-mcp').run(target, { remove: !!flag('remove') });
    } catch (err) {
      die(err.message);
    }
  },
  // Judge one session from the terminal with the local model of the data folder's settings (see docs/evals.md).
  async eval() {
    const { runEval, USAGE } = require('../lib/evals/cli');
    const session = flag('session');
    if (!flag('judge') || typeof session !== 'string' || !session) die(USAGE, 2);
    const source = flag('source');
    const code = await runEval({
      session,
      source: typeof source === 'string' ? source : undefined,
      json: !!flag('json'),
      dir: platform.dataDir(),
      out: (m) => console.log(m),
      err: (m) => console.error(m),
    });
    process.exitCode = code;
  },
  version() {
    console.log(pkg.version);
  },
  help() {
    console.log(`ZAAFPulse ${pkg.version}: AI command center and agentic workspace

  zaafpulse [start]                 run in the foreground (http://localhost:4777)
      --host 0.0.0.0                listen on the network (server mode, needs a password)
      --port 4777  --data DIR  --demo  --open
  zaafpulse set-password            set the admin password for server mode
  zaafpulse service install         run in the background and at startup (--system: as a server service)
  zaafpulse service uninstall|status|restart
  zaafpulse status | open | doctor
  zaafpulse eval --judge --session <id> [--source claude|codex] [--json]
                                    judge one session with the local model (--data DIR: the data folder)
  zaafpulse register-mcp <client|all> [--remove]
                                    clients: ${mcpClients().join(', ')}
  zaafpulse mcp                     the stdio MCP server (what AI clients start)
  zaafpulse version`);
  },
};

// Opens a local file with the default browser. On Windows through explorer.exe, so the path never passes
// through cmd.exe and its quoting.
function openFile(file) {
  const { spawn } = require('child_process');
  const [cmd, args] =
    platform.OS === 'macos'
      ? ['open', [file]]
      : platform.OS === 'windows'
        ? ['explorer.exe', [file]]
        : ['xdg-open', [file]];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('spawn', () => {
        p.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

async function waitUp(ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

const run = commands[cmd];
if (!run) die(`unknown command "${cmd}". Try: zaafpulse help`, 2);
Promise.resolve(run()).catch((err) => die(err.stack || err.message));
