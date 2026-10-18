const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { fakeServer, secretsFor } = require('./helpers');
const { scanMarkdown, paraOf } = require('../lib/brain/markdown');
const apps = require('../lib/brain/apps');
const vectors = require('../lib/brain/vectors');
const pg = require('../lib/brain/pg');
const { createBrain } = require('../lib/brain');

const tmp = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-brain-')); for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); } return d; };

test('markdown: Logseq pages, journals, properties and #tags; PARA buckets from folders and tags', () => {
  const d = tmp({ 'pages/Project Atlas.md': 'tags:: project, client\nalias:: Atlas\n- kickoff with [[Rina]] #[[Weekly Review]]', 'pages/Rina.md': '- works on [[Atlas]]', 'pages/Weekly Review.md': '- every friday',
    'pages/notes___ideas.md': '- nested page', 'journals/2026_10_17.md': '- met [[Rina]] about #budget', 'logseq/config.edn': '{}' });
  const g = scanMarkdown(d, { flavor: 'logseq' });
  const by = Object.fromEntries(g.notes.map((n) => [n.name, n]));
  assert.ok(by['notes/ideas']); assert.equal(by['2026_10_17'].group, 'journal'); assert.equal(new Date(by['2026_10_17'].created).getDate(), 17);
  assert.equal(by['Project Atlas'].para, 'projects'); assert.deepEqual(by['Project Atlas'].tags.slice(0, 2), ['project', 'client']);
  const link = (a, b) => g.edges.some(([x, y]) => x === by[a].id && y === by[b].id);
  assert.ok(link('Rina', 'Project Atlas')); // resolved through the alias
  assert.ok(link('Project Atlas', 'Weekly Review')); assert.ok(link('2026_10_17', 'Rina'));
  assert.ok(g.unresolved.some((u) => u.name === 'budget')); assert.ok(!g.notes.some((n) => n.path.startsWith('logseq/')));
  assert.equal(paraOf(['01 Projects']), 'projects'); assert.equal(paraOf(['3-Resources']), 'resources'); assert.equal(paraOf(['Archive']), 'archives'); assert.equal(paraOf([], ['Area']), 'areas'); assert.equal(paraOf(['Inbox']), null);
  const p = scanMarkdown(tmp({ '1 Projects/Launch.md': 'see [[Brand]]', '2 Areas/Health.md': 'x', '3 Resources/Brand.md': 'y', '4 Archives/Old.md': 'z', 'Inbox.md': 'w' }), { flavor: 'markdown' });
  assert.deepEqual(Object.fromEntries(p.notes.map((n) => [n.name, n.para])), { Launch: 'projects', Health: 'areas', Brand: 'resources', Old: 'archives', Inbox: null });
});

test('apps: Roam JSON export and Tana export become graphs; Notion hierarchy, mentions and PARA through its API', async () => {
  const roamFile = path.join(tmp({ 'r.json': JSON.stringify([
    { title: 'Projects', uid: 'p1', children: [{ string: 'Launch is a [[Launch]]' }] }, { title: 'Launch', uid: 'l1', 'create-time': 1700000000000, children: [{ string: 'owner:: [[Rina]] #urgent', children: [{ string: 'see ((abc)) and [[Missing Page]]' }] }] },
    { title: 'Rina', uid: 'r1', children: [] }, { title: 'October 17th, 2026', uid: 'd1', children: [{ string: 'worked on [[Launch]]' }] }]) }), 'r.json');
  const r = await apps.roam({ options: { path: roamFile, graph: 'mine' } });
  const rb = Object.fromEntries(r.notes.map((n) => [n.name, n]));
  assert.equal(rb['October 17th, 2026'].group, 'daily'); assert.ok(rb.Launch.tags.includes('urgent')); assert.match(rb.Launch.url, /roamresearch\.com\/#\/app\/mine\/page\/l1/);
  assert.ok(r.edges.some(([a, b]) => a === rb.Launch.id && b === rb.Rina.id)); assert.ok(r.unresolved.some((u) => u.name === 'Missing Page'));
  const tanaFile = path.join(tmp({ 't.json': JSON.stringify({ formatVersion: 1, docs: [
    { id: 'tag1', props: { name: 'project', _docType: 'tagDef' } }, { id: 'A', props: { name: 'Website relaunch', created: 1 }, children: ['a1', 'a2'], supertags: ['tag1'] },
    { id: 'a1', props: { name: 'talk to <span data-inlineref-node="B"></span>' } }, { id: 'a2', props: { name: 'budget' } }, { id: 'B', props: { name: 'Design team', created: 2 }, children: ['b1', 'b2'] }, { id: 'b1', props: { name: 'x' } }, { id: 'b2', props: { name: 'y' } }] }) }), 't.json');
  const t = apps.tana({ options: { path: tanaFile } });
  const tb = Object.fromEntries(t.notes.map((n) => [n.name, n]));
  assert.equal(tb['Website relaunch'].group, '#project'); assert.equal(tb['Website relaunch'].para, 'projects');
  assert.ok(t.edges.some(([a, b]) => a === tb['Website relaunch'].id && b === tb['Design team'].id)); // the inline reference inside a child bullet
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push([url, init.headers]);
    const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/v1/search')) return J({ results: [
      { object: 'database', id: 'db1', title: [{ plain_text: 'Projects' }], parent: { type: 'workspace' }, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-01-02T00:00:00Z', url: 'https://notion.so/db1' },
      { object: 'page', id: 'p1', parent: { database_id: 'db1' }, properties: { Name: { type: 'title', title: [{ plain_text: 'Launch plan' }] } }, created_time: '2026-02-01T00:00:00Z', last_edited_time: '2026-02-02T00:00:00Z', url: 'https://notion.so/p1' },
      { object: 'page', id: 'p2', parent: { type: 'workspace' }, properties: { title: { type: 'title', title: [{ plain_text: 'Brand guide' }] } }, created_time: '2026-03-01T00:00:00Z', last_edited_time: '2026-03-01T00:00:00Z', url: 'https://notion.so/p2' }], has_more: false });
    if (url.includes('/blocks/p1/children')) return J({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', plain_text: 'see ' }, { type: 'mention', plain_text: 'Brand guide', mention: { type: 'page', page: { id: 'p2' } } }] } }] });
    return J({ results: [] });
  };
  try {
    const n = await apps.notion({ secret: 'ntn_x', options: { deepPages: 5 } });
    const nb = Object.fromEntries(n.notes.map((x) => [x.name, x]));
    assert.equal(nb['Launch plan'].group, 'db:Projects'); assert.equal(nb['Launch plan'].para, 'projects'); assert.equal(nb['Launch plan'].url, 'https://notion.so/p1');
    assert.ok(n.edges.some(([a, b]) => a === nb.Projects.id && b === nb['Launch plan'].id)); assert.ok(n.edges.some(([a, b]) => a === nb['Launch plan'].id && b === nb['Brand guide'].id));
    assert.equal(calls[0][1].authorization, 'Bearer ntn_x'); assert.equal(calls[0][1]['Notion-Version'], '2022-06-28');
  } finally { global.fetch = realFetch; }
});

test('vectors: PCA keeps clusters apart, kNN links neighbours, k-means finds groups; Qdrant, Chroma, Weaviate and Pinecone clients', async () => {
  const around = (c, i) => c.map((x, k) => x + Math.sin(i * 7 + k) * 0.05);
  const A = Array.from({ length: 10 }, (_, i) => around([1, 0, 0, 0], i)); const B = Array.from({ length: 10 }, (_, i) => around([0, 0, 1, 0], i));
  const xy = vectors.project2d([...A, ...B]);
  const meanX = (pts) => pts.reduce((s, p) => s + p[0], 0) / pts.length;
  assert.ok(Math.abs(meanX(xy.slice(0, 10)) - meanX(xy.slice(10))) > 1);
  const e = vectors.knn([...A, ...B], 2); assert.ok(e.every(([a, b]) => (a < 10) === (b < 10)));
  const k = vectors.kmeans([...A, ...B], 2); assert.ok(new Set(k.slice(0, 10)).size === 1 && k[0] !== k[10]);
  const pts = [...A, ...B].map((v, i) => ({ id: i, vector: v, payload: { title: `doc ${i}` } }));
  const up = await fakeServer({
    'GET /collections': { body: { result: { collections: [{ name: 'notes' }] } } },
    'POST /collections/notes/points/scroll': (r) => { assert.equal(r.headers['api-key'], 'qk'); assert.equal(r.body.with_vector, true); return { body: { result: { points: pts } } }; },
    'GET /api/v2/tenants/default_tenant/databases/default_database/collections': { body: [{ id: 'c1', name: 'kb' }] },
    'POST /api/v2/tenants/default_tenant/databases/default_database/collections/c1/get': { body: { ids: pts.map((p) => String(p.id)), embeddings: pts.map((p) => p.vector), metadatas: pts.map(() => ({})), documents: pts.map((p) => `text ${p.id}`) } },
    'GET /v1/schema': { body: { classes: [{ class: 'Article' }] } },
    'GET /v1/objects': (r) => { assert.equal(r.query.include, 'vector'); return { body: { objects: pts.map((p) => ({ id: `w${p.id}`, class: 'Article', properties: { title: `article ${p.id}` }, vector: p.vector })) } }; },
  });
  try {
    const q = vectors.semanticGraph('Qdrant', await vectors.sampleVectors('qdrant', { url: up.url, secret: 'qk' }));
    assert.equal(q.notes.length, 20); assert.equal(q.notes[3].name, 'doc 3'); assert.ok(q.notes.every((n) => Array.isArray(n.xy))); assert.equal(q.layout, 'semantic'); assert.equal(q.groups.length, 2);
    const c = await vectors.sampleVectors('chroma', { url: up.url }); assert.equal(c.length, 20); assert.equal(c[0].meta.text, 'text 0');
    const w = await vectors.sampleVectors('weaviate', { url: up.url }); assert.equal(w[5].meta.title, 'article 5');
  } finally { await up.close(); }
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const J = (o) => new Response(JSON.stringify(o), { status: 200 });
    assert.equal(init.headers['Api-Key'], 'pk');
    if (url === 'https://api.pinecone.io/indexes') return J({ indexes: [{ name: 'idx', host: 'idx-1.svc.pinecone.io', dimension: 4 }] });
    if (url.startsWith('https://idx-1.svc.pinecone.io/vectors/list')) return J({ vectors: [{ id: 'a' }, { id: 'b' }] });
    if (url.startsWith('https://idx-1.svc.pinecone.io/vectors/fetch')) return J({ vectors: { a: { id: 'a', values: [1, 0, 0, 0], metadata: { title: 'Alpha' } }, b: { id: 'b', values: [0, 1, 0, 0], metadata: {} } } });
    return new Response('{}', { status: 404 });
  };
  try { const p = await vectors.sampleVectors('pinecone', { secret: 'pk' }); assert.deepEqual(p.map((x) => x.id), ['a', 'b']); assert.equal(p[0].meta.title, 'Alpha'); } finally { global.fetch = realFetch; }
});

test('pgvector: the tiny Postgres client authenticates and reads vector columns', async () => {
  // A fake Postgres that asks for a cleartext password and answers two queries.
  const server = net.createServer((sock) => {
    const send = (type, body) => { const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4); sock.write(Buffer.concat([Buffer.from(type), len, body])); };
    const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
    const rowDesc = (names) => Buffer.concat([Buffer.from([0, names.length]), ...names.map((n) => Buffer.concat([Buffer.from(`${n}\0`), Buffer.alloc(18)]))]);
    const dataRow = (vals) => Buffer.concat([Buffer.from([0, vals.length]), ...vals.map((v) => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v)]))]);
    let buf = Buffer.alloc(0); let started = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        if (buf.length < 8) return; const len = buf.readInt32BE(0); const code = buf.readInt32BE(4);
        if (code === 80877103) { buf = buf.subarray(8); sock.write('N'); return; }
        if (buf.length < len) return; buf = buf.subarray(len); started = true; send('R', int32(3)); return;
      }
      while (buf.length >= 5) {
        const type = String.fromCharCode(buf[0]); const len = buf.readInt32BE(1); if (buf.length < len + 1) return; const body = buf.subarray(5, len + 1).toString(); buf = buf.subarray(len + 1);
        if (type === 'p') { assert.equal(body.replace(/\0$/, ''), 's3cret'); send('R', int32(0)); send('Z', Buffer.from('I')); }
        if (type === 'Q') {
          if (/information_schema/.test(body)) { send('T', rowDesc(['table_schema', 'table_name', 'column_name'])); send('D', dataRow(['public', 'docs', 'embedding'])); }
          else { send('T', rowDesc(['id', 'title', 'embedding'])); for (let i = 0; i < 6; i++) send('D', dataRow([String(i), `doc ${i}`, i < 3 ? `[1,0.${i},0]` : `[0,0.${i},1]`])); }
          send('C', Buffer.from('SELECT\0')); send('Z', Buffer.from('I'));
        }
        if (type === 'X') sock.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `postgres://me:s3cret@127.0.0.1:${server.address().port}/db`;
  try {
    const c = await pg.connect(url); const rows = await c.query('SELECT 1'); c.end();
    assert.equal(rows.length, 6);
    const recs = await vectors.sampleVectors('pgvector', { secret: url });
    assert.equal(recs.length, 6); assert.deepEqual(recs[1].vector, [1, 0.1, 0]); assert.equal(recs[1].meta.title, 'doc 1'); assert.equal(recs[0].collection, 'docs');
    assert.throws(() => pg.parseUrl('http://x'), /postgres:\/\//);
  } finally { server.close(); }
});

test('sources: Obsidian by default, connected sources saved with secrets, and one merged map across them', async () => {
  const vault = tmp({ 'Launch.md': 'links [[Brand]]', 'Brand.md': 'x' });
  const lsq = tmp({ 'pages/Launch.md': '- same title as the Obsidian note', 'pages/Other.md': '- [[Launch]]' });
  let conf = {}; const stored = {};
  const brain = createBrain({ getConfig: () => conf, writeBrainConfig: (b) => { conf = { ...conf, brain: b }; }, secrets: secretsFor({}), resolveSecret: (id, input) => { stored[id] = input.value; return { env: `BRAIN_${id.toUpperCase()}` }; },
    knowledge: { graph: () => [] }, getVaultPaths: () => [vault] });
  assert.deepEqual(brain.sources().map((s) => s.id), ['obsidian', 'rag']);
  const o = await brain.graph('obsidian'); assert.equal(o.notes.length, 2); assert.equal(o.source.label, 'Obsidian'); assert.match(o.notes[0].url, /^obsidian:\/\/open/);
  assert.match((await brain.graph('rag')).notice, /No knowledge base/);
  assert.deepEqual(brain.save({ type: 'logseq', id: 'work', path: '/no/such/folder' }).errors, ['path not found: /no/such/folder']);
  assert.ok(brain.save({ type: 'logseq', id: 'work', name: 'Work graph', path: lsq }).source);
  assert.ok(brain.save({ type: 'qdrant', id: 'vec', url: 'http://127.0.0.1:1', secret: { mode: 'store', value: 'qk' } }).source);
  assert.equal(stored.vec, 'qk'); assert.equal(conf.brain.sources[1].secret.env, 'BRAIN_VEC'); assert.ok(!JSON.stringify(conf).includes('qk'));
  assert.equal(brain.save({ type: 'logseq', id: 'obsidian', path: lsq }).errors[0], 'that id is reserved');
  const all = await brain.graph('all');
  assert.equal(all.layout, 'sources'); assert.deepEqual(all.sources.map((s) => s.id), ['obsidian', 'work']); assert.equal(all.same, 1); // "Launch" in both
  assert.match((await brain.graph('vec')).error, /BRAIN_VEC is not set/); // the secret reference is checked before any call
  assert.ok(brain.remove('work').id); assert.ok(brain.remove('obsidian').errors);
});

test('mem.ai notes with mem:// links and collections; Heybrain documents through MCP', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const J = (o) => new Response(JSON.stringify(o), { status: 200 });
    assert.equal(init.headers.authorization, 'Bearer mk');
    if (url.startsWith('https://api.mem.ai/v2/collections')) return J({ results: [{ id: 'c1', title: 'Projects' }] });
    if (url.includes('/v2/notes') && !url.includes('page=')) return J({ results: [{ id: 'aaaaaaaa-1', title: 'Launch', content: '# Launch\nsee [Pricing](mem://notes/bbbbbbbb-2) #q4', collection_ids: ['c1'], created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z' }], next_page: 'p2' });
    if (url.includes('page=p2')) return J({ results: [{ id: 'bbbbbbbb-2', title: 'Pricing', content: 'numbers', collection_ids: [] }], next_page: null });
    return new Response('{}', { status: 404 });
  };
  try {
    const g = await apps.mem({ secret: 'mk' });
    assert.deepEqual(g.notes.map((n) => n.name), ['Launch', 'Pricing']); assert.equal(g.notes[0].group, 'col:Projects'); assert.equal(g.notes[0].para, 'projects');
    assert.deepEqual(g.edges, [[0, 1]]); assert.deepEqual(g.notes[0].tags, ['q4']);
  } finally { global.fetch = realFetch; }
  const seen = [];
  const mcp = await fakeServer({ 'POST /mcp': (r) => {
    seen.push(r.body.method);
    if (r.body.method === 'initialize') return { headers: { 'mcp-session-id': 's1' }, body: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {} } } };
    if (r.body.method === 'notifications/initialized') return { status: 202, body: '' };
    assert.equal(r.headers['mcp-session-id'], 's1'); assert.equal(r.headers.authorization, 'Bearer ak_1'); assert.equal(r.body.params.name, 'list_documents');
    return { body: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify([{ id: 'd1', title: 'Board memo', content: 'links [[Budget]]', created_at: '2026-10-01' }, { id: 'd2', title: 'Budget' }]) }] } } };
  } });
  try {
    const docs = await apps.mcpList({ url: `${mcp.url}/mcp`, secret: 'ak_1' });
    assert.equal(docs.length, 2); assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/call']);
    let conf = {};
    const brain = createBrain({ getConfig: () => conf, writeBrainConfig: (b) => { conf = { ...conf, brain: b }; }, secrets: secretsFor({ HB: 'ak_1' }), resolveSecret: () => ({ env: 'HB' }), knowledge: null });
    assert.ok(brain.save({ type: 'heybrain', id: 'hb', url: `${mcp.url}/mcp`, secret: { mode: 'store', value: 'ak_1' } }).source);
    const g = await brain.graph('hb'); assert.equal(g.notes.length, 2); assert.deepEqual(g.edges, [[0, 1]]);
  } finally { await mcp.close(); }
});
