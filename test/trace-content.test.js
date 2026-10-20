const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContent } = require('../lib/trace/content');

// Built at runtime with varied characters: a low-variety key ("aaaa…") counts as a placeholder in
// isLiveSecret, and a literal key-shaped string would trip GitHub push protection.
const alphabet = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
function makeSecret() {
  return 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('');
}

function offsets(lines) {
  const off = [];
  let n = 0;
  for (const l of lines) {
    off.push([n, n + Buffer.byteLength(l)]);
    n += Buffer.byteLength(l);
  }
  return off;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  const secret = makeSecret();
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hello <script>alert(1)</script>' } },
    { type: 'assistant', message: { id: 'm1', model: 'x', content: [{ type: 'text', text: `key ${secret} done` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(70000) }] } },
  ].map((o) => JSON.stringify(o) + '\n');
  fs.writeFileSync(file, lines.join(''));
  return { root, file, off: offsets(lines), secret };
}

function outsideDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zp-outside-'));
}

// A saved-output marker that cannot be followed gives back the original content plus the reason.
async function unfollowed(c, ref, status, msg) {
  const r = await c.read(ref);
  assert.equal(r.saved && r.saved.status, status, JSON.stringify(r.saved));
  assert.match(r.text, /saved to|Full output saved/, 'the original content is returned');
  if (msg) assert.match(r.saved.error, msg);
  return r;
}

test('prompt text comes back as plain text (HTML is not interpreted here)', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  const r = await c.read({ f: file, s: off[0][0], e: off[0][1], k: 'prompt' });
  assert.equal(r.text, 'hello <script>alert(1)</script>');
});

test('secrets are masked, and reveal returns one value on request', async () => {
  const { root, file, off, secret } = fixture();
  const c = createContent({ roots: [root] });
  const ref = { f: file, s: off[1][0], e: off[1][1], k: 'reply', i: 'm1' };
  const r = await c.read(ref);
  assert.ok(!r.text.includes(secret));
  assert.equal(r.masked.length, 1);
  assert.equal(r.text.slice(r.masked[0].start, r.masked[0].end), '‹Anthropic API key hidden›');
  assert.equal((await c.reveal(ref, 0)).value, secret);
  await assert.rejects(c.reveal(ref, 5), /no such masked/);
});

test('tool output is paged at 64 KB', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  const ref = { f: file, s: off[2][0], e: off[2][1], k: 'tool_output', i: 't1' };
  const p1 = await c.read(ref);
  assert.equal(p1.text.length, 65536);
  assert.equal(p1.truncated, true);
  const p2 = await c.read(ref, { offset: p1.next });
  assert.equal(p2.text.length, 70000 - 65536);
  assert.equal(p2.next, null);
  assert.equal(p2.total, 70000);
});

test('refs outside the roots or past the file end are refused', async () => {
  const { root, file } = fixture();
  const out = outsideDir();
  const other = path.join(out, 'other.jsonl');
  fs.writeFileSync(other, '{"a":1}\n');
  const c = createContent({ roots: [root] });
  await assert.rejects(c.read({ f: other, s: 0, e: 4, k: 'raw' }), { status: 403, message: /outside/ });
  await assert.rejects(c.read({ f: path.join(root, '..', path.basename(root), '..', 'x'), s: 0, e: 1, k: 'raw' }), /outside|missing/);
  await assert.rejects(c.read({ f: file, s: 0, e: 10 ** 9, k: 'raw' }), { status: 400, message: /range/ });
  if (process.platform !== 'win32') {
    const link = path.join(root, 'link.jsonl');
    fs.symlinkSync(other, link);
    await assert.rejects(c.read({ f: link, s: 0, e: 4, k: 'raw' }), { status: 403, message: /outside/ });
  }
});

test('a sibling folder that only shares the root name prefix is outside', async () => {
  const { root } = fixture();
  const sibling = root + '-evil';
  fs.mkdirSync(sibling);
  const f = path.join(sibling, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  const c = createContent({ roots: [root] });
  await assert.rejects(c.read({ f, s: 0, e: 4, k: 'raw' }), { status: 403 });
});

test('bad offsets, ranges and refs are rejected with 400', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  for (const bad of [
    { s: -1, e: 5 },
    { s: 5, e: 2 },
    { s: 1.5, e: 5 },
    { s: '0', e: 5 },
    { s: 0, e: NaN },
    { s: 0, e: Infinity },
  ])
    await assert.rejects(c.read({ f: file, k: 'raw', ...bad }), { status: 400 }, JSON.stringify(bad));
  await assert.rejects(c.read({ f: file, s: 0, e: 5, k: 'nope' }), { status: 400 });
  await assert.rejects(c.read({ f: 42, s: 0, e: 5, k: 'raw' }), { status: 400 });
  await assert.rejects(c.read(null), { status: 400 });
  await assert.rejects(c.read({ f: file, s: off[0][0], e: off[0][1], k: 'prompt' }, { offset: -1 }), { status: 400 });
  await assert.rejects(c.read({ f: file, s: off[0][0], e: off[0][1], k: 'prompt' }, { offset: 1.5 }), { status: 400 });
  await assert.rejects(c.read({ f: path.join(root, 'nope.jsonl'), s: 0, e: 1, k: 'raw' }), { status: 404 });
});

test('raw returns only the bytes of the range', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  const r = await c.read({ f: file, s: off[0][0], e: off[0][0] + 10, k: 'raw' });
  assert.equal(r.text, '{"type":"u');
  const full = await c.read({ f: file, s: off[0][0], e: off[0][1], k: 'raw' });
  assert.ok(full.text.endsWith('}') && !full.text.includes('\n'));
});

test('reply joins streamed blocks of one message id and skips other messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  const lines = [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'other' }] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'second' }, { type: 'tool_use', id: 't', name: 'X', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'anon' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt text' }] } },
  ].map((o) => JSON.stringify(o) + '\n');
  fs.writeFileSync(file, lines.join(''));
  const off = offsets(lines);
  const c = createContent({ roots: [root] });
  assert.equal((await c.read({ f: file, s: 0, e: off[4][1], k: 'reply', i: 'm1' })).text, 'first\nsecond');
  // id-less message: ref.i is null; take the assistant lines without an id, never a user line
  assert.equal((await c.read({ f: file, s: off[3][0], e: off[4][1], k: 'reply', i: null })).text, 'anon');
  assert.equal((await c.read({ f: file, s: off[4][0], e: off[4][0], k: 'prompt' })).text, 'prompt text');
});

test('tool input is pretty-printed JSON and array tool output is joined', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  const lines = [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } },
  ].map((o) => JSON.stringify(o) + '\n');
  fs.writeFileSync(file, lines.join(''));
  const off = offsets(lines);
  const c = createContent({ roots: [root] });
  assert.equal((await c.read({ f: file, s: off[0][0], e: off[0][1], k: 'tool_input', i: 't1' })).text, JSON.stringify({ command: 'ls' }, null, 2));
  assert.equal((await c.read({ f: file, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' })).text, 'a\nb');
});

test('a secret on a page boundary is never shown in part', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  const secret = makeSecret();
  const body = 'y'.repeat(65536 - 11) + ' ' + secret + ' tail'; // the key starts 10 characters before the page end
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: body } }) + '\n';
  fs.writeFileSync(file, line);
  const c = createContent({ roots: [root] });
  const ref = { f: file, s: 0, e: 0, k: 'prompt' };
  const p1 = await c.read(ref);
  assert.ok(!p1.text.includes(secret.slice(0, 12)), 'page 1 must not carry a fragment');
  const p2 = await c.read(ref, { offset: p1.next });
  assert.ok(!p2.text.includes(secret.slice(-12)), 'page 2 must not carry a fragment');
  assert.equal(p2.masked.length, 1);
  assert.equal((await c.reveal(ref, 0, { offset: p1.next })).value, secret);
  assert.equal(p1.text.length + p2.text.length - '‹Anthropic API key hidden›'.length + secret.length, body.length);
});

// --- Claude Code's "output saved to a file" marker ---

function sessionFixture(saved) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const proj = path.join(root, 'proj');
  const sid = '0a1b2c3d-1111-2222-3333-444455556666';
  const trDir = path.join(proj, sid, 'tool-results');
  fs.mkdirSync(trDir, { recursive: true });
  const transcript = path.join(proj, sid + '.jsonl');
  const marker = (p) =>
    `Error: result (94,299 characters across 1,017 lines) exceeds maximum allowed tokens. Output has been saved to ${p}.\nFormat: JSON array\nUse offset and limit to read it in parts.`;
  const lines = (p) =>
    [
      { type: 'assistant', sessionId: sid, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__x', input: {} }] } },
      { type: 'user', sessionId: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: marker(p) }] }, toolUseResult: marker(p) },
    ].map((o) => JSON.stringify(o) + '\n');
  return { root, proj, sid, trDir, transcript, lines, write: (p) => { const l = lines(p); fs.writeFileSync(transcript, l.join('')); return offsets(l); } };
}

test('a large tool output saved to the session tool-results folder is read from there, masked and paged', async () => {
  const f = sessionFixture();
  const secret = makeSecret();
  const saved = path.join(f.trDir, 'out.txt');
  fs.writeFileSync(saved, 'z'.repeat(70000) + ` ${secret}`);
  const off = f.write(saved);
  const c = createContent({ roots: [f.root] });
  const ref = { f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' };
  const p1 = await c.read(ref);
  assert.equal(p1.text.length, 65536);
  assert.ok(!p1.text.includes('exceeds maximum'));
  assert.equal(p1.truncated, true);
  const p2 = await c.read(ref, { offset: p1.next });
  assert.ok(!p2.text.includes(secret));
  assert.equal(p2.masked.length, 1);
  assert.equal((await c.reveal(ref, 0, { offset: p1.next })).value, secret);
});

test('a saved path outside the session tool-results folder is refused with 403', async () => {
  const f = sessionFixture();
  const out = outsideDir();
  const evil = path.join(out, 'secret.txt');
  fs.writeFileSync(evil, 'nope');
  const c = createContent({ roots: [f.root] });
  const bad = [
    evil,
    path.join(f.trDir, '..', '..', '..', path.basename(out), 'secret.txt'), // dot-dot out of the folder
    path.join(f.proj, 's2', 'tool-results', 'x.txt'), // another session's folder
    path.join(f.trDir, '..', 'sibling.txt'), // beside the folder, still inside the root
    path.join(f.root, 'zz-missing', 'nope.txt'), // missing files must not answer differently
  ];
  fs.writeFileSync(path.join(f.proj, f.sid, 'sibling.txt'), 'sibling');
  for (const p of bad) {
    const off = f.write(p);
    await unfollowed(c, { f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }, 403);
  }
});

test('a symlink inside tool-results that leads out is refused with 403', { skip: process.platform === 'win32' }, async () => {
  const f = sessionFixture();
  const out = outsideDir();
  const evil = path.join(out, 'secret.txt');
  fs.writeFileSync(evil, 'nope');
  const link = path.join(f.trDir, 'link.txt');
  fs.symlinkSync(evil, link);
  const off = f.write(link);
  const c = createContent({ roots: [f.root] });
  await unfollowed(c, { f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }, 403);
});

test('a relative saved path is refused, and a missing saved file is a 404', async () => {
  const f = sessionFixture();
  const c = createContent({ roots: [f.root] });
  let off = f.write('tool-results/out.txt');
  const rel = await c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' });
  // not a saved-output marker we trust: the marker sentence itself comes back as text
  assert.match(rel.text, /Output has been saved to tool-results/);
  off = f.write(path.join(f.trDir, 'gone.txt'));
  await unfollowed(c, { f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }, 404);
});

test('a saved output over 16 MB is refused with 413', async () => {
  const f = sessionFixture();
  const saved = path.join(f.trDir, 'big.txt');
  fs.writeFileSync(saved, '');
  fs.truncateSync(saved, 16 * 1024 * 1024 + 1);
  const off = f.write(saved);
  const c = createContent({ roots: [f.root] });
  await unfollowed(c, { f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }, 413, /saved output too large/);
});

test('the marker is only honoured for tool_output', async () => {
  const f = sessionFixture();
  const saved = path.join(f.trDir, 'out.txt');
  fs.writeFileSync(saved, 'file body');
  const off = f.write(saved);
  const c = createContent({ roots: [f.root] });
  const raw = await c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'raw' });
  assert.ok(!raw.text.includes('file body'));
});

// Newer wording: "<persisted-output>\nOutput too large (..). Full output saved to: <path>\n\nPreview ..." (no final period).
function markerB(p) {
  return `<persisted-output>\nOutput too large (34.6KB). Full output saved to: ${p}\n\nPreview (first 2KB):\n{"a":1}\n...\n</persisted-output>`;
}

function toolLines(text) {
  return [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] }, toolUseResult: text },
  ].map((o) => JSON.stringify(o) + '\n');
}

// <root>/proj/<sid>.jsonl (main) and <root>/proj/<sid>/subagents/agent-x.jsonl (subagent)
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const proj = path.join(root, 'proj');
  const sid = 'sess-main';
  fs.mkdirSync(path.join(proj, sid, 'tool-results'), { recursive: true });
  fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'sess-other', 'tool-results'), { recursive: true });
  const put = (file, text) => {
    const l = toolLines(text);
    fs.writeFileSync(file, l.join(''));
    const off = offsets(l);
    return { f: file, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' };
  };
  return {
    root,
    main: path.join(proj, sid + '.jsonl'),
    sub: path.join(proj, sid, 'subagents', 'agent-x.jsonl'),
    own: path.join(proj, sid, 'tool-results', 'own.txt'),
    other: path.join(proj, 'sess-other', 'tool-results', 'other.txt'),
    put,
  };
}

test('the newer "Full output saved to:" marker is followed from a main transcript', async () => {
  const L = layout();
  fs.writeFileSync(L.own, 'main body');
  const c = createContent({ roots: [L.root] });
  assert.equal((await c.read(L.put(L.main, markerB(L.own)))).text, 'main body');
  // CRLF line endings after the path do not become part of it
  assert.equal((await c.read(L.put(L.main, markerB(L.own).replace('\n', '\r\n')))).text, 'main body');
});

test('a subagent transcript reads saved outputs from the parent session tool-results (both wordings)', async () => {
  const L = layout();
  fs.writeFileSync(L.own, 'parent body');
  const c = createContent({ roots: [L.root] });
  assert.equal((await c.read(L.put(L.sub, markerB(L.own)))).text, 'parent body');
  const older = `Error: result (1 characters across 1 lines) exceeds maximum allowed tokens. Output has been saved to ${L.own}.\nUse offset.`;
  assert.equal((await c.read(L.put(L.sub, older))).text, 'parent body');
});

test('a subagent marker pointing at another session or its own subagents folder is refused with 403', async () => {
  const L = layout();
  fs.writeFileSync(L.other, 'other body');
  fs.writeFileSync(path.join(path.dirname(L.sub), 'agent-y.txt'), 'sub body');
  const c = createContent({ roots: [L.root] });
  await unfollowed(c, L.put(L.sub, markerB(L.other)), 403);
  await unfollowed(c, L.put(L.main, markerB(L.other)), 403);
  await unfollowed(c, L.put(L.sub, markerB(path.join(path.dirname(L.sub), 'agent-y.txt'))), 403);
  // the folder itself and the transcript folder above it are not files to serve either
  await unfollowed(c, L.put(L.sub, markerB(path.dirname(L.own))), 403);
});

// --- masking is computed on the whole field, never per page ---

function oneLine(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  return { root, ref: { f: file, s: 0, e: 0, k: 'prompt' }, c: createContent({ roots: [root] }) };
}

async function readAll(c, ref) {
  const pages = [];
  for (let off = 0, p; off !== null; off = p.next) {
    p = await c.read(ref, { offset: off });
    pages.push(p);
  }
  return pages;
}

test('a database password that straddles a page end is masked on both sides of the cut', async () => {
  const pw = 'Tr0ub4dor3xQz';
  for (const cut of [4, 8, 12]) {
    // the page end falls `cut` characters into the password
    const prefix = ' postgres://app:';
    const pad = 'y'.repeat(PAGE_LEN - prefix.length - cut);
    const { ref, c } = oneLine(pad + prefix + pw + '@db.local/app tail');
    const pages = await readAll(c, ref);
    const joined = pages.map((p) => p.text).join('');
    assert.ok(!joined.includes(pw.slice(0, 6)) && !joined.includes(pw.slice(-6)), `cut ${cut}: ${joined.slice(-60)}`);
    assert.equal(pages.reduce((n, p) => n + p.masked.length, 0), 1, `cut ${cut}`);
    assert.ok(joined.includes('@db.local/app tail'), 'the host stays readable');
  }
});
const PAGE_LEN = 65536;

test('an arbitrary offset inside a secret still masks the part that is visible', async () => {
  const secret = makeSecret();
  const { ref, c } = oneLine(`before ${secret} after`);
  const at = 'before '.length;
  for (const skip of [1, 5, 20, secret.length - 3]) {
    const r = await c.read(ref, { offset: at + skip });
    assert.ok(!r.text.includes(secret.slice(skip, skip + 6)), `skip ${skip}: ${r.text}`);
    assert.equal(r.masked.length, 1);
    assert.equal((await c.reveal(ref, 0, { offset: at + skip })).value, secret);
  }
  // a short page that would end inside the secret stops before it; one that starts at it masks its part
  const before = await c.read(ref, { offset: 0, max: at + 10 });
  assert.equal(before.text, 'before ');
  assert.equal(before.next, at);
  const r = await c.read(ref, { offset: at, max: 10 });
  assert.ok(!r.text.includes('sk-ant'), r.text);
  assert.equal(r.masked.length, 1);
});

test('masked[i] and reveal(i) refer to the same secrets, in order', async () => {
  const a = makeSecret();
  const b = 'postgres://app:' + 'Tr0ub4dor3x' + '@db.local/app';
  const { ref, c } = oneLine(`one ${a} two ${b} three`);
  const r = await c.read(ref);
  assert.deepEqual(r.masked.map((m) => m.label), ['Anthropic API key', 'Database URL with password']);
  assert.equal((await c.reveal(ref, 0)).value, a);
  assert.equal((await c.reveal(ref, 1)).value, 'Tr0ub4dor3x');
  assert.ok(r.text.includes('postgres://app:'));
});

test('an offset past the end of the text is a 400, the end itself is an empty page', async () => {
  const { ref, c } = oneLine('hello');
  await assert.rejects(c.read(ref, { offset: 6 }), { status: 400 });
  const r = await c.read(ref, { offset: 5 });
  assert.equal(r.text, '');
  assert.equal(r.next, null);
});

// --- markers: anchored, linear, and never hiding the content ---

test('a marker quoted inside a normal tool output does not redirect it', async () => {
  const f = sessionFixture();
  const saved = path.join(f.trDir, 'out.txt');
  fs.writeFileSync(saved, 'file body');
  const text = `ls shows: Error: result (1 characters across 1 lines) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nand also Full output saved to: ${saved}\n`;
  const l = toolLines(text);
  fs.writeFileSync(f.transcript, l.join(''));
  const off = offsets(l);
  const c = createContent({ roots: [f.root] });
  const r = await c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' });
  assert.equal(r.text, text);
  assert.equal(r.saved, undefined);
});

test('a megabyte of repeated marker text does not stall the reader', async () => {
  const f = sessionFixture();
  const text = 'Output has been saved to '.repeat(Math.ceil((1024 * 1024) / 25));
  const l = toolLines(text);
  fs.writeFileSync(f.transcript, l.join(''));
  const off = offsets(l);
  const c = createContent({ roots: [f.root] });
  const t0 = Date.now();
  const r = await c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(r.total, text.length);
  // the same text behind a real header is still bounded
  const longHeader = 'Error: result (' + 'x'.repeat(2000) + ') exceeds maximum allowed tokens. Output has been saved to /nope.';
  const l2 = toolLines(longHeader);
  fs.writeFileSync(f.transcript, l2.join(''));
  const o2 = offsets(l2);
  assert.equal((await c.read({ f: f.transcript, s: o2[1][0], e: o2[1][1], k: 'tool_output', i: 't1' })).text, longHeader);
});

test('a tool-results folder that is itself a link to another session is refused', { skip: process.platform === 'win32' }, async () => {
  const L = layout();
  fs.writeFileSync(L.other, 'other body');
  const real = path.join(path.dirname(L.main), 'sess-main', 'tool-results');
  fs.rmSync(real, { recursive: true });
  fs.symlinkSync(path.join(path.dirname(L.main), 'sess-other', 'tool-results'), real);
  const c = createContent({ roots: [L.root] });
  await unfollowed(c, L.put(L.main, markerB(path.join(real, 'other.txt'))), 403);
});

// --- size caps, lazy roots ---

test('every kind refuses a range or line over 16 MB with 413', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 'big.jsonl');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, 17 * 1024 * 1024); // sparse, one 17 MB line with no newline
  const c = createContent({ roots: [root] });
  for (const k of ['raw', 'reply', 'tool_input', 'tool_output'])
    await assert.rejects(c.read({ f: file, s: 0, e: 17 * 1024 * 1024, k, i: 'x' }), { status: 413 }, k);
  await assert.rejects(c.read({ f: file, s: 0, e: 0, k: 'prompt' }), { status: 413 });
});

test('a root that is created after the reader was made is honoured', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const later = path.join(base, 'sessions');
  const c = createContent({ roots: [later] });
  fs.mkdirSync(later);
  const file = path.join(later, 'a.jsonl');
  fs.writeFileSync(file, '{"x":1}\n');
  assert.equal((await c.read({ f: file, s: 0, e: 7, k: 'raw' })).text, '{"x":1}');
});

// --- Codex lines (refs carry src: 'codex') ---

function codexLog(objs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const file = path.join(root, 'rollout.jsonl');
  const lines = objs.map((o) => JSON.stringify(o) + '\n');
  fs.writeFileSync(file, lines.join(''));
  const off = offsets(lines);
  const all = { f: file, s: 0, e: off[off.length - 1][1], src: 'codex' };
  return { root, file, off, all, c: createContent({ roots: [root] }) };
}
const resp = (payload) => ({ timestamp: '2026-10-20T10:00:00.000Z', type: 'response_item', payload });
const evt = (payload) => ({ timestamp: '2026-10-20T10:00:00.000Z', type: 'event_msg', payload });
const msg = (role, text) => resp({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });

test('codex prompt (older form): a user_message event is the prompt', async () => {
  const { all, c } = codexLog([evt({ type: 'task_started' }), evt({ type: 'user_message', message: 'add <b>pagination</b>' }), msg('user', 'not this one')]);
  assert.equal((await c.read({ ...all, k: 'prompt' })).text, 'add <b>pagination</b>');
});

test('codex prompt (newer form): only typed user messages, never injected context', async () => {
  const injected = ['<environment_context>\n</environment_context>', '<task-notification>x</task-notification>', '[Request interrupted by user]', '[external unsupported block]', '## Referenced files\nsrc/a.js', '  <recommended_plugins>x'];
  const { all, c } = codexLog([
    evt({ type: 'task_started' }),
    msg('developer', 'system rules'),
    ...injected.map((t) => msg('user', t)),
    msg('user', 'first typed'),
    msg('assistant', 'reply text'),
    msg('user', 'second typed'),
  ]);
  const r = await c.read({ ...all, k: 'prompt' });
  assert.equal(r.text, 'first typed\n\nsecond typed');
});

test('codex prompt: several input_text parts are joined, and a message with none of its own text is skipped', async () => {
  const { all, c } = codexLog([resp({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'part one' }, { type: 'input_image', image_url: 'x' }, { type: 'input_text', text: 'part two' }] }), resp({ type: 'message', role: 'user', content: [] })]);
  assert.equal((await c.read({ ...all, k: 'prompt' })).text, 'part one\npart two');
});

test('codex prompt: with only injected messages, the last user message is used', async () => {
  const { all, c } = codexLog([msg('user', '<environment_context>a</environment_context>'), msg('user', '<command-name>/clear</command-name>')]);
  assert.equal((await c.read({ ...all, k: 'prompt' })).text, '<command-name>/clear</command-name>');
});

test('codex prompt: a turn with no user message reads as empty text', async () => {
  const { all, c } = codexLog([evt({ type: 'task_started' }), msg('assistant', 'hi')]);
  assert.equal((await c.read({ ...all, k: 'prompt' })).text, '');
});

test('codex reply (older form): agent_message', async () => {
  const { all, c } = codexLog([evt({ type: 'agent_message', message: 'done, see <i>this</i>' })]);
  assert.equal((await c.read({ ...all, k: 'reply' })).text, 'done, see <i>this</i>');
});

test('codex reply (newer form): assistant output_text only, not user or developer messages', async () => {
  const { all, c } = codexLog([msg('user', 'q'), msg('developer', 'rules'), msg('assistant', 'first'), msg('assistant', 'second')]);
  assert.equal((await c.read({ ...all, k: 'reply' })).text, 'first\n\nsecond');
});

test('codex reply: the same reply logged in both forms is counted once', async () => {
  const { all, c } = codexLog([evt({ type: 'agent_message', message: 'same reply' }), msg('assistant', 'same reply'), msg('assistant', 'another'), evt({ type: 'agent_message', message: 'another' })]);
  assert.equal((await c.read({ ...all, k: 'reply' })).text, 'same reply\n\nanother');
});

test('codex reply is masked for secrets like any other field', async () => {
  const secret = makeSecret();
  const { all, c } = codexLog([msg('assistant', `key ${secret} done`)]);
  const r = await c.read({ ...all, k: 'reply' });
  assert.ok(!r.text.includes(secret));
  assert.equal(r.masked.length, 1);
  assert.equal((await c.reveal({ ...all, k: 'reply' }, 0)).value, secret);
});

test('codex tool input: the call arguments (function_call) or input (custom_tool_call), by call id', async () => {
  const args = '{"command":["bash","-lc","ls"]}';
  const { all, c } = codexLog([
    resp({ type: 'function_call', name: 'shell', call_id: 'k1', arguments: args }),
    resp({ type: 'function_call', name: 'shell', call_id: 'k2', arguments: '{"cmd":"pwd"}' }),
    resp({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'k3', input: '*** Begin Patch' }),
    resp({ type: 'web_search_call', action: { type: 'search', query: 'q' } }),
  ]);
  assert.equal((await c.read({ ...all, k: 'tool_input', i: 'k1' })).text, args);
  assert.equal((await c.read({ ...all, k: 'tool_input', i: 'k2' })).text, '{"cmd":"pwd"}');
  assert.equal((await c.read({ ...all, k: 'tool_input', i: 'k3' })).text, '*** Begin Patch');
  assert.deepEqual(JSON.parse((await c.read({ ...all, k: 'tool_input', i: null })).text), { type: 'search', query: 'q' });
  assert.equal((await c.read({ ...all, k: 'tool_input', i: 'nope' })).text, '');
});

test('codex tool output: a string, parts or an object, by call id', async () => {
  const { all, c } = codexLog([
    resp({ type: 'function_call_output', call_id: 'k1', output: 'src\n' }),
    resp({ type: 'function_call_output', call_id: 'k2', output: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }),
    resp({ type: 'custom_tool_call_output', call_id: 'k3', output: { content: 'x', success: true } }),
  ]);
  assert.equal((await c.read({ ...all, k: 'tool_output', i: 'k1' })).text, 'src\n');
  assert.equal((await c.read({ ...all, k: 'tool_output', i: 'k2' })).text, 'a\nb');
  assert.deepEqual(JSON.parse((await c.read({ ...all, k: 'tool_output', i: 'k3' })).text), { content: 'x', success: true });
});

test('codex tool output is paged and a saved-output marker is not followed (that is Claude only)', async () => {
  const marker = 'Error: result (1 B) exceeds maximum allowed tokens. Output has been saved to /etc/hosts.';
  const { all, c } = codexLog([resp({ type: 'function_call_output', call_id: 'k1', output: marker }), resp({ type: 'function_call_output', call_id: 'k2', output: 'y'.repeat(70000) })]);
  const r = await c.read({ ...all, k: 'tool_output', i: 'k1' });
  assert.equal(r.text, marker);
  assert.equal(r.saved, undefined);
  const big = await c.read({ ...all, k: 'tool_output', i: 'k2' });
  assert.equal(big.text.length, 64 * 1024);
  assert.equal(big.total, 70000);
});

test('codex refs keep every check: roots, byte range, kinds, 16 MB', async () => {
  const { all, file, c } = codexLog([msg('assistant', 'x')]);
  await assert.rejects(c.read({ ...all, e: all.e + 1, k: 'reply' }), { status: 400 });
  await assert.rejects(c.read({ ...all, k: 'nope' }), { status: 400 });
  await assert.rejects(createContent({ roots: [outsideDir()] }).read({ ...all, f: file, k: 'reply' }), { status: 403 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-content-'));
  const big = path.join(root, 'big.jsonl');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 17 * 1024 * 1024);
  const cb = createContent({ roots: [root] });
  for (const k of ['prompt', 'reply', 'tool_input', 'tool_output'])
    await assert.rejects(cb.read({ f: big, s: 0, e: 17 * 1024 * 1024, k, i: 'x', src: 'codex' }), { status: 413 }, k);
  await assert.rejects(cb.read({ f: big, s: 0, e: 1024, k: 'prompt', src: 'codex' }), { status: 413 }, 'one 17 MB line');
});

test('a ref without src is still read as a Claude line', async () => {
  const { root, file, off } = fixture();
  const c = createContent({ roots: [root] });
  assert.equal((await c.read({ f: file, s: off[0][0], e: off[0][1], k: 'prompt' })).text, 'hello <script>alert(1)</script>');
  // A Codex-shaped line is not understood without src.
  const cx = codexLog([evt({ type: 'agent_message', message: 'hi' })]);
  assert.equal((await cx.c.read({ f: cx.file, s: cx.all.s, e: cx.all.e, k: 'reply' })).text, '');
});
