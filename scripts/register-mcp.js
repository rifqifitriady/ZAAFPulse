#!/usr/bin/env node
// Registers this MCP server in Claude Code, Kiro and Antigravity, or removes it again.
//   node scripts/register-mcp.js <claude|kiro|antigravity|all> [--remove] [--dry-run]
// Config files are backed up before every write and only our own entry is touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = 'ai-command-center';
// node + mcp.js, or the single-file binary with "mcp" (lib/platform.js).
const { mcpCommand } = require('../lib/platform');

function clients(home = os.homedir()) {
  return {
    claude: { name: 'Claude Code', file: path.join(home, '.claude.json'), cli: true },
    kiro: { name: 'Kiro', file: path.join(home, '.kiro', 'settings', 'mcp.json') },
    antigravity: { name: 'Antigravity', file: path.join(home, '.gemini', 'config', 'mcp_config.json') },
  };
}
const entry = () => mcpCommand();

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it first, nothing was changed`);
  }
}

function isRegistered(file) {
  try {
    const s = readJson(file).mcpServers;
    return !!(s && s[NAME]);
  } catch {
    return false;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file))
    fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function claudeArgs(remove) {
  const m = mcpCommand();
  return remove
    ? ['mcp', 'remove', '--scope', 'user', NAME]
    : ['mcp', 'add', '--scope', 'user', NAME, '--', m.command, ...m.args];
}

function run(target, { remove = false, dryRun = false, home, exec = execFileSync, log = console.log } = {}) {
  const all = clients(home);
  const ids = target === 'all' ? Object.keys(all) : [target];
  for (const id of ids) {
    const c = all[id];
    if (!c) throw new Error(`unknown client "${id}" (use claude, kiro, antigravity or all)`);
    if (c.cli) {
      const args = claudeArgs(remove);
      if (dryRun) {
        log(`[dry-run] claude ${args.join(' ')}`);
        continue;
      }
      if (isRegistered(c.file) !== remove) {
        log(`${c.name}: already ${remove ? 'absent' : 'registered'}`);
        continue;
      }
      // Windows: claude is claude.cmd, which runs through cmd.exe: quote every argument, so a path with
      // spaces or characters such as & or ^ stays one argument instead of starting another command.
      const win = process.platform === 'win32';
      try {
        exec('claude', win ? args.map((x) => `"${String(x).replace(/"/g, '')}"`) : args, {
          stdio: 'inherit',
          ...(win ? { shell: true } : {}),
        });
        log(`${c.name}: ${remove ? 'removed' : 'registered'} (user scope)`);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        log(`claude CLI not found. Run this yourself:\n  claude ${args.join(' ')}`);
      }
      continue;
    }
    const data = readJson(c.file);
    const servers = { ...(data.mcpServers || {}) };
    const before = JSON.stringify(servers[NAME]);
    if (remove) delete servers[NAME];
    else servers[NAME] = entry();
    const next = { ...data, mcpServers: servers };
    if (dryRun) {
      log(`[dry-run] ${c.file}\n${JSON.stringify(next, null, 2)}`);
      continue;
    }
    if (before === JSON.stringify(servers[NAME])) {
      log(`${c.name}: already ${remove ? 'absent' : 'registered'} (${c.file})`);
      continue;
    }
    writeJson(c.file, next);
    log(`${c.name}: ${remove ? 'removed from' : 'registered in'} ${c.file}`);
  }
}

module.exports = { run, clients, isRegistered, NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: npm run mcp:register -- <claude|kiro|antigravity|all> [--remove] [--dry-run]');
    process.exit(2);
  }
  try {
    run(target, { remove: args.includes('--remove'), dryRun: args.includes('--dry-run') });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
