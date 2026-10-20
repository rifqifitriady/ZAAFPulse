// Reads one span's text from the original log, on demand: only the span's byte range, masked for secrets,
// in 64 KB pages. Files must resolve inside a known source root (no traversal, no symlinks out of it).
// Errors carry an HTTP-style `status` (400 bad ref, 403 outside the roots, 404 missing, 413 too large).
const fs = require('fs');
const path = require('path');
const { readLines } = require('./lines');
const sig = require('../signals');

const PAGE = 64 * 1024;
const MAX_READ = 16 * 1024 * 1024; // the most one ref, one line or one saved tool output may be
const KINDS = new Set(['prompt', 'reply', 'tool_input', 'tool_output', 'raw']);
// Claude Code's two wordings for a tool result saved to a file (both verified on real transcripts). They
// are anchored to the start of the content: a tool output that merely quotes the sentence is just text.
const SAVED = [
  /^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to (\S[^\n]*?)\.(?:\s|$)/,
  /^<persisted-output>\r?\nOutput too large[^\n]*?Full output saved to: (\S[^\n]*?)\r?(?:\n|$)/,
];
const MARKER_SCAN = 1000; // a marker is a short header: never test more than this, so the scan stays linear
function savedPath(content) {
  const head = content.slice(0, MARKER_SCAN);
  for (const re of SAVED) {
    const m = re.exec(head);
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
  // Resolved on every call, so a root that is created later (a CLI used for the first time) works.
  function realRoots() {
    const out = [];
    for (const r of roots || []) {
      try {
        out.push(fs.realpathSync.native(r));
      } catch {
        /* missing for now */
      }
    }
    return out;
  }

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
    if (!realRoots().some((r) => inside(r, rp))) throw fail(403, 'path outside the known log folders');
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
    if (e - s > MAX_READ) throw fail(413, 'range too large');
    return rp;
  }

  // <proj>/<sid>/tool-results for a transcript <proj>/<sid>.jsonl, and the parent session's folder for a
  // subagent transcript <proj>/<sid>/subagents/agent-x.jsonl. Nothing wider than that.
  function toolResultsDir(file) {
    const dir = path.dirname(file);
    if (path.basename(dir) === 'subagents') return path.join(path.dirname(dir), 'tool-results');
    return path.join(dir, path.basename(file, path.extname(file)), 'tool-results');
  }

  // The real tool-results folder of a transcript, which must be exactly <real session dir>/tool-results
  // (a folder that is itself a link to somewhere else is refused).
  function realToolResults(rp) {
    const lexical = toolResultsDir(rp);
    let session;
    let real;
    try {
      session = fs.realpathSync.native(path.dirname(lexical));
      real = fs.realpathSync.native(path.join(session, 'tool-results'));
    } catch {
      throw fail(404, 'file missing');
    }
    if (real !== path.join(session, 'tool-results')) throw fail(403, 'tool-results folder is a link');
    if (!realRoots().some((r) => inside(r, real))) throw fail(403, 'path outside the known log folders');
    return real;
  }

  // The saved file of a large tool output, only from the transcript's own session tool-results folder.
  async function savedOutput(ref, rp, given) {
    if (!path.isAbsolute(given)) return null; // not the form Claude Code writes: leave the sentence as text
    // The lexical check comes first and never touches the disk, so a path outside answers the same
    // whether or not the file exists there.
    const lexical = path.resolve(given);
    const dirs = [toolResultsDir(rp), toolResultsDir(path.resolve(ref.f))];
    if (!dirs.some((d) => lexical !== d && inside(d, lexical))) throw fail(403, 'saved output is outside the session tool-results folder');
    const folder = realToolResults(rp);
    // Then the same realpath and root checks as any ref file, and the real file must sit in that folder.
    const { rp: saved } = resolve(lexical);
    if (saved === folder || !inside(folder, saved)) throw fail(403, 'saved output is outside the session tool-results folder');
    // Open once and ask the handle, so the file cannot change between the check and the read.
    let fh;
    try {
      fh = await fs.promises.open(saved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    } catch (err) {
      throw err && err.code === 'ENOENT' ? fail(404, 'file missing') : fail(403, 'saved output cannot be opened');
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw fail(403, 'not a regular file');
      if (st.size > MAX_READ) throw fail(413, 'saved output too large');
      const buf = Buffer.alloc(st.size + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      if (n > st.size) throw fail(413, 'saved output too large');
      return buf.toString('utf8', 0, n);
    } finally {
      await fh.close();
    }
  }

  // The field's text, and `saved` when the content named a saved file that could not be followed (the
  // content itself is then returned as it is).
  async function fieldText(ref) {
    const rp = safe(ref);
    if (ref.k === 'raw') {
      // Only the bytes of the range, not the rest of the line past it.
      const fh = await fs.promises.open(rp, 'r');
      try {
        const buf = Buffer.alloc(ref.e - ref.s);
        const { bytesRead } = await fh.read(buf, 0, buf.length, ref.s);
        return { text: buf.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '') };
      } finally {
        await fh.close();
      }
    }
    const parts = [];
    let saved;
    // A prompt ref has s === e: read the single line that starts there.
    for await (const { text } of readLines(rp, { start: ref.s, end: ref.e === ref.s ? ref.s + 1 : ref.e, maxLine: MAX_READ })) {
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
          let body = c;
          if (given) {
            try {
              body = (await savedOutput(ref, rp, given)) ?? c;
            } catch (err) {
              if (!err || !err.status) throw err;
              saved = { status: err.status, error: err.message };
            }
          }
          parts.push(body);
        }
    }
    return { text: parts.join('\n'), saved };
  }

  // The page [from, to) of the text, with the secret spans that touch it. Spans come from the whole text,
  // so a page that starts or ends inside a secret still masks its part of it, whatever offset was asked.
  // The page end avoids splitting a surrogate pair or the start of a pattern match (a database URL).
  function pageOf(full, offset, max) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > full.length) throw fail(400, 'bad offset');
    if (!Number.isSafeInteger(max) || max < 1) throw fail(400, 'bad page size');
    const all = sig.secretSpans(full);
    let to = Math.min(full.length, offset + Math.min(max, PAGE));
    if (to < full.length) {
      const c = full.charCodeAt(to - 1);
      if (c >= 0xd800 && c <= 0xdbff && to - 1 > offset) to -= 1;
      for (const sp of all) {
        if (sp.matchStart < to && sp.end > to && sp.matchStart > offset) {
          to = sp.matchStart;
          break;
        }
      }
    }
    return { to, spans: all.filter((sp) => sp.start < to && sp.end > offset) };
  }

  async function read(ref, { offset = 0, max = PAGE } = {}) {
    const { text: full, saved } = await fieldText(ref);
    const { to, spans } = pageOf(full, offset, max);
    const masked = [];
    let text = '';
    let last = offset;
    for (const sp of spans) {
      const mark = `‹${sp.label} hidden›`;
      text += full.slice(last, Math.max(sp.start, offset));
      masked.push({ start: text.length, end: text.length + mark.length, label: sp.label });
      text += mark;
      last = Math.min(sp.end, to);
    }
    text += full.slice(last, to);
    const next = to < full.length ? to : null;
    const out = { text, masked, offset, next, total: full.length, truncated: next !== null };
    if (saved) out.saved = saved;
    return out;
  }

  // One value on request, for the same page the caller was shown (the whole secret, even when the page
  // shows only a part of it). Nothing is cached.
  async function reveal(ref, index, { offset = 0, max = PAGE } = {}) {
    const { text: full } = await fieldText(ref);
    const { spans } = pageOf(full, offset, max);
    const sp = Number.isInteger(index) ? spans[index] : undefined;
    if (!sp) throw fail(404, 'no such masked value');
    return { value: full.slice(sp.start, sp.end) };
  }

  return { read, reveal };
}

module.exports = { createContent, PAGE };
