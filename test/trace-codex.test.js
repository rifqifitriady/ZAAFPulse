const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codexParser = require('../lib/codex');
const adapter = require('../lib/trace/codex');
const { validate, totals } = require('../lib/trace/model');
const { createContent } = require('../lib/trace/content');

const F = path.join(__dirname, 'fixtures', 'trace', 'codex');
const entryOf = async (file) => ({ file, source: 'codex', size: fs.statSync(file).size, result: await codexParser.parseFile(file) });
const entry = (name) => entryOf(path.join(F, name));
const skel = async (name, turn) => {
  const e = await entry(name);
  const sid = Object.keys(e.result.sessions)[0];
  return { e, sid, sk: await adapter.skeleton(e, sid, { turn, entries: [e] }) };
};
const content = createContent({ roots: [F] });
const textOf = async (ref) => (await content.read(ref)).text;

// A throwaway log for the cases the shared fixtures do not cover.
function tmpLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-codex-'));
  const file = path.join(dir, 'rollout-x.jsonl');
  fs.writeFileSync(file, lines.map((o) => (typeof o === 'string' ? o : JSON.stringify(o)) + '\n').join(''));
  return { dir, file };
}
const L = (ts, type, payload) => ({ timestamp: `2026-10-20T15:00:${ts}Z`, type, payload });

test('codex turn: chat from token counts, a shell tool paired by call id', async () => {
  const e = await entry('rollout-c1.jsonl');
  const sid = Object.keys(e.result.sessions)[0];
  const sk = await adapter.skeleton(e, sid, { turn: 0, entries: [e] });
  assert.deepEqual(validate(sk.spans), []);
  const tool = sk.spans.find((s) => s.kind === 'tool');
  assert.equal(tool.name, 'execute_tool shell');
  assert.equal(tool.status, 'ok');
  assert.equal(tool.tool.target, 'ls');
  const chat = sk.spans.find((s) => s.kind === 'chat');
  assert.equal(chat.model, 'gpt-5.3-codex');
  assert.equal(chat.usage.input, 300);
});

test('codex fork: copied parent history is not part of the turn', async () => {
  const e = await entry('rollout-fork.jsonl');
  const sid = Object.keys(e.result.sessions)[0];
  const sk = await adapter.skeleton(e, sid, { turn: 0, entries: [e] });
  assert.equal(sk.spans.filter((s) => s.kind === 'chat').length, 1);
});

test('codex fork: the first request is counted against the copied history total, as the parser does', async () => {
  const tc = (ts, input, output) =>
    L(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output }, last_token_usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 15, total_tokens: 135 } } });
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'fk', forked_from_id: 'p1' }),
    L('00.100', 'event_msg', { type: 'task_started' }),
    tc('00.200', 300, 30),
    L('30.000', 'event_msg', { type: 'task_started' }),
    tc('33.000', 420, 45),
    tc('36.000', 520, 60),
  ]);
  const e = await entryOf(file);
  assert.equal(e.result.sessions.fk.turns.length, 1);
  const sk = await adapter.skeleton(e, 'fk', { turn: 0, entries: [e] });
  assert.deepEqual(sk.spans.filter((s) => s.kind === 'chat').map((c) => [c.usage.input, c.usage.output]), [[120, 15], [100, 15]]);
});

test('sessions: one row per Codex log, with turns, tools and cost', async () => {
  const entries = [await entry('rollout-c1.jsonl'), await entry('rollout-new.jsonl')];
  const rows = adapter.sessions([...entries, { file: 'x', source: 'claude', size: 0, result: { sessions: {} } }]);
  assert.deepEqual(rows.map((r) => r.id).sort(), ['c1', 'n1']);
  const c1 = rows.find((r) => r.id === 'c1');
  assert.equal(c1.source, 'codex');
  assert.equal(c1.turns, 2);
  assert.equal(c1.tools, 1);
  assert.equal(c1.title, null);
  assert.ok(rows.find((r) => r.id === 'n1').cost > 0);
});

test('an unknown session, or a log with no turns, is a 404', async () => {
  const e = await entry('rollout-c1.jsonl');
  await assert.rejects(adapter.skeleton(e, 'nope', { turn: 0, entries: [e] }), { status: 404 });
  const { file } = tmpLog([L('00.000', 'session_meta', { id: 'z' })]);
  const z = await entryOf(file);
  await assert.rejects(adapter.skeleton(z, 'z', { turn: 0, entries: [z] }), { status: 404 });
});

test('turn is clamped, and the last turn is the default', async () => {
  const e = await entry('rollout-new.jsonl');
  assert.equal((await adapter.skeleton(e, 'n1', { entries: [e] })).spans.find((s) => s.kind === 'turn').name, 'turn 2');
  assert.equal((await adapter.skeleton(e, 'n1', { turn: 9, entries: [e] })).spans.find((s) => s.kind === 'turn').name, 'turn 2');
  assert.equal((await adapter.skeleton(e, 'n1', { turn: -3, entries: [e] })).spans.find((s) => s.kind === 'turn').name, 'turn 1');
});

// --- the newer log form: task_started, response_item messages ---

test('new form turn 1: a tool and a chat from the token count, no answer', async () => {
  const { sk } = await skel('rollout-new.jsonl', 0);
  assert.deepEqual(validate(sk.spans), []);
  assert.equal(sk.turns.length, 2);
  assert.deepEqual(
    sk.spans.map((s) => s.kind),
    ['session', 'turn', 'tool', 'chat'],
  );
  const tool = sk.spans.find((s) => s.kind === 'tool');
  assert.equal(tool.name, 'execute_tool shell');
  assert.equal(tool.status, 'ok');
  assert.equal(tool.tool.target, 'ls');
  const chat = sk.spans.find((s) => s.kind === 'chat');
  assert.equal(chat.model, 'gpt-5.3-codex');
  assert.deepEqual(chat.usage, { input: 400, output: 40, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.ok(chat.cost > 0);
  assert.equal(totals(sk.spans).tools, 1);
});

test('new form turn 2: chat, reply text and an answer span', async () => {
  const { sk } = await skel('rollout-new.jsonl', 1);
  assert.deepEqual(validate(sk.spans), []);
  assert.deepEqual(
    sk.spans.map((s) => s.kind),
    ['session', 'turn', 'chat', 'answer'],
  );
  const chat = sk.spans.find((s) => s.kind === 'chat');
  // 900-500 input of which 300-100 was cached; cumulative totals become this request's delta.
  assert.deepEqual(chat.usage, { input: 200, output: 50, cacheRead: 200, cacheWrite5m: 0, cacheWrite1h: 0 });
  const answer = sk.spans.find((s) => s.kind === 'answer');
  assert.equal(answer.text.src, 'codex');
  assert.equal(await textOf(answer.text), 'Added the test.');
  assert.equal(await textOf(chat.text), 'Added the test.');
});

test('new form: the prompt is the typed text, never the injected environment context', async () => {
  for (const [turn, want] of [
    [0, 'fix the login redirect'],
    [1, 'now add a test'],
  ]) {
    const { sk } = await skel('rollout-new.jsonl', turn);
    const t = sk.spans.find((s) => s.kind === 'turn');
    assert.equal(t.text.k, 'prompt');
    assert.equal(t.text.src, 'codex');
    assert.ok(t.text.e > t.text.s, 'the ref spans the whole turn');
    const text = await textOf(t.text);
    assert.equal(text, want);
    assert.ok(!text.includes('environment_context'));
  }
});

test('new form: tool refs carry the call id and read back the call and its output', async () => {
  const { sk } = await skel('rollout-new.jsonl', 0);
  const tool = sk.spans.find((s) => s.kind === 'tool');
  assert.equal(tool.text.i, 'k1');
  assert.equal(tool.result.i, 'k1');
  assert.equal(tool.text.src, 'codex');
  assert.deepEqual(JSON.parse(await textOf(tool.text)), { command: ['bash', '-lc', 'ls src'] });
  assert.match(await textOf(tool.result), /^Exit code: 0[\s\S]*login\.js/);
});

test('old form: prompt comes from user_message, reply from agent_message', async () => {
  const { sk } = await skel('rollout-mixed.jsonl', 0);
  assert.equal(await textOf(sk.spans.find((s) => s.kind === 'turn').text), 'first ask');
  const answer = sk.spans.find((s) => s.kind === 'answer');
  assert.equal(await textOf(answer.text), 'ok');
  const { sk: c1 } = await skel('rollout-c1.jsonl', 0);
  assert.equal(await textOf(c1.spans.find((s) => s.kind === 'turn').text), 'add pagination');
});

test('a log with task_started only still gives one turn per task', async () => {
  const { sk } = await skel('rollout-tasks.jsonl', 0);
  assert.deepEqual(validate(sk.spans), []);
  assert.deepEqual(sk.spans.map((s) => s.kind), ['session', 'turn', 'answer']);
});

// --- cases built on the fly ---

test('a failing shell call is an error span with a signal; a call with no output is unknown', async () => {
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'z1' }),
    L('01.000', 'event_msg', { type: 'task_started' }),
    L('02.000', 'response_item', { type: 'function_call', name: 'shell', call_id: 'a', arguments: '{"command":["bash","-lc","cat nope.txt"]}' }),
    L('03.000', 'response_item', { type: 'function_call_output', call_id: 'a', output: 'cat: nope.txt: No such file or directory\nExit code: 1' }),
    L('04.000', 'response_item', { type: 'function_call', name: 'shell', call_id: 'b', arguments: '{"cmd":"sleep 9"}' }),
    L('05.000', 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c', input: '*** Begin Patch\n*** Update File: src/app.js\n*** End Patch' }),
    L('06.000', 'response_item', { type: 'custom_tool_call_output', call_id: 'c', output: 'Done!' }),
    L('07.000', 'response_item', { type: 'web_search_call', action: { type: 'search', query: 'node test runner' } }),
  ]);
  const e = await entryOf(file);
  const sk = await adapter.skeleton(e, 'z1', { turn: 0, entries: [e] });
  assert.deepEqual(validate(sk.spans), []);
  const byId = (name) => sk.spans.filter((s) => s.kind === 'tool' && s.name === name);
  const [a, b] = byId('execute_tool shell');
  assert.equal(a.status, 'error');
  assert.equal(a.signals.length, 1);
  assert.equal(a.tool.target, 'cat');
  assert.equal(b.status, 'unknown');
  assert.equal(b.tool.target, 'sleep');
  const patch = byId('execute_tool apply_patch')[0];
  assert.equal(patch.status, 'ok');
  assert.equal(patch.tool.target, 'app.js');
  const ws = byId('execute_tool web_search')[0];
  assert.equal(ws.status, 'ok');
  assert.deepEqual(JSON.parse(await createContent({ roots: [path.dirname(file)] }).read(ws.text).then((r) => r.text)), { type: 'search', query: 'node test runner' });
  assert.equal(totals(sk.spans).errors, 1);
});

test('turn_aborted marks the turn as an interrupted error', async () => {
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'z2' }),
    L('01.000', 'event_msg', { type: 'task_started' }),
    L('02.000', 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
  ]);
  const e = await entryOf(file);
  const sk = await adapter.skeleton(e, 'z2', { turn: 0, entries: [e] });
  const t = sk.spans.find((s) => s.kind === 'turn');
  assert.equal(t.status, 'error');
  assert.deepEqual(t.signals, ['interrupted']);
});

test('chats follow each token count; a repeated snapshot makes none', async () => {
  const tc = (ts, input, output) => L(ts, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } });
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'z3' }),
    L('01.000', 'event_msg', { type: 'task_started' }),
    L('02.000', 'turn_context', { model: 'gpt-5.3-codex' }),
    tc('03.000', 100, 10),
    tc('03.500', 100, 10),
    L('04.000', 'event_msg', { type: 'token_count', info: null }),
    tc('05.000', 250, 30),
  ]);
  const e = await entryOf(file);
  const sk = await adapter.skeleton(e, 'z3', { turn: 0, entries: [e] });
  assert.deepEqual(validate(sk.spans), []);
  const chats = sk.spans.filter((s) => s.kind === 'chat');
  assert.deepEqual(chats.map((c) => [c.usage.input, c.usage.output]), [[100, 10], [150, 20]]);
  assert.ok(chats[0].start <= chats[0].end && chats[1].start >= chats[0].end);
});

test('an unreadable line is an unknown span and a missing timestamp never becomes NaN', async () => {
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'z4' }),
    L('01.000', 'event_msg', { type: 'task_started' }),
    '{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"q"',
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'n', arguments: '{"cmd":"ls"}' } },
  ]);
  const e = await entryOf(file);
  const sk = await adapter.skeleton(e, 'z4', { turn: 0, entries: [e] });
  const bad = sk.spans.find((s) => s.kind === 'unknown');
  assert.equal(bad.text.k, 'raw');
  assert.equal(bad.status, 'unknown');
  for (const s of sk.spans) for (const k of ['start', 'end']) assert.ok(s[k] === null || Number.isFinite(s[k]), `${s.kind}.${k}`);
});

test('a shell call is named by its program, never by an env assignment that holds a key', async () => {
  const secret = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-'); // built here so no key sits in the repo
  const { file } = tmpLog([
    L('00.000', 'session_meta', { id: 'cmd1' }),
    L('01.000', 'event_msg', { type: 'task_started' }),
    L('02.000', 'response_item', { type: 'function_call', name: 'shell', call_id: 'a', arguments: JSON.stringify({ command: ['bash', '-lc', `API_KEY=${secret} node deploy.js`] }) }),
    L('03.000', 'response_item', { type: 'function_call', name: 'shell', call_id: 'b', arguments: JSON.stringify({ cmd: 'sudo env FOO=1 /usr/bin/git push' }) }),
  ]);
  const e = await entryOf(file);
  const sk = await adapter.skeleton(e, 'cmd1', { turn: 0, entries: [e] });
  assert.deepEqual(sk.spans.filter((s) => s.kind === 'tool').map((s) => s.tool.target), ['node', 'git']);
  assert.equal(JSON.stringify(sk).includes('Ab3dE7gH1jK5'), false);
});
