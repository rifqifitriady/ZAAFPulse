// Snapshot of AI apps running right now, grouped by app (helpers count toward their parent).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// First match wins, so specific patterns come before broad ones.
const APPS = [
  { id: 'claude', name: 'Claude Code', re: /native-binary\/claude\b|claude-code|(^|\/)claude(\s|$)/, paths: ['~/.claude/projects'] },
  { id: 'claude-desktop', name: 'Claude Desktop', re: /\/Claude\.app\//, paths: ['/Applications/Claude.app'] },
  { id: 'codex', name: 'Codex', re: /codex/i, paths: ['~/.codex/sessions'] },
  { id: 'chatgpt', name: 'ChatGPT', re: /\/ChatGPT\.app\//, paths: ['/Applications/ChatGPT.app'] },
  { id: 'antigravity', name: 'Antigravity / Gemini', re: /Antigravity|gemini-cli|\/gemini(\s|$)/i, paths: ['/Applications/Antigravity.app', '/Applications/Antigravity IDE.app', '~/.gemini'] },
  { id: 'cursor', name: 'Cursor', re: /\/Cursor\.app\//, paths: ['/Applications/Cursor.app', '~/.cursor'] },
  { id: 'kiro', name: 'Kiro', re: /\/Kiro\.app\/|kiro-cli/i, paths: ['/Applications/Kiro.app', '~/.kiro'] },
  { id: 'ollama', name: 'Ollama', re: /ollama/i, paths: ['/Applications/Ollama.app', '~/.ollama'] },
  { id: 'lmstudio', name: 'LM Studio', re: /LM Studio/i, paths: ['/Applications/LM Studio.app', '~/.lmstudio'] },
];

function installed() {
  const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
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

function usedMemory() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => execFile('vm_stat', (err, out) => resolve(err ? null : parseVmStat(out))));
}

async function snapshot() {
  const used = await usedMemory();
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,pcpu=,rss=,etime=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ts: Date.now(), apps: [], installed: installed(), system: system(used), error: err.message });
      const apps = {};
      for (const raw of stdout.split('\n')) {
        const m = raw.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const args = m[5];
        if (args.includes('ai-command-center')) continue;
        const app = APPS.find((a) => a.re.test(args));
        if (!app) continue;
        const a = (apps[app.id] ||= { id: app.id, name: app.name, processes: 0, cpu: 0, memMB: 0, uptimeSec: 0 });
        a.processes++;
        a.cpu += Number(m[2]);
        a.memMB += Number(m[3]) / 1024;
        a.uptimeSec = Math.max(a.uptimeSec, parseEtime(m[4]));
      }
      const list = Object.values(apps).map((a) => ({ ...a, cpu: +a.cpu.toFixed(1), memMB: Math.round(a.memMB) }));
      list.sort((x, y) => y.cpu - x.cpu || y.memMB - x.memMB);
      resolve({ ts: Date.now(), apps: list, installed: installed(), system: system(used) });
    });
  });
}

module.exports = { snapshot, system, parseVmStat, APPS };
