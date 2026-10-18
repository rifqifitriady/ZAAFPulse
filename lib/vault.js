// Reads an Obsidian vault into a note graph: notes, [[wikilinks]] / markdown links between
// them, tags, and frontmatter type. Follows symlinked folders (the vault links in Claude's
// memory and customer folders) with a realpath guard against cycles.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.venv', '__pycache__', 'dist', 'build']);
const MAX_FILES = 3000;
const MAX_BYTES = 1.5 * 1024 * 1024;

// The vaults Obsidian knows about (its obsidian.json, wherever this OS keeps it).
const { registeredVaults } = require('./platform');

function listNotes(root) {
  const out = [];
  const seen = new Set();
  const walk = (dir, rel, depth) => {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real) || depth > 8 || out.length >= MAX_FILES) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory(); let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = fs.statSync(p); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      }
      if (isDir) walk(p, r, depth + 1);
      else if (isFile && e.name.toLowerCase().endsWith('.md')) out.push({ abs: p, rel: r });
    }
  };
  walk(root, '', 0);
  return out;
}

function frontmatter(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const raw = text.slice(3, end);
  const fm = {};
  const tags = [];
  let inTags = false;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) {
      inTags = m[1] === 'tags' && !m[2].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1] === 'tags' && v) tags.push(...v.replace(/[[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean));
      else if (!(m[1] in fm)) fm[m[1]] = v;
    } else if (inTags) {
      const t = line.match(/^\s*-\s*(.+)$/);
      if (t) tags.push(t[1].trim());
    }
  }
  fm.tags = tags;
  return { fm, body: text.slice(end + 4) };
}

const WIKILINK = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/gi;
const TAG = /(^|\s)#([A-Za-z][\w/-]{1,40})/g;

function groupOf(rel, fm, name) {
  if (/^(_brain|_moc|MEMORY$|START HERE$|📊)/i.test(name)) return 'hub';
  const type = (fm.type || '').toLowerCase();
  if (['project', 'reference', 'feedback'].includes(type)) return type;
  if (rel.startsWith('Projects/')) return 'account';
  if (type) return 'other';
  return 'vault';
}

function scanVault(root) {
  const files = listNotes(root);
  const notes = [];
  const byName = new Map(); // lowercase basename -> note index (Obsidian resolves by shortest unique name)
  const byPath = new Map();

  for (const f of files) {
    let st;
    try { st = fs.statSync(f.abs); } catch { continue; }
    let text = '';
    if (st.size <= MAX_BYTES) { try { text = fs.readFileSync(f.abs, 'utf8'); } catch { /* unreadable */ } }
    const { fm, body } = frontmatter(text);
    const name = path.basename(f.rel, path.extname(f.rel));
    const tags = new Set(fm.tags || []);
    for (const m of body.matchAll(TAG)) tags.add(m[2]);
    const links = [];
    for (const m of body.matchAll(WIKILINK)) links.push(m[1].trim());
    for (const m of text.matchAll(MDLINK)) links.push(decodeURIComponent(m[1]).replace(/^\.\//, ''));
    if (fm.description) for (const m of String(fm.description).matchAll(WIKILINK)) links.push(m[1].trim());
    const top = f.rel.includes('/') ? f.rel.split('/')[0] : '(root)';
    const note = {
      id: notes.length, name, path: f.rel, folder: top, group: groupOf(f.rel, fm, name),
      words: (body.match(/\S+/g) || []).length, tags: [...tags].slice(0, 12),
      description: String(fm.description || '').replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1').slice(0, 220),
      created: Math.round(st.birthtimeMs || st.mtimeMs), modified: Math.round(st.mtimeMs), links,
    };
    notes.push(note);
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), note.id);
    byPath.set(f.rel.toLowerCase().replace(/\.md$/, ''), note.id);
  }

  const edges = new Map();
  const unresolved = {};
  for (const n of notes) {
    for (const raw of n.links) {
      const key = raw.toLowerCase().replace(/\.md$/, '');
      const target = byPath.get(key) ?? byName.get(path.basename(key)) ?? null;
      if (target == null) { unresolved[raw] = (unresolved[raw] || 0) + 1; continue; }
      if (target === n.id) continue;
      edges.set(`${n.id}>${target}`, [n.id, target]);
    }
    delete n.links;
  }
  const deg = notes.map(() => ({ in: 0, out: 0 }));
  for (const [a, b] of edges.values()) { deg[a].out++; deg[b].in++; }
  notes.forEach((n, i) => { n.inLinks = deg[i].in; n.outLinks = deg[i].out; });

  return {
    vault: path.basename(root), root, scannedAt: Date.now(),
    notes, edges: [...edges.values()],
    unresolved: Object.entries(unresolved).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 40),
  };
}

let memo = { key: null, data: null, at: 0 };
function getVault(configured) {
  const roots = configured && configured.length ? configured : registeredVaults();
  if (!roots.length) return { vault: null, notes: [], edges: [], unresolved: [], error: 'No Obsidian vault found. Add its path under Settings.' };
  const root = roots[0];
  if (memo.key === root && Date.now() - memo.at < 30000) return memo.data;
  const data = scanVault(root);
  data.vaults = roots;
  memo = { key: root, data, at: Date.now() };
  return data;
}

module.exports = { getVault };
