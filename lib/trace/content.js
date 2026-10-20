// Reads one span's text from the original log, on demand: only the span's byte range, masked for secrets,
// in 64 KB pages. Files must resolve inside a known source root (no traversal, no symlinks out of it).
// Errors carry an HTTP-style `status` (400 bad ref, 403 outside the roots, 404 missing, 413 too large).
const fs = require('fs');
const path = require('path');
const { readLines } = require('./lines');
const sig = require('../signals');

const PAGE = 64 * 1024;
const SAVED_MAX = 16 * 1024 * 1024; // Claude Code's saved tool outputs; larger than this is not a normal result
const OVERLAP = 8192; // look this far past a page end so a secret on the boundary is seen whole
const KINDS = new Set(['prompt', 'reply', 'tool_input', 'tool_output', 'raw']);
// Claude Code's two wordings for a tool result saved to a file (both verified on real transcripts):
// older "Output has been saved to /abs/name.txt." followed by instructions, newer
// "<persisted-output>\nOutput too large (34.6KB). Full output saved to: /abs/name.txt\n\nPreview ...".
const SAVED = [/Output has been saved to ([^\n]+?\.[A-Za-z0-9]+)\.(?:\s|$)/, /Full output saved to: ([^\n]+)/];
function savedPath(content) {
  for (const re of SAVED) {
    const m = re.exec(content);
    if (m) return m[1].trim();
  }
  return null;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function inside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function createContent({ roots }) {
  const real = (roots || [])
    .map((r) => {
      try {
        return fs.realpathSync.native(r);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Resolves symlinks first, then checks the real location against the roots, so neither "../" nor a link
  // can lead out. Returns the real path and the file size.
  function resolve(file) {
    if (typeof file !== 'string' || !file || file.includes('\0')) throw fail(400, 'bad file reference');
    let rp;
    try {
      rp = fs.realpathSync.native(file);
    } catch {
      throw fail(404, 'file missing');
    }
    if (!real.some((r) => inside(r, rp))) throw fail(403, 'path outside the known log folders');
    let st;
    try {
      st = fs.statSync(rp);
    } catch {
      throw fail(404, 'file missing');
    }
    if (!st.isFile()) throw fail(403, 'not a regular file');
    return { rp, size: st.size };
  }

  function safe(ref) {
    if (!ref || typeof ref !== 'object' || !KINDS.has(ref.k)) throw fail(400, 'bad content reference');
    const { rp, size } = resolve(ref.f);
    const { s, e } = ref;
    if (!(Number.isSafeInteger(s) && Number.isSafeInteger(e) && s >= 0 && e >= s && e <= size)) throw fail(400, 'byte range outside the file');
    return rp;
  }

  // The session's tool-results folder for a transcript: <proj>/<sid>/tool-results for <proj>/<sid>.jsonl,
  // and the parent session's folder for a subagent transcript <proj>/<sid>/subagents/agent-x.jsonl.
  // Nothing wider than that.
  function toolResultsDir(file) {
    const dir = path.dirname(file);
    if (path.basename(dir) === 'subagents') return path.join(path.dirname(dir), 'tool-results');
    return path.join(dir, path.basename(file, path.extname(file)), 'tool-results');
  }

  // The saved file of a large tool output, only from the transcript's session tool-results folder.
  async function savedOutput(ref, rp, given) {
    if (!path.isAbsolute(given)) return null; // not the form Claude Code writes: leave the sentence as text
    // The lexical check comes first and never touches the disk, so a path outside answers the same
    // whether or not the file exists there.
    const dirs = [...new Set([toolResultsDir(rp), toolResultsDir(path.resolve(ref.f))])];
    const lexical = path.resolve(given);
    if (!dirs.some((d) => lexical !== d && inside(d, lexical))) throw fail(403, 'saved output is outside the session tool-results folder');
    // Then the same realpath and root checks as any ref file, against the real tool-results folder.
    const { rp: saved, size } = resolve(lexical);
    const okDir = dirs.some((d) => {
      try {
        const rd = fs.realpathSync.native(d);
        return saved !== rd && inside(rd, saved);
      } catch {
        return false;
      }
    });
    if (!okDir) throw fail(403, 'saved output is outside the session tool-results folder');
    if (size > SAVED_MAX) throw fail(413, 'saved output too large');
    return fs.promises.readFile(saved, 'utf8');
  }

  async function fieldText(ref) {
    const rp = safe(ref);
    if (ref.k === 'raw') {
      if (ref.e - ref.s > SAVED_MAX) throw fail(413, 'range too large');
      // Only the bytes of the range, not the rest of the line past it.
      const fh = await fs.promises.open(rp, 'r');
      try {
        const buf = Buffer.alloc(ref.e - ref.s);
        const { bytesRead } = await fh.read(buf, 0, buf.length, ref.s);
        return buf.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
      } finally {
        await fh.close();
      }
    }
    const parts = [];
    // A prompt ref has s === e: read the single line that starts there.
    for await (const { text } of readLines(rp, { start: ref.s, end: ref.e === ref.s ? ref.s + 1 : ref.e })) {
      let o;
      try {
        o = JSON.parse(text);
      } catch {
        continue;
      }
      if (!o || typeof o !== 'object') continue;
      const m = o.message && typeof o.message === 'object' ? o.message : {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (ref.k === 'prompt') {
        parts.push(typeof m.content === 'string' ? m.content : blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n'));
        break;
      }
      if (ref.k === 'reply') {
        // An id-less message has ref.i null: take the id-less assistant lines in the range.
        const mine = ref.i == null ? !m.id : m.id === ref.i;
        if (mine && (o.type === 'assistant' || m.role === 'assistant')) for (const b of blocks) if (b && b.type === 'text' && b.text) parts.push(b.text);
      }
      if (ref.k === 'tool_input') for (const b of blocks) if (b && b.type === 'tool_use' && b.id === ref.i) parts.push(JSON.stringify(b.input ?? {}, null, 2));
      if (ref.k === 'tool_output')
        for (const b of blocks) {
          if (!b || b.type !== 'tool_result' || b.tool_use_id !== ref.i) continue;
          const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : '';
          const given = typeof b.content === 'string' ? savedPath(c) : null;
          const saved = given ? await savedOutput(ref, rp, given) : null;
          parts.push(saved ?? c);
        }
    }
    return parts.join('\n');
  }

  // The page [from, to) of the text. It never ends inside a surrogate pair or inside a secret: a secret
  // that crosses the end moves to the next page whole (unless the page starts with it).
  function pageOf(full, offset, max) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail(400, 'bad offset');
    if (!Number.isSafeInteger(max) || max < 1) throw fail(400, 'bad page size');
    const size = Math.min(max, PAGE);
    let to = Math.min(full.length, offset + size);
    if (to < full.length) {
      const c = full.charCodeAt(to - 1);
      if (c >= 0xd800 && c <= 0xdbff && to - 1 > offset) to -= 1;
      const spans = sig.secretSpans(full.slice(offset, Math.min(full.length, to + OVERLAP)));
      for (const sp of spans) {
        if (offset + sp.start < to && offset + sp.end > to) {
          to = sp.start > 0 ? offset + sp.start : Math.min(full.length, offset + sp.end);
          break;
        }
      }
    }
    const page = full.slice(offset, to);
    return { page, to, spans: sig.secretSpans(page) };
  }

  async function read(ref, { offset = 0, max = PAGE } = {}) {
    const full = await fieldText(ref);
    const { page, to, spans } = pageOf(full, offset, max);
    const masked = [];
    let text = '';
    let last = 0;
    for (const m of spans) {
      const mark = `‹${m.label} hidden›`;
      text += page.slice(last, m.start);
      masked.push({ start: text.length, end: text.length + mark.length, label: m.label });
      text += mark;
      last = m.end;
    }
    text += page.slice(last);
    const next = to < full.length ? to : null;
    return { text, masked, offset, next, total: full.length, truncated: next !== null };
  }

  // One value on request, for the same page the caller was shown. Nothing is cached.
  async function reveal(ref, index, { offset = 0, max = PAGE } = {}) {
    const full = await fieldText(ref);
    const { page, spans } = pageOf(full, offset, max);
    const m = Number.isInteger(index) ? spans[index] : undefined;
    if (!m) throw fail(404, 'no such masked value');
    return { value: page.slice(m.start, m.end) };
  }

  return { read, reveal };
}

module.exports = { createContent, PAGE };
