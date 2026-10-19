// Markdown knowledge graphs: Obsidian vaults, Logseq graphs, and Markdown exports (Reflect, Heybrain,
// any PARA folder). Notes, [[wikilinks]] / markdown links / #tags between them, frontmatter or Logseq
// `key:: value` properties. Follows symlinked folders with a realpath guard against cycles. Only metadata
// and link structure leave this module; note text is read but never returned.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  '.obsidian',
  '.git',
  'node_modules',
  '.trash',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'logseq',
  'bak',
  '.recycle',
]);
const MAX_FILES = 3000;
const MAX_BYTES = 1.5 * 1024 * 1024;

// The vaults Obsidian knows about (its obsidian.json, wherever this OS keeps it).
const { registeredVaults } = require('../platform');

function listNotes(root, exts = ['.md']) {
  const out = [];
  const seen = new Set();
  const walk = (dir, rel, depth) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real) || depth > 8 || out.length >= MAX_FILES) return;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) walk(p, r, depth + 1);
      else if (isFile && exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push({ abs: p, rel: r });
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
      if (m[1] === 'tags' && v)
        tags.push(
          ...v
            .replace(/[[\]]/g, '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        );
      else if (!(m[1] in fm)) fm[m[1]] = v;
    } else if (inTags) {
      const t = line.match(/^\s*-\s*(.+)$/);
      if (t) tags.push(t[1].trim());
    }
  }
  fm.tags = tags;
  return { fm, body: text.slice(end + 4) };
}
// Logseq page properties: leading `key:: value` lines.
function logseqProps(text) {
  const fm = { tags: [] };
  const links = [];
  for (const line of text.split('\n').slice(0, 30)) {
    const m = line.match(/^\s*-?\s*([A-Za-z][\w-]*)::\s*(.*)$/);
    if (!m) {
      if (line.trim() && !line.trim().startsWith('-')) break;
      continue;
    }
    const vals = m[2]
      .split(',')
      .map((v) =>
        v
          .trim()
          .replace(/^\[\[|\]\]$/g, '')
          .replace(/^#/, ''),
      )
      .filter(Boolean);
    if (m[1] === 'tags') {
      fm.tags.push(...vals);
      links.push(...vals);
    } else if (m[1] === 'alias') {
      fm.aliases = vals;
    } else if (!(m[1] in fm)) fm[m[1]] = m[2].trim();
  }
  return { fm, links };
}

const WIKILINK = /!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/gi;
const TAG = /(^|\s)#([A-Za-z][\w/-]{1,40})/g;
const LOGSEQ_TAG = /(^|\s)#(?:\[\[([^\]]+)\]\]|([A-Za-z][\w/-]{1,60}))/g;

// PARA (Projects, Areas, Resources, Archives) from a folder name like "1 Projects", "02-Areas", "Archive".
const PARA = [
  ['projects', /^(\d+[\s._-]*)?projects?$/i],
  ['areas', /^(\d+[\s._-]*)?areas?( of responsibility)?$/i],
  ['resources', /^(\d+[\s._-]*)?resources?$/i],
  ['archives', /^(\d+[\s._-]*)?archives?$/i],
];
function paraOf(segments = [], tags = []) {
  for (const s of segments) for (const [k, re] of PARA) if (re.test(String(s).trim())) return k;
  for (const t of tags) {
    const x = String(t).toLowerCase();
    if (/^(project|projects)$/.test(x)) return 'projects';
    if (/^(area|areas)$/.test(x)) return 'areas';
    if (/^(resource|resources)$/.test(x)) return 'resources';
    if (/^(archive|archived|archives)$/.test(x)) return 'archives';
  }
  return null;
}

function groupOf(rel, fm, name, flavor) {
  if (flavor === 'logseq') return rel.startsWith('journals/') ? 'journal' : (fm.tags || []).length ? 'tagged' : 'page';
  if (/^(_brain|_moc|MEMORY$|START HERE$|📊)/i.test(name)) return 'hub';
  const type = (fm.type || '').toLowerCase();
  if (['project', 'reference', 'feedback'].includes(type)) return type;
  if (rel.startsWith('Projects/')) return 'account';
  if (type) return 'other';
  return 'vault';
}
// Logseq file names encode "/" in page names as "___" (or %2F in older graphs); journals are yyyy_mm_dd.
const logseqName = (base) => decodeURIComponent(base.replace(/___/g, '/').replace(/%(?![0-9A-F]{2})/gi, '%25'));
const journalDate = (base) => {
  const m = base.match(/^(\d{4})_(\d{2})_(\d{2})$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T09:00:00`).getTime() : null;
};

// flavor: obsidian | logseq | markdown (exports, PARA folders)
function scanMarkdown(root, { flavor = 'obsidian', uri } = {}) {
  const files = listNotes(root);
  const notes = [];
  const byName = new Map(); // lowercase name or alias -> note index (resolve by shortest unique name)
  const byPath = new Map();

  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f.abs);
    } catch {
      continue;
    }
    let text = '';
    if (st.size <= MAX_BYTES) {
      try {
        text = fs.readFileSync(f.abs, 'utf8');
      } catch {
        /* unreadable */
      }
    }
    let fm;
    let body;
    const links = [];
    if (flavor === 'logseq') {
      const p = logseqProps(text);
      fm = p.fm;
      body = text;
      links.push(...p.links);
    } else ({ fm, body } = frontmatter(text));
    const base = path.basename(f.rel, path.extname(f.rel));
    const name = flavor === 'logseq' ? logseqName(base) : base;
    const tags = new Set(fm.tags || []);
    if (flavor === 'logseq')
      for (const m of body.matchAll(LOGSEQ_TAG)) {
        const t = m[2] || m[3];
        tags.add(t);
        links.push(t);
      }
    else for (const m of body.matchAll(TAG)) tags.add(m[2]);
    for (const m of body.matchAll(WIKILINK)) links.push(m[1].trim());
    for (const m of text.matchAll(MDLINK)) links.push(decodeURIComponent(m[1]).replace(/^\.\//, ''));
    if (fm.description) for (const m of String(fm.description).matchAll(WIKILINK)) links.push(m[1].trim());
    const segs = f.rel.split('/');
    const top = segs.length > 1 ? segs[0] : '(root)';
    const created = (flavor === 'logseq' && journalDate(base)) || Math.round(st.birthtimeMs || st.mtimeMs);
    const note = {
      id: notes.length,
      name,
      path: f.rel,
      folder: top,
      group: groupOf(f.rel, fm, name, flavor),
      para: paraOf(segs.slice(0, -1), [...tags]),
      words: (body.match(/\S+/g) || []).length,
      tags: [...tags].slice(0, 12),
      description: String(fm.description || '')
        .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1')
        .slice(0, 220),
      created,
      modified: Math.round(st.mtimeMs),
      links,
      ...(uri ? { url: uri(f.rel, name) } : {}),
    };
    notes.push(note);
    for (const k of [name, ...(fm.aliases || [])])
      if (!byName.has(String(k).toLowerCase())) byName.set(String(k).toLowerCase(), note.id);
    byPath.set(f.rel.toLowerCase().replace(/\.md$/, ''), note.id);
  }

  const edges = new Map();
  const unresolved = {};
  for (const n of notes) {
    for (const raw of n.links) {
      const key = raw.toLowerCase().replace(/\.md$/, '');
      const target = byPath.get(key) ?? byName.get(key) ?? byName.get(path.basename(key)) ?? null;
      if (target == null) {
        unresolved[raw] = (unresolved[raw] || 0) + 1;
        continue;
      }
      if (target === n.id) continue;
      edges.set(`${n.id}>${target}`, [n.id, target]);
    }
    delete n.links;
  }
  return finish({ name: path.basename(root), root, notes, edges: [...edges.values()], unresolved });
}

// Degrees, unresolved list and counts: shared by every connector.
function finish({ name, root = null, notes, edges, unresolved = {}, extra = {} }) {
  const deg = notes.map(() => ({ in: 0, out: 0 }));
  for (const [a, b] of edges) {
    if (deg[a] && deg[b]) {
      deg[a].out++;
      deg[b].in++;
    }
  }
  notes.forEach((n, i) => {
    n.inLinks = deg[i].in;
    n.outLinks = deg[i].out;
    n.words ??= 0;
    n.tags ??= [];
    n.folder ??= '(root)';
    n.created ??= n.modified ?? Date.now();
    n.modified ??= n.created;
  });
  return {
    vault: name,
    root,
    scannedAt: Date.now(),
    notes,
    edges,
    unresolved: Object.entries(unresolved)
      .map(([n, count]) => ({ name: n, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40),
    ...extra,
  };
}

module.exports = { scanMarkdown, registeredVaults, frontmatter, paraOf, finish, listNotes };
