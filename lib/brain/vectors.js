// Vector stores as a "semantic map": up to 240 records sampled from Pinecone, Weaviate, Qdrant, Chroma or
// pgvector (and the RAG knowledge bases), projected to 2D with PCA so that position means meaning,
// linked to their nearest neighbours by cosine similarity, and grouped by collection or by k-means
// cluster. Clients are plain fetch (and a tiny Postgres client); only labels and coordinates leave here.
const pg = require('./pg');
const { finish } = require('./markdown');

const SAMPLE = 240;
const TIMEOUT_MS = 20000;

function norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

// Two principal components by power iteration on the centred data (no covariance matrix needed).
function project2d(vectors) {
  const n = vectors.length;
  if (!n) return [];
  const d = vectors[0].length;
  const mean = new Float64Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const X = vectors.map((v) => Float64Array.from(v, (x, i) => x - mean[i]));
  const component = (orth) => {
    let w = Float64Array.from({ length: d }, (_, i) => Math.sin(i * 12.9898 + (orth ? 4.1 : 0)) || 0.1);
    for (let it = 0; it < 40; it++) {
      const next = new Float64Array(d);
      for (const x of X) {
        const p = dot(x, w);
        for (let i = 0; i < d; i++) next[i] += p * x[i];
      }
      if (orth) {
        const p = dot(next, orth);
        for (let i = 0; i < d; i++) next[i] -= p * orth[i];
      }
      const len = Math.hypot(...next) || 1;
      w = next.map((x) => x / len);
    }
    return w;
  };
  const c1 = component(null);
  const c2 = component(c1);
  const pts = X.map((x) => [dot(x, c1), dot(x, c2)]);
  const max = Math.max(1e-9, ...pts.flat().map(Math.abs));
  return pts.map(([a, b]) => [+(a / max).toFixed(4), +(b / max).toFixed(4)]);
}
// Each record linked to its k nearest neighbours above a cosine floor.
function knn(vectors, k = 3, floor = 0.35) {
  const u = vectors.map(norm);
  const edges = new Map();
  for (let i = 0; i < u.length; i++) {
    const best = [];
    for (let j = 0; j < u.length; j++) {
      if (i === j) continue;
      const s = dot(u[i], u[j]);
      if (s >= floor) best.push([s, j]);
    }
    best.sort((a, b) => b[0] - a[0]);
    for (const [, j] of best.slice(0, k)) {
      const key = i < j ? `${i}>${j}` : `${j}>${i}`;
      if (!edges.has(key)) edges.set(key, [i, j]);
    }
  }
  return [...edges.values()];
}
// k-means on unit vectors (cosine), deterministic seeding (farthest-point).
function kmeans(vectors, k) {
  const u = vectors.map(norm);
  k = Math.max(1, Math.min(k, u.length));
  if (!u.length) return [];
  const cents = [u[0]];
  while (cents.length < k) {
    let far = 0;
    let fd = -1;
    u.forEach((v, i) => {
      const s = Math.max(...cents.map((c) => dot(v, c)));
      const dist = 1 - s;
      if (dist > fd) {
        fd = dist;
        far = i;
      }
    });
    cents.push(u[far]);
  }
  let assign = new Array(u.length).fill(0);
  for (let it = 0; it < 12; it++) {
    assign = u.map((v) => {
      let b = 0;
      let bs = -2;
      cents.forEach((c, ci) => {
        const s = dot(v, c);
        if (s > bs) {
          bs = s;
          b = ci;
        }
      });
      return b;
    });
    for (let ci = 0; ci < k; ci++) {
      const mem = u.filter((_, i) => assign[i] === ci);
      if (!mem.length) continue;
      const m = new Array(u[0].length).fill(0);
      for (const v of mem)
        v.forEach((x, i) => {
          m[i] += x;
        });
      cents[ci] = norm(m);
    }
  }
  return assign;
}
const labelOf = (meta = {}, fallback) => {
  for (const k of [
    'title',
    'name',
    'heading',
    'subject',
    'file_name',
    'filename',
    'source',
    'url',
    'text',
    'content',
    'document',
    'chunk',
    'page_content',
  ]) {
    const v = meta[k];
    if (v != null && String(v).trim()) return String(v).replace(/\s+/g, ' ').trim().slice(0, 70);
  }
  return String(fallback).slice(0, 40);
};

// records: [{ id, vector, meta, collection, text }] → a brain graph with xy coordinates.
function semanticGraph(name, records, { kind = 'vector' } = {}) {
  const recs = records.filter((r) => Array.isArray(r.vector) && r.vector.length).slice(0, SAMPLE);
  const dims = new Set(recs.map((r) => r.vector.length));
  const dim = [...dims].sort(
    (a, b) => recs.filter((r) => r.vector.length === b).length - recs.filter((r) => r.vector.length === a).length,
  )[0];
  const same = recs.filter((r) => r.vector.length === dim); // one dimension per map
  const vecs = same.map((r) => r.vector);
  const xy = project2d(vecs);
  const edges = knn(vecs);
  const collections = [...new Set(same.map((r) => r.collection))];
  const clusters =
    collections.length > 1 ? null : kmeans(vecs, Math.min(6, Math.max(2, Math.round(Math.sqrt(same.length / 6)))));
  const now = Date.now();
  const notes = same.map((r, i) => ({
    id: i,
    name: labelOf(r.meta, r.id),
    path: `${r.collection}/${r.id}`,
    folder: r.collection,
    group: clusters ? `cluster-${clusters[i] + 1}` : r.collection,
    tags: Object.keys(r.meta || {}).slice(0, 6),
    description: r.text ? String(r.text).replace(/\s+/g, ' ').slice(0, 220) : '',
    words: r.text ? String(r.text).split(/\s+/).length : 0,
    created:
      Number(new Date((r.meta || {}).created_at || (r.meta || {}).createdAt || (r.meta || {}).date || now)) || now,
    modified: now,
    xy: xy[i],
  }));
  const groups = clusters
    ? [...new Set(clusters)].sort((a, b) => a - b).map((c) => ({ id: `cluster-${c + 1}`, name: `Cluster ${c + 1}` }))
    : collections.map((c) => ({ id: c, name: c }));
  return finish({
    name,
    notes,
    edges,
    extra: {
      kind,
      layout: 'semantic',
      groups,
      dimension: dim,
      sampled: same.length,
      skipped: recs.length - same.length,
    },
  });
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not json */
    }
    if (!r.ok)
      throw new Error(
        `HTTP ${r.status}${j && (j.message || j.error) ? `: ${String(j.message || (j.error && j.error.message) || j.error).slice(0, 160)}` : ''}`,
      );
    return j;
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out' : err.cause?.code || err.message);
  } finally {
    clearTimeout(t);
  }
}
const strip = (u) => String(u || '').replace(/\/+$/, '');
const pickCollections = (all, wanted) => (wanted ? all.filter((c) => c === wanted) : all).slice(0, 4);

const CLIENTS = {
  // Serverless indexes list ids; pod indexes fall back to a query around a neutral vector.
  async pinecone({ secret, options = {} }) {
    const h = { 'Api-Key': secret, 'X-Pinecone-API-Version': '2026-07' };
    const idx = await call('https://api.pinecone.io/indexes', { headers: h });
    const list = (idx.indexes || []).filter((i) => !options.collection || i.name === options.collection).slice(0, 3);
    const out = [];
    for (const i of list) {
      const host = `https://${i.host}`;
      const per = Math.floor(SAMPLE / list.length);
      // Since API 2026-07 the dimension lives under schema.fields; older versions have it at the top.
      i.dimension ||=
        (Object.values((i.schema && i.schema.fields) || {}).find((f) => f && f.type === 'dense_vector') || {})
          .dimension || 1536;
      let vectors = {};
      try {
        const ids = await call(
          `${host}/vectors/list?limit=${Math.min(100, per)}${options.namespace ? `&namespace=${encodeURIComponent(options.namespace)}` : ''}`,
          { headers: h },
        );
        const want = (ids.vectors || []).map((v) => v.id);
        if (want.length)
          vectors =
            (
              await call(
                `${host}/vectors/fetch?${want.map((x) => `ids=${encodeURIComponent(x)}`).join('&')}${options.namespace ? `&namespace=${encodeURIComponent(options.namespace)}` : ''}`,
                { headers: h },
              )
            ).vectors || {};
      } catch {
        const q = await call(`${host}/query`, {
          method: 'POST',
          headers: h,
          body: {
            vector: new Array(i.dimension).fill(1 / Math.sqrt(i.dimension)),
            topK: Math.min(100, per),
            includeValues: true,
            includeMetadata: true,
            ...(options.namespace ? { namespace: options.namespace } : {}),
          },
        });
        for (const m of q.matches || []) vectors[m.id] = m;
      }
      for (const v of Object.values(vectors))
        out.push({
          id: v.id,
          vector: v.values,
          meta: v.metadata || {},
          collection: i.name,
          text: (v.metadata || {}).text,
        });
    }
    return out;
  },
  async weaviate({ url, secret, options = {} }) {
    const h = secret ? { authorization: `Bearer ${secret}` } : {};
    const schema = await call(`${strip(url)}/v1/schema`, { headers: h });
    const classes = pickCollections(
      (schema.classes || []).map((c) => c.class),
      options.collection,
    );
    const out = [];
    for (const c of classes) {
      const j = await call(
        `${strip(url)}/v1/objects?class=${encodeURIComponent(c)}&limit=${Math.floor(SAMPLE / classes.length)}&include=vector`,
        { headers: h },
      );
      for (const o of j.objects || [])
        out.push({
          id: o.id,
          vector: o.vector || (o.vectors && Object.values(o.vectors)[0]),
          meta: o.properties || {},
          collection: c,
          text: (o.properties || {}).text || (o.properties || {}).content,
        });
    }
    return out;
  },
  async qdrant({ url, secret, options = {} }) {
    const h = secret ? { 'api-key': secret } : {};
    const cols = await call(`${strip(url)}/collections`, { headers: h });
    const names = pickCollections(
      ((cols.result || {}).collections || []).map((c) => c.name),
      options.collection,
    );
    const out = [];
    for (const c of names) {
      const j = await call(`${strip(url)}/collections/${encodeURIComponent(c)}/points/scroll`, {
        method: 'POST',
        headers: h,
        body: { limit: Math.floor(SAMPLE / names.length), with_payload: true, with_vector: true },
      });
      for (const p of (j.result || {}).points || [])
        out.push({
          id: p.id,
          vector: Array.isArray(p.vector) ? p.vector : p.vector && Object.values(p.vector)[0],
          meta: p.payload || {},
          collection: c,
          text: (p.payload || {}).text || (p.payload || {}).page_content,
        });
    }
    return out;
  },
  // Chroma v2 (tenant/database paths), then the v1 API.
  async chroma({ url, secret, options = {} }) {
    const h = secret ? { authorization: `Bearer ${secret}`, 'x-chroma-token': secret } : {};
    const t = options.tenant || 'default_tenant';
    const d = options.database || 'default_database';
    let base = `${strip(url)}/api/v2/tenants/${encodeURIComponent(t)}/databases/${encodeURIComponent(d)}`;
    let cols;
    try {
      cols = await call(`${base}/collections`, { headers: h });
    } catch {
      base = `${strip(url)}/api/v1`;
      cols = await call(`${base}/collections`, { headers: h });
    }
    const list = (Array.isArray(cols) ? cols : [])
      .filter((c) => !options.collection || c.name === options.collection)
      .slice(0, 4);
    const out = [];
    for (const c of list) {
      const j = await call(`${base}/collections/${c.id}/get`, {
        method: 'POST',
        headers: h,
        body: { limit: Math.floor(SAMPLE / list.length), include: ['embeddings', 'metadatas', 'documents'] },
      });
      (j.ids || []).forEach((id, i) =>
        out.push({
          id,
          vector: (j.embeddings || [])[i],
          meta: { ...((j.metadatas || [])[i] || {}), ...((j.documents || [])[i] ? { text: j.documents[i] } : {}) },
          collection: c.name,
          text: (j.documents || [])[i],
        }),
      );
    }
    return out;
  },
  // pgvector: tables with a column of type vector; rows read as text, the vector parsed from "[1,2,3]".
  async pgvector({ url, secret, options = {} }) {
    const conn = await pg.connect(secret || url);
    try {
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const cols = await conn.query(
        "SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE udt_name = 'vector' ORDER BY table_schema, table_name LIMIT 40",
      );
      const tables = cols
        .filter(
          (c) =>
            !options.collection ||
            c.table_name === options.collection ||
            `${c.table_schema}.${c.table_name}` === options.collection,
        )
        .slice(0, 4);
      const out = [];
      for (const c of tables) {
        const rows = await conn.query(
          `SELECT * FROM ${q(c.table_schema)}.${q(c.table_name)} LIMIT ${Math.floor(SAMPLE / tables.length)}`,
        );
        rows.forEach((r, i) => {
          const raw = r[c.column_name];
          if (!raw) return;
          const vector = raw
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(Number);
          const meta = Object.fromEntries(
            Object.entries(r).filter(([k, v]) => k !== c.column_name && v != null && String(v).length < 2000),
          );
          out.push({
            id: r.id || r.uuid || i,
            vector,
            meta,
            collection: `${c.table_name}`,
            text: meta.content || meta.text || meta.document,
          });
        });
      }
      return out;
    } finally {
      conn.end();
    }
  },
};

async function sampleVectors(type, cfg) {
  return CLIENTS[type](cfg);
}

module.exports = { semanticGraph, sampleVectors, project2d, knn, kmeans, labelOf, CLIENTS };
