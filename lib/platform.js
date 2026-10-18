// Operating-system differences in one place: where data lives, the machine and user names, where
// Obsidian keeps its vault list, how to open a URL, and how to run the MCP server. ZAAFPulse runs on
// macOS, Linux (Debian, Ubuntu, RHEL and friends) and Windows 10/11, on a laptop or a server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const OS = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const OS_LABEL = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }[OS];

// True inside a single-file executable (Node SEA); then the MCP server is `<binary> mcp`.
function isSea() { try { return require('node:sea').isSea(); } catch { return false; } }

// config.json, .data/ and .cache/: ZAAFPULSE_DATA when set; next to the code for a git checkout (or a
// folder that already has them, as before); otherwise the OS's data folder, so the server, the CLI and
// MCP clients (which start mcp.js without our environment) always find the same place.
function dataDir(env = process.env) {
  const inApp = ['.git', 'config.json', '.data'].some((f) => fs.existsSync(path.join(APP_DIR, f)));
  const d = env.ZAAFPULSE_DATA ? path.resolve(expandHome(env.ZAAFPULSE_DATA)) : inApp && !isSea() ? APP_DIR : defaultDataDir({ system: OS === 'linux' && process.getuid && process.getuid() === 0 });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// The OS's data folder: ~/Library/Application Support/ZAAFPulse, %APPDATA%\ZAAFPulse,
// ~/.local/share/zaafpulse/data, or /var/lib/zaafpulse for a system (root) install on Linux.
function defaultDataDir({ system = false } = {}) {
  if (OS === 'macos') return path.join(os.homedir(), 'Library', 'Application Support', 'ZAAFPulse');
  if (OS === 'windows') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ZAAFPulse');
  return system ? '/var/lib/zaafpulse' : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'zaafpulse', 'data');
}

// "~/x" and "~\x" → the home folder.
function expandHome(p) { return String(p || '').trim().replace(/^~(?=$|[\\/])/, os.homedir()); }

function run(cmd, args, timeout = 3000) {
  try { return String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, windowsHide: true })).trim(); } catch { return ''; }
}

function computerName() {
  if (OS === 'macos') return run('scutil', ['--get', 'ComputerName']) || os.hostname().replace(/\.local$/, '');
  if (OS === 'windows') return process.env.COMPUTERNAME || os.hostname();
  return run('hostnamectl', ['--pretty']) || os.hostname();
}

// The user's first name for the greeting; the login name when the OS does not know it.
function fullName() {
  let name = '';
  if (OS === 'macos') name = run('id', ['-F']);
  else if (OS === 'linux') { const gecos = (run('getent', ['passwd', os.userInfo().username]).split(':')[4] || '').split(',')[0]; name = gecos; }
  return (name.trim().split(/\s+/)[0]) || os.userInfo().username;
}

// Obsidian's list of vaults (obsidian.json) on each OS, including the Flatpak and Snap builds on Linux.
function obsidianConfigFiles() {
  const h = os.homedir();
  if (OS === 'macos') return [path.join(h, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  if (OS === 'windows') return [path.join(process.env.APPDATA || path.join(h, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')];
  return [path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'obsidian', 'obsidian.json'),
    path.join(h, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json'), path.join(h, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json')];
}
function registeredVaults() {
  for (const f of obsidianConfigFiles()) {
    try { return Object.values(JSON.parse(fs.readFileSync(f, 'utf8')).vaults || {}).map((v) => v.path).filter((p) => p && fs.existsSync(p)); } catch { /* next */ }
  }
  return [];
}

// Opens a URL in the default browser; resolves false when there is no desktop (a server).
function openUrl(url) {
  const [cmd, args] = OS === 'macos' ? ['open', [url]] : OS === 'windows' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try { const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }); p.on('error', () => resolve(false)); p.on('spawn', () => { p.unref(); resolve(true); }); } catch { resolve(false); }
  });
}

// How an MCP client starts our stdio server: node + mcp.js, or the single-file binary with "mcp".
function mcpCommand() {
  return isSea() ? { command: process.execPath, args: ['mcp'] } : { command: process.execPath, args: [path.join(APP_DIR, 'mcp.js')] };
}

module.exports = { OS, OS_LABEL, APP_DIR, isSea, dataDir, defaultDataDir, expandHome, computerName, fullName, obsidianConfigFiles, registeredVaults, openUrl, mcpCommand };
