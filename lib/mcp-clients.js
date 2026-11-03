// The AI clients that keep MCP server settings: where each one keeps its file, how our own entry is recognised, and
// a reader for the TOML subset Codex CLI writes. Shared by scripts/register-mcp.js (which writes our entry) and the
// governance MCP scan (lib/governance/mcp-scan.js, which lists every entry). Pure but for the home folder and the
// environment it is given.
const os = require('os');
const path = require('path');
const { expandHome } = require('./platform');

const NAME = 'zaafpulse';
// Earlier releases registered the stdio server under this name; it is replaced when it points at ZAAFPulse.
const OLD_NAMES = ['ai-command-center'];

// Every client with its config file. "home" given without "env" (tests) never reads this machine's variables, so a
// test can never reach a real config through CODEX_HOME, APPDATA or XDG_CONFIG_HOME.
// Paths follow each vendor's documentation (docs/integrations.md lists the sources).
function clients(home, { env, platform = process.platform } = {}) {
  const e = env || (home == null ? process.env : {});
  const h = home == null ? os.homedir() : home;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const j = (...p) => P.join(h, ...p);
  const abs = (p) => P.resolve(expandHome(p));
  const appData = e.APPDATA || j('AppData', 'Roaming');
  const xdg = e.XDG_CONFIG_HOME || j('.config');
  // An app's per-user folder: ~/Library/Application Support on macOS, %APPDATA% on Windows, ~/.config on Linux.
  const appDir = (...p) =>
    platform === 'darwin'
      ? j('Library', 'Application Support', ...p)
      : platform === 'win32'
        ? P.join(appData, ...p)
        : P.join(xdg, ...p);
  const claudeDir = e.CLAUDE_CONFIG_DIR ? abs(e.CLAUDE_CONFIG_DIR) : null;
  const codexHome = e.CODEX_HOME ? abs(e.CODEX_HOME) : j('.codex');
  // Windsurf became Devin Desktop (June 2026); its docs now name ~/.config/devin. A Windsurf install that predates
  // the rename keeps ~/.codeium/windsurf, so that file is kept up to date too whenever its folder exists.
  const devin = platform === 'win32' ? P.join(appData, 'devin') : P.join(xdg, 'devin');
  const windsurf = j('.codeium', 'windsurf');
  const zed =
    platform === 'win32' ? P.join(appData, 'Zed') : platform === 'darwin' ? j('.config', 'zed') : P.join(xdg, 'zed');
  const stdio = (m) => ({ type: 'stdio', ...m });
  return {
    claude: {
      name: 'Claude Code',
      kind: 'claude',
      file: claudeDir ? P.join(claudeDir, '.claude.json') : j('.claude.json'),
      cli: 'claude',
      detect: [claudeDir || j('.claude'), j('.claude.json')],
    },
    kiro: { name: 'Kiro', kind: 'json', file: j('.kiro', 'settings', 'mcp.json'), detect: [j('.kiro')] },
    antigravity: {
      name: 'Antigravity',
      kind: 'json',
      file: j('.gemini', 'config', 'mcp_config.json'),
      detect: [j('.gemini', 'config'), j('.gemini', 'antigravity')],
    },
    cursor: { name: 'Cursor', kind: 'json', file: j('.cursor', 'mcp.json'), shape: stdio, detect: [j('.cursor')] },
    vscode: {
      name: 'VS Code',
      kind: 'json',
      key: 'servers',
      file: appDir('Code', 'User', 'mcp.json'),
      shape: stdio,
      jsonc: true,
      detect: [appDir('Code')],
    },
    'claude-desktop': {
      name: 'Claude Desktop',
      kind: 'json',
      file: appDir('Claude', 'claude_desktop_config.json'),
      detect: [appDir('Claude')],
    },
    codex: {
      name: 'Codex CLI',
      kind: 'codex',
      file: P.join(codexHome, 'config.toml'),
      cli: 'codex',
      detect: [codexHome],
    },
    gemini: {
      name: 'Gemini CLI',
      kind: 'json',
      file: j('.gemini', 'settings.json'),
      jsonc: true,
      cli: 'gemini',
      detect: [j('.gemini', 'settings.json')],
    },
    windsurf: {
      name: 'Windsurf / Devin Desktop',
      kind: 'json',
      file: P.join(devin, 'mcp_config.json'),
      detect: [devin],
    },
    'windsurf-legacy': {
      name: 'Windsurf (before the Devin rename)',
      kind: 'json',
      file: P.join(windsurf, 'mcp_config.json'),
      detect: [windsurf],
    },
    // Zed's settings.json is JSONC; it is edited only when it happens to be plain JSON.
    zed: {
      name: 'Zed',
      kind: 'json',
      key: 'context_servers',
      file: P.join(zed, 'settings.json'),
      jsonc: true,
      detect: [zed],
    },
  };
}

// Our server entry, recognised by its command: an mcp.js script, or the zaafpulse binary started with "mcp".
function isOurs(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.args)) return false;
  if (e.args.some((a) => /(^|[\\/])mcp\.js$/.test(String(a)))) return true;
  return /zaafpulse/i.test(path.basename(String(e.command || ''))) && e.args[0] === 'mcp';
}

// --- the TOML subset of Codex CLI's config.toml --------------------------------------------------------------------
// Tables, [[arrays]], key = value lines with strings, bare values (kept as written), arrays and inline tables. A
// multi-line string cannot be read: the table holding it reads as null.

// "a."b".c" -> ['a', 'b', 'c']
const tomlKey = (raw) =>
  (raw.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) || []).map((p) => {
    const s = p.trim();
    return s.startsWith('"') ? JSON.parse(s) : s.startsWith("'") ? s.slice(1, -1) : s;
  });

// Each [table] or [[array]] header, skipping lines inside multi-line strings and arrays, so a "[" there is not one.
function tomlTables(text) {
  const out = [];
  let pos = 0;
  let multi = null;
  let depth = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const m = !multi && depth === 0 && line.match(/^[ \t]*(\[\[?)\s*([^[\]\r\n]+?)\s*\]\]?[ \t]*(#.*)?\r?\n?$/);
    if (m) out.push({ key: tomlKey(m[2]), start: pos, body: pos + line.length });
    else {
      for (const q of line.match(/"""|'''/g) || []) multi = !multi ? q : multi === q ? null : multi;
      if (!multi) {
        const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/#.*/, '');
        depth = Math.max(0, depth + (bare.match(/[[{]/g) || []).length - (bare.match(/[\]}]/g) || []).length);
      }
    }
    pos += line.length;
  }
  return out;
}

// key = value lines: strings, bare values (numbers, booleans; kept as written), arrays and inline tables.
function tomlBody(s) {
  let i = 0;
  const ws = () => {
    while (i < s.length)
      if (/[ \t\r\n]/.test(s[i])) i++;
      else if (s[i] === '#') while (i < s.length && s[i] !== '\n') i++;
      else break;
  };
  const str = () => {
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) throw new Error('multi-line string');
    if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"' && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      const v = JSON.parse(s.slice(i, j + 1)); // TOML basic strings use JSON's escapes
      i = j + 1;
      return v;
    }
    if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0 || s.slice(i, j).includes('\n')) throw new Error('literal string');
      const v = s.slice(i + 1, j);
      i = j + 1;
      return v;
    }
    return null;
  };
  const key = () => {
    const parts = [];
    do {
      ws();
      const q = str();
      if (q !== null) parts.push(q);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
        if (!m) throw new Error(`key at ${i}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
    } while (s[i] === '.' && ++i);
    return parts;
  };
  const value = () => {
    ws();
    const q = str();
    if (q !== null) return q;
    if (s[i] === '[' || s[i] === '{') {
      const arr = s[i++] === '[';
      const out = arr ? [] : {};
      for (;;) {
        ws();
        if (s[i] === (arr ? ']' : '}')) return (i++, out);
        if (arr) out.push(value());
        else {
          const k = key();
          if (s[i++] !== '=') throw new Error('inline table');
          setPath(out, k, value());
        }
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== (arr ? ']' : '}')) throw new Error('array or inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(s.slice(i));
    if (!m) throw new Error(`value at ${i}`);
    i += m[0].length;
    return { raw: m[0] };
  };
  const out = {};
  for (;;) {
    ws();
    if (i >= s.length) return out;
    const k = key();
    if (s[i++] !== '=') throw new Error(`"=" expected after ${k.join('.')}`);
    setPath(out, k, value());
  }
}
function setPath(obj, keys, v) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !o[k].raw ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = v;
}

// Where [mcp_servers.<name>] and its sub-tables sit, and what they hold (null when it cannot be read).
function tomlFind(text, name) {
  const t = tomlTables(text);
  const ours = (x) => x && x.key[0] === 'mcp_servers' && x.key[1] === name;
  const first = t.findIndex(ours);
  if (first < 0) return { start: -1 };
  let last = first;
  while (ours(t[last + 1])) last++;
  const end = last + 1 < t.length ? t[last + 1].start : text.length;
  let value = {};
  try {
    for (let k = first; k <= last; k++) {
      const body = tomlBody(text.slice(t[k].body, k + 1 < t.length ? t[k + 1].start : text.length));
      if (t[k].key.length === 2) Object.assign(value, body);
      else setPath(value, t[k].key.slice(2), body);
    }
  } catch {
    value = null;
  }
  const plain = (v) => (v && v.raw !== undefined ? v.raw : v);
  if (value && value.env) value.env = Object.fromEntries(Object.entries(value.env).map(([k, v]) => [k, plain(v)]));
  return { start: t[first].start, end, value, scattered: t.slice(last + 1).some(ours) };
}

module.exports = {
  clients,
  isOurs,
  NAME,
  OLD_NAMES,
  toml: { key: tomlKey, tables: tomlTables, body: tomlBody, find: tomlFind, setPath },
};
