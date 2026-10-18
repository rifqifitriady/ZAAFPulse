// Second-brain apps as graphs: Notion (API), Roam Research (Backend API or JSON export) and Tana (JSON
// export). Each returns the same shape as the Markdown scanner: notes with name, group, tags, times and
// a link to open them, plus the links between notes. Note text is read to find links, never returned.
const fs = require('fs');
const { finish, paraOf } = require('./markdown');

const TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(url, { method = 'GET', headers = {}, body, manualRedirect = false } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const init = { method, signal: ctl.signal, redirect: manualRedirect ? 'manual' : 'follow', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined };
    let r = await fetch(url, init);
    // Roam answers with a 308 to a peer host; fetch would drop the auth header on that hop, so resend it ourselves.
    if (manualRedirect && r.status >= 300 && r.status < 400 && r.headers.get('location')) r = await fetch(new URL(r.headers.get('location'), url).toString(), init);
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) throw new Error(`HTTP ${r.status}${j && (j.message || j.error) ? `: ${String(j.message || j.error).slice(0, 160)}` : ''}`);
    return j;
  } catch (err) { throw new Error(err.name === 'AbortError' ? 'timed out' : err.cause?.code || err.message); } finally { clearTimeout(t); }
}
const readJsonFile = (p) => { if (!p) throw new Error('set the path of the export file'); return JSON.parse(fs.readFileSync(p.replace(/^~(?=\/)/, require('os').homedir()), 'utf8')); };
const LINKS = /\[\[([^\]]+)\]\]|(?:^|\s)#\[\[([^\]]+)\]\]|(?:^|\s)#([\w/-]+)|^([^:\n]{1,60})::/gm;

/* ---------- Notion: pages and databases, their hierarchy, and @-mentions / link-to-page blocks ---------- */
async function notion({ secret, options = {} }) {
  if (!secret) throw new Error('paste a Notion integration token (shared with the pages you want mapped)');
  const h = { authorization: `Bearer ${secret}`, 'Notion-Version': options.version || '2022-06-28' };
  const items = []; let cursor = null;
  do {
    const j = await call('https://api.notion.com/v1/search', { method: 'POST', headers: h, body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
    items.push(...(j.results || [])); cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && items.length < (options.maxPages || 600));
  const titleOf = (o) => {
    if (Array.isArray(o.title)) return o.title.map((t) => t.plain_text).join('') || 'Untitled';
    const p = Object.values(o.properties || {}).find((x) => x.type === 'title');
    return (p && p.title.map((t) => t.plain_text).join('')) || 'Untitled';
  };
  const idx = new Map(items.map((o, i) => [o.id, i]));
  const parentOf = (o) => { const p = o.parent || {}; return p.page_id || p.database_id || p.data_source_id || p.block_id || null; };
  const notes = items.map((o, i) => ({ id: i, name: titleOf(o).slice(0, 120), path: o.id, url: o.url, folder: o.object, group: o.object === 'database' || o.object === 'data_source' ? 'database' : 'page',
    tags: [], created: Date.parse(o.created_time) || Date.now(), modified: Date.parse(o.last_edited_time) || Date.now(), parent: parentOf(o) }));
  const edges = new Map(); const add = (a, b) => { if (a != null && b != null && a !== b) edges.set(`${a}>${b}`, [a, b]); };
  for (const n of notes) { const p = idx.get(n.parent); if (p != null) { add(p, n.id); if (notes[p].group === 'database') n.group = `db:${notes[p].name}`.slice(0, 60); } }
  // Mentions and link-to-page blocks: first-level blocks of up to deepPages pages, about 3 requests a second.
  const deep = Math.min(notes.length, options.deepPages ?? 120);
  for (let i = 0; i < deep; i++) {
    if (notes[i].group === 'database') continue;
    try {
      const j = await call(`https://api.notion.com/v1/blocks/${items[i].id}/children?page_size=100`, { headers: h });
      for (const b of j.results || []) {
        const body = b[b.type] || {};
        if (b.type === 'link_to_page') add(i, idx.get(body.page_id || body.database_id));
        if (b.type === 'child_page' || b.type === 'child_database') add(i, idx.get(b.id));
        for (const rt of body.rich_text || []) if (rt.type === 'mention' && rt.mention) add(i, idx.get((rt.mention.page || rt.mention.database || {}).id));
        notes[i].words = (notes[i].words || 0) + (body.rich_text || []).reduce((n, rt) => n + String(rt.plain_text || '').split(/\s+/).filter(Boolean).length, 0);
      }
    } catch (err) { if (/HTTP 429/.test(err.message)) await sleep(1500); }
    await sleep(340);
  }
  // PARA from the titles above a page (a "Projects" database or page, and so on).
  for (const n of notes) { const chain = []; let p = idx.get(n.parent); let guard = 0; while (p != null && guard++ < 8) { chain.push(notes[p].name); p = idx.get(notes[p].parent); } n.para = paraOf([...chain, n.name]); n.folder = chain[chain.length - 1] || n.folder; delete n.parent; }
  return finish({ name: options.name || 'Notion', notes, edges: [...edges.values()], extra: { layout: 'hierarchy' } });
}

/* ---------- Roam Research: pages, [[links]], #tags and attributes ---------- */
function roamGraph(pages, name) {
  const byTitle = new Map(pages.map((p, i) => [p.title.toLowerCase(), i])); const edges = new Map(); const unresolved = {};
  const notes = pages.map((p, i) => ({ id: i, name: p.title, path: p.uid || p.title, folder: /^(January|February|March|April|May|June|July|August|September|October|November|December) \d/.test(p.title) ? 'Daily notes' : 'Pages',
    group: /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/.test(p.title) ? 'daily' : 'page', words: p.words, tags: [...p.tags].slice(0, 12), created: p.created || Date.now(), modified: p.edited || p.created || Date.now(),
    ...(p.url ? { url: p.url } : {}), para: paraOf([], [...p.tags]) }));
  pages.forEach((p, i) => { for (const t of p.links) { const j = byTitle.get(t.toLowerCase()); if (j == null) { unresolved[t] = (unresolved[t] || 0) + 1; continue; } if (j !== i) edges.set(`${i}>${j}`, [i, j]); } });
  return finish({ name, notes, edges: [...edges.values()], unresolved });
}
function scanStrings(strings) {
  const links = new Set(); const tags = new Set(); let words = 0;
  for (const s of strings) { words += String(s).split(/\s+/).filter(Boolean).length; for (const m of String(s).matchAll(LINKS)) { const v = (m[1] || m[2] || m[3] || m[4] || '').trim(); if (!v) continue; links.add(v); if (m[2] || m[3]) tags.add(v); } }
  return { links, tags, words };
}
async function roam({ secret, options = {} }) {
  if (options.path) { // JSON export: [{ title, uid, children: [{ string, children }], "create-time", "edit-time" }]
    const data = readJsonFile(options.path);
    const pages = data.filter((p) => p && p.title).slice(0, 3000).map((p) => {
      const strings = []; const walk = (bs) => { for (const b of bs || []) { if (b.string) strings.push(b.string); walk(b.children); } }; walk(p.children);
      return { title: p.title, uid: p.uid, created: p['create-time'], edited: p['edit-time'], ...scanStrings(strings), url: options.graph ? `https://roamresearch.com/#/app/${options.graph}/page/${p.uid}` : undefined };
    });
    return roamGraph(pages, options.graph || 'Roam export');
  }
  if (!options.graph || !secret) throw new Error('set the graph name and a graph API token, or the path of a JSON export');
  const q = (query) => call(`https://api.roamresearch.com/api/graph/${encodeURIComponent(options.graph)}/q`, { method: 'POST', manualRedirect: true, headers: { authorization: `Bearer ${secret}`, 'x-authorization': `Bearer ${secret}` }, body: { query } });
  const titles = (await q('[:find ?t ?u :where [?p :node/title ?t] [?p :block/uid ?u]]')).result || [];
  const blocks = (await q('[:find ?t ?s :where [?p :node/title ?t] [?b :block/page ?p] [?b :block/string ?s]]')).result || [];
  const byPage = new Map(titles.map(([t, u]) => [t, { title: t, uid: u, strings: [] }]));
  for (const [t, s] of blocks) { const p = byPage.get(t); if (p) p.strings.push(s); }
  const pages = [...byPage.values()].slice(0, 3000).map((p) => ({ title: p.title, uid: p.uid, ...scanStrings(p.strings), url: `https://roamresearch.com/#/app/${options.graph}/page/${p.uid}` }));
  return roamGraph(pages, options.graph);
}

/* ---------- Tana: JSON export (docs with props, children and inline references) ---------- */
const TANA_SKIP = new Set(['tuple', 'metanode', 'associatedData', 'visual', 'codeblock', 'journal', 'workspace', 'home', 'search', 'command', 'chat', 'viewDef', 'attrDef', 'tagDef']);
function tana({ options = {} }) {
  const data = readJsonFile(options.path);
  const docs = data.docs || data.nodes || (Array.isArray(data) ? data : []);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const parent = new Map(); for (const d of docs) for (const c of d.children || []) parent.set(c, d.id);
  const inline = (s) => [...String(s || '').matchAll(/data-inlineref-node="([^"]+)"|\[\[[^\]]*\^([\w-]+)\]\]/g)].map((m) => m[1] || m[2]);
  const refsOf = (d) => [...inline((d.props || {}).name), ...(d.refs || []), ...(d.inbound_refs ? [] : [])];
  const referenced = new Set(); for (const d of docs) for (const r of refsOf(d)) referenced.add(r);
  const tagNames = new Map(docs.filter((d) => (d.props || {})._docType === 'tagDef').map((d) => [d.id, d.props.name]));
  // A "note" is a named node with content or that something points to; plain bullets fold into their note.
  const isNote = (d) => { const p = d.props || {}; if (!p.name || TANA_SKIP.has(p._docType) || String(p.name).startsWith('SYS_')) return false; return (d.children || []).length >= 2 || referenced.has(d.id) || (d.supertags || []).length; };
  const noteDocs = docs.filter(isNote).slice(0, 2500); const idx = new Map(noteDocs.map((d, i) => [d.id, i]));
  const noteOf = (id) => { let cur = id; let guard = 0; while (cur && guard++ < 40) { if (idx.has(cur)) return idx.get(cur); cur = parent.get(cur); } return null; };
  const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const notes = noteDocs.map((d, i) => { const tags = (d.supertags || []).map((t) => tagNames.get(t) || t).filter(Boolean);
    return { id: i, name: clean(d.props.name).slice(0, 120) || 'Untitled', path: d.id, folder: clean(((byId.get(parent.get(d.id)) || {}).props || {}).name).slice(0, 40) || '(root)', group: tags[0] ? `#${tags[0]}` : 'node',
      tags, words: (d.children || []).length, created: d.props.created || Date.now(), modified: d.props.modified || d.props.created || Date.now(), para: paraOf([], tags) }; });
  const edges = new Map(); const add = (a, b) => { if (a != null && b != null && a !== b) edges.set(`${a}>${b}`, [a, b]); };
  for (const d of docs) { const from = noteOf(d.id); for (const r of refsOf(d)) add(from, noteOf(r)); }
  for (const d of noteDocs) add(noteOf(parent.get(d.id)), idx.get(d.id));
  return finish({ name: options.name || 'Tana', notes, edges: [...edges.values()] });
}

/* ---------- mem.ai: Mem API v2 (notes with content, collections, mem:// links) ---------- */
async function mem({ secret, options = {} }) {
  if (!secret) throw new Error('paste a Mem API key');
  const h = { authorization: `Bearer ${secret}` }; const base = 'https://api.mem.ai/v2';
  const names = new Map();
  try { const c = await call(`${base}/collections?limit=100`, { headers: h }); for (const x of c.results || []) names.set(x.id, x.title || x.name || x.id); } catch { /* collections are optional */ }
  const items = []; let page = null;
  do { // cursor paging; about 100 requests a minute is allowed, so 1,000 notes is ten calls
    const j = await call(`${base}/notes?limit=100&include_note_content=true${page ? `&page=${encodeURIComponent(page)}` : ''}`, { headers: h });
    items.push(...(j.results || [])); page = j.next_page || null;
  } while (page && items.length < (options.maxNotes || 1000));
  const idx = new Map(items.map((n, i) => [n.id, i])); const edges = new Map();
  const notes = items.map((n, i) => {
    const content = String(n.content || n.snippet || ''); const cols = (n.collection_ids || []).map((c) => names.get(c) || c);
    for (const m of content.matchAll(/mem:\/\/notes\/([0-9a-f-]{8,})/gi)) { const j = idx.get(m[1]); if (j != null && j !== i) edges.set(`${i}>${j}`, [i, j]); }
    const tags = [...new Set([...content.matchAll(/(^|\s)#([A-Za-z][\w/-]{1,40})/g)].map((m) => m[2]))].slice(0, 12);
    return { id: i, name: String(n.title || content.split('\n')[0] || 'Untitled').replace(/^#+\s*/, '').slice(0, 120), path: n.id, url: `https://mem.ai/m/${n.id}`, folder: cols[0] || 'Notes', group: cols[0] ? `col:${cols[0]}`.slice(0, 60) : 'note',
      tags, words: content.split(/\s+/).filter(Boolean).length, created: Date.parse(n.created_at) || Date.now(), modified: Date.parse(n.updated_at) || Date.now(), para: paraOf(cols, tags) };
  });
  return finish({ name: options.name || 'mem.ai', notes, edges: [...edges.values()] });
}

/* ---------- MCP over HTTP (Heybrain): initialize, then call a listing tool ---------- */
async function mcpList({ url, secret, tool = 'list_documents', args = {} }) {
  const h = { accept: 'application/json, text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) };
  const rpc = async (method, params, id, session) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }) });
    if (!r.ok && r.status !== 202) throw new Error(`MCP ${method}: HTTP ${r.status}`);
    const text = await r.text(); const line = /^data:/m.test(text) ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() : text;
    let j = null; try { j = JSON.parse(line || 'null'); } catch { /* notification ack */ }
    if (j && j.error) throw new Error(`MCP ${method}: ${j.error.message}`);
    return { result: j && j.result, session: r.headers.get('mcp-session-id') || session };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'zaafpulse-brain', version: '1' } }, 1);
  await rpc('notifications/initialized', {}, null, init.session).catch(() => {});
  const out = await rpc('tools/call', { name: tool, arguments: args }, 2, init.session);
  const res = out.result || {};
  if (res.structuredContent) return res.structuredContent;
  const text = (res.content || []).map((c) => c.text || '').join('\n');
  try { return JSON.parse(text); } catch { return text.split('\n').filter((l) => l.trim()).map((l) => ({ title: l.replace(/^[-*\d.\s]+/, '').trim() })); }
}

module.exports = { notion, roam, tana, mem, mcpList, roamGraph, scanStrings, call, readJsonFile };
