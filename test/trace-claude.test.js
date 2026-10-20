const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeParser = require('../lib/claude');
const adapter = require('../lib/trace/claude');
const { validate, totals } = require('../lib/trace/model');

const dir = path.join(__dirname, 'fixtures', 'trace', 'claude', 'proj');
async function entriesFor(files) {
  const out = [];
  for (const file of files) out.push({ file, source: 'claude', size: fs.statSync(file).size, result: await claudeParser.parseFile(file) });
  return out;
}

test('sessions: one row per session, subagent files folded in', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')]);
  const rows = adapter.sessions(entries);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
  assert.equal(rows[0].turns, 2);
  assert.ok(rows[0].cost > 0);
});

test('skeleton of turn 0: turn → chat → Agent tool → subagent chat, then answer', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')]);
  const main = entries[0];
  const sk = await adapter.skeleton(main, 's1', { turn: 0, entries });
  assert.deepEqual(validate(sk.spans), []);
  // Time order. The Agent tool_use becomes one `agent` span (not a tool span plus an agent span).
  assert.deepEqual(
    sk.spans.map((s) => s.kind),
    ['session', 'turn', 'chat', 'agent', 'chat', 'chat', 'answer'],
  );
  const agent = sk.spans.find((s) => s.kind === 'agent');
  assert.equal(agent.name, 'invoke_agent Explore');
  const subChat = sk.spans.find((s) => s.parent === agent.id && s.kind === 'chat');
  assert.equal(subChat.model, 'claude-haiku-5-5');
  assert.equal(sk.turns.length, 2);
  // Spans carry references only: a ref is {s, e, k}, and no span holds the prompt text itself.
  for (const s of sk.spans) {
    for (const ref of [s.text, s.result]) assert.ok(ref == null || (typeof ref.s === 'number' && typeof ref.e === 'number' && typeof ref.k === 'string'), `span ${s.kind} carries a ref only`);
    assert.equal(JSON.stringify(s).includes('fix the login redirect'), false);
  }
  const t = totals(sk.spans);
  assert.equal(t.input, 100 + 50 + 150);
});

test('span ids are stable across rebuilds', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl')]);
  const a = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  const b = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  assert.deepEqual(a.spans.map((s) => s.id), b.spans.map((s) => s.id));
});

test('the skeleton reads only the chosen turn (byte range)', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl')]);
  const sk = await adapter.skeleton(entries[0], 's1', { turn: 1, entries });
  assert.equal(sk.spans.filter((s) => s.kind === 'chat').length, 1);
  assert.ok(sk.spans.every((s) => !s.text || s.text.s >= entries[0].result.sessions.s1.turns[1][0]));
});

const root = path.join(__dirname, 'fixtures', 'trace', 'claude');

test('sessions: a failing subagent adds its tools, errors, flag and cost to the parent', async () => {
  const main = path.join(dir, 's1.jsonl');
  const bare = adapter.sessions(await entriesFor([main]))[0];
  const withSub = adapter.sessions(await entriesFor([main, path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag3.jsonl')]))[0];
  assert.equal(bare.errors, 0);
  assert.equal(bare.flags.errors, false);
  assert.equal(withSub.tools, bare.tools + 1);
  assert.equal(withSub.errors, bare.errors + 1);
  assert.equal(withSub.flags.errors, true);
  assert.ok(withSub.cost > bare.cost);
});

test('skeleton: cache writes are in the usage and the chat costs sum to the session cost', async () => {
  const entries = await entriesFor([path.join(root, 'proj3', 'c1.jsonl')]);
  const sk = await adapter.skeleton(entries[0], 'c1', { entries });
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.equal(chats.length, 3, 'id-less messages are separate chats');
  assert.deepEqual(chats[0].usage, { input: 100, output: 10, cacheRead: 500, cacheWrite5m: 300, cacheWrite1h: 200 });
  const row = adapter.sessions(entries)[0];
  assert.ok(Math.abs(totals(sk.spans).cost - row.cost) < 1e-12, `${totals(sk.spans).cost} vs ${row.cost}`);
});

test('answer: none when the last chat has no text', async () => {
  const entries = await entriesFor([path.join(root, 'proj3', 'c1.jsonl')]);
  const sk = await adapter.skeleton(entries[0], 'c1', { entries });
  assert.equal(sk.spans.some((s) => s.kind === 'answer'), false);
});

test('a subagent that spawns a subagent nests two levels', async () => {
  const sub = path.join(root, 'proj2', 'n1', 'subagents');
  const entries = await entriesFor([path.join(root, 'proj2', 'n1.jsonl'), path.join(sub, 'agent-nx1.jsonl'), path.join(sub, 'agent-nx2.jsonl')]);
  const sk = await adapter.skeleton(entries[0], 'n1', { entries });
  assert.deepEqual(validate(sk.spans), []);
  const outer = sk.spans.find((s) => s.name === 'invoke_agent Outer');
  const inner = sk.spans.find((s) => s.name === 'invoke_agent Inner');
  assert.equal(inner.parent, outer.id);
  assert.equal(inner.kind, 'agent');
  const leaf = sk.spans.find((s) => s.kind === 'chat' && s.parent === inner.id);
  assert.equal(leaf.usage.input, 3);
});

test('skeleton: an unknown session is a 404, not a TypeError', async () => {
  const entries = await entriesFor([path.join(dir, 's1.jsonl'), path.join(dir, 's1', 'subagents', 'agent-ag1.jsonl')]);
  await assert.rejects(adapter.skeleton(entries[0], 'nope', { entries }), (e) => e.status === 404 && e.message === 'unknown session');
  // A subagent file has no turns of its own.
  await assert.rejects(adapter.skeleton(entries[1], 's1', { entries }), (e) => e.status === 404);
});

test('a bad timestamp or a non-object line does not leak NaN or throw', async () => {
  const f = path.join(os.tmpdir(), `trace-bad-${process.pid}.jsonl`);
  const lines = [
    '{"type":"user","sessionId":"b1","timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"user","content":"go"}}',
    '{"type":"assistant","sessionId":"b1","timestamp":"oops","message":{"id":"msg_b","role":"assistant","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"hi"}]}}',
    '[{"type":"assistant"}]', // valid JSON, but not an object
    '{"type":"user" broken',
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  try {
    const entries = await entriesFor([f]);
    const sk = await adapter.skeleton(entries[0], 'b1', { entries });
    assert.ok(sk.spans.every((s) => !Number.isNaN(s.start) && !Number.isNaN(s.end)));
    const chat = sk.spans.find((s) => s.kind === 'chat');
    assert.equal(chat.start, null);
    assert.equal(sk.spans.filter((s) => s.kind === 'unknown').length, 2);
    assert.equal(Number.isFinite(sk.spans.find((s) => s.kind === 'turn').end), true);
  } finally {
    fs.unlinkSync(f);
  }
});
