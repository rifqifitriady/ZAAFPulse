// Snapshot of AI apps running right now, grouped by app (helpers count toward their parent).
// macOS uses ps and vm_stat, Linux reads /proc (works on minimal images too), Windows asks CIM.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    paths: ['~/.claude/projects'],
  },
  { id: 'codex', name: 'Codex', re: /codex/i, paths: ['~/.codex/sessions'] },
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
  return APPS.filter((a) => a.paths.some((p) => fs.existsSync(expand(p)))).map((a) => a.id);
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
// the way ps reports %CPU, so the numbers mean the same thing on every OS.
function psRows() {
  return new Promise((resolve, reject) =>
    execFile('ps', ['-axo', 'pid=,pcpu=,rss=,etime=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(
        stdout
          .split('\n')
          .map((raw) => raw.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/))
          .filter(Boolean)
          .map((m) => ({
            pid: Number(m[1]),
            cpu: Number(m[2]),
            rssKB: Number(m[3]),
            upSec: parseEtime(m[4]),
            args: m[5],
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
      const args = fs
        .readFileSync(path.join(root, d, 'cmdline'), 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
      if (!args) continue; // kernel threads
      const stat = fs.readFileSync(path.join(root, d, 'stat'), 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cpuSec = (Number(f[11]) + Number(f[12])) / hz;
      const upSec = Math.max(1, uptime - Number(f[19]) / hz);
      const rssKB =
        Number((fs.readFileSync(path.join(root, d, 'status'), 'utf8').match(/^VmRSS:\s+(\d+)/m) || [])[1]) || 0;
      rows.push({ pid: Number(d), cpu: (cpuSec / upSec) * 100, rssKB, upSec: Math.round(upSec), args });
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

function groupApps(rows) {
  const apps = {};
  for (const r of rows) {
    if (r.pid === process.pid || /ai-command-center|zaafpulse/i.test(r.args)) continue;
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

async function snapshot() {
  const used = await usedMemory();
  try {
    return { ts: Date.now(), apps: groupApps(await rowsForOs()), installed: installed(), system: system(used) };
  } catch (err) {
    return { ts: Date.now(), apps: [], installed: installed(), system: system(used), error: err.message };
  }
}

module.exports = { snapshot, system, parseVmStat, parseMeminfo, procRows, parseWinRows, groupApps, APPS };
