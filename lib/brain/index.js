// Second brain sources. Obsidian stays the default (the vault registered in Obsidian, or Settings), and
// more sources can be connected: Logseq, Notion, Tana, Roam Research, mem.ai, Reflect, Heybrain, a PARA
// workspace, the RAG knowledge bases, and vector databases (Pinecone, Weaviate, Qdrant, pgvector,
// Chroma). Every source becomes the same graph (notes, links, groups, optional PARA bucket and 2D
// meaning-coordinates); "all" merges them and links notes with the same title across sources.
// Sources live in config.json under "brain"; their secrets are references (Keychain or env).
const os = require('os');
const fs = require('fs');
const path = require('path');
const { scanMarkdown, registeredVaults, finish, paraOf } = require('./markdown');
const apps = require('./apps');
const vectors = require('./vectors');

const F = (key, label, extra = {}) => ({ key, label, ...extra });
const PATH = (label, extra) => F('path', label, { kind: 'path', ...extra });
const SECRET = (label, extra) => F('secret', label, { kind: 'secret', ...extra });
const TYPES = {
  obsidian: { label: 'Obsidian', family: 'Notes', fields: [PATH('Vault folder', { placeholder: 'empty = the vault registered in Obsidian' })], about: 'Markdown vault: [[wikilinks]], tags, frontmatter.' },
  logseq: { label: 'Logseq', family: 'Notes', fields: [PATH('Graph folder (with pages/ and journals/)', { required: true, placeholder: '~/Documents/logseq-graph' })], about: 'Local graph: pages, journals, [[links]], #tags and tags:: properties.' },
  notion: { label: 'Notion', family: 'Notes', fields: [SECRET('Integration token', { required: true, placeholder: 'ntn_…' }), F('deepPages', 'Pages to scan for mentions', { kind: 'number', placeholder: '120' })], about: 'Pages and databases shared with your integration: hierarchy and @-mentions.' },
  tana: { label: 'Tana', family: 'Notes', fields: [PATH('Workspace export (JSON)', { required: true, placeholder: '~/Downloads/tana-export.json' })], about: 'Workspace JSON export: nodes, supertags and references.' },
  roam: { label: 'Roam Research', family: 'Notes', fields: [F('graph', 'Graph name'), SECRET('Graph API token (roam-graph-token-…)'), PATH('…or a JSON export instead')], about: 'Backend API or JSON export: pages, [[links]], #tags and attributes.' },
  mem: { label: 'mem.ai', family: 'Notes', fields: [SECRET('API key', { required: true })], about: 'Notes and collections through the Mem API.' },
  reflect: { label: 'Reflect', family: 'Notes', fields: [PATH('Export: Markdown folder (unzipped) or JSON file', { required: true }), SECRET('API token (optional: adds your bookmarked links)'), F('graph', 'Graph id (for the links)')], about: 'Reflect notes are end-to-end encrypted, so the API cannot read them: map your export.' },
  heybrain: { label: 'Heybrain', family: 'Notes', fields: [F('url', 'MCP URL (Dashboard → MCP)', { placeholder: 'https://heybrain.io/mcp/…' }), SECRET('Agent key (ak_…)'), PATH('…or an export folder / JSON file')], about: 'Documents through Heybrain\'s MCP server (list_documents), or an export.' },
  para: { label: 'PARA workspace', family: 'Method', fields: [PATH('Folder with Projects, Areas, Resources, Archives', { required: true })], about: 'Tiago Forte\'s PARA: notes laid out by Projects, Areas, Resources and Archives.', layout: 'para' },
  rag: { label: 'RAG knowledge bases', family: 'AI memory', fields: [], about: 'ZAAFPulse knowledge bases: documents placed by meaning when they have embeddings.', builtin: true, layout: 'semantic' },
  pinecone: { label: 'Pinecone', family: 'Vector DB', fields: [SECRET('API key', { required: true }), F('collection', 'Index (empty = up to 3)'), F('namespace', 'Namespace')], layout: 'semantic' },
  weaviate: { label: 'Weaviate', family: 'Vector DB', fields: [F('url', 'Cluster URL', { required: true, placeholder: 'http://localhost:8080' }), SECRET('API key (optional)'), F('collection', 'Collection (empty = up to 4)')], layout: 'semantic' },
  qdrant: { label: 'Qdrant', family: 'Vector DB', fields: [F('url', 'URL', { required: true, placeholder: 'http://localhost:6333' }), SECRET('API key (optional)'), F('collection', 'Collection (empty = up to 4)')], layout: 'semantic' },
  pgvector: { label: 'pgvector', family: 'Vector DB', fields: [SECRET('Connection URL (postgres://user:pass@host/db)', { required: true }), F('collection', 'Table (empty = up to 4)')], layout: 'semantic' },
  chroma: { label: 'Chroma', family: 'Vector DB', fields: [F('url', 'URL', { required: true, placeholder: 'http://localhost:8000' }), SECRET('Token (optional)'), F('collection', 'Collection (empty = up to 4)'), F('tenant', 'Tenant', { placeholder: 'default_tenant' }), F('database', 'Database', { placeholder: 'default_database' })], layout: 'semantic' },
};
const ID = /^[a-z0-9-]{1,32}$/;
const home = (p) => String(p || '').trim().replace(/^~(?=\/|$)/, os.homedir());

function cleanSource(input = {}, existing = null) {
  const errors = []; const t = TYPES[input.type];
  if (!t || t.builtin) errors.push('type: pick a source type');
  const id = String(input.id || '').trim(); if (!ID.test(id)) errors.push('id: 1-32 lowercase letters, digits or dashes');
  const out = { id, type: input.type, name: String(input.name || (t && t.label) || id).trim().slice(0, 60), enabled: input.enabled !== false, options: {} };
  for (const f of (t && t.fields) || []) {
    if (f.kind === 'secret') continue;
    const v = String((input.options || {})[f.key] ?? input[f.key] ?? '').trim();
    if (f.key === 'path') { if (v) out.path = home(v).slice(0, 500); } else if (f.key === 'url') { if (v && !/^https?:\/\/\S+$/.test(v)) errors.push(`${f.label}: must start with http:// or https://`); if (v) out.url = v.replace(/\/+$/, ''); } else if (v) out.options[f.key] = v.slice(0, 200);
    if (f.required && f.kind !== 'secret' && !v && !(f.key === 'path' && existing && existing.path)) errors.push(`${f.label} is required`);
  }
  if (out.path && !fs.existsSync(out.path)) errors.push(`path not found: ${out.path}`);
  if (input.type === 'roam' && !out.path && !out.options.graph) errors.push('Roam: a graph name with a token, or the path of a JSON export');
  if (input.type === 'heybrain' && !out.path && !out.url) errors.push('Heybrain: the MCP URL, or an export path');
  out.secret = existing ? existing.secret : undefined;
  return { errors, value: out };
}

function createBrain({ getConfig, writeBrainConfig, secrets, resolveSecret, knowledge, getVaultPaths = () => [], now = Date.now }) {
  const memo = new Map(); // source id -> { at, data }
  const cfg = () => ((getConfig() || {}).brain || {});
  const userSources = () => cfg().sources || [];
  const builtins = () => [{ id: 'obsidian', type: 'obsidian', name: 'Obsidian', enabled: true, builtin: true }, { id: 'rag', type: 'rag', name: 'RAG knowledge bases', enabled: true, builtin: true }];
  const all = () => [...builtins(), ...userSources()];
  const secretOf = (s) => (s.secret ? secrets.resolve(s.secret, `${s.name} secret`) : null);

  async function build(s) {
    const o = s.options || {};
    switch (s.type) {
      case 'obsidian': {
        const roots = s.path ? [s.path] : getVaultPaths().length ? getVaultPaths() : registeredVaults();
        if (!roots.length) return { ...finish({ name: 'Obsidian', notes: [], edges: [] }), error: 'No Obsidian vault found. Add its path under Settings.' };
        const g = scanMarkdown(roots[0], { flavor: 'obsidian', uri: (rel) => `obsidian://open?vault=${encodeURIComponent(path.basename(roots[0]))}&file=${encodeURIComponent(rel.replace(/\.md$/i, ''))}` });
        return { ...g, vaults: roots };
      }
      case 'logseq': return scanMarkdown(s.path, { flavor: 'logseq', uri: (rel, name) => `logseq://graph/${encodeURIComponent(path.basename(s.path))}?page=${encodeURIComponent(name)}` });
      case 'para': return { ...scanMarkdown(s.path, { flavor: 'markdown' }), layout: 'para' };
      case 'reflect': {
        const g = s.path.toLowerCase().endsWith('.json') ? jsonItems(apps.readJsonFile(s.path), s.name) : scanMarkdown(s.path, { flavor: 'markdown' });
        if (!secretOf(s) || !o.graph) return g;
        // Bookmarked web links are readable through the API; they join the map as their own group.
        const links = await apps.call(`https://reflect.app/api/graphs/${encodeURIComponent(o.graph)}/links`, { headers: { authorization: `Bearer ${secretOf(s)}` } }).catch(() => []);
        for (const l of (Array.isArray(links) ? links : links.links || []).slice(0, 500)) g.notes.push({ id: g.notes.length, name: String(l.title || l.url).slice(0, 120), path: l.id || l.url, url: l.url, folder: 'Links', group: 'web link', tags: [], words: 0, created: Date.parse(l.created_at || l.updated_at || '') || now(), modified: now(), inLinks: 0, outLinks: 0 });
        return g;
      }
      case 'heybrain': {
        if (s.path) return s.path.toLowerCase().endsWith('.json') ? jsonItems(apps.readJsonFile(s.path), s.name) : scanMarkdown(s.path, { flavor: 'markdown' });
        if (!s.url) throw new Error('set the MCP URL from Heybrain (Dashboard → MCP), or an export path');
        const docs = await apps.mcpList({ url: s.url, secret: secretOf(s), tool: 'list_documents' });
        return jsonItems(Array.isArray(docs) ? docs : docs.documents || docs.items || docs.results || [], s.name);
      }
      case 'notion': return apps.notion({ secret: secretOf(s), options: { ...o, name: s.name, deepPages: o.deepPages != null ? Number(o.deepPages) : undefined } });
      case 'tana': return apps.tana({ options: { path: s.path, name: s.name } });
      case 'roam': return apps.roam({ secret: secretOf(s), options: { ...o, path: s.path } });
      case 'mem': return apps.mem({ secret: secretOf(s), options: { ...o, name: s.name } });
      case 'rag': return ragGraph();
      default:
        if (vectors.CLIENTS[s.type]) return vectors.semanticGraph(s.name, await vectors.sampleVectors(s.type, { url: s.url, secret: secretOf(s), options: o }));
        throw new Error(`unknown source type ${s.type}`);
    }
  }
  // A generic JSON export: an array (or { items }) of { title|name, content|text, tags, url, created_at, links }.
  function jsonItems(data, name) {
    const items = (Array.isArray(data) ? data : data.items || data.notes || data.data || []).slice(0, 3000);
    const notes = items.map((it, i) => ({ id: i, name: String(it.title || it.name || it.url || `Item ${i + 1}`).slice(0, 120), path: String(it.id || i), url: it.url || it.link, folder: String(it.collection || it.folder || it.type || 'items').slice(0, 40),
      group: String(it.type || it.kind || 'item').slice(0, 30), tags: (it.tags || []).map(String).slice(0, 12), words: String(it.content || it.text || it.note || '').split(/\s+/).filter(Boolean).length,
      created: Date.parse(it.created_at || it.createdAt || it.created || '') || now(), modified: Date.parse(it.updated_at || it.updatedAt || '') || now(), para: paraOf([it.collection, it.folder].filter(Boolean), it.tags || []) }));
    const byName = new Map(notes.map((n) => [n.name.toLowerCase(), n.id])); const edges = new Map();
    items.forEach((it, i) => { const text = `${it.content || it.text || ''}`; for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) { const j = byName.get(m[1].toLowerCase()); if (j != null && j !== i) edges.set(`${i}>${j}`, [i, j]); } for (const l of it.links || []) { const j = byName.get(String(l).toLowerCase()); if (j != null && j !== i) edges.set(`${i}>${j}`, [i, j]); } });
    return finish({ name, notes, edges: [...edges.values()] });
  }
  // RAG: documents by meaning when they have embeddings, else linked by shared keywords.
  function ragGraph() {
    const docs = knowledge ? knowledge.graph() : [];
    if (!docs.length) return { ...finish({ name: 'RAG', notes: [], edges: [] }), notice: 'No knowledge base documents yet: add some under RAG Service.' };
    if (docs.filter((d) => d.vector).length >= 3) {
      const g = vectors.semanticGraph('RAG knowledge bases', docs.filter((d) => d.vector).map((d) => ({ id: d.id, vector: d.vector, meta: { title: d.title }, collection: d.kbName, text: `${d.chunks} chunks · ${d.source || ''}` })), { kind: 'rag' });
      g.notes.forEach((n) => { n.created = (docs.find((d) => d.title === n.name) || {}).addedAt || n.created; });
      return g;
    }
    const notes = docs.map((d, i) => ({ id: i, name: d.title, path: `${d.kb}/${d.id}`, folder: d.kbName, group: d.kbName, words: Math.round(d.chars / 6), tags: [], created: d.addedAt, modified: d.addedAt, description: `${d.chunks} chunks · ${d.source || ''}` }));
    const sets = docs.map((d) => new Set(d.words)); const edges = [];
    for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) { let n = 0; for (const w of sets[i]) if (sets[j].has(w)) n++; const jac = n / (sets[i].size + sets[j].size - n || 1); if (jac > 0.12) edges.push([i, j]); }
    return finish({ name: 'RAG knowledge bases', notes, edges, extra: { kind: 'rag', groups: [...new Set(docs.map((d) => d.kbName))].map((k) => ({ id: k, name: k })) } });
  }

  async function graph(id, { fresh = false } = {}) {
    if (id === 'all') return merged(fresh);
    const s = all().find((x) => x.id === (id || 'obsidian')); if (!s) return { error: `no source "${id}"`, notes: [], edges: [], unresolved: [] };
    const hit = memo.get(s.id); if (!fresh && hit && now() - hit.at < (TYPES[s.type].family === 'Notes' && s.type !== 'notion' && s.type !== 'mem' && s.type !== 'roam' ? 30000 : 300000)) return hit.data;
    let data;
    try { data = await build(s); } catch (err) { data = { ...finish({ name: s.name, notes: [], edges: [] }), error: secrets.mask(String(err.message || err)) }; }
    data.source = { id: s.id, type: s.type, name: s.name, label: TYPES[s.type].label };
    data.layout ||= TYPES[s.type].layout || 'network';
    memo.set(s.id, { at: now(), data }); return data;
  }
  // Every enabled source in one map: groups become sources, and notes with the same title in two
  // sources are joined by a "same note" link (an Obsidian note and its Notion page, for instance).
  async function merged(fresh) {
    const parts = []; for (const s of all().filter((x) => x.enabled !== false)) { const g = await graph(s.id, { fresh }); if (g.notes && g.notes.length) parts.push(g); }
    const notes = []; const edges = []; const same = [];
    for (const g of parts) {
      const off = notes.length;
      for (const n of g.notes) notes.push({ ...n, id: off + n.id, group: g.source.id, sourceGroup: n.group, source: g.source.id });
      for (const [a, b] of g.edges) edges.push([off + a, off + b]);
    }
    const byTitle = new Map(); for (const n of notes) { const k = n.name.toLowerCase(); if (k.length < 3) continue; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(n); }
    for (const list of byTitle.values()) { const srcs = new Set(list.map((n) => n.source)); if (srcs.size < 2 || list.length > 6) continue; for (let i = 1; i < list.length; i++) if (list[i].source !== list[0].source) { edges.push([list[0].id, list[i].id]); same.push([list[0].id, list[i].id]); } }
    const g = finish({ name: 'All sources', notes, edges, extra: { layout: 'sources', groups: parts.map((p) => ({ id: p.source.id, name: p.source.name })), same: same.length, sources: parts.map((p) => ({ ...p.source, notes: p.notes.length, edges: p.edges.length })) } });
    g.source = { id: 'all', type: 'all', name: 'All sources', label: 'All sources' };
    return g;
  }

  const pub = (s) => ({ id: s.id, type: s.type, name: s.name, enabled: s.enabled !== false, builtin: !!s.builtin, path: s.path || null, url: s.url || null, options: s.options || {}, hasSecret: !!s.secret,
    label: TYPES[s.type].label, family: TYPES[s.type].family, cached: memo.has(s.id) ? { at: memo.get(s.id).at, notes: memo.get(s.id).data.notes.length, error: memo.get(s.id).data.error || null, notice: memo.get(s.id).data.notice || null } : null });
  return {
    TYPES, graph,
    sources: () => all().map(pub),
    save(input) {
      const list = userSources(); const existing = list.find((x) => x.id === (input.originalId || input.id));
      if (['obsidian', 'rag', 'all'].includes(input.id) && !existing) return { errors: ['that id is reserved'] };
      const { errors, value } = cleanSource(input, existing); if (errors.length) return { errors };
      if (!existing && list.some((x) => x.id === value.id)) return { errors: [`a source called "${value.id}" already exists`] };
      try { if (input.secret) value.secret = resolveSecret(value.id, input.secret, existing && existing.secret); } catch (err) { return { errors: [err.message] }; }
      if (!value.secret) delete value.secret;
      writeBrainConfig({ ...cfg(), sources: existing ? list.map((x) => (x === existing ? value : x)) : [...list, value] });
      memo.delete(value.id); return { source: pub(value) };
    },
    remove(id) { const list = userSources(); if (!list.some((x) => x.id === id)) return { errors: ['no such source (built-in sources cannot be removed)'] }; writeBrainConfig({ ...cfg(), sources: list.filter((x) => x.id !== id) }); memo.delete(id); return { id }; },
    async test(id) { const g = await graph(id, { fresh: true }); return g.error ? { ok: false, error: g.error } : { ok: true, notes: g.notes.length, edges: g.edges.length, notice: g.notice || null }; },
  };
}

module.exports = { createBrain, TYPES, cleanSource };
