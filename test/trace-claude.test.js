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

test('a Bash call is named by its program, never by an env assignment that holds a key', async () => {
  const secret = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-'); // built here so no key sits in the repo
  const f = path.join(os.tmpdir(), `trace-cmd-${process.pid}.jsonl`);
  const use = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
  const lines = [
    { type: 'user', sessionId: 'cmd1', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'deploy' } },
    { type: 'assistant', sessionId: 'cmd1', timestamp: '2026-10-20T10:00:02.000Z', requestId: 'r1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [use('t1', `API_KEY=${secret} node deploy.js`), use('t2', 'sudo env FOO=1 /usr/bin/git push')] } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const entries = await entriesFor([f]);
    const sk = await adapter.skeleton(entries[0], 'cmd1', { turn: 0, entries });
    const targets = sk.spans.filter((s) => s.kind === 'tool').map((s) => s.tool.target);
    assert.deepEqual(targets, ['node', 'git']);
    assert.equal(JSON.stringify(sk).includes('Ab3dE7gH1jK5'), false);
  } finally {
    fs.unlinkSync(f);
  }
});

// Names stay on show with content off, so a tool name, a subagent type or a file name is masked and capped.
test('tool names, subagent types and file names are masked and capped at 80 characters', async () => {
  const key = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-'); // built here so no key sits in the repo
  const long = 'x'.repeat(200);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-claude-mask-'));
  fs.cpSync(dir, path.join(tmp, 'proj'), { recursive: true });
  const main = path.join(tmp, 'proj', 's1.jsonl');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('"subagent_type":"Explore"', `"subagent_type":"Explore ${key} ${long}"`));
  const sid = 'mk1';
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const lines = [
    { type: 'user', sessionId: sid, timestamp: '2026-10-20T10:00:01.000Z', cwd: '/w/p', message: { role: 'user', content: 'go' } },
    { type: 'assistant', sessionId: sid, timestamp: '2026-10-20T10:00:02.000Z', requestId: 'r1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [use('t1', `mcp.${key}.x`, { file_path: `/w/p/${key}.${long}.txt` }), use('t2', 'WebFetch', { url: `https://${long}.example.com/` })] } },
  ];
  const other = path.join(tmp, 'proj', 'mk1.jsonl');
  fs.writeFileSync(other, lines.map((o) => JSON.stringify(o) + '\n').join(''));
  const entries = await entriesFor([main, path.join(tmp, 'proj', 's1', 'subagents', 'agent-ag1.jsonl'), other]);
  const agent = (await adapter.skeleton(entries[0], 's1', { turn: 0, entries })).spans.find((s) => s.kind === 'agent');
  const tools = (await adapter.skeleton(entries[2], sid, { entries })).spans.filter((s) => s.kind === 'tool');
  const shown = [agent.name, ...tools.flatMap((t) => [t.name, t.tool.name, t.tool.target])];
  for (const v of shown) {
    assert.ok(!v.includes(key), `no key in ${v.slice(0, 40)}`);
    assert.ok(v.replace(/^(execute_tool|invoke_agent) /, '').length <= 80, `capped: ${v.length}`);
  }
  assert.match(agent.name, /^invoke_agent Explore \u2039/);
  assert.match(tools[0].tool.target, /hidden/);
});

test('a skeleton line over the read limit fails with 413 instead of being buffered whole', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-claude-big-'));
  const file = path.join(tmp, 'big.jsonl');
  const user = { type: 'user', sessionId: 'big', timestamp: '2026-10-20T10:00:01.000Z', cwd: '/w/p', message: { role: 'user', content: 'go' } };
  const huge = { type: 'assistant', sessionId: 'big', timestamp: '2026-10-20T10:00:02.000Z', requestId: 'r1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'y'.repeat(17 * 1024 * 1024) }] } };
  fs.writeFileSync(file, JSON.stringify(user) + '\n' + JSON.stringify(huge) + '\n');
  const [e] = await entriesFor([file]);
  await assert.rejects(adapter.skeleton(e, 'big', { entries: [e] }), (er) => er.status === 413);
});
