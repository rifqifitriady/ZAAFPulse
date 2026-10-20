#!/usr/bin/env node
// Registers this MCP server in AI clients, or removes it again.
//   node scripts/register-mcp.js <client|all> [--remove] [--dry-run] [--data DIR]
// Config files are backed up before every write (the last 3 backups are kept) and only our own entry is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// node + mcp.js, or the single-file binary with "mcp", plus the data folder when one was chosen (lib/platform.js).
const { mcpCommand, expandHome } = require('../lib/platform');

const NAME = 'zaafpulse';
// Earlier releases registered the stdio server under this name; it is replaced when it points at ZAAFPulse.
const OLD_NAMES = ['ai-command-center'];
const KEEP_BACKUPS = 3;

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
  // the rename keeps ~/.codeium/windsurf, which is used only when the new folder does not exist.
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
      file: exists(devin) || !exists(windsurf) ? P.join(devin, 'mcp_config.json') : P.join(windsurf, 'mcp_config.json'),
      detect: [devin, windsurf],
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

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// The executable on PATH, without starting a shell: on Windows a missing claude.cmd run through cmd.exe ends with
// exit status 1 rather than ENOENT, so it has to be looked up first.
function findOnPath(cmd, env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const dirs = String(env.PATH || env.Path || '')
    .split(win ? ';' : ':')
    .filter(Boolean);
  const exts = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const d of dirs)
    for (const x of exts) {
      const f = path.join(d, cmd + x);
      try {
        if (!fs.statSync(f).isFile()) continue;
        if (!win) fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch {
        /* next */
      }
    }
  return null;
}

// A command as the user would paste it: POSIX single quotes, or double quotes for cmd.exe and PowerShell.
function quoteArg(a, platform = process.platform) {
  const s = String(a);
  if (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s)) return s;
  return platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}
const showCmd = (cmd, args, platform) => [cmd, ...args].map((a) => quoteArg(a, platform)).join(' ');

// Our server entry, recognised by its command: an mcp.js script, or the zaafpulse binary started with "mcp".
function isOurs(e) {
  if (!e || typeof e !== 'object' || !Array.isArray(e.args)) return false;
  if (e.args.some((a) => /(^|[\\/])mcp\.js$/.test(String(a)))) return true;
  return /zaafpulse/i.test(path.basename(String(e.command || ''))) && e.args[0] === 'mcp';
}
const envOf = (e) => JSON.stringify(Object.entries((e && e.env) || {}).sort(([a], [b]) => a.localeCompare(b)));
// Same command, arguments and environment: an entry that still starts this install the same way.
const sameEntry = (a, b) =>
  !!a &&
  !!b &&
  a.command === b.command &&
  JSON.stringify(a.args || []) === JSON.stringify(b.args || []) &&
  envOf(a) === envOf(b);

// JSON config: a UTF-8 BOM is accepted (and kept), an empty or "null" file counts as {}.
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, bom: false };
    throw err;
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  if (!text.trim()) return { data: {}, bom };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`${file} is not valid JSON; fix or move it first, nothing was changed`);
    err.invalidJson = true;
    throw err;
  }
  if (data === null) data = {};
  if (typeof data !== 'object' || Array.isArray(data))
    throw new Error(`${file} does not hold a JSON object; nothing was changed`);
  return { data, bom };
}

// Whether our entry is in a client's config. Takes a client from clients() or, as server.js passes it, a file path
// (matched against this machine's clients so VS Code's "servers" and Codex's TOML are read the right way).
function isRegistered(target, key) {
  const c =
    target && typeof target === 'object'
      ? target
      : Object.values(clients()).find((x) => x.file === target) || { kind: 'json', file: target };
  let text = '';
  try {
    text = fs.readFileSync(c.file, 'utf8').replace(/^\ufeff/, '');
  } catch {
    return false;
  }
  if (c.kind === 'codex') return tomlFind(text, NAME).start >= 0;
  try {
    const s = readJson(c.file).data[key || c.key || 'mcpServers'];
    return !!(s && s[NAME]);
  } catch {
    // JSONC (comments, trailing commas) cannot be parsed here; the entry's key is a fair sign.
    return !!c.jsonc && new RegExp(`"${NAME}"\\s*:`).test(text);
  }
}

// The file a write lands in: a symlinked config is written through to its target, so the link stays a link.
function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    try {
      return path.resolve(path.dirname(file), fs.readlinkSync(file)); // dangling link: create its target
    } catch {
      return file;
    }
  }
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 17);
// <file>.bak-<timestamp> beside the path the user knows (the link, not its target), with the original's mode, and
// only the newest KEEP_BACKUPS of them kept.
function backup(file) {
  if (!exists(file)) return null;
  const b = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, b);
  try {
    fs.chmodSync(b, fs.statSync(file).mode & 0o7777);
  } catch {
    /* best effort on file systems without modes */
  }
  const dir = path.dirname(file);
  const re = new RegExp(`^${path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak-\\d{14,17}$`);
  const all = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS)))
    fs.rmSync(path.join(dir, old), { force: true });
  return b;
}

// Backup, then an atomic replace that keeps the file's mode and writes through a symlink.
function writeText(file, text) {
  const real = realTarget(file);
  let mode;
  try {
    mode = fs.statSync(real).mode & 0o7777;
  } catch {
    /* a new file gets the default mode */
  }
  fs.mkdirSync(path.dirname(real), { recursive: true });
  backup(file);
  const tmp = `${real}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, mode === undefined ? {} : { mode });
  if (mode !== undefined) fs.chmodSync(tmp, mode); // the mode passed to writeFileSync is reduced by the umask
  fs.renameSync(tmp, real);
}
const writeJson = (file, data, bom = false) =>
  writeText(file, `${bom ? '\ufeff' : ''}${JSON.stringify(data, null, 2)}\n`);

// What to change in one servers object: our entry set or removed, and old-named entries of ours removed.
function plan(servers, want, remove) {
  const cur = servers[NAME];
  return {
    legacy: OLD_NAMES.filter((n) => isOurs(servers[n])),
    cur,
    set: !remove && !sameEntry(cur, want),
    del: remove && cur !== undefined,
  };
}
const verb = (p, remove) => (remove ? 'removed' : p.cur !== undefined ? 'updated' : 'registered');

// Windows: claude and codex are .cmd files, which run through cmd.exe: quote any argument with spaces or cmd
// characters (& | < > ^ ( ) % !), so a path stays one argument instead of starting another command.
function runCli(o, cmd, args) {
  const win = o.platform === 'win32';
  o.exec(
    cmd,
    win ? args.map((x) => (/[\s&|<>^()%!"]/.test(String(x)) ? `"${String(x).replace(/"/g, '')}"` : String(x))) : args,
    { stdio: 'inherit', ...(win ? { shell: true } : {}) },
  );
}

// Claude Code: through its CLI (`claude mcp add|remove --scope user`); the state is read from ~/.claude.json.
function runClaude(c, want, o) {
  let servers = {};
  try {
    servers = readJson(c.file).data.mcpServers || {};
  } catch {
    /* unreadable: treat as not registered and let the CLI decide */
  }
  const p = plan(servers, want, o.remove);
  const rm = (n) => ['mcp', 'remove', '--scope', 'user', n];
  // --env pairs need another option before the name, or the CLI reads the name as one more pair.
  const env = Object.entries(want.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const add = ['mcp', 'add', '--scope', 'user', ...(env.length ? [...env, '--transport', 'stdio'] : []), NAME];
  const steps = [
    ...p.legacy.map(rm),
    ...(p.del || (p.set && p.cur !== undefined) ? [rm(NAME)] : []),
    ...(p.set ? [[...add, '--', want.command, ...want.args]] : []),
  ];
  if (!steps.length) return o.log(`${c.name}: already ${o.remove ? 'absent' : 'registered'}`);
  const shown = steps.map((a) => showCmd('claude', a, o.platform));
  const manual = () => o.log(`claude CLI not found. Run this yourself:\n  ${shown.join('\n  ')}`);
  if (o.dryRun) return shown.forEach((s) => o.log(`[dry-run] ${s}`));
  if (!o.which('claude')) return manual();
  backup(c.file);
  for (const args of steps) {
    try {
      runCli(o, 'claude', args);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return manual();
    }
  }
  if (p.legacy.length) o.log(`${c.name}: removed the old "${p.legacy.join('", "')}" entry`);
  if (p.set || p.del) o.log(`${c.name}: ${verb(p, o.remove)} (user scope)`);
}

// File clients with a JSON object of servers under one key.
function runJson(c, want, o) {
  const key = c.key || 'mcpServers';
  const entry = c.shape ? c.shape(want) : want;
  let parsed;
  try {
    parsed = readJson(c.file);
  } catch (err) {
    if (!(err.invalidJson && c.jsonc)) throw err;
    return o.log(manualJson(c, key, entry, o));
  }
  const { data, bom } = parsed;
  const found = data[key] == null ? {} : data[key];
  if (typeof found !== 'object' || Array.isArray(found)) throw new Error(`${c.file}: "${key}" is not an object`);
  const servers = { ...found };
  const p = plan(servers, entry, o.remove);
  if (!p.set && !p.del && !p.legacy.length)
    return o.log(`${c.name}: already ${o.remove ? 'absent' : 'registered'} (${c.file})`);
  for (const n of p.legacy) delete servers[n];
  if (p.del) delete servers[NAME];
  if (p.set) {
    // Keep settings the user added to our entry (disabled, autoApprove, ...); replace how it starts.
    const next = { ...(p.cur && typeof p.cur === 'object' ? p.cur : {}), ...entry };
    if (!entry.env) delete next.env;
    servers[NAME] = next;
  }
  if (o.dryRun) {
    const what = [
      ...p.legacy.map((n) => `remove "${n}"`),
      ...(p.del ? [`remove "${NAME}"`] : []),
      ...(p.set ? [`set "${NAME}" = ${JSON.stringify(servers[NAME])}`] : []),
    ];
    return o.log(`[dry-run] ${c.file}: ${what.join('; ')}`);
  }
  writeJson(c.file, { ...data, [key]: servers }, bom);
  if (p.legacy.length) o.log(`${c.name}: removed the old "${p.legacy.join('", "')}" entry (${c.file})`);
  if (p.set || p.del) o.log(`${c.name}: ${verb(p, o.remove)} (${c.file})`);
}

// A JSONC file (VS Code, Zed, Gemini CLI allow comments) is never rewritten, since that would drop the comments:
// say exactly what to add or remove instead.
function manualJson(c, key, entry, o) {
  const old = OLD_NAMES.map((n) => `"${n}"`).join(', ');
  if (o.remove)
    return `${c.name}: ${c.file} has comments or trailing commas, so it was left alone. Remove the "${NAME}" entry (and ${old} if present) from "${key}" yourself.`;
  const lines = [
    `${c.name}: ${c.file} has comments or trailing commas, so it was left alone. Add this under "${key}" yourself (and remove ${old} if present):`,
    `  "${NAME}": ${JSON.stringify(entry)}`,
  ];
  if (c.key === 'servers')
    lines.push(`or run:\n  ${showCmd('code', ['--add-mcp', JSON.stringify({ name: NAME, ...entry })], o.platform)}`);
  return lines.join('\n');
}

// --- Codex CLI: $CODEX_HOME/config.toml (default ~/.codex) ---------------------------------------------------------
// Without a TOML library the file is never re-serialised: only the [mcp_servers.<name>] table (and its sub-tables)
// is cut out, replaced or appended, and every other byte stays as it was.

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

const tq = (s) => JSON.stringify(String(s)); // a JSON string is a valid TOML basic string
const tk = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tq(k));
const tv = (v) =>
  v && v.raw !== undefined
    ? v.raw
    : Array.isArray(v)
      ? `[${v.map(tv).join(', ')}]`
      : v && typeof v === 'object'
        ? `{ ${Object.entries(v)
            .map(([k, x]) => `${tk(k)} = ${tv(x)}`)
            .join(', ')} }`
        : tq(v);
// Our table; settings the user added to it (enabled, timeouts, ...) are kept.
function tomlBlock(name, e, cur) {
  const lines = [`[mcp_servers.${tk(name)}]`, `command = ${tq(e.command)}`, `args = ${tv(e.args)}`];
  if (e.env) lines.push(`env = ${tv(e.env)}`);
  for (const [k, v] of Object.entries(cur || {}))
    if (!['command', 'args', 'env'].includes(k)) lines.push(`${tk(k)} = ${tv(v)}`);
  return `${lines.join('\n')}\n`;
}
function tomlCut(text, f, insert = '') {
  const before = text.slice(0, f.start);
  const after = text.slice(f.end);
  if (insert) return before + insert + (after ? `\n${after}` : '');
  return after ? before + after : before.replace(/\s+$/, '') + (before.trim() ? '\n' : '');
}

function runCodex(c, want, o) {
  let text = '';
  try {
    text = fs.readFileSync(c.file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const block = tomlBlock(NAME, want);
  const manual = (why) =>
    o.log(
      `${c.name}: ${c.file} ${why}, so it was left alone. ${o.remove ? `Remove the [mcp_servers.${NAME}] table yourself.` : `Add this yourself:\n${block}`}`,
    );
  // mcp_servers written as dotted keys or an inline table, or our table split in two: not safe to cut out.
  if (/^[ \t]*mcp_servers[ \t]*[.=]/m.test(text)) return manual('defines mcp_servers with dotted keys or inline');
  const cur = tomlFind(text, NAME);
  if (cur.scattered) return manual(`has the [mcp_servers.${NAME}] table in more than one place`);
  const legacy = OLD_NAMES.filter((n) => {
    const f = tomlFind(text, n);
    return f.start >= 0 && !f.scattered && isOurs(f.value);
  });
  const has = cur.start >= 0;
  const set = !o.remove && !(has && sameEntry(cur.value, want));
  const del = o.remove && has;
  if (!set && !del && !legacy.length)
    return o.log(`${c.name}: already ${o.remove ? 'absent' : 'registered'} (${c.file})`);
  const fresh = set && !has && !legacy.length;
  const cliArgs = [
    'mcp',
    'add',
    NAME,
    ...Object.entries(want.env || {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--',
    want.command,
    ...want.args,
  ];
  if (o.dryRun) {
    if (fresh && o.which('codex')) return o.log(`[dry-run] ${showCmd('codex', cliArgs, o.platform)}`);
    const what = [
      ...legacy.map((n) => `remove [mcp_servers.${n}]`),
      ...(del ? [`remove [mcp_servers.${NAME}]`] : []),
      ...(set ? [`set:\n${tomlBlock(NAME, want, has && cur.value)}`] : []),
    ];
    return o.log(`[dry-run] ${c.file}: ${what.join('; ')}`);
  }
  // A new entry goes through `codex mcp add` when the CLI is installed; replacing or removing one is a table edit.
  if (fresh && o.which('codex')) {
    backup(c.file);
    try {
      runCli(o, 'codex', cliArgs);
      return o.log(`${c.name}: registered (codex mcp add)`);
    } catch (err) {
      o.log(`${c.name}: codex mcp add failed (${err.message.split('\n')[0]}); editing ${c.file} instead`);
    }
  }
  let next = text;
  for (const n of legacy) next = tomlCut(next, tomlFind(next, n));
  const now = tomlFind(next, NAME);
  if (del) next = tomlCut(next, now);
  if (set)
    next =
      now.start >= 0
        ? tomlCut(next, now, tomlBlock(NAME, want, now.value))
        : `${next.replace(/\s+$/, '')}${next.trim() ? '\n\n' : ''}${block}`;
  writeText(c.file, (bom ? '\ufeff' : '') + next);
  if (legacy.length) o.log(`${c.name}: removed the old "${legacy.join('", "')}" entry (${c.file})`);
  if (set || del) o.log(`${c.name}: ${o.remove ? 'removed' : has ? 'updated' : 'registered'} (${c.file})`);
}

const RUNNERS = { claude: runClaude, json: runJson, codex: runCodex };

function detected(c, which = (cmd) => findOnPath(cmd)) {
  return (c.detect || []).some(exists) || (!!c.cli && !!which(c.cli));
}

function run(
  target,
  {
    remove = false,
    dryRun = false,
    data,
    home,
    env,
    platform = process.platform,
    exec = execFileSync,
    which,
    log = console.log,
  } = {},
) {
  const e = env || (home == null ? process.env : {});
  const all = clients(home, { env: e, platform });
  const o = { remove, dryRun, platform, exec, log, which: which || ((cmd) => findOnPath(cmd, e, platform)) };
  const ids = target === 'all' ? Object.keys(all) : [target];
  const want = mcpCommand({ env: e, data });
  const skipped = [];
  const failed = [];
  for (const id of ids) {
    const c = all[id];
    if (!c) throw new Error(`unknown client "${id}" (use ${Object.keys(all).join(', ')} or all)`);
    // "all" only touches clients that are installed here, so it never creates config folders for apps you lack.
    if (target === 'all' && !detected(c, o.which)) {
      skipped.push(c.name);
      continue;
    }
    try {
      RUNNERS[c.kind](c, want, o);
    } catch (err) {
      if (target !== 'all') throw err;
      failed.push(`${c.name}: ${err.message}`);
    }
  }
  if (skipped.length) log(`Skipped (not found on this machine): ${skipped.join(', ')}`);
  if (failed.length) throw new Error(failed.join('\n'));
}

module.exports = {
  run,
  clients,
  isRegistered,
  detected,
  findOnPath,
  quoteArg,
  isOurs,
  toml: { find: tomlFind, tables: tomlTables, body: tomlBody, block: tomlBlock },
  NAME,
  OLD_NAMES,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
    if (i < 0) return undefined;
    return args[i].includes('=') ? args[i].slice(flag.length + 1) : args[i + 1];
  };
  const data = valueOf('--data');
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--data');
  if (!target || args.includes('--help')) {
    console.error(
      `usage: npm run mcp:register -- <${Object.keys(clients()).join('|')}|all> [--remove] [--dry-run] [--data DIR]\n` +
        '  all       every client found on this machine\n' +
        '  --data    the data folder the client should use (default: ZAAFPULSE_DATA or the usual folder)',
    );
    process.exit(args.includes('--help') ? 0 : 2);
  }
  try {
    run(target, { remove: args.includes('--remove'), dryRun: args.includes('--dry-run'), data });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
