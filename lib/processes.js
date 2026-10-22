// Snapshot of AI apps running right now, grouped by app (helpers count toward their parent).
// macOS uses ps and vm_stat, Linux reads /proc (works on minimal images too), Windows asks CIM.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIR_PREFIX, runningPids } = require('./evals/claude-cli');

// First match wins, so specific patterns come before broad ones.
// Patterns cover macOS app bundles, Windows .exe paths and Linux binaries/AppImages.
const APPS = [
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    re: /[\\/]Claude\.app[\\/]|AnthropicClaude[\\/]/i,
    paths: ['/Applications/Claude.app', '%LOCALAPPDATA%/AnthropicClaude'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    re: /native-binary[\\/]claude\b|claude-code|(^|[\\/"])claude(\.exe)?("|\s|$)/,
    paths: [], // the log folders, from lib/claude (installed())
  },
  { id: 'codex', name: 'Codex', re: /codex/i, paths: [] }, // the log folders, from lib/codex (installed())
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    re: /[\\/]ChatGPT(\.app[\\/]|\.exe)/i,
    paths: ['/Applications/ChatGPT.app', '%LOCALAPPDATA%/Programs/ChatGPT'],
  },
  {
    id: 'antigravity',
    name: 'Antigravity / Gemini',
    re: /Antigravity|gemini-cli|[\\/]gemini(\.exe)?(\s|$)/i,
    paths: ['/Applications/Antigravity.app', '/Applications/Antigravity IDE.app', '~/.gemini'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    re: /[\\/]Cursor(\.app[\\/]|\.exe)|cursor[^\\/]*\.appimage/i,
    paths: ['/Applications/Cursor.app', '~/.cursor', '%LOCALAPPDATA%/Programs/cursor'],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    re: /[\\/]Kiro(\.app[\\/]|\.exe)|kiro-cli/i,
    paths: ['/Applications/Kiro.app', '~/.kiro', '%LOCALAPPDATA%/Programs/Kiro'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    re: /ollama/i,
    paths: [
      '/Applications/Ollama.app',
      '~/.ollama',
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      '%LOCALAPPDATA%/Programs/Ollama',
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    re: /LM Studio|lm-studio/i,
    paths: ['/Applications/LM Studio.app', '~/.lmstudio', '~/.cache/lm-studio'],
  },
];

function installed() {
  const local = process.env.LOCALAPPDATA || '';
  const expand = (p) =>
    p.startsWith('~')
      ? path.join(os.homedir(), p.slice(1))
      : p.startsWith('%LOCALAPPDATA%')
        ? local
          ? path.join(local, p.slice(15))
          : ''
        : p;
  // Claude Code and Codex are installed when any of the folders their logs are read from exists.
  const logs = { claude: require('./claude').roots(), codex: require('./codex').roots() };
  return APPS.filter((a) => (logs[a.id] || a.paths).some((p) => fs.existsSync(expand(p)))).map((a) => a.id);
}

function parseEtime(s) {
  // [[dd-]hh:]mm:ss
  const [days, rest] = s.includes('-') ? s.split('-') : [0, s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(days) * 24 + parts[0]) * 60 + parts[1]) * 60 + parts[2];
}

// Whole-machine context for the live page: how much of the laptop the AI apps are using.
// usedMB, when given, replaces os.freemem(), which on macOS counts only never-touched pages.
function system(usedMB) {
  const total = Math.round(os.totalmem() / 1048576);
  return {
    cores: os.cpus().length,
    load: os.loadavg().map((v) => +v.toFixed(2)),
    memTotalMB: total,
    memFreeMB: usedMB == null ? Math.round(os.freemem() / 1048576) : Math.max(0, total - usedMB),
    uptimeSec: Math.round(os.uptime()),
  };
}

// "Memory Used" the way Activity Monitor counts it: app memory + wired + compressed.
function parseVmStat(out) {
  const page = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 4096;
  const get = (label) => Number((out.match(new RegExp(`${label}:\\s+(\\d+)`)) || [])[1]) || 0;
  const app = get('Anonymous pages') ? get('Anonymous pages') - get('Pages purgeable') : get('Pages active');
  const pages = app + get('Pages wired down') + get('Pages occupied by compressor');
  return pages ? Math.round((pages * page) / 1048576) : null;
}

// Linux: MemTotal - MemAvailable, the "used" figure free(1) and most monitors show.
function parseMeminfo(text) {
  const kb = (k) => Number((text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  return total && Number.isFinite(avail) ? Math.round((total - avail) / 1024) : null;
}

function usedMemory() {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')));
    } catch {
      return Promise.resolve(null);
    }
  }
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => execFile('vm_stat', (err, out) => resolve(err ? null : parseVmStat(out))));
}

// Every process as { pid, cpu, rssKB, upSec, args }. cpu is the lifetime average share of one core,
// the way ps reports %CPU, so the numbers mean the same thing on every OS. On POSIX a row also says whether the
// process is stopped (SIGSTOP or job control), which agent control reads back after a restart.
function psRows() {
  return new Promise((resolve, reject) =>
    execFile('ps', ['-axo', 'pid=,pcpu=,rss=,etime=,stat=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(
        stdout
          .split('\n')
          .map((raw) => raw.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/))
          .filter(Boolean)
          .map((m) => ({
            pid: Number(m[1]),
            cpu: Number(m[2]),
            rssKB: Number(m[3]),
            upSec: parseEtime(m[4]),
            stopped: m[5].includes('T'),
            args: m[6],
          })),
      );
    }),
  );
}
function procRows(root = '/proc', hz = 100) {
  const uptime = Number(fs.readFileSync(path.join(root, 'uptime'), 'utf8').split(/\s+/)[0]);
  const rows = [];
  for (const d of fs.readdirSync(root)) {
    if (!/^\d+$/.test(d)) continue;
    try {
      // The arguments one by one, so a path with spaces stays whole (agent control reads the program from argv[0]).
      const argv = fs
        .readFileSync(path.join(root, d, 'cmdline'), 'utf8')
        .split('\0')
        .filter(Boolean);
      const args = argv.join(' ');
      if (!args) continue; // kernel threads
      const stat = fs.readFileSync(path.join(root, d, 'stat'), 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cpuSec = (Number(f[11]) + Number(f[12])) / hz;
      const upSec = Math.max(1, uptime - Number(f[19]) / hz);
      const rssKB =
        Number((fs.readFileSync(path.join(root, d, 'status'), 'utf8').match(/^VmRSS:\s+(\d+)/m) || [])[1]) || 0;
      const row = {
        pid: Number(d),
        cpu: (cpuSec / upSec) * 100,
        rssKB,
        upSec: Math.round(upSec),
        stopped: f[0] === 'T', // the state letter after the name: T stopped by a signal; t (a debugger's stop) is not
        args,
        argv,
      };
      try {
        row.cwd = fs.readlinkSync(path.join(root, d, 'cwd')); // only for this user's own processes
      } catch {
        /* another user's process, or gone */
      }
      rows.push(row);
    } catch {
      /* the process ended while we read it */
    }
  }
  return rows;
}
// Windows: one CIM query; CPU from kernel + user time (100 ns units) over the process's age.
const WIN_PS =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $n=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine -and $_.CreationDate) { '{0}`t{1}`t{2}`t{3}`t{4}' -f $_.ProcessId,($_.KernelModeTime+$_.UserModeTime),$_.WorkingSetSize,($n-([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds()),$_.CommandLine } }";
function parseWinRows(out) {
  return out
    .split(/\r?\n/)
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 5 && /^\d+$/.test(f[0]))
    .map((f) => {
      const upSec = Math.max(1, Number(f[3]));
      return {
        pid: Number(f[0]),
        cpu: (Number(f[1]) / 1e7 / upSec) * 100,
        rssKB: Number(f[2]) / 1024,
        upSec,
        args: f.slice(4).join('\t'),
      };
    });
}
function winRows() {
  return new Promise((resolve, reject) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WIN_PS],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 15000 },
      (err, stdout) => (err ? reject(err) : resolve(parseWinRows(stdout))),
    ),
  );
}
const rowsForOs = () =>
  process.platform === 'linux'
    ? Promise.resolve().then(() => procRows())
    : process.platform === 'win32'
      ? winRows()
      : psRows();

// The judge's Claude Code calls (lib/evals/claude-cli) run in a zaafpulse-judge-* temp folder: they are ZAAFPulse
// at work, not an app the owner runs. Known by that folder in argv or as the working folder, or by pid (`skip`, the
// calls this process started, for systems where the working folder is not cheap to read).
const isJudge = (r, skip) =>
  skip.has(r.pid) || [r.args, r.cwd].some((x) => typeof x === 'string' && x.includes(DIR_PREFIX));

// ZAAFPulse itself (this process, or anything run from its folder) and the judge's calls are never an AI app the owner
// runs. One rule for the live page and for agent control, so neither can classify a process differently.
const isOwn = (r, skip = new Set()) =>
  r.pid === process.pid || /ai-command-center|zaafpulse/i.test(r.args) || isJudge(r, skip);

function groupApps(rows, { skip = new Set() } = {}) {
  const apps = {};
  for (const r of rows) {
    if (isOwn(r, skip)) continue;
    const app = APPS.find((a) => a.re.test(r.args));
    if (!app) continue;
    const a = (apps[app.id] ||= { id: app.id, name: app.name, processes: 0, cpu: 0, memMB: 0, uptimeSec: 0 });
    a.processes++;
    a.cpu += r.cpu;
    a.memMB += r.rssKB / 1024;
    a.uptimeSec = Math.max(a.uptimeSec, r.upSec);
  }
  const list = Object.values(apps).map((a) => ({ ...a, cpu: +a.cpu.toFixed(1), memMB: Math.round(a.memMB) }));
  return list.sort((x, y) => y.cpu - x.cpu || y.memMB - x.memMB);
}

// macOS: lsof -Fn prints "p<pid>", then "f<fd>" and "n<path>" lines; with -d cwd, the path is the working folder.
function parseLsofCwd(out) {
  const cwds = new Map();
  let pid = null;
  for (const line of String(out).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid) cwds.set(pid, line.slice(1));
  }
  return cwds;
}
// The working folders of the rows `wanted` picks (by default the ones that look like Claude Code), on macOS (ps
// cannot show them). Others are left as they are; a failure leaves every row without one.
const CLAUDE = APPS.find((a) => a.id === 'claude');
const isAgent = (r) => APPS.some((a) => a.re.test(r.args));
function withCwds(rows, wanted = (r) => CLAUDE.re.test(r.args)) {
  const pids = rows.filter((r) => !r.cwd && wanted(r)).map((r) => r.pid);
  if (process.platform !== 'darwin' || !pids.length) return Promise.resolve(rows);
  return new Promise((resolve) =>
    execFile(
      'lsof',
      ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const cwds = parseLsofCwd(stdout || ''); // lsof exits 1 when a pid has gone; what it printed still counts
        resolve(rows.map((r) => (cwds.has(r.pid) ? { ...r, cwd: cwds.get(r.pid) } : r)));
      },
    ),
  );
}

// macOS: `ps -o pid=,comm=` prints each process's executable as a full path, spaces included.
function parsePsComm(out) {
  const exes = new Map();
  for (const line of String(out).split('\n')) {
    const m = line.match(/^\s*(\d+) (.+)$/);
    if (m && m[2].trim()) exes.set(Number(m[1]), m[2].trim());
  }
  return exes;
}
// An argv from a ps command line whose executable path is known: that path whole, then the other arguments split on
// spaces. `args` starts with the path when the process was run by it; otherwise (run as `node`, say) the first word
// is the name it was run by.
function argvFrom(args, exe) {
  const text = String(args || '');
  const rest = text.startsWith(exe) ? text.slice(exe.length) : text.replace(/^\S*/, '');
  return [exe, ...rest.trim().split(/\s+/).filter(Boolean)];
}
// On macOS, an argv for the rows `wanted` picks, from their executable path (ps args cannot tell where a path with
// spaces ends). Linux rows have one from /proc already. A failure leaves the rows without one.
function withArgv(rows, wanted) {
  const pids = rows.filter((r) => !r.argv && wanted(r)).map((r) => r.pid);
  if (process.platform !== 'darwin' || !pids.length) return Promise.resolve(rows);
  return new Promise((resolve) =>
    execFile(
      'ps',
      ['-ww', '-o', 'pid=,comm=', '-p', pids.join(',')],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const exes = parsePsComm(stdout || ''); // ps exits 1 when a pid has gone; what it printed still counts
        resolve(rows.map((r) => (exes.has(r.pid) ? { ...r, argv: argvFrom(r.args, exes.get(r.pid)) } : r)));
      },
    ),
  );
}

// Every process row, with the working folder and argv of each AI app process where the OS can tell (agent control).
const rows = async () => withArgv(await withCwds(await rowsForOs(), isAgent), isAgent);

async function snapshot() {
  const used = await usedMemory();
  try {
    const rows = await withCwds(await rowsForOs());
    const skip = runningPids();
    return { ts: Date.now(), apps: groupApps(rows, { skip }), installed: installed(), system: system(used) };
  } catch (err) {
    return { ts: Date.now(), apps: [], installed: installed(), system: system(used), error: err.message };
  }
}

module.exports = {
  installed,
  snapshot,
  system,
  parseVmStat,
  parseMeminfo,
  procRows,
  parseWinRows,
  parseLsofCwd,
  parsePsComm,
  argvFrom,
  groupApps,
  isJudge,
  isOwn,
  rows,
  APPS,
};
