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
    await assert.rejects(c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }), { status: 403 }, p);
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
  await assert.rejects(c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }), { status: 403 });
});

test('a relative saved path is refused, and a missing saved file is a 404', async () => {
  const f = sessionFixture();
  const c = createContent({ roots: [f.root] });
  let off = f.write('tool-results/out.txt');
  const rel = await c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' });
  // not a saved-output marker we trust: the marker sentence itself comes back as text
  assert.match(rel.text, /Output has been saved to tool-results/);
  off = f.write(path.join(f.trDir, 'gone.txt'));
  await assert.rejects(c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }), { status: 404 });
});

test('a saved output over 16 MB is refused with 413', async () => {
  const f = sessionFixture();
  const saved = path.join(f.trDir, 'big.txt');
  fs.writeFileSync(saved, '');
  fs.truncateSync(saved, 16 * 1024 * 1024 + 1);
  const off = f.write(saved);
  const c = createContent({ roots: [f.root] });
  await assert.rejects(c.read({ f: f.transcript, s: off[1][0], e: off[1][1], k: 'tool_output', i: 't1' }), { status: 413, message: /saved output too large/ });
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
