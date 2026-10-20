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
function clients(home, { env, platform = process.platform } = {}) {
  const e = env || (home == null ? process.env : {});
  const h = home == null ? os.homedir() : home;
  const j = (...p) => path.join(h, ...p);
  const claudeDir = e.CLAUDE_CONFIG_DIR ? path.resolve(expandHome(e.CLAUDE_CONFIG_DIR)) : null;
  return {
    claude: {
      name: 'Claude Code',
      kind: 'claude',
      file: claudeDir ? path.join(claudeDir, '.claude.json') : j('.claude.json'),
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

function isRegistered(file, key = 'mcpServers') {
  try {
    const s = readJson(file).data[key];
    return !!(s && s[NAME]);
  } catch {
    return false;
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
const writeJson = (file, data, bom = false) => writeText(file, `${bom ? '﻿' : ''}${JSON.stringify(data, null, 2)}\n`);

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
  const win = o.platform === 'win32';
  for (const args of steps) {
    try {
      // Windows: claude is claude.cmd, which runs through cmd.exe: quote any argument with spaces or cmd
      // characters (& | < > ^ ( ) % !), so a path stays one argument instead of starting another command.
      o.exec(
        'claude',
        win
          ? args.map((x) => (/[\s&|<>^()%!"]/.test(String(x)) ? `"${String(x).replace(/"/g, '')}"` : String(x)))
          : args,
        { stdio: 'inherit', ...(win ? { shell: true } : {}) },
      );
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
  const { data, bom } = readJson(c.file);
  const found = data[key] == null ? {} : data[key];
  if (typeof found !== 'object' || Array.isArray(found)) throw new Error(`${c.file}: "${key}" is not an object`);
  const servers = { ...found };
  const entry = c.shape ? c.shape(want) : want;
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

const RUNNERS = { claude: runClaude, json: runJson };

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

module.exports = { run, clients, isRegistered, detected, findOnPath, quoteArg, isOurs, NAME, OLD_NAMES };

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
    process.exit(target ? 0 : 2);
  }
  try {
    run(target, { remove: args.includes('--remove'), dryRun: args.includes('--dry-run'), data });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
