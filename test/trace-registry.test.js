const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const claudeParser = require('../lib/claude');
const codexParser = require('../lib/codex');
const { createTrace, contentDefaultOff } = require('../lib/trace');

const FIX = path.join(__dirname, 'fixtures', 'trace');
const dir = path.join(FIX, 'claude', 'proj');
const entryOf = async (file, source, parser) => ({ file, source, size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs, result: await parser.parseFile(file) });
async function fakeIndexer(extra = []) {
  const files = [path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')];
  const entries = [];
  for (const file of files) entries.push(await entryOf(file, 'claude', claudeParser));
  entries.push(...extra);
  return { entries: () => entries };
}
const codexEntry = () => entryOf(path.join(FIX, 'codex', 'rollout-c1.jsonl'), 'codex', codexParser);
const gw = { runs: () => [], run: () => null, requests: () => [] };
const make = async (o = {}) => createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [FIX], listTtlMs: 0, ...o });

// A secret built at run time, never written out whole (push protection).
const secret = () => 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');

// A throwaway Claude log under a fresh root, for the cases the shared fixtures do not cover.
function tmpClaude(lines, name = 's9') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-reg-'));
  const proj = path.join(root, 'proj');
  fs.mkdirSync(proj);
  const file = path.join(proj, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((o) => JSON.stringify(o) + '\n').join(''));
  return { root, file };
}
const U = (sid, ts, content) => ({ type: 'user', sessionId: sid, uuid: `u${ts}`, timestamp: `2026-10-20T10:00:${ts}.000Z`, cwd: '/w/p', message: { role: 'user', content } });
const A = (sid, ts, id, content) => ({ type: 'assistant', sessionId: sid, uuid: `a${ts}`, timestamp: `2026-10-20T10:00:${ts}.000Z`, requestId: `r${ts}`, message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content } });
const tmpEntry = async (file) => entryOf(file, 'claude', claudeParser);

// Every string in a value, for the "no path reaches the client" checks.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

// A light-source stand-in with a few rows and a skeleton that can be slow.
function fakeLight(id, n, { skeleton, ok = true, reason = null, throws = false } = {}) {
  const now = Date.now();
  return {
    id,
    available: () => ({ ok, reason }),
    sessions() {
      if (throws) throw new Error('listing failed');
      return Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, source: id, title: `${id} session ${i}`, project: 'proj', branch: null, start: now - (i + 2) * 1000, end: now - i * 1000, turns: 1, tools: 0, errors: i % 2, cost: null, flags: { errors: i % 2 === 1, loop: false, injection: false } }));
    },
    skeleton: skeleton || (async (_e, sid) => ({ session: { id: sid, source: id, project: 'proj', branch: null, start: 1, end: 2 }, turns: [{ index: 0, start: 0, ts: 1 }], spans: [{ id: 'a', parent: null, kind: 'session', text: null }] })),
  };
}

test('sessions get opaque keys; a forged key is refused', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')] });
  const [row] = t.sessions({});
  assert.ok(row.key && !row.key.includes('/'));
  await assert.rejects(t.session(Buffer.from('claude:s1').toString('base64url')), /unknown session/);
});

test('skeleton text refs are opaque content ids, and content reads back', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')] });
  const [row] = t.sessions({});
  const sk = await t.session(row.key, { turn: 0 });
  const turn = sk.spans.find((s) => s.kind === 'turn');
  assert.equal(typeof turn.text, 'string');
  assert.ok(!JSON.stringify(sk).includes(dir), 'no file paths reach the client');
  const c = await t.content(turn.text, {});
  assert.equal(c.text, 'fix the login redirect');
  assert.equal(await t.title(row.key), 'fix the login redirect');
});

test('content can be switched off', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), gateway: gw, light: [], roots: [path.join(__dirname, 'fixtures', 'trace')], contentOff: true });
  const [row] = t.sessions({});
  const sk = await t.session(row.key, { turn: 0 });
  await assert.rejects(t.content(sk.spans[1].text, {}), /content viewing is off/);
});

test('a failing adapter is isolated', async () => {
  const t = createTrace({
    indexer: {
      entries: () => {
        throw new Error('boom');
      },
    },
    gateway: gw,
    light: [],
    roots: [],
  });
  const src = t.sources();
  assert.equal(src.find((s) => s.id === 'claude').ok, false);
  assert.ok(Array.isArray(t.sessions({})));
});

test('demo mode serves synthetic sessions without files', async () => {
  const t = createTrace({ demo: true });
  const rows = t.sessions({});
  assert.ok(rows.length >= 3);
  const sk = await t.session(rows[0].key, {});
  assert.ok(sk.spans.length > 3);
});

test('keyFor finds the key of a listed session by source and id, and refuses the rest', async () => {
  const t = createTrace({ demo: true, listTtlMs: 0 });
  const rows = t.sessions({});
  const claude = rows.find((r) => r.source === 'claude');
  assert.equal(t.keyFor('claude', 'demo-claude-1'), claude.key);
  assert.equal(t.keyFor('codex', 'demo-codex-1'), rows.find((r) => r.source === 'codex').key);
  assert.ok((await t.session(t.keyFor('claude', 'demo-claude-1'), {})).spans.length > 3);
  // A listed id under another source, an unknown id and a path are all just unknown.
  for (const [src, sid] of [['codex', 'demo-claude-1'], ['claude', 'nope'], ['claude', '../../etc/passwd']])
    assert.throws(() => t.keyFor(src, sid), (e) => e.status === 404 && /unknown session/.test(e.message), `${src} ${sid}`);
  for (const [src, sid] of [['', 'demo-claude-1'], ['claude', ''], [undefined, undefined], ['claude', 42]])
    assert.throws(() => t.keyFor(src, sid), (e) => e.status === 400, `${src} ${sid}`);
});

test('demo: links from the demo Sessions and AI Office pages open the synthetic trace of their tool', async () => {
  const { buildResults } = require('../lib/demo');
  const t = createTrace({ demo: true, listTtlMs: 0 });
  const rows = t.sessions({});
  const keyOf = (src) => rows.find((r) => r.source === src).key;
  // The ids the demo Sessions page links with.
  const ids = buildResults().flatMap((r) => Object.keys(r.sessions));
  const claudeId = ids.find((id) => id.startsWith('claude-'));
  const codexId = ids.find((id) => id.startsWith('codex-'));
  assert.ok(claudeId && codexId);
  assert.equal(t.keyFor('claude', claudeId), keyOf('claude'));
  assert.equal(t.keyFor('codex', codexId), keyOf('codex'));
  assert.equal(t.keyFor('claude', 'demo-2'), keyOf('claude'), 'an AI Office agent');
  // Still only those shapes, and only under their own source.
  for (const [src, sid] of [['codex', claudeId], ['kiro', 'demo-1'], ['claude', 'claude-1-2'], ['claude', '../claude-1-2-x']])
    assert.throws(() => t.keyFor(src, sid), (e) => e.status === 404, `${src} ${sid}`);
  // Outside demo mode nothing is mapped.
  const real = await make();
  assert.throws(() => real.keyFor('claude', claudeId), (e) => e.status === 404);
});

test('keyFor sees a file-backed session the listing just picked up', async () => {
  const t = await make();
  assert.equal(t.keyFor('claude', 's1'), t.sessions({}).find((r) => r.source === 'claude').key);
});

// ---- rows and keys ----

test('client rows carry only the allowed fields and no path or size', async () => {
  const t = await make({ indexer: await fakeIndexer([await codexEntry()]) });
  const rows = t.sessions({});
  assert.deepEqual(rows.map((r) => r.source).sort(), ['claude', 'codex']);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['branch', 'cost', 'end', 'errors', 'flags', 'key', 'project', 'source', 'start', 'title', 'tools', 'turns']);
    assert.ok(!('file' in r) && !('size' in r) && !('id' in r));
  }
  // The project is a folder name, not the cwd the log recorded.
  assert.equal(rows.find((r) => r.source === 'claude').project, 'p');
  assert.equal(rows.find((r) => r.source === 'codex').project, 'q');
  for (const s of strings(rows)) assert.ok(!/[\\/]/.test(s), `path-like value in a row: ${s}`);
  assert.ok(!JSON.stringify(rows).includes(FIX));
});

test('a key with a forged or foreign tag is refused, a missing key is a 400', async () => {
  const t = await make();
  const [row] = t.sessions({});
  const [body, tag] = row.key.split('.');
  const flip = tag[0] === 'a' ? 'b' : 'a';
  for (const bad of [`${body}.${flip}${tag.slice(1)}`, `${body}.`, body, `${body}.${tag}${tag}`, `${Buffer.from('claude:other').toString('base64url')}.${tag}`, '.', '\u0000', 'x'.repeat(5000)]) {
    await assert.rejects(t.session(bad), (e) => e.status === 404 && /unknown session/.test(e.message), bad.slice(0, 20));
  }
  await assert.rejects(t.session(undefined), (e) => e.status === 400);
  await assert.rejects(t.session({}), (e) => e.status === 400);
  await assert.rejects(t.live(undefined, 0), (e) => e.status === 400);
  await assert.rejects(t.title(undefined), (e) => e.status === 400);
  await assert.rejects(t.title('nope.nope'), (e) => e.status === 404);
  // The secret is per process, so a key stays valid across registries built on the same data.
  assert.ok(await (await make()).session(row.key));
});

test('a bad turn is a 400', async () => {
  const t = await make();
  const [row] = t.sessions({});
  for (const turn of [-1, 1.5, 'x']) await assert.rejects(t.session(row.key, { turn }), (e) => e.status === 400);
});

test('the skeleton carries no path: project is a folder name and every ref is an id', async () => {
  const t = await make({ indexer: await fakeIndexer([await codexEntry()]) });
  for (const row of t.sessions({})) {
    const sk = await t.session(row.key, { turn: 0 });
    for (const s of strings(sk)) assert.ok(!/[\\/]/.test(s), `path-like value in a skeleton: ${s}`);
    assert.equal(sk.session.project, row.source === 'claude' ? 'p' : 'q');
    for (const sp of sk.spans) for (const f of ['text', 'result']) if (sp[f] != null) assert.match(sp[f], /^ci_[0-9a-f]{16}$/);
  }
});

test('result refs of tool and agent spans are content ids too', async () => {
  const t = await make();
  const [row] = t.sessions({});
  const sk = await t.session(row.key, { turn: 0 });
  const agent = sk.spans.find((s) => s.kind === 'agent');
  assert.match(agent.result, /^ci_/);
  assert.equal((await t.content(agent.result, {})).text, 'found src/auth.js');
});

test('codex sessions work end to end: title, skeleton and content', async () => {
  const t = await make({ indexer: await fakeIndexer([await codexEntry()]) });
  const row = t.sessions({ source: 'codex' })[0];
  assert.equal(await t.title(row.key), 'add pagination');
  const sk = await t.session(row.key, { turn: 0 });
  const tool = sk.spans.find((s) => s.kind === 'tool');
  assert.equal((await t.content(tool.result, {})).text.trim(), 'src');
  assert.equal((await t.content(sk.spans.find((s) => s.kind === 'turn').text, {})).text, 'add pagination');
});

// ---- titles ----

test('a title is one line, masked and at most 80 characters, and it is cached by key and mtime', async () => {
  const k = secret();
  const long = `first line with ${k}\n\nthen  more   words ` + 'x'.repeat(200);
  const { root, file } = tmpClaude([U('s9', '00', long), A('s9', '01', 'm1', [{ type: 'text', text: 'ok' }])]);
  const e = await tmpEntry(file);
  const t2 = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const [row] = t2.sessions({});
  assert.equal(row.title, null, 'unknown until asked');
  const title = await t2.title(row.key);
  assert.ok(title.length <= 80);
  assert.ok(!title.includes(k) && !/\n/.test(title));
  assert.match(title, /^first line with ‹Anthropic API key hidden›/);
  assert.equal(t2.sessions({})[0].title, title, 'known titles show in the rows');
  // Rewriting the log changes mtime: the stale title is not served.
  fs.writeFileSync(file, JSON.stringify(U('s9', '00', 'a new prompt')) + '\n');
  const e2 = { ...(await tmpEntry(file)), mtimeMs: e.mtimeMs + 5000 };
  const t3 = createTrace({ indexer: { entries: () => [e2] }, light: [], roots: [root], listTtlMs: 0 });
  assert.equal(await t3.title(t3.sessions({})[0].key), 'a new prompt');
});

test('a title read that fails is null, not an error', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'hello')]);
  const e = await tmpEntry(file);
  fs.unlinkSync(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  assert.equal(await t.title(t.sessions({})[0].key), null);
});

test('light and gateway titles come from the row', async () => {
  const g = { runs: () => [{ id: 'r1', pattern: 'debate', state: 'done', steps: [], createdAt: Date.now() - 1000, updatedAt: Date.now() }], run: () => null, requests: () => [] };
  const t = createTrace({ indexer: { entries: () => [] }, gateway: g, light: [fakeLight('kiro', 2)], roots: [] });
  const k = t.sessions({ source: 'kiro' })[0];
  assert.equal(k.title, 'kiro session 0');
  assert.equal(await t.title(k.key), 'kiro session 0');
  const r = t.sessions({ source: 'gateway' })[0];
  assert.equal(await t.title(r.key), 'debate run · done · 0 steps');
});

test('with content off, no transcript or user title is shown for any source; the gateway keeps its own', async () => {
  const g = { runs: () => [{ id: 'r1', pattern: 'debate', state: 'done', steps: [], createdAt: Date.now() - 1000, updatedAt: Date.now() }], run: () => null, requests: () => [] };
  const build = async (contentOff) =>
    createTrace({
      indexer: await fakeIndexer([await codexEntry()]),
      gateway: g,
      light: [fakeLight('kiro', 1), fakeLight('gemini', 1), fakeLight('antigravity', 1)],
      roots: [FIX],
      contentOff,
      listTtlMs: 0,
    });
  const on = await build(false);
  const off = await build(true);
  for (const id of ['claude', 'codex', 'kiro', 'gemini', 'antigravity']) {
    assert.ok(await on.title(on.sessions({ source: id })[0].key), `${id} has a title when content is on`);
    const row = off.sessions({ source: id })[0];
    assert.equal(row.title, null, `${id} row`);
    assert.equal(await off.title(row.key), null, `${id} title()`);
  }
  assert.equal(off.sessions({ q: 'session 0' }).length, 0, 'q cannot reach a hidden title');
  const gwRow = off.sessions({ source: 'gateway' })[0];
  assert.equal(gwRow.title, 'debate run · done · 0 steps');
  assert.equal(await off.title(gwRow.key), 'debate run · done · 0 steps');
  // Demo titles are text too.
  assert.ok(createTrace({ demo: true, contentOff: true }).sessions({}).every((r) => r.title === null));
});

// ---- sessions() filters ----

test('sessions: range, source, q, errors flag, newest first, cap of 500', async () => {
  const now = Date.now();
  const day = 86400e3;
  const light = {
    id: 'kiro',
    available: () => ({ ok: true, reason: null }),
    sessions: () => [
      { id: 'old', source: 'kiro', title: 'Alpha job', project: 'billing', branch: 'main', start: now - 10 * day, end: now - 9 * day, turns: 1, tools: 0, errors: 0, cost: null, flags: { errors: false, loop: false, injection: false } },
      { id: 'mid', source: 'kiro', title: 'Beta job', project: 'tokoku-api', branch: 'feat-x', start: now - 3 * day, end: now - 2 * day, turns: 1, tools: 0, errors: 2, cost: null, flags: { errors: true, loop: false, injection: false } },
      { id: 'new', source: 'kiro', title: 'Gamma job', project: 'web', branch: 'dev', start: now - day, end: now - 1000, turns: 1, tools: 0, errors: 0, cost: null, flags: { errors: false, loop: false, injection: false } },
    ],
    skeleton: async () => ({}),
  };
  const t = createTrace({ indexer: { entries: () => [] }, light: [light], roots: [] });
  const titles = (o) => t.sessions(o).map((r) => r.title);
  assert.deepEqual(titles({}), ['Gamma job', 'Beta job', 'Alpha job']);
  assert.deepEqual(titles({ range: 5 }), ['Gamma job', 'Beta job']);
  assert.deepEqual(titles({ range: 1 }), ['Gamma job']);
  assert.deepEqual(titles({ source: 'kiro' }).length, 3);
  assert.deepEqual(titles({ source: 'codex' }), []);
  assert.deepEqual(titles({ q: 'BETA' }), ['Beta job']);
  assert.deepEqual(titles({ q: 'tokoku' }), ['Beta job']);
  assert.deepEqual(titles({ q: 'feat-x' }), ['Beta job']);
  assert.deepEqual(titles({ q: 'nothing' }), []);
  assert.deepEqual(titles({ flags: 'errors' }), ['Beta job']);
  assert.equal(createTrace({ indexer: { entries: () => [] }, light: [fakeLight('kiro', 700)], roots: [] }).sessions({}).length, 500);
});

test('q does not read content: an unknown claude title does not match', async () => {
  const t = await make();
  assert.equal(t.sessions({ q: 'login redirect' }).length, 0);
  await t.title(t.sessions({})[0].key);
  assert.equal(t.sessions({ q: 'login redirect' }).length, 1);
});

// ---- sources and isolation ----

test('sources lists every configured source with ok, reason and count', async () => {
  const t = await make({ light: [fakeLight('kiro', 2), fakeLight('gemini', 0, { ok: false, reason: 'not installed' }), fakeLight('antigravity', 1, { throws: true })] });
  const src = Object.fromEntries(t.sources().map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(src), ['claude', 'codex', 'gateway', 'kiro', 'gemini', 'antigravity']);
  assert.deepEqual(src.claude, { id: 'claude', ok: true, reason: null, count: 1 });
  assert.equal(src.codex.count, 0);
  assert.equal(src.gateway.ok, true);
  assert.deepEqual(src.kiro, { id: 'kiro', ok: true, reason: null, count: 2 });
  assert.deepEqual(src.gemini, { id: 'gemini', ok: false, reason: 'not installed', count: 0 });
  assert.equal(src.antigravity.ok, false);
  assert.match(src.antigravity.reason, /listing failed/);
  // The sources that work still list their sessions.
  assert.equal(t.sessions({}).filter((r) => r.source === 'antigravity').length, 0);
  assert.equal(t.sessions({}).filter((r) => r.source === 'kiro').length, 2);
});

test('a reason never carries a file path', async () => {
  const bad = { ...fakeLight('kiro', 1), sessions: () => { throw new Error("ENOENT: no such file or directory, open '/Users/someone/.kiro/sessions/x.json'"); } };
  const t = createTrace({ indexer: { entries: () => [] }, light: [bad], roots: [] });
  const r = t.sources().find((s) => s.id === 'kiro').reason;
  assert.ok(!r.includes('/Users') && !r.includes('someone'), r);
});

test('a throwing gateway and a throwing claude are separate failures', async () => {
  const g = { runs: () => { throw new Error('gw down'); }, run: () => null, requests: () => [] };
  const t = createTrace({ indexer: await fakeIndexer(), gateway: g, light: [], roots: [FIX] });
  const src = Object.fromEntries(t.sources().map((s) => [s.id, s]));
  assert.equal(src.gateway.ok, false);
  assert.equal(src.claude.ok, true);
  assert.equal(t.sessions({}).length, 1);
});

test('all six sources are always listed; the ones not set up say so', async () => {
  const t = createTrace({ indexer: await fakeIndexer(), light: [], roots: [FIX] });
  const src = t.sources();
  assert.deepEqual(src.map((s) => s.id), ['claude', 'codex', 'gateway', 'kiro', 'gemini', 'antigravity']);
  for (const id of ['gateway', 'kiro', 'gemini', 'antigravity']) {
    assert.deepEqual(src.find((s) => s.id === id), { id, ok: false, reason: 'not configured', count: 0 });
  }
  assert.equal(src[0].ok, true);
  // No indexer: claude and codex are not configured either.
  assert.ok(createTrace({ light: [] }).sources().every((s) => s.reason === 'not configured'));
});

test('a failing skeleton in one source does not break another', async () => {
  const bad = fakeLight('kiro', 1, { skeleton: async () => { throw Object.assign(new Error('kiro broke'), { status: 500 }); } });
  const t = await make({ light: [bad] });
  const k = t.sessions({ source: 'kiro' })[0];
  await assert.rejects(t.session(k.key), /kiro broke/);
  const c = t.sessions({ source: 'claude' })[0];
  assert.ok((await t.session(c.key, { turn: 0 })).spans.length);
});

// ---- content ----

test('content and reveal: masked text pages back and reveal returns the value', async () => {
  const k = secret();
  const { root, file } = tmpClaude([
    U('s9', '00', 'run it'),
    A('s9', '01', 'm1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat .env' } }]),
    U('s9', '02', [{ type: 'tool_result', tool_use_id: 'tu1', content: `KEY=${k}\nrest` }]),
  ]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
  const tool = sk.spans.find((s) => s.kind === 'tool');
  const c = await t.content(tool.result, {});
  assert.ok(!c.text.includes(k));
  assert.equal(c.masked.length, 1);
  assert.deepEqual(await t.reveal(tool.result, 0, {}), { value: k });
  await assert.rejects(t.reveal(tool.result, 5, {}), (er) => er.status === 404);
  await assert.rejects(t.reveal(tool.result, undefined, {}), (er) => er.status === 400);
});

test('an unknown content id is a 404, a missing one a 400', async () => {
  const t = await make();
  await assert.rejects(t.content('ci_0123456789abcdef', {}), (e) => e.status === 404 && /unknown content/.test(e.message));
  await assert.rejects(t.content(undefined, {}), (e) => e.status === 400);
  await assert.rejects(t.content('', {}), (e) => e.status === 400);
  await assert.rejects(t.reveal('ci_0123456789abcdef', 0, {}), (e) => e.status === 404);
});

test('contentOff: content and reveal answer 403 with status', async () => {
  const t = await make({ contentOff: true });
  await assert.rejects(t.content('ci_x', {}), (e) => e.status === 403 && /content viewing is off/.test(e.message));
  await assert.rejects(t.reveal('ci_x', 0, {}), (e) => e.status === 403 && /content viewing is off/.test(e.message));
});

test('content offset pages a long text', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'z'.repeat(70000))]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
  const id = sk.spans.find((s) => s.kind === 'turn').text;
  const first = await t.content(id, {});
  assert.ok(first.next > 0);
  const second = await t.content(id, { offset: first.next });
  assert.equal(second.offset, first.next);
  assert.equal(first.text.length + second.text.length, 70000);
});

// ---- LRU ----

test('the cache keeps cacheMax skeletons and drops the content ids of the evicted one', async () => {
  const ix = await fakeIndexer();
  const t = createTrace({ indexer: ix, gateway: gw, light: [], roots: [FIX], cacheMax: 2, listTtlMs: 0 });
  const [row] = t.sessions({});
  const a = await t.session(row.key, { turn: 0 });
  const b = await t.session(row.key, { turn: 1 });
  const idA = a.spans.find((s) => s.kind === 'turn').text;
  await t.content(idA, {}); // touches A: B is now the oldest
  const c = await t.session(row.key, { turn: 2 });
  assert.equal(t.stats().cached, 2);
  await assert.rejects(t.content(b.spans.find((s) => s.kind === 'turn').text, {}), /unknown content/);
  assert.ok((await t.content(idA, {})).text);
  assert.ok((await t.content(c.spans.find((s) => s.kind === 'turn').text, {})).text);
});

test('the cache also evicts by size', async () => {
  const ix = await fakeIndexer();
  const t = createTrace({ indexer: ix, gateway: gw, light: [], roots: [FIX], cacheBytes: 10, listTtlMs: 0 });
  const [row] = t.sessions({});
  await t.session(row.key, { turn: 0 });
  const b = await t.session(row.key, { turn: 1 });
  assert.equal(t.stats().cached, 1, 'only the newest stays');
  assert.ok((await t.content(b.spans.find((s) => s.kind === 'turn').text, {})).text);
});

test('an unchanged skeleton is served from the cache; a changed file rebuilds it', async () => {
  const e = (await fakeIndexer()).entries()[0];
  const entries = [e];
  const t = createTrace({ indexer: { entries: () => entries }, gateway: gw, light: [], roots: [FIX], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const a = await t.session(key, { turn: 0 });
  assert.equal(await t.session(key, { turn: 0 }), a);
  entries[0] = { ...e, mtimeMs: e.mtimeMs + 1 };
  assert.notEqual(await t.session(key, { turn: 0 }), a);
});

// ---- read limit ----

test('at most maxReads skeleton builds run at once; the rest wait in order', async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const slow = fakeLight('kiro', 6, {
    skeleton: async (_e, sid) => {
      started.push(sid);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      return { session: { id: sid }, turns: [], spans: [] };
    },
  });
  const t = createTrace({ indexer: { entries: () => [] }, light: [slow], roots: [], maxReads: 2 });
  const rows = t.sessions({});
  const order = rows.map((r) => r.key);
  const p = order.map((k) => t.session(k));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.stats().active, 2);
  assert.equal(t.stats().queued, 4);
  await Promise.all(p);
  assert.equal(peak, 2);
  assert.equal(started.length, 6);
  assert.deepEqual(started, rows.map((r) => r.title.replace(' session ', '-')), 'first in, first out');
  assert.equal(t.stats().active, 0);
});

test('content reads share the same limit and a failed build frees its slot', async () => {
  const boom = fakeLight('kiro', 3, { skeleton: async () => { throw new Error('nope'); } });
  const t = createTrace({ indexer: { entries: () => [] }, light: [boom], roots: [], maxReads: 1 });
  const rows = t.sessions({});
  const res = await Promise.allSettled(rows.map((r) => t.session(r.key)));
  assert.deepEqual(res.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(t.stats().active, 0);
  assert.equal(t.stats().queued, 0);
});

test('two requests for the same skeleton build it once', async () => {
  let calls = 0;
  const l = fakeLight('kiro', 1, { skeleton: async (_e, sid) => { calls++; await new Promise((r) => setTimeout(r, 10)); return { session: { id: sid }, turns: [], spans: [] }; } });
  const t = createTrace({ indexer: { entries: () => [] }, light: [l], roots: [] });
  const k = t.sessions({})[0].key;
  const [a, b] = await Promise.all([t.session(k), t.session(k)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

// ---- worker offload ----

const scrub = (sk) => JSON.parse(JSON.stringify(sk, (k, v) => (k === 'text' || k === 'result') && typeof v === 'string' ? 'ref' : v));

test('a big file is built in a worker and matches the in-thread skeleton', async () => {
  const inThread = await make({ workerMinBytes: 1e12 });
  const worker = await make({ workerMinBytes: 0 });
  for (const t of [inThread, worker]) {
    const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
    t.sk = sk;
  }
  assert.equal(worker.stats().workers, 1);
  assert.equal(inThread.stats().workers, 0);
  assert.deepEqual(scrub(worker.sk), scrub(inThread.sk));
  assert.ok(worker.sk.spans.some((s) => s.kind === 'agent'), 'the subagent file reached the worker');
  assert.equal((await worker.content(worker.sk.spans.find((s) => s.kind === 'turn').text, {})).text, 'fix the login redirect');
});

test('a codex session is built in a worker too', async () => {
  const codexE = await codexEntry();
  const ix = { entries: () => [codexE] };
  const a = createTrace({ indexer: ix, light: [], roots: [FIX], workerMinBytes: 0 });
  const b = createTrace({ indexer: ix, light: [], roots: [FIX], workerMinBytes: 1e12 });
  const ska = await a.session(a.sessions({})[0].key, { turn: 0 });
  const skb = await b.session(b.sessions({})[0].key, { turn: 0 });
  assert.equal(a.stats().workers, 1);
  assert.deepEqual(scrub(ska), scrub(skb));
});

test('a worker that exits, throws or hangs falls back to the main thread', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-wk-'));
  const script = (name, body) => {
    const f = path.join(scratch, name);
    fs.writeFileSync(f, body);
    return f;
  };
  const cases = {
    exits: script('exit.js', 'process.exit(3);'),
    throws: script('throw.js', 'throw new Error("worker broke");'),
    hangs: script('hang.js', 'setInterval(() => {}, 1000);'),
    fails: script('fail.js', 'require("worker_threads").parentPort.postMessage({ ok: false, message: "no" });'),
  };
  for (const [name, workerFile] of Object.entries(cases)) {
    const t = await make({ workerMinBytes: 0, workerFile, workerTimeoutMs: 300 });
    const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
    assert.ok(sk.spans.length > 3, name);
    assert.equal(t.stats().fallbacks, 1, name);
    assert.equal((await t.content(sk.spans.find((s) => s.kind === 'turn').text, {})).text, 'fix the login redirect', name);
  }
});

test('the worker decision counts the subagent files of the session, not only the main log', async () => {
  const ix = await fakeIndexer();
  const main = ix.entries().find((e) => !e.file.includes('subagents'));
  // The main log alone is not over the bar; with its subagent file it is.
  const t = await make({ indexer: ix, workerMinBytes: main.size });
  await t.session(t.sessions({})[0].key, { turn: 0 });
  assert.equal(t.stats().workers, 1);
  const small = await make({ indexer: ix, workerMinBytes: ix.entries().reduce((a, e) => a + e.size, 0) });
  await small.session(small.sessions({})[0].key, { turn: 0 });
  assert.equal(small.stats().workers, 0);
});

test('a small file never starts a worker', async () => {
  const t = await make();
  await t.session(t.sessions({})[0].key, { turn: 0 });
  assert.equal(t.stats().workers, 0);
});

// ---- pricing ----

test("the owner's pricing reaches the row cost, the span cost and the worker, and a getter's change applies", async () => {
  const { DEFAULT_PRICING } = require('../lib/pricing');
  const scale = (k) => Object.fromEntries(Object.entries(DEFAULT_PRICING).map(([m, p]) => [m, { ...p, input: p.input * k, output: p.output * k, cacheRead: p.cacheRead * k, cacheWrite5m: p.cacheWrite5m * k, cacheWrite1h: p.cacheWrite1h * k, tiers: undefined }]));
  const ten = scale(10);
  // rollout-new has usage rows from the parser, so its listing has a cost.
  const ix = await fakeIndexer([await entryOf(path.join(FIX, 'codex', 'rollout-new.jsonl'), 'codex', codexParser)]);
  const costs = async (t) => {
    const out = {};
    for (const r of t.sessions({})) {
      const sk = await t.session(r.key, { turn: 0 });
      out[r.source] = { row: r.cost, spans: sk.spans.reduce((a, x) => a + (x.cost || 0), 0) };
    }
    return out;
  };
  const base = await costs(await make({ indexer: ix, pricing: scale(1) }));
  const mine = await costs(await make({ indexer: ix, pricing: ten }));
  const viaWorker = await costs(await make({ indexer: ix, pricing: ten, workerMinBytes: 0 }));
  for (const src of ['claude', 'codex']) {
    assert.ok(base[src].row > 0 && base[src].spans > 0, src);
    const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, b), `${src} ${what}: ${a} vs ${b}`);
    near(mine[src].row, base[src].row * 10, 'row');
    near(mine[src].spans, base[src].spans * 10, 'spans');
    near(viaWorker[src].spans, base[src].spans * 10, 'worker spans');
  }
  // A getter (config.json reloads): a new list is used by the next listing, and a cached skeleton is rebuilt.
  let cur = scale(1);
  const t = await make({ indexer: ix, pricing: () => cur });
  const before = await costs(t);
  cur = ten;
  const after = await costs(t);
  for (const src of ['claude', 'codex']) {
    assert.ok(Math.abs(after[src].row - before[src].row * 10) < 1e-9, `${src} row after the change`);
    assert.ok(Math.abs(after[src].spans - before[src].spans * 10) < 1e-9, `${src} spans after the change`);
  }
});

// ---- live ----

test('live: an unchanged file reports changed false, growth rebuilds the last turn; the cursor is opaque', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const before = await t.session(key);
  // No cursor yet: from the beginning, so the first poll is a change.
  const first = await t.live(key);
  assert.equal(first.changed, true);
  const idle = await t.live(key, first.cursor);
  assert.equal(idle.changed, false);
  assert.ok(!('size' in idle) && !('skeleton' in idle));
  assert.equal(typeof idle.cursor, 'string');
  // The cursor does not show the size, in plain text or as base64.
  assert.ok(!idle.cursor.includes(String(e.size)));
  assert.ok(!Buffer.from(idle.cursor, 'base64url').toString('latin1').includes(String(e.size)));
  // The log grows inside the last turn (the index has not been refreshed).
  fs.appendFileSync(file, JSON.stringify(A('s9', '05', 'm2', [{ type: 'text', text: 'two' }])) + '\n');
  const live = await t.live(key, idle.cursor);
  assert.equal(live.changed, true);
  assert.ok(!('size' in live));
  assert.equal(live.skeleton.spans.filter((s) => s.kind === 'chat').length, 2);
  assert.notEqual(live.skeleton, before);
  const answer = live.skeleton.spans.find((s) => s.kind === 'answer');
  assert.equal((await t.content(answer.text, {})).text, 'two');
  for (const s of strings(live.skeleton)) assert.ok(!/[\\/]/.test(s), s);
  assert.equal((await t.live(key, live.cursor)).changed, false);
  // The cached skeleton is untouched: live bypasses the cache.
  assert.equal(await t.session(key), before);
});

test('a bad, tampered or foreign live cursor counts as from the beginning', async () => {
  const one = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const two = tmpClaude([U('s8', '30', 'other')], 's8'); // ends later, so it lists first
  const e = await tmpEntry(one.file);
  const o = await tmpEntry(two.file);
  const t = createTrace({ indexer: { entries: () => [e, o] }, light: [], roots: [one.root, two.root], listTtlMs: 0 });
  const [k8, k9] = t.sessions({}).map((r) => r.key);
  const good = (await t.live(k9)).cursor;
  assert.equal((await t.live(k9, good)).changed, false);
  const flipped = good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA');
  for (const bad of [flipped, 'x', '', 'a'.repeat(300), 42, {}, null]) assert.equal((await t.live(k9, bad)).changed, true, String(bad).slice(0, 12));
  assert.equal((await t.live(k8, good)).changed, true, 'a cursor of another session does not work');
  assert.equal((await t.live(k9, e.size)).changed, true, 'a plain size is not a cursor');
});

test('each live size gets its own cache slot; only the two newest per session are kept', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const turnId = (r) => r.skeleton.spans.find((s) => s.kind === 'turn').text;
  const a = await t.live(key);
  fs.appendFileSync(file, JSON.stringify(A('s9', '05', 'm2', [{ type: 'text', text: 'two' }])) + '\n');
  const b = await t.live(key, a.cursor);
  assert.equal(t.stats().cached, 2);
  assert.ok((await t.content(turnId(a), {})).text, 'the earlier slot is still there');
  fs.appendFileSync(file, JSON.stringify(A('s9', '06', 'm3', [{ type: 'text', text: 'three' }])) + '\n');
  const c = await t.live(key, b.cursor);
  assert.equal(c.changed, true);
  assert.equal(t.stats().cached, 2, 'growth never holds more than two slots');
  await assert.rejects(t.content(turnId(a), {}), /unknown content/);
  assert.ok((await t.content(turnId(b), {})).text);
  assert.ok((await t.content(turnId(c), {})).text);
});

test('live: lines that make no span still give new content ids, and only the two newest growths keep theirs', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const answerOf = (r) => r.skeleton.spans.find((s) => s.kind === 'answer');
  const a = await t.live(key);
  fs.appendFileSync(file, JSON.stringify(A('s9', '05', 'm2', [{ type: 'text', text: 'two' }])) + '\n');
  const b = await t.live(key, a.cursor); // a new span: the client repaints and holds b
  // Real transcripts grow mostly by lines like these, which create no span.
  const quiet = (n) => JSON.stringify({ type: 'attachment', sessionId: 's9', timestamp: `2026-10-20T10:00:0${n}.000Z`, attachment: { n } }) + '\n';
  fs.appendFileSync(file, quiet(6));
  const c = await t.live(key, b.cursor);
  fs.appendFileSync(file, quiet(7));
  const d = await t.live(key, c.cursor);
  for (const r of [c, d]) {
    assert.equal(r.changed, true);
    assert.equal(r.skeleton.spans.length, b.skeleton.spans.length, 'same shape');
  }
  // Span ids are stable, so a selection survives adopting the new skeleton...
  assert.deepEqual(d.skeleton.spans.map((s) => s.id), b.skeleton.spans.map((s) => s.id));
  // ...but the content ids of a skeleton two growths old are gone: the client must adopt every change.
  await assert.rejects(t.content(answerOf(b).text, {}), /unknown content/);
  assert.equal((await t.content(answerOf(c).text, {})).text, 'two');
  assert.equal((await t.content(answerOf(d).text, {})).text, 'two');
});

test('live growth slots do not push other sessions out of the cache', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: await fakeIndexer([e]), light: [], roots: [root, FIX], listTtlMs: 0, cacheMax: 4 });
  const rows = t.sessions({});
  const other = rows.find((r) => r.turns !== 1);
  const mine = rows.find((r) => r.turns === 1).key;
  const keep = await t.session(other.key, { turn: 0 });
  let cursor;
  for (let i = 0; i < 6; i++) {
    fs.appendFileSync(file, JSON.stringify(A('s9', String(10 + i), `x${i}`, [{ type: 'text', text: `n${i}` }])) + '\n');
    cursor = (await t.live(mine, cursor)).cursor;
  }
  assert.equal(await t.session(other.key, { turn: 0 }), keep, 'the other session is still cached');
});

test('repeated live polls without a usable cursor reuse the slot for the same size', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'first'), A('s9', '01', 'm1', [{ type: 'text', text: 'one' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const a = await t.live(key);
  const b = await t.live(key, 'garbage');
  const c = await t.live(key, null);
  assert.equal(b.skeleton, a.skeleton);
  assert.equal(c.skeleton, a.skeleton);
  assert.equal(t.stats().cached, 1);
});

test('live for other sources and demo is not changed', async () => {
  const t = await make({ light: [fakeLight('kiro', 1)] });
  assert.deepEqual(await t.live(t.sessions({ source: 'kiro' })[0].key), { changed: false });
  const d = createTrace({ demo: true });
  assert.deepEqual(await d.live(d.sessions({})[0].key), { changed: false });
});

// ---- demo ----

test('demo: three synthetic sources, keys, content ids and masked content', async () => {
  const t = createTrace({ demo: true, roots: ['/does/not/exist'], indexer: { entries: () => { throw new Error('must not be called'); } }, gateway: { runs: () => { throw new Error('no'); } } });
  const rows = t.sessions({});
  assert.deepEqual(rows.map((r) => r.source).sort(), ['claude', 'codex', 'kiro']);
  assert.ok(rows.every((r) => r.title && r.key));
  const titles = rows.map((r) => r.title);
  assert.ok(titles.includes('fix auth redirect') && titles.includes('tokoku-api pagination') && titles.includes('spec: billing'));
  assert.deepEqual(t.sources().filter((s) => s.ok).map((s) => s.id).sort(), ['claude', 'codex', 'kiro']);
  let secretSeen = 0;
  for (const row of rows) {
    const sk = await t.session(row.key, {});
    assert.ok(sk.spans.length > 3);
    for (const s of strings(sk)) assert.ok(!/^\/(Users|home)/.test(s), s);
    for (const sp of sk.spans)
      for (const f of ['text', 'result'])
        if (sp[f]) {
          assert.match(sp[f], /^ci_[0-9a-f]{16}$/);
          const c = await t.content(sp[f], {});
          assert.ok(c.text.length > 0);
          assert.ok(!/sk-ant-api03/.test(c.text), 'a demo secret comes back masked');
          if (c.masked.length) {
            secretSeen++;
            const i = sp[f];
            assert.match((await t.reveal(i, 0, {})).value, /^sk-ant-api03-/);
          }
        }
  }
  assert.ok(secretSeen >= 1, 'one demo output carries a masked secret');
});

test('demo: the claude session has a subagent, a failed Bash call and a loop; content off still applies', async () => {
  const t = createTrace({ demo: true });
  const row = t.sessions({ source: 'claude' })[0];
  assert.equal(row.flags.loop, true);
  assert.ok(row.errors >= 1);
  const sk = await t.session(row.key, {});
  assert.ok(sk.spans.some((s) => s.kind === 'agent'));
  assert.ok(sk.spans.some((s) => s.kind === 'tool' && s.tool.name === 'Bash' && s.status === 'error'));
  const codex = await t.session(t.sessions({ source: 'codex' })[0].key, {});
  assert.ok(codex.spans.some((s) => s.kind === 'tool'));
  const off = createTrace({ demo: true, contentOff: true });
  const id = (await off.session(off.sessions({ source: 'claude' })[0].key, {})).spans.find((s) => s.text).text;
  await assert.rejects(off.content(id, {}), (e) => e.status === 403);
  await assert.rejects(t.session(Buffer.from('claude:demo').toString('base64url') + '.abc'), /unknown session/);
});

// ---- errors, stale keys, freezing, ids ----

test('a session file that vanishes gives a 404 with no path, and the listing is rescanned', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'hello'), A('s9', '01', 'm1', [{ type: 'text', text: 'hi' }])]);
  const e = await tmpEntry(file);
  let listed = 0;
  const t = createTrace({ indexer: { entries: () => (listed++, [e]) }, light: [], roots: [root], listTtlMs: 60000 });
  const key = t.sessions({})[0].key;
  fs.unlinkSync(file);
  await assert.rejects(t.session(key), (er) => {
    assert.equal(er.status, 404);
    assert.equal(er.message, 'session file changed, rescanning');
    assert.ok(!er.message.includes(root) && !/[\\/]/.test(er.message));
    return true;
  });
  const before = listed;
  t.sessions({});
  assert.ok(listed > before, 'the next listing is rebuilt');
  await assert.rejects(t.live(key), (er) => er.status === 404 && !/[\\/]/.test(er.message));
});

test('an error without a status is a 500 that names no path and is logged once, scrubbed', async () => {
  const logs = [];
  const bad = fakeLight('kiro', 1, { skeleton: async () => { throw new Error("EACCES: permission denied, open '/Users/someone/.kiro/x.json'"); } });
  const t = createTrace({ indexer: { entries: () => [] }, light: [bad], roots: [], log: (m) => logs.push(m), listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  for (let i = 0; i < 3; i++) await assert.rejects(t.session(key), (er) => er.status === 500 && er.message === 'trace read failed');
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('/Users') && !logs[0].includes('someone'), logs[0]);
});

test('errors that carry a status keep it, with the message scrubbed', async () => {
  const bad = fakeLight('kiro', 1, { skeleton: async () => { throw Object.assign(new Error("gone: '/Users/someone/x'"), { status: 410 }); } });
  const t = createTrace({ indexer: { entries: () => [] }, light: [bad], roots: [] });
  await assert.rejects(t.session(t.sessions({})[0].key), (er) => er.status === 410 && !er.message.includes('/Users'));
});

test('a content read of a vanished file does not leak the path', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'hello')]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
  fs.unlinkSync(file);
  await assert.rejects(t.content(sk.spans.find((s) => s.kind === 'turn').text, {}), (er) => er.status === 404 && !er.message.includes(root));
});

test('a stale valid key does not rescan on every request', async () => {
  const full = await fakeIndexer();
  const key = (await make({ indexer: full })).sessions({})[0].key;
  let calls = 0;
  const t = createTrace({ indexer: { entries: () => (calls++, []) }, gateway: gw, light: [], roots: [FIX] });
  for (let i = 0; i < 100; i++) await assert.rejects(t.session(key), (er) => er.status === 404 && /unknown session/.test(er.message));
  assert.ok(calls <= 2, `${calls} listings for 100 requests`);
  // Titles and live go through the same lookup.
  for (let i = 0; i < 50; i++) await assert.rejects(t.title(key), (er) => er.status === 404);
  assert.ok(calls <= 2, `${calls} listings after 150 requests`);
});

test('a key that appears after the last listing is found with one rebuild', async () => {
  const entries = [];
  const t = createTrace({ indexer: { entries: () => entries }, gateway: gw, light: [], roots: [FIX] });
  assert.equal(t.sessions({}).length, 0);
  const full = await fakeIndexer();
  entries.push(...full.entries());
  const key = (await make({ indexer: full })).sessions({})[0].key;
  assert.ok((await t.session(key, { turn: 0 })).spans.length);
});

test('the sealed skeleton is frozen all the way down', async () => {
  const t = await make();
  const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
  assert.ok(Object.isFrozen(sk) && Object.isFrozen(sk.spans) && Object.isFrozen(sk.spans[1]) && Object.isFrozen(sk.session) && Object.isFrozen(sk.turns[0]));
  assert.throws(() => {
    'use strict';
    sk.spans[0].name = 'changed';
  }, TypeError);
  assert.throws(() => sk.spans.push({}), TypeError);
  const again = await t.session(t.sessions({})[0].key, { turn: 0 });
  assert.notEqual(again.spans[0].name, 'changed');
  const tool = sk.spans.find((s) => s.tool);
  if (tool) assert.ok(Object.isFrozen(tool.tool));
});

test('turns carry no byte offsets', async () => {
  const t = await make();
  const sk = await t.session(t.sessions({})[0].key, { turn: 0 });
  assert.ok(sk.turns.length >= 2);
  for (const turn of sk.turns) assert.deepEqual(Object.keys(turn).sort(), ['index', 'ts']);
});

test('span ids are keyed: not the plain hash of the file, stable across rebuilds, and still a tree', async () => {
  const { spanId, validate } = require('../lib/trace/model');
  const ix = await fakeIndexer();
  const file = ix.entries()[0].file;
  const t = createTrace({ indexer: ix, gateway: gw, light: [], roots: [FIX], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const sk = await t.session(key, { turn: 0 });
  assert.deepEqual(validate(sk.spans), []);
  const plain = new Set([spanId(file, 's1', 'session'), spanId(file, 's1', 'turn', 0)]);
  for (const s of sk.spans) {
    assert.ok(!plain.has(s.id) && !plain.has(s.parent));
    assert.match(s.id, /^[0-9a-f]{16}$/);
  }
  // A rebuild (another registry on the same data, a worker build) keeps the ids.
  const other = createTrace({ indexer: ix, gateway: gw, light: [], roots: [FIX], workerMinBytes: 0, listTtlMs: 0 });
  const sk2 = await other.session(other.sessions({})[0].key, { turn: 0 });
  assert.deepEqual(sk2.spans.map((s) => [s.id, s.parent]), sk.spans.map((s) => [s.id, s.parent]));
});

test('a light adapter reason is scrubbed too', async () => {
  const l = fakeLight('kiro', 0, { ok: false, reason: "cannot read '/Users/someone/.kiro'" });
  const t = createTrace({ indexer: { entries: () => [] }, light: [l], roots: [] });
  const r = t.sources().find((s) => s.id === 'kiro').reason;
  assert.ok(!r.includes('/Users') && !r.includes('someone'), r);
});

test('a slower build of an older listing does not replace a newer cached skeleton', async () => {
  const state = { end: 1000, wait: 120, tag: 'old' };
  const l = {
    id: 'kiro',
    available: () => ({ ok: true, reason: null }),
    sessions: () => [{ id: 'k1', source: 'kiro', title: 't', project: 'p', branch: null, start: 1, end: state.end, turns: 1, tools: 0, errors: 0, cost: null, flags: {} }],
    skeleton: async () => {
      const { wait, tag } = state;
      await new Promise((r) => setTimeout(r, wait));
      return { session: { id: 'k1', project: 'p' }, turns: [], spans: [{ id: tag, parent: null, kind: 'session', text: null }] };
    },
  };
  const t = createTrace({ indexer: { entries: () => [] }, light: [l], roots: [], listTtlMs: 0 });
  const key = t.sessions({})[0].key;
  const slow = t.session(key); // built from the first listing: stamp 1000
  await new Promise((r) => setTimeout(r, 10));
  Object.assign(state, { end: 2000, wait: 0, tag: 'new' }); // the session changed; a newer listing
  t.sessions({});
  const fresh = await t.session(key);
  const late = await slow;
  assert.equal(late.spans[0].id, fresh.spans[0].id, 'the late build answers with the newer skeleton');
  assert.equal(await t.session(key), fresh, 'and the newer skeleton is still the cached one');
  assert.equal(t.stats().cached, 1);
});

// ---- review round 2 ----

test('a deleted file the index still lists causes at most one rescan across 100 requests', async () => {
  const { root, file } = tmpClaude([U('s9', '00', 'hello'), A('s9', '01', 'm1', [{ type: 'text', text: 'hi' }])]);
  const e = await tmpEntry(file);
  let listed = 0;
  const t = createTrace({ indexer: { entries: () => (listed++, [e]) }, light: [], roots: [root] });
  const key = t.sessions({})[0].key;
  fs.unlinkSync(file);
  for (let i = 0; i < 100; i++) await assert.rejects(t.session(key), (er) => er.status === 404 && !/[\\/]/.test(er.message));
  assert.ok(listed <= 2, `${listed} listings for 100 session() calls`);
  for (let i = 0; i < 100; i++) await assert.rejects(t.live(key), (er) => er.status === 404);
  assert.ok(listed <= 2, `${listed} listings after 100 live() polls`);
  await assert.rejects(t.title(key), (er) => er.status === 404);
});

test('errors are scrubbed of paths, including paths with spaces', async () => {
  const cases = [
    "open 'C:\\Users\\Jane Doe\\a.json'",
    "open '~/Library/Application Support/Tool/x.json'",
    'open "~/Library/Application Support/Tool/x.json"',
    'open /Users/someone/file.json now',
    "EACCES: permission denied, open '/Users/some one/.kiro/x.json'",
  ];
  for (const msg of cases) {
    const bad = { ...fakeLight('kiro', 1), sessions: () => { throw new Error(msg); } };
    const t = createTrace({ indexer: { entries: () => [] }, light: [bad], roots: [] });
    const r = t.sources().find((x) => x.id === 'kiro').reason;
    assert.ok(!/Users|Jane|Doe|Library|Application|Support|someone|some one|\.json|Tool/.test(r), `${msg} -> ${r}`);
    assert.match(r, /<path>/);
  }
  const plain = { ...fakeLight('kiro', 1), sessions: () => { throw new Error('listing failed'); } };
  assert.equal(createTrace({ indexer: { entries: () => [] }, light: [plain], roots: [] }).sources().find((x) => x.id === 'kiro').reason, 'listing failed');
});

test('session keys are opaque: no id in them, only the listing resolves them', async () => {
  const sid = 'a'.repeat(64); // like a hash of a folder
  const l = fakeLight('gemini', 0);
  l.sessions = () => [{ id: sid, source: 'gemini', title: 't', project: 'p', branch: null, start: 1, end: 2, turns: 1, tools: 0, errors: 0, cost: null, flags: {} }];
  const t = createTrace({ indexer: { entries: () => [] }, light: [l], roots: [] });
  const [row] = t.sessions({});
  assert.match(row.key, /^gemini\.[0-9a-f]{32}$/);
  assert.ok(!row.key.includes(sid) && !Buffer.from(row.key.split('.')[1], 'hex').toString('latin1').includes('aaaa'));
  const sk = await t.session(row.key);
  assert.equal(sk.session.id, row.key, 'the skeleton does not repeat the id');
  assert.ok(!JSON.stringify(sk).includes(sid));
  // Stable within the process, and a different session has a different key.
  assert.equal(t.sessions({})[0].key, row.key);
  const t2 = await make();
  assert.notEqual(t2.sessions({})[0].key, row.key);
  for (const bad of [`gemini.${'0'.repeat(32)}`, `gemini.${row.key.split('.')[1].toUpperCase()}`, `claude.${row.key.split('.')[1]}`, `${row.key}0`]) {
    await assert.rejects(t.session(bad), (er) => er.status === 404 && /unknown session/.test(er.message));
  }
});

test('an error status outside 400-599 is a 500', async () => {
  for (const status of ['oops', 200, 302, 700, 404.5, NaN, 0]) {
    const bad = fakeLight('kiro', 1, { skeleton: async () => { throw Object.assign(new Error('odd'), { status }); } });
    const t = createTrace({ indexer: { entries: () => [] }, light: [bad], roots: [], log: () => {}, listTtlMs: 0 });
    await assert.rejects(t.session(t.sessions({})[0].key), (er) => er.status === 500 && er.message === 'trace read failed', String(status));
  }
  const ok = fakeLight('kiro', 1, { skeleton: async () => { throw Object.assign(new Error('teapot'), { status: 418 }); } });
  const t = createTrace({ indexer: { entries: () => [] }, light: [ok], roots: [] });
  await assert.rejects(t.session(t.sessions({})[0].key), (er) => er.status === 418);
});

test('content is off by default in server mode only, and the setting wins either way', () => {
  assert.equal(contentDefaultOff({ ZAAFPULSE_CONTENT: 'off' }, false), true, 'off is off');
  assert.equal(contentDefaultOff({ ZAAFPULSE_CONTENT: 'off' }, true), true);
  assert.equal(contentDefaultOff({}, true), true, 'server mode without a value');
  assert.equal(contentDefaultOff({ ZAAFPULSE_CONTENT: 'on' }, true), false, 'server mode, asked for');
  assert.equal(contentDefaultOff({}, false), false, 'loopback without a value');
});

// ---- judge material (server-side only: never returned by an HTTP route) ----

test('material: the Claude turn prompt, answer and tools, with the subagent span and the tools offered', async () => {
  const t = await make();
  const m = await t.material('claude', 's1', 0);
  assert.equal(m.material.prompt, 'fix the login redirect');
  assert.equal(m.material.answer, 'Changed the redirect.');
  const agent = m.material.tools.find((x) => x.name === 'Agent');
  assert.ok(agent, 'the subagent span is a tool');
  assert.equal(agent.output, 'found src/auth.js');
  assert.deepEqual(Object.keys(agent).sort(), ['name', 'output', 'status', 'target'], 'no tool input');
  assert.ok(m.material.available.includes('Agent'));
  assert.ok(!('prompts' in m.material));
  assert.deepEqual(m.target, { source: 'claude', session: 's1', turn: 0, span: null });
  // The first turn ends where the second begins.
  const turns = await t.turnsOf(t.keyFor('claude', 's1'));
  assert.equal(m.finishedAt, turns[1].ts);
  // The last turn ends with its own spans, not at a next turn; no turn means the last one.
  const last = await t.material('claude', 's1');
  assert.equal(last.material.prompt, 'now run the tests');
  assert.equal(last.target.turn, turns.length - 1);
  assert.ok(Number.isFinite(last.finishedAt) && last.finishedAt >= turns[turns.length - 1].ts);
  assert.equal(await t.material('claude', 's1', 99), null, 'a turn that does not exist');
});

test('material: a secret in the prompt or a tool output comes back masked', async () => {
  const k = secret();
  const { root, file } = tmpClaude([
    U('s9', '00', `deploy with ${k}`),
    A('s9', '01', 'm1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `echo ${k}` } }]),
    U('s9', '02', [{ type: 'tool_result', tool_use_id: 'tu1', content: `KEY=${k}\nrest` }]),
    A('s9', '03', 'm2', [{ type: 'text', text: 'done' }]),
  ]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const m = await t.material('claude', 's9', 0);
  assert.ok(!JSON.stringify(m).includes(k), 'no live secret anywhere in the material');
  assert.match(m.material.prompt, /hidden/);
  assert.match(m.material.tools[0].output, /KEY=.*hidden.*\nrest/);
  assert.equal(m.material.tools[0].name, 'Bash');
});

test('material: an unknown session, a light source and a gateway request are null; a bad turn is refused', async () => {
  const t = await make({ light: [fakeLight('kiro', 1)], gateway: { runs: () => [], run: () => null, requests: () => [{ ts: 1000, keyId: 'k', provider: 'p', model: 'm', sessionId: 'c1', kind: 'chat', status: 200, ms: 5, input: 1, output: 1, cost: 0 }] } });
  assert.equal(await t.material('claude', 'nope', 0), null);
  assert.equal(await t.material('nope', 's1', 0), null);
  assert.equal(await t.material('kiro', 'kiro-0', 0), null);
  assert.equal(await t.material('gateway', 'req:c1', 0), null);
  assert.equal(await t.materialSession('kiro', 'kiro-0'), null);
  assert.equal(await t.materialSession('gateway', 'req:c1'), null);
  assert.equal(await t.materialSession('claude', 'nope'), null);
  assert.equal(await t.material(undefined, undefined, 0), null);
  await assert.rejects(t.material('claude', 's1', -1), (e) => e.status === 400);
  await assert.rejects(t.material('claude', 's1', 'x'), (e) => e.status === 400);
});

test('material: the raw skeleton is not left in the client cache', async () => {
  const t = await make();
  await t.material('claude', 's1', 0);
  assert.deepEqual([t.stats().cached, t.stats().contentIds], [0, 0]);
});

test('material: a Codex turn works', async () => {
  const t = await make({ indexer: await fakeIndexer([await codexEntry()]) });
  const sid = Object.keys((await codexEntry()).result.sessions)[0];
  const m = await t.material('codex', sid, 0);
  assert.equal(m.material.prompt, 'add pagination');
  assert.ok(m.material.tools.some((x) => x.name && x.output.trim() === 'src'));
});

test('sourceOf maps a key back to its source and session id; a forged key is a 404', async () => {
  const t = await make();
  const key = t.keyFor('claude', 's1');
  assert.deepEqual(t.sourceOf(key), { source: 'claude', sid: 's1' });
  const [body, tag] = key.split('.');
  const flip = tag[0] === 'a' ? 'b' : 'a';
  for (const bad of [`${body}.${flip}${tag.slice(1)}`, 'claude.' + '0'.repeat(32), 'x', Buffer.from('claude:s1').toString('base64url')])
    assert.throws(() => t.sourceOf(bad), (e) => e.status === 404 && /unknown session/.test(e.message), bad.slice(0, 20));
  assert.throws(() => t.sourceOf(undefined), (e) => e.status === 400);
});

test('turnsOf lists the index and time of each turn, nothing else', async () => {
  const t = await make();
  const turns = await t.turnsOf(t.keyFor('claude', 's1'));
  assert.deepEqual(turns.map((x) => x.index), [0, 1]);
  for (const x of turns) assert.deepEqual(Object.keys(x).sort(), ['index', 'ts']);
  await assert.rejects(t.turnsOf('claude.' + '0'.repeat(32)), (e) => e.status === 404);
});

test('materialSession: the prompt of each turn, at most 1000 characters, latest 30 turns', async () => {
  const t = await make();
  const m = await t.materialSession('claude', 's1');
  assert.deepEqual(m.material, { prompts: ['fix the login redirect', 'now run the tests'] });
  assert.deepEqual(m.target, { source: 'claude', session: 's1', turn: null, span: null });

  const k = secret();
  const lines = [];
  for (let i = 0; i < 35; i++) {
    const ts = String(i).padStart(2, '0');
    lines.push(U('s9', ts, i === 34 ? `${'x'.repeat(1500)} ${k}` : i === 33 ? `with ${k}` : `p${i}`));
    lines.push(A('s9', ts, `m${i}`, [{ type: 'text', text: 'ok' }]));
  }
  const { root, file } = tmpClaude(lines);
  const e = await tmpEntry(file);
  const big = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const p = (await big.materialSession('claude', 's9')).material.prompts;
  assert.equal(p.length, 30);
  assert.equal(p[0], 'p5', 'the latest 30 turns, oldest first');
  assert.ok(p[29].length <= 1000);
  assert.ok(!JSON.stringify(p).includes(k));
  assert.match(p[28], /hidden/);
});

test('material and materialSession work with content off (server-internal), and content stays 403', async () => {
  const t = await make({ contentOff: true });
  assert.equal((await t.material('claude', 's1', 0)).material.prompt, 'fix the login redirect');
  assert.equal((await t.materialSession('claude', 's1')).material.prompts.length, 2);
  assert.equal(t.stats().contentIds, 0);
});

test('material: a gateway run is judged like a turn: the task masked, the answer, the steps', async () => {
  const k = secret();
  const T0 = 1700000000000;
  const run = {
    id: 'r1',
    pattern: 'vote',
    state: 'completed',
    createdAt: T0,
    updatedAt: T0 + 5000,
    task: `ship it with ${k}`,
    answer: 'final answer',
    steps: [{ n: 1, agent: 'a', model: 'm', text: 'step a text', status: 'done' }],
    trace: [
      { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 0, end: 5000, status: 'ok', attrs: {} },
      { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
      { id: 'x2', parent: 'x1', name: 'chat m', start: 200, end: 2000, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
    ],
  };
  const t = await make({ gateway: { runs: () => [run], run: (id) => (id === 'r1' ? run : null), requests: () => [] } });
  const m = await t.material('gateway', 'run:r1', 0);
  assert.match(m.material.prompt, /^ship it with .*hidden/);
  assert.ok(!JSON.stringify(m).includes(k));
  assert.equal(m.material.answer, 'final answer');
  assert.ok(m.material.tools.some((x) => x.output === 'step a text'));
  assert.deepEqual(m.target, { source: 'gateway', session: 'run:r1', turn: 0, span: null });
  assert.equal(m.finishedAt, T0 + 5000);
  const s = await t.materialSession('gateway', 'run:r1');
  assert.equal(s.material.prompts.length, 1);
  assert.ok(!JSON.stringify(s).includes(k));
});

test('material: demo mode serves the synthetic turn through the same content path', async () => {
  const t = createTrace({ demo: true, listTtlMs: 0 });
  const m = await t.material('claude', 'demo-claude-1', 0);
  assert.match(m.material.prompt, /^fix auth redirect/);
  assert.match(m.material.answer, /^Fixed:/);
  assert.ok(m.material.tools.some((x) => x.name === 'Agent') && m.material.tools.some((x) => x.name === 'Bash' && x.status === 'error'));
  assert.ok(!JSON.stringify(m).includes('sk-ant-api03'), 'the demo secret is masked');
  assert.ok(m.material.tools.some((x) => /hidden/.test(x.output)));
  assert.equal(await t.material('kiro', 'demo-kiro-1', 0), null);
  assert.equal((await t.materialSession('claude', 'demo-claude-1')).material.prompts.length, 1);
});

// ---- judge material: unreadable text is reported, and long turns keep both ends ----

// Fails the last `n` reads of a log range (as a vanished file would), after a counting run.
async function failLastReads(t, n, run) {
  let calls = 0;
  const real = fs.createReadStream;
  const count = test.mock.method(fs, 'createReadStream', (...a) => (calls++, real(...a)));
  await run();
  const total = calls;
  count.mock.restore();
  calls = 0;
  const gone = test.mock.method(fs, 'createReadStream', (...a) => (++calls > total - n ? real(path.join(os.tmpdir(), 'zp-gone', 'x.jsonl')) : real(...a)));
  try {
    return await run();
  } finally {
    gone.mock.restore();
  }
}
const twoTools = () =>
  tmpClaude([
    U('s9', '00', 'list both'),
    A('s9', '01', 'm1', [
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a' } },
      { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } },
    ]),
    U('s9', '02', [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'first out' },
      { type: 'tool_result', tool_use_id: 'tu2', content: 'second out' },
    ]),
    A('s9', '03', 'm2', [{ type: 'text', text: 'done' }]),
  ]);

test('material: one tool output that cannot be read is marked unavailable, not empty', async () => {
  const { root, file } = twoTools();
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  const m = await failLastReads(t, 1, () => t.material('claude', 's9', 0));
  assert.equal(m.material.tools[0].output, 'first out');
  assert.ok(!('unavailable' in m.material.tools[0]));
  assert.deepEqual([m.material.tools[1].output, m.material.tools[1].unavailable], [null, true]);
  assert.equal(m.material.prompt, 'list both');
});

test('material: when the prompt, or every tool output, cannot be read, it fails instead of judging empty text', async () => {
  const { root, file } = twoTools();
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  await assert.rejects(failLastReads(t, 2, () => t.material('claude', 's9', 0)), (er) => er.status === 404);
  await assert.rejects(failLastReads(t, 4, () => t.material('claude', 's9', 0)), (er) => er.status === 404, 'prompt, answer and outputs');
  const m = await t.material('claude', 's9', 0);
  assert.equal(m.material.tools.length, 2, 'unharmed once the reads work again');
});

test('material and materialSession reject with 404 when the session file is deleted after listing', async () => {
  const { root, file } = twoTools();
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 60000 });
  t.sessions({});
  fs.unlinkSync(file);
  await assert.rejects(t.material('claude', 's9', 0), (er) => er.status === 404 && !/zp-reg/.test(er.message));
  await assert.rejects(t.materialSession('claude', 's9'), (er) => er.status === 404 && !/zp-reg/.test(er.message));
});

test('materialSession: when every prompt is unreadable it fails instead of returning no prompts', async () => {
  const { root, file } = twoTools();
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root], listTtlMs: 0 });
  await assert.rejects(failLastReads(t, 1, () => t.materialSession('claude', 's9')), (er) => er.status === 404);
});

test('material: a turn of 300 calls keeps the first 50 and the last 150, and available covers every call', async () => {
  const uses = Array.from({ length: 300 }, (_, i) => ({ type: 'tool_use', id: `tu${i}`, name: i === 250 ? 'LateTool' : i === 299 ? 'FinalTool' : 'Bash', input: { command: `c${i}` } }));
  const results = uses.map((u, i) => ({ type: 'tool_result', tool_use_id: u.id, content: `out${i}` }));
  const { root, file } = tmpClaude([U('s9', '00', 'many'), A('s9', '01', 'm1', uses), U('s9', '02', results), A('s9', '03', 'm2', [{ type: 'text', text: 'done' }])]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const { material: m } = await t.material('claude', 's9', 0);
  assert.equal(m.tools.length, 200);
  assert.equal(m.tools[0].output, 'out0');
  assert.equal(m.tools[49].output, 'out49');
  assert.equal(m.tools[50].output, 'out150', 'the middle is what is left out');
  assert.equal(m.tools[199].output, 'out299');
  assert.equal(m.tools[199].name, 'FinalTool');
  assert.ok(m.available.includes('LateTool') && m.available.includes('FinalTool') && m.available.includes('Bash'));
});

test('registry: an opened skeleton carries its analysis, rooted at the turn', async () => {
  const t = createTrace({ demo: true });
  const row = t.sessions({ range: 30 }).find((r) => r.source === 'claude');
  const sk = await t.session(row.key);
  const turn = sk.spans.find((s) => s.kind === 'turn');
  assert.equal(sk.analysis.rootSpanId, turn.id);
  assert.ok(sk.analysis.criticalPath.length > 0);
  assert.equal(sk.analysis.rootCause.name, 'execute_tool Bash');
  assert.ok(sk.analysis.rollup[turn.id].costUSD > 0);
  // Filters on duration and cost.
  assert.equal(t.sessions({ range: 30, minCost: 1000 }).length, 0);
  assert.ok(t.sessions({ range: 30, minMs: 1 }).length >= 3);
  assert.equal(t.sessions({ range: 30, minMs: 1e12 }).length, 0);
  // Demo dependencies are a fixed sample.
  assert.ok(t.deps({ range: 7 }).edges.length > 0);
});

test('registry: deps are cached for 30 s per range and refreshed when the store changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-regdeps-'));
  const store = require('../lib/trace/store').createTraceStore({ dir });
  let reads = 0;
  const getSpans = store.getSpans;
  store.getSpans = (id) => (reads++, getSpans(id));
  const now = Date.now();
  const span = (t, s) => ({ t, s, p: null, n: 'invoke_agent a', k: 'internal', st: (now - 1000) * 1000, d: 5000, ok: true, src: 'gateway', svc: 'zaafpulse', a: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.id': 'a' } });
  store.writeSpans([span('a'.repeat(32), '1'.repeat(16))]);
  const t = createTrace({ indexer: { entries: () => [] }, light: [], roots: [], traceStore: store });
  assert.equal(t.deps({ range: 7 }).nodes[0].count, 1);
  const first = reads;
  assert.equal(t.deps({ range: 7 }).nodes[0].count, 1);
  assert.equal(reads, first, 'unchanged store: served from memory');
  store.writeSpans([span('b'.repeat(32), '2'.repeat(16))]);
  assert.equal(t.deps({ range: 7 }).nodes[0].count, 2, 'a new trace gives a fresh result');
});

// ---- dataset example (server-side only: the API decides whether a viewer may add it) ----

test('example: the Claude turn as prompt, tool results, answer and model, with its source', async () => {
  const t = await make();
  const key = t.keyFor('claude', 's1');
  const ex = await t.example(key, 0);
  assert.deepEqual(ex.input.messages[0], { role: 'user', text: 'fix the login redirect' });
  assert.equal(ex.output.text, 'Changed the redirect.');
  assert.deepEqual(ex.source, { source: 'claude', session: 's1', turn: 0, span: null });
  assert.equal(ex.input.system, null);
  assert.ok(ex.input.tools.some((x) => x.name === 'Agent' && x.description === ''));
  assert.ok(ex.input.messages.length > 1);
  for (const m of ex.input.messages.slice(1)) {
    assert.equal(m.role, 'tool');
    assert.equal(typeof m.name, 'string');
  }
  assert.equal(ex.input.messages[1].text, 'found src/auth.js');
  assert.equal(typeof ex.output.model, 'string');
  assert.equal((await t.example(key, 1)).input.messages[0].text, 'now run the tests');
});

test('example: a secret in the prompt or a tool output comes back masked', async () => {
  const k = secret();
  const { root, file } = tmpClaude([
    U('s9', '00', `deploy with ${k}`),
    A('s9', '01', 'm1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `echo ${k}` } }]),
    U('s9', '02', [{ type: 'tool_result', tool_use_id: 'tu1', content: `KEY=${k}\nrest` }]),
    A('s9', '03', 'm2', [{ type: 'text', text: `done ${k}` }]),
  ]);
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const ex = await t.example(t.keyFor('claude', 's9'), 0);
  assert.ok(!JSON.stringify(ex).includes(k), 'no live secret anywhere in the example');
  assert.match(ex.input.messages[0].text, /hidden/);
  assert.match(ex.input.messages[1].text, /KEY=.*hidden.*\nrest/);
  assert.equal(ex.input.messages[1].name, 'Bash');
  assert.match(ex.output.text, /hidden/);
});

test('example: a long answer keeps its head and tail, a long tool output is cut to 8000, only the last ten stay', async () => {
  const { MARK } = require('../lib/evals/judge');
  const answer = Array.from({ length: 7000 }, (_, i) => String(i % 10).repeat(9) + '|').join('');
  const lines = [U('s8', '00', 'go')];
  for (let i = 0; i < 12; i++) {
    const ts = String(1 + i * 2).padStart(2, '0');
    const ts2 = String(2 + i * 2).padStart(2, '0');
    lines.push(A('s8', ts, `m${i}`, [{ type: 'tool_use', id: `tu${i}`, name: i % 2 ? 'Read' : 'Bash', input: { n: i } }]));
    lines.push(U('s8', ts2, [{ type: 'tool_result', tool_use_id: `tu${i}`, content: i === 11 ? 'x'.repeat(20000) : `out ${i}` }]));
  }
  lines.push(A('s8', '50', 'mz', [{ type: 'text', text: answer }]));
  const { root, file } = tmpClaude(lines, 's8');
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const ex = await t.example(t.keyFor('claude', 's8'), 0);
  assert.equal(answer.length, 70000);
  assert.ok(ex.output.text.length <= 65536 + MARK.length + 2);
  assert.ok(ex.output.text.includes(MARK));
  assert.ok(ex.output.text.endsWith(answer.slice(-100)));
  assert.ok(ex.output.text.startsWith(answer.slice(0, 100)));
  const tool = ex.input.messages.slice(1);
  assert.deepEqual(tool.map((m) => m.text).slice(0, 9), ['out 2', 'out 3', 'out 4', 'out 5', 'out 6', 'out 7', 'out 8', 'out 9', 'out 10']);
  assert.equal(tool.length, 10, 'the last ten results, in call order');
  assert.ok(tool[9].text.length <= 8000 + MARK.length + 2 && tool[9].text.includes(MARK));
  assert.deepEqual(ex.input.tools.map((x) => x.name).sort(), ['Bash', 'Read']);
});

test('example: a sealed span id is kept raw in the source and maps back; a span of another turn is refused', async () => {
  const t = await make();
  const key = t.keyFor('claude', 's1');
  const sealed = (await t.session(key, { turn: 0 })).spans.find((s) => s.kind === 'tool' || s.kind === 'agent').id;
  const ex = await t.example(key, 0, sealed);
  assert.equal(typeof ex.source.span, 'string');
  assert.notEqual(ex.source.span, sealed, 'the raw id, not the one the client holds');
  assert.equal(t.sealSpan(ex.source.span), sealed);
  assert.deepEqual(await t.example(key, 0, sealed).then((x) => x.input), (await t.example(key, 0)).input, 'content is the same');
  const other = (await t.session(key, { turn: 1 })).spans.find((s) => s.kind === 'answer').id;
  await assert.rejects(t.example(key, 0, other), (e) => e.status === 400 && /span is not in this turn/.test(e.message));
  await assert.rejects(t.example(key, 0, 'nope'), (e) => e.status === 400);
  assert.equal(t.sealSpan(''), null);
  assert.equal(t.sealSpan(undefined), null);
});

test('example: a light source or a gateway request group is null, a forged key 404, a bad turn 400, a turn past the end null', async () => {
  const reqs = [{ ts: 1000, keyId: 'k', provider: 'p', model: 'm', sessionId: 'c1', kind: 'chat', status: 200, ms: 5, input: 1, output: 1, cost: 0 }];
  const t = await make({ light: [fakeLight('kiro', 1)], gateway: { runs: () => [], run: () => null, requests: () => reqs } });
  assert.equal(await t.example(t.keyFor('kiro', 'kiro-0'), 0), null);
  assert.equal(await t.example(t.keyFor('gateway', 'req:c1'), 0), null);
  await assert.rejects(t.example('claude.' + '0'.repeat(32), 0), (e) => e.status === 404);
  await assert.rejects(t.example('nope', 0), (e) => e.status === 404);
  const key = t.keyFor('claude', 's1');
  for (const bad of [-1, 'x', 1.5, undefined, null]) await assert.rejects(t.example(key, bad), (e) => e.status === 400 && /bad turn/.test(e.message), String(bad));
  assert.equal(await t.example(key, 99), null);
  assert.deepEqual([t.stats().cached, t.stats().contentIds], [0, 0], 'the raw skeleton is not left in the client cache');
});

test('example: a gateway run uses its masked task as the prompt, has no tool messages, and demo mode works', async () => {
  const k = secret();
  const T0 = 1700000000000;
  const run = {
    id: 'r1',
    pattern: 'vote',
    state: 'completed',
    createdAt: T0,
    updatedAt: T0 + 5000,
    task: `ship it with ${k}`,
    answer: 'final answer',
    steps: [{ n: 1, agent: 'a', model: 'm', text: 'step a text', status: 'done' }],
    trace: [
      { id: 'x0', parent: null, name: 'invoke_workflow vote', start: 0, end: 5000, status: 'ok', attrs: {} },
      { id: 'x1', parent: 'x0', name: 'invoke_agent a', start: 100, end: 3000, status: 'ok', attrs: {} },
      { id: 'x2', parent: 'x1', name: 'chat m', start: 200, end: 2000, status: 'ok', attrs: { 'zp.agent': 'a', 'gen_ai.request.model': 'm' } },
    ],
  };
  const t = await make({ gateway: { runs: () => [run], run: (id) => (id === 'r1' ? run : null), requests: () => [] } });
  const ex = await t.example(t.keyFor('gateway', 'run:r1'), 0);
  assert.match(ex.input.messages[0].text, /^ship it with .*hidden/);
  assert.equal(ex.input.messages.length, 1, 'no tool messages');
  assert.ok(!JSON.stringify(ex).includes(k));
  assert.equal(ex.output.text, 'final answer');
  assert.equal(ex.output.model, 'm');
  assert.deepEqual(ex.source, { source: 'gateway', session: 'run:r1', turn: 0, span: null });
  const d = createTrace({ demo: true, listTtlMs: 0 });
  const dx = await d.example(d.keyFor('claude', 'demo-claude-1'), 0);
  assert.match(dx.input.messages[0].text, /^fix auth redirect/);
  assert.match(dx.output.text, /^Fixed:/);
  assert.ok(dx.input.tools.some((x) => x.name === 'Agent'));
  assert.ok(!JSON.stringify(dx).includes('sk-ant-api03'));
});

test('example: a text that fits the field comes back whole even when it needs two pages', async () => {
  const { MARK } = require('../lib/evals/judge');
  const answer = Array.from({ length: 5000 }, (_, i) => String(i % 10).repeat(9) + '|').join('');
  const { root, file } = tmpClaude([U('s7', '00', 'go'), A('s7', '01', 'm1', [{ type: 'text', text: answer }])], 's7');
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const ex = await t.example(t.keyFor('claude', 's7'), 0);
  assert.equal(ex.output.text, answer);
  assert.ok(!ex.output.text.includes(MARK));
});

// D-T2-3: a key at a page edge never shows raw. `half` is the page size readHeadTail uses for an answer
// (EXAMPLE_FIELD / 2). Over 70,000 characters the head page ends at half (it stops before a key it would cut, so the
// head key falls in the left-out middle) and the tail page starts at total − half, inside the tail key: the masking
// of that second page is what hides the key's end. A key is planted 20 characters before each edge.
test('example: a key cut by a head or tail page edge is masked, never shown raw', async () => {
  const half = 65536 / 2;
  const words = Array.from({ length: 7000 }, (_, i) => String(i % 10).repeat(9) + '|').join('');
  assert.equal(words.length, 70000);
  // Two different runtime-built keys, so each check knows which edge it is about.
  const head = secret();
  const tail = 'sk-' + 'ant-api03-' + Array.from({ length: 48 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 5 + 1) % 36]).join('');
  const plant = (text, at, k) => text.slice(0, at - 1) + ' ' + k + ' ' + text.slice(at + k.length + 1);
  const answer = plant(plant(words, half - 20, head), words.length - half - 20, tail);
  assert.equal(answer.length, 70000);
  assert.equal(answer.indexOf(head), half - 20);
  assert.equal(answer.indexOf(tail), answer.length - half - 20);
  const { root, file } = tmpClaude([U('s5', '00', 'go'), A('s5', '01', 'm1', [{ type: 'text', text: answer }])], 's5');
  const e = await tmpEntry(file);
  const t = createTrace({ indexer: { entries: () => [e] }, light: [], roots: [root] });
  const out = (await t.example(t.keyFor('claude', 's5'), 0)).output.text;
  assert.match(out, /hidden›/);
  for (const k of [head, tail]) {
    assert.ok(!out.includes(k), 'never the whole key');
    // Nor the part of it on either side of the edge.
    assert.ok(!out.includes(k.slice(0, 20)) && !out.includes(k.slice(-20)), 'never a piece of the key');
  }
});
