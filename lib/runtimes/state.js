// What each local model runtime and desktop app (lib/runtimes/registry.js) is doing now: whether it is installed, its
// server process (pid, start time, children) and how that server runs, and whether its health URL answers within 1.5 s
// (a desktop app has none: it is up while its main process runs). Read from the process table (lib/processes), the
// servers ZAAFPulse started (.data/runtimes/started.json), launchd's job list on macOS and /proc/<pid>/cgroup on
// Linux. A process whose parent (or an ancestor a few levels up) is a runtime's server counts toward that server and
// is never a server itself: Ollama's runners and its llama-server, or an app's helpers.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const realProcesses = require('../processes');
const { trusted } = require('../trust');
const { sameStart, startOf } = require('../agents/control');

const HEALTH_TIMEOUT_MS = 1500;
const MAX_DEPTH = 4; // how far up the parent chain a server is looked for
const LAUNCHCTL_TIMEOUT_MS = 3000;

// A small JSON object kept in a file of its own (mode 0600), written through a temp file and a rename.
function jsonFile(file) {
  return {
    file,
    read() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    },
    write(obj) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // A leftover temp file (maybe 0644, maybe a link) is removed, and the new one must not exist: flag 'wx'.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    },
  };
}

// Whether `url` answers within `timeoutMs`. An answer below 500 counts (a 503 means "not ready yet").
function probe(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(v);
    }
    try {
      req = http.get(url, (res) => {
        res.resume();
        finish(res.statusCode < 500);
      });
    } catch {
      return finish(false);
    }
    req.on('error', () => finish(false));
  });
}

// `launchctl list`: "PID<TAB>Status<TAB>Label" per job; a job that is not running has "-" for its pid.
function parseLaunchctlList(out) {
  const jobs = new Map();
  for (const line of String(out).split('\n')) {
    const f = line.split('\t');
    if (f.length >= 3 && /^\d+$/.test(f[0])) jobs.set(f[2].trim(), Number(f[0]));
  }
  return jobs;
}
const listLaunchd = () =>
  new Promise((resolve) =>
    execFile('/bin/launchctl', ['list'], { timeout: LAUNCHCTL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? new Map() : parseLaunchctlList(stdout)),
    ),
  );

// Linux: the systemd system unit a process runs under ("ollama.service"), or null. User units are not "the system".
function systemUnit(cgroup) {
  const m = /(?:^|\n)[^\n]*:\/system\.slice\/([^/\n]+\.service)(?:\/|\n|$)/.exec(String(cgroup || ''));
  return m ? m[1] : null;
}

const isFile = (f, win) => {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (!win) fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const isDir = (f) => {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return false;
  }
};
const defaultBinDirs = (platform, home) =>
  platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.lmstudio', 'bin'), path.join(home, '.local', 'bin')];

// A program as it would be run: an absolute path as given (when it is an executable file; the owner named it), else
// the first trusted match on PATH and then the usual folders (a file or folder anyone can write, or another user owns,
// is skipped: approvals hash the command, not the path it resolves to). A relative path is never looked up.
function findBin(name, { env = process.env, platform = process.platform, home = os.homedir(), dirs } = {}) {
  if (typeof name !== 'string' || !name) return null;
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  if (p.isAbsolute(name)) return isFile(name, win) ? name : null;
  if (/[\\/]/.test(name)) return null;
  const all = [
    ...String(env.PATH || env.Path || '').split(win ? ';' : ':'),
    ...(dirs || defaultBinDirs(platform, home)),
  ].filter((d) => d && p.isAbsolute(d));
  const names = win && !/\.exe$/i.test(name) ? [`${name}.exe`] : [name];
  for (const d of all) for (const n of names) if (isFile(p.join(d, n), win) && trusted(p.join(d, n), { platform })) return p.join(d, n);
  return null;
}

// Whether the row's PROGRAM (argv[0], else the leading path of its command line) is inside `bundle`: a path in the
// arguments (`ollama serve --note /Applications/Ollama.app/Contents/MacOS/x`) does not count.
function runsFrom(r, bundle) {
  if (!r || !bundle) return false;
  if (Array.isArray(r.argv) && typeof r.argv[0] === 'string') return r.argv[0].includes(bundle);
  const args = String(r.args || '');
  const quoted = /^"([^"]+)"(?=\s|$)/.exec(args);
  if (quoted) return quoted[1].includes(bundle);
  const i = args.indexOf(bundle);
  // Only the app's own name may hold a space, so what comes before the bundle is one word: a path.
  return i > 0 && /^(?:[A-Za-z]:[\\/]|\/)\S*$/.test(args.slice(0, i));
}

function createRuntimeState({
  processes = realProcesses,
  entries = () => [], // the runtimes, from lib/runtimes/registry.js entries()
  started = { read: () => ({}) }, // .data/runtimes/started.json: { [id]: { pid, startTime } }
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  binDirs, // the usual folders after PATH (default: Homebrew, /usr/local/bin, /usr/bin, ~/.lmstudio/bin, ~/.local/bin)
  appDirs = platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : [],
  brewPrefixes = platform === 'darwin' ? ['/opt/homebrew', '/usr/local'] : [],
  launchctl = listLaunchd, // () => Promise<Map label -> pid>
  readCgroup = (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'),
  probe: probeUrl = probe,
  now = Date.now,
} = {}) {
  // pid -> the first start time read for it, as agent control keeps it: ps gives an age in whole seconds.
  let starts = new Map();
  const bin = (name) => findBin(name, { env, platform, home, dirs: binDirs });
  // The first bundle installed (a preset may list several), in any app folder.
  const app = (bundles) =>
    [].concat(bundles || []).flatMap((b) => appDirs.map((d) => path.join(d, b))).find(isDir) || null;
  const brewed = (formula) => !!formula && brewPrefixes.some((p) => isDir(path.join(p, 'opt', formula)));
  const brewBin = () => brewPrefixes.map((p) => path.join(p, 'bin', 'brew')).find((f) => isFile(f, false)) || null;

  // Where a runtime is on this machine, and the argv that starts and (when it has one) stops it.
  function install(e) {
    if (!e.preset) {
      const b = e.error ? null : bin(e.command[0]);
      return { installed: !!b, bin: b, app: null, startArgv: b ? [b, ...e.command.slice(1)] : null, stopArgv: null };
    }
    const b = e.bin ? bin(e.bin) : null;
    const a = platform === 'darwin' ? app(e.app) : null;
    const installed = !!(b || a || brewed(e.brew));
    let startArgv = null;
    if (b && e.start && e.start[0] === e.bin) startArgv = [b, ...e.start.slice(1)];
    else if (a && e.openApp) startArgv = ['/usr/bin/open', '-a', a];
    const stopArgv = b && e.stop && e.stop[0] === e.bin ? [b, ...e.stop.slice(1)] : null;
    return { installed, bin: b, app: a, startArgv, stopArgv };
  }

  async function table() {
    const t = now();
    const next = new Map();
    const rows = (await processes.rows()).map((r) => {
      let startTime = startOf(r, t);
      const known = starts.get(r.pid);
      if (sameStart(known, startTime)) startTime = known;
      if (startTime != null) next.set(r.pid, startTime);
      return { ...r, startTime };
    });
    starts = next;
    return rows;
  }

  // Every runtime with its server, or only the one with id `only` (the others are still read: a process is a server
  // or a child depending on the processes around it).
  async function list({ only } = {}) {
    const all = entries();
    // Owner entries first: their match is narrower than a preset's (a llama-server on their port).
    const order = [...all.filter((e) => !e.preset && !e.error), ...all.filter((e) => e.preset)];
    let rows = [];
    let tableError = null;
    try {
      rows = await table();
    } catch {
      tableError = 'the process table could not be read';
    }
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const runtimeOf = new Map(); // pid -> entry, for the rows that match a runtime
    for (const r of rows) {
      if (realProcesses.isOwn(r)) continue;
      const e = order.find((x) => x.match(r));
      if (e) runtimeOf.set(r.pid, e);
    }
    // The topmost matching process at most MAX_DEPTH parents up, other than the row itself; null when none. A desktop
    // app absorbs no other runtime's server: `ollama serve` run from a shell inside Claude Desktop is Ollama's server,
    // not a child of the app (while the llama-server Ollama starts still counts toward Ollama).
    const serverAbove = (r) => {
      let found = null;
      let cur = r;
      const own = runtimeOf.get(r.pid);
      for (let i = 0; i < MAX_DEPTH; i++) {
        const p = byPid.get(cur.ppid);
        if (!p || p.pid === cur.pid) break;
        const above = runtimeOf.get(p.pid);
        if (above && (!own || above.id === own.id || above.kind !== 'app')) {
          // Past a model server found inside an app, only the server's own runtime goes on: not the app around it.
          if (found && above.kind === 'app' && above.id !== runtimeOf.get(found.pid).id) break;
          found = p;
        }
        cur = p;
      }
      return found;
    };
    const servers = new Map(); // entry id -> [server rows], oldest first
    const children = new Map(); // server pid -> how many processes run under it
    for (const r of rows) {
      const above = serverAbove(r);
      if (above) children.set(above.pid, (children.get(above.pid) || 0) + 1);
      else if (runtimeOf.has(r.pid)) {
        const id = runtimeOf.get(r.pid).id;
        servers.set(id, [...(servers.get(id) || []), r]);
      }
    }
    for (const xs of servers.values()) xs.sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
    const mine = started.read();
    let jobs = null; // launchd's jobs, read once and only when a server could be a brew service
    const out = [];
    for (const e of all) {
      if (only !== undefined && e.id !== only) continue;
      const found = e.error ? [] : servers.get(e.id) || [];
      const rec = Object.hasOwn(mine, e.id) ? mine[e.id] : null; // an id like 'constructor' is a valid id
      const ours = (r) => !!rec && r.pid === rec.pid && sameStart(rec.startTime, r.startTime);
      const srv = found.find(ours) || found[0] || null;
      let how = null;
      let appBundle = null; // the app bundle (a name, never a path) the server or its parent runs from
      if (srv) {
        const parent = byPid.get(srv.ppid) || null;
        const fromBundle = (b) => [srv, parent].some((x) => runsFrom(x, `/${b}/Contents/MacOS/`));
        appBundle = [].concat(e.app || []).find(fromBundle) || null;
        if (ours(srv)) how = 'zaafpulse';
        else if (appBundle) how = 'app';
        else if (platform === 'darwin' && e.brew && srv.ppid === 1) {
          if (!jobs) jobs = await launchctl();
          if (jobs.get(`homebrew.mxcl.${e.brew}`) === srv.pid) how = 'service';
        } else if (platform === 'linux') {
          let cg = '';
          try {
            cg = readCgroup(srv.pid);
          } catch {
            cg = '';
          }
          if (systemUnit(cg)) how = 'system';
        }
      }
      if (how !== 'app') appBundle = null;
      out.push({ e, srv, how: srv ? how || 'process' : null, appBundle, where: install(e) });
    }
    // The health URLs are asked at the same time, each for at most 1.5 s.
    return Promise.all(
      out.map(async ({ e, srv, how, appBundle, where }) => {
        const answered = e.health && !e.error && (srv || where.installed) ? await probeUrl(e.health) : false;
        const running = e.upByHealth ? answered : !!srv;
        return {
          entry: e,
          ...where,
          brewBin: how === 'service' ? brewBin() : null,
          running,
          // A desktop app has no health URL: it is healthy while its main process runs.
          healthy: running && (e.kind === 'app' || answered),
          how: running && srv ? how : null,
          appBundle: running && srv ? appBundle : null,
          pid: running && srv ? srv.pid : null,
          startTime: running && srv ? srv.startTime : null,
          children: running && srv ? children.get(srv.pid) || 0 : 0,
          tableError,
        };
      }),
    );
  }

  const one = async (id) => {
    const xs = await list({ only: id });
    return xs.find((x) => !x.entry.error) || xs[0] || null;
  };

  return { list, one, install };
}

module.exports = {
  createRuntimeState,
  jsonFile,
  probe,
  findBin,
  parseLaunchctlList,
  systemUnit,
  HEALTH_TIMEOUT_MS,
};
