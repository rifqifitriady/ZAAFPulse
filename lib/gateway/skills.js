// Agent Skills for ZAAFPulse (skills/<name>/SKILL.md in this repo): served by the gateway at
// /skills/<name>/SKILL.md so an AI can read them from the running version (never from a public branch),
// and installable into Claude Code (~/.claude/skills). Install copies only our skills and marks them;
// remove deletes only folders that carry that mark, so a user's own skill of the same name is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'skills');
const NAME = /^zaafpulse(-[a-z0-9-]{1,30})?$/;
const MARK = '.installed-by-zaafpulse';

function frontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/); const out = {};
  if (m) for (const line of m[1].split('\n')) { const kv = line.match(/^([a-z_-]+):\s*(.*)$/i); if (kv) out[kv[1]] = kv[2].trim(); }
  return out;
}

function createSkills({ dir = DIR, home = os.homedir(), version = '1.0.0' } = {}) {
  const names = () => { try { return fs.readdirSync(dir).filter((n) => NAME.test(n) && fs.existsSync(path.join(dir, n, 'SKILL.md'))).sort((a, b) => (a === 'zaafpulse' ? -1 : b === 'zaafpulse' ? 1 : a.localeCompare(b))); } catch { return []; } };
  const read = (name) => (NAME.test(name) && names().includes(name) ? fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8') : null);
  const target = (name) => path.join(home, '.claude', 'skills', name);
  const status = (name) => { const t = target(name); if (!fs.existsSync(path.join(t, 'SKILL.md'))) return 'not installed'; if (!fs.existsSync(path.join(t, MARK))) return 'yours'; return fs.readFileSync(path.join(t, 'SKILL.md'), 'utf8') === read(name) ? 'installed' : 'outdated'; };
  return {
    list: () => names().map((n) => { const fm = frontmatter(read(n)); return { name: n, description: fm.description || '', path: `/skills/${n}/SKILL.md`, claude: status(n) }; }),
    read,
    index: (base) => `# ZAAFPulse agent skills (v${version})\n\nStart with ${base}/skills/zaafpulse/SKILL.md\n\n${names().map((n) => `- ${n}: ${base}/skills/${n}/SKILL.md\n  ${frontmatter(read(n)).description || ''}`).join('\n')}\n`,
    install() {
      const done = []; const skipped = [];
      for (const n of names()) {
        const t = target(n);
        if (fs.existsSync(path.join(t, 'SKILL.md')) && !fs.existsSync(path.join(t, MARK))) { skipped.push(n); continue; } // a skill of the user's own
        fs.mkdirSync(t, { recursive: true }); fs.writeFileSync(path.join(t, 'SKILL.md'), read(n)); fs.writeFileSync(path.join(t, MARK), `v${version}\n`); done.push(n);
      }
      return { installed: done, skipped, path: '~/.claude/skills' };
    },
    uninstall() {
      const removed = [];
      for (const n of names()) { const t = target(n); if (fs.existsSync(path.join(t, MARK))) { fs.rmSync(t, { recursive: true, force: true }); removed.push(n); } }
      return { removed };
    },
  };
}

module.exports = { createSkills, frontmatter };
