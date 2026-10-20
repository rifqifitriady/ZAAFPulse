// Agent Skills for ZAAFPulse (skills/<name>/ in this repo): served by the gateway at /skills/<name>/SKILL.md so an AI
// can read them from the running version (never from a public branch), and installable as whole folders into
// Claude Code (~/.claude/skills, or $CLAUDE_CONFIG_DIR/skills) and into ~/.agents/skills, the cross-client location
// from the Agent Skills client guide (agentskills.io). Install copies only our skills and marks them; remove deletes
// only folders that carry that mark, so a user's own skill of the same name is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'skills');
const NAME = /^zaafpulse(-[a-z0-9-]{1,30})?$/;
const MARK = '.installed-by-zaafpulse';
const TARGETS = ['claude', 'agents'];

// name and description from the YAML frontmatter; files checked out with CRLF line ends (or a BOM) work too.
function frontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (m)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_-]+):\s*(.*)$/i);
      if (kv) out[kv[1]] = kv[2].trim();
    }
  return out;
}

// Every regular file under a folder, as relative paths with "/" (links and our mark left out).
function filesIn(root) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r);
      else if (d.isFile() && d.name !== MARK) out.push(r);
    }
  };
  try {
    walk('');
  } catch {
    /* missing folder: no files */
  }
  return out.sort();
}

// "home" given without "env" (tests, demo) never reads this machine's CLAUDE_CONFIG_DIR.
function createSkills({ dir = DIR, home, env, version = '1.0.0' } = {}) {
  const e = env || (home == null ? process.env : {});
  const h = home == null ? os.homedir() : home;
  const roots = {
    claude: e.CLAUDE_CONFIG_DIR
      ? path.join(path.resolve(String(e.CLAUDE_CONFIG_DIR).replace(/^~(?=$|[\\/])/, h)), 'skills')
      : path.join(h, '.claude', 'skills'),
    agents: path.join(h, '.agents', 'skills'),
  };
  const shown = (p) => (p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p).split(path.sep).join('/');
  const names = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => NAME.test(n) && fs.existsSync(path.join(dir, n, 'SKILL.md')))
        .sort((a, b) => (a === 'zaafpulse' ? -1 : b === 'zaafpulse' ? 1 : a.localeCompare(b)));
    } catch {
      return [];
    }
  };
  const read = (name) =>
    NAME.test(name) && names().includes(name) ? fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8') : null;
  const target = (name, where) => path.join(roots[where], name);
  const same = (a, b) => {
    try {
      return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch {
      return false;
    }
  };
  const status = (name, where = 'claude') => {
    const t = target(name, where);
    if (!fs.existsSync(path.join(t, 'SKILL.md'))) return 'not installed';
    if (!fs.existsSync(path.join(t, MARK))) return 'yours';
    const src = filesIn(path.join(dir, name));
    const dst = filesIn(t);
    return src.length === dst.length &&
      src.every((f, i) => f === dst[i] && same(path.join(dir, name, f), path.join(t, f)))
      ? 'installed'
      : 'outdated';
  };
  const pick = (where) => {
    if (where === 'all') return TARGETS;
    if (!TARGETS.includes(where)) throw new Error(`unknown skills location "${where}" (use claude, agents or all)`);
    return [where];
  };
  return {
    roots: () => ({ claude: shown(roots.claude), agents: shown(roots.agents) }),
    list: () =>
      names().map((n) => {
        const fm = frontmatter(read(n));
        return {
          name: n,
          description: fm.description || '',
          path: `/skills/${n}/SKILL.md`,
          claude: status(n, 'claude'),
          agents: status(n, 'agents'),
        };
      }),
    read,
    index: (base) =>
      `# ZAAFPulse agent skills (v${version})\n\nStart with ${base}/skills/zaafpulse/SKILL.md\n\n${names()
        .map((n) => `- ${n}: ${base}/skills/${n}/SKILL.md\n  ${frontmatter(read(n)).description || ''}`)
        .join('\n')}\n`,
    // Copies each skill folder whole (SKILL.md and any scripts/, references/, assets/), replacing an older copy of
    // ours. where: "claude" (default), "agents" or "all".
    install(where = 'claude') {
      const done = [];
      const skipped = [];
      const places = pick(where);
      for (const w of places)
        for (const n of names()) {
          const t = target(n, w);
          const label = places.length > 1 ? `${n} (${shown(roots[w])})` : n;
          if (fs.existsSync(t) && !fs.existsSync(path.join(t, MARK))) {
            skipped.push(label); // a skill of the user's own
            continue;
          }
          fs.rmSync(t, { recursive: true, force: true });
          for (const f of filesIn(path.join(dir, n))) {
            fs.mkdirSync(path.dirname(path.join(t, f)), { recursive: true });
            fs.copyFileSync(path.join(dir, n, f), path.join(t, f));
          }
          fs.writeFileSync(path.join(t, MARK), `v${version}\n`);
          done.push(label);
        }
      return { installed: done, skipped, path: places.map((w) => shown(roots[w])).join(', ') };
    },
    uninstall(where = 'all') {
      const removed = [];
      const places = pick(where);
      for (const w of places)
        for (const n of names()) {
          const t = target(n, w);
          if (fs.existsSync(path.join(t, MARK))) {
            fs.rmSync(t, { recursive: true, force: true });
            removed.push(places.length > 1 ? `${n} (${shown(roots[w])})` : n);
          }
        }
      return { removed };
    },
  };
}

module.exports = { createSkills, frontmatter };
