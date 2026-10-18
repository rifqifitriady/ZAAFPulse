// RAG Service: knowledge bases with document ingestion and a local vector store, no dependencies.
// Each knowledge base is one JSON file in .data/kb/: documents, chunks and (when an embedding model is
// set) a Float32 vector per chunk. Search is hybrid: cosine similarity on embeddings blended with BM25
// keyword scores, or BM25 alone when the knowledge base has no embedding model.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[a-z0-9-]{1,40}$/;
const CHUNK = 900; const OVERLAP = 150;
const MAX_DOC_CHARS = 2_000_000;
const tokenize = (s) => String(s || '').toLowerCase().match(/[a-z0-9À-ɏ]{2,}/g) || [];

// Plain text from common formats. HTML loses tags, scripts and styles; JSON and CSV stay as text.
function toText(content, kind = 'text') {
  let s = String(content || '');
  if (kind === 'html' || /^\s*<(!doctype|html|body|div|p|article)/i.test(s)) {
    s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  if (kind === 'json') { try { s = JSON.stringify(JSON.parse(s), null, 1); } catch { /* keep raw */ } }
  return s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Chunks of ~900 characters that end at a paragraph or sentence when possible, overlapping by 150.
function chunkText(text) {
  const out = []; let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK);
    if (end < text.length) {
      const window = text.slice(i + CHUNK * 0.5, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (cut > 0) end = i + Math.floor(CHUNK * 0.5) + cut + 1;
    }
    const piece = text.slice(i, end).trim(); if (piece) out.push(piece);
    if (end >= text.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return out;
}

const encodeVec = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const decodeVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4); };
function cosine(a, b) { let d = 0; let na = 0; let nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; }

function bm25Index(chunks) {
  const docs = chunks.map((c) => tokenize(c.text)); const df = new Map(); let total = 0;
  for (const toks of docs) { total += toks.length; for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1); }
  const avg = total / Math.max(1, docs.length); const N = docs.length;
  return (query) => {
    const q = tokenize(query);
    return docs.map((toks) => {
      const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      let s = 0;
      for (const t of q) { const f = tf.get(t); if (!f) continue; const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * toks.length / avg)); }
      return s;
    });
  };
}

// embed(model, texts) → vectors; provided by the gateway so embeddings go through configured providers.
function createKnowledge({ dir, embed, now = Date.now }) {
  const cache = new Map();
  const file = (id) => path.join(dir, `${id}.json`);
  function load(id) {
    if (cache.has(id)) return cache.get(id);
    let kb = null; try { kb = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
    kb._bm25 = bm25Index(kb.chunks); kb._vecs = kb.chunks.map((c) => (c.vec ? decodeVec(c.vec) : null));
    cache.set(id, kb); return kb;
  }
  function save(kb) {
    const { _bm25, _vecs, ...plain } = kb;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file(kb.id)}.tmp`, JSON.stringify(plain), { mode: 0o600 }); fs.renameSync(`${file(kb.id)}.tmp`, file(kb.id));
    kb._bm25 = bm25Index(kb.chunks); kb._vecs = kb.chunks.map((c) => (c.vec ? decodeVec(c.vec) : null)); cache.set(kb.id, kb);
  }
  const summary = (kb) => ({ id: kb.id, name: kb.name, description: kb.description, embedModel: kb.embedModel || '', documents: kb.docs.length, chunks: kb.chunks.length,
    chars: kb.docs.reduce((a, d) => a + d.chars, 0), embedded: kb.chunks.filter((c) => c.vec).length, updatedAt: kb.updatedAt, createdAt: kb.createdAt });
  const ids = () => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } };

  return {
    list: () => ids().map(load).filter(Boolean).map(summary),
    // For the second-brain map: each document with the mean of its chunk vectors (null without embeddings)
    // and its keyword set, so documents can be placed by meaning or, failing that, by shared words.
    graph() {
      const out = [];
      for (const kb of ids().map(load).filter(Boolean)) {
        for (const d of kb.docs) {
          const idx = kb.chunks.map((c, i) => (c.docId === d.id ? i : -1)).filter((i) => i >= 0);
          const vecs = idx.map((i) => kb._vecs[i]).filter(Boolean);
          let vector = null;
          if (vecs.length) { vector = new Array(vecs[0].length).fill(0); for (const v of vecs) for (let i = 0; i < v.length; i++) vector[i] += v[i] / vecs.length; }
          const words = new Set(); for (const i of idx.slice(0, 40)) for (const w of tokenize(kb.chunks[i].text)) if (w.length > 3) words.add(w);
          out.push({ kb: kb.id, kbName: kb.name || kb.id, id: d.id, title: d.title, source: d.source, chars: d.chars, chunks: d.chunks, addedAt: d.addedAt, vector, words: [...words].slice(0, 400) });
        }
      }
      return out;
    },
    get: (id) => { const kb = load(id); return kb ? { ...summary(kb), docs: kb.docs } : null; },
    create({ id, name, description = '', embedModel = '' }) {
      if (!ID.test(id || '')) return { errors: ['id: 1-40 lowercase letters, digits or dashes'] };
      if (load(id)) return { errors: [`a knowledge base called "${id}" already exists`] };
      const kb = { id, name: String(name || id).slice(0, 80), description: String(description).slice(0, 300), embedModel: String(embedModel || '').trim(), docs: [], chunks: [], createdAt: now(), updatedAt: now() };
      save(kb); return { kb: summary(kb) };
    },
    update(id, { name, description, embedModel }) {
      const kb = load(id); if (!kb) return { errors: ['no such knowledge base'] };
      if (name != null) kb.name = String(name).slice(0, 80); if (description != null) kb.description = String(description).slice(0, 300);
      if (embedModel != null && embedModel !== kb.embedModel) { kb.embedModel = String(embedModel).trim(); for (const c of kb.chunks) delete c.vec; } // re-embed on next ingest/reindex
      kb.updatedAt = now(); save(kb); return { kb: summary(kb) };
    },
    remove(id) { if (!load(id)) return false; fs.rmSync(file(id), { force: true }); cache.delete(id); return true; },

    // Document ingestion: text → chunks → (embeddings) → saved. Re-ingesting the same title replaces it.
    async ingest(id, { title, content, kind = 'text', source = '' }) {
      const kb = load(id); if (!kb) return { errors: ['no such knowledge base'] };
      const text = toText(String(content || '').slice(0, MAX_DOC_CHARS), kind);
      if (!text) return { errors: ['the document has no text'] };
      const docTitle = String(title || source || 'Untitled').slice(0, 200);
      const old = kb.docs.find((d) => d.title === docTitle);
      if (old) { kb.chunks = kb.chunks.filter((c) => c.docId !== old.id); kb.docs = kb.docs.filter((d) => d !== old); }
      const doc = { id: `doc_${crypto.randomBytes(6).toString('hex')}`, title: docTitle, source: String(source).slice(0, 500), kind, chars: text.length, addedAt: now() };
      const pieces = chunkText(text);
      const chunks = pieces.map((t, i) => ({ id: `${doc.id}_${i}`, docId: doc.id, n: i, text: t }));
      let embedError = null;
      if (kb.embedModel) {
        try { for (let i = 0; i < chunks.length; i += 64) { const vecs = await embed(kb.embedModel, chunks.slice(i, i + 64).map((c) => c.text)); vecs.forEach((v, j) => { chunks[i + j].vec = encodeVec(v); }); } }
        catch (err) { embedError = err.message; for (const c of chunks) delete c.vec; }
      }
      doc.chunks = chunks.length; kb.docs.push(doc); kb.chunks.push(...chunks); kb.updatedAt = now(); save(kb);
      return { doc, embedded: chunks.filter((c) => c.vec).length, ...(embedError ? { warning: `saved for keyword search only; embeddings failed: ${embedError}` } : {}) };
    },
    removeDoc(id, docId) { const kb = load(id); if (!kb) return false; kb.docs = kb.docs.filter((d) => d.id !== docId); kb.chunks = kb.chunks.filter((c) => c.docId !== docId); kb.updatedAt = now(); save(kb); return true; },
    async reindex(id) {
      const kb = load(id); if (!kb) return { errors: ['no such knowledge base'] }; if (!kb.embedModel) return { errors: ['set an embedding model first'] };
      const todo = kb.chunks.filter((c) => !c.vec);
      for (let i = 0; i < todo.length; i += 64) { const vecs = await embed(kb.embedModel, todo.slice(i, i + 64).map((c) => c.text)); vecs.forEach((v, j) => { todo[i + j].vec = encodeVec(v); }); }
      kb.updatedAt = now(); save(kb); return { embedded: todo.length };
    },

    // Hybrid search: 0.65 × cosine + 0.35 × normalised BM25 when vectors exist, else BM25 only.
    async search(id, query, k = 5) {
      const kb = load(id); if (!kb) return { errors: ['no such knowledge base'] };
      if (!kb.chunks.length) return { results: [], method: 'empty' };
      const bm = kb._bm25(query); const maxBm = Math.max(...bm, 1e-9);
      let qv = null; let method = 'keyword';
      if (kb.embedModel && kb._vecs.some(Boolean)) { try { [qv] = await embed(kb.embedModel, [query]); method = 'hybrid'; } catch { method = 'keyword (embedding failed)'; } }
      const scored = kb.chunks.map((c, i) => {
        const kw = bm[i] / maxBm; const sem = qv && kb._vecs[i] ? cosine(qv, kb._vecs[i]) : null;
        return { c, score: sem == null ? kw : 0.65 * sem + 0.35 * kw, sem, kw };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(20, k));
      const title = (docId) => (kb.docs.find((d) => d.id === docId) || {}).title || '';
      return { method, results: scored.map((x) => ({ text: x.c.text, document: title(x.c.docId), chunk: x.c.n, score: +x.score.toFixed(4), ...(x.sem != null ? { semantic: +x.sem.toFixed(4) } : {}), keyword: +x.kw.toFixed(4) })) };
    },
  };
}

module.exports = { createKnowledge, chunkText, toText, cosine, bm25Index };
