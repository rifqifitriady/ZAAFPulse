const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readRange } = require('../lib/trace/lines');
const claude = require('../lib/claude');
const codex = require('../lib/codex');

const F = path.join(__dirname, 'fixtures', 'trace');

test('claude: turns start at each typed prompt, with byte offsets', async () => {
  const file = path.join(F, 'claude', 'proj', 's1.jsonl');
  const r = await claude.parseFile(file);
  const s = r.sessions.s1;
  assert.equal(s.turns.length, 2);
  const first = (await readRange(file, s.turns[0][0], s.turns[0][0] + 200)).toString();
  assert.match(first, /^\{"type":"user".*fix the login redirect/);
  const second = (await readRange(file, s.turns[1][0], s.turns[1][0] + 200)).toString();
  assert.match(second, /now run the tests/);
  assert.equal(s.turns[1][1], Date.parse('2026-10-20T10:05:00.000Z'));
});

test('claude: the spawning tool_use is linked to the subagent file', async () => {
  const r = await claude.parseFile(path.join(F, 'claude', 'proj', 's1.jsonl'));
  assert.deepEqual(r.sessions.s1.agentLinks, [{ toolUseId: 'tu_1', agentId: 'ag1' }]);
  const sub = await claude.parseFile(path.join(F, 'claude', 'proj', 's1', 'subagents', 'agent-ag1.jsonl'));
  assert.equal(sub.sessions.s1.agentId, 'ag1');
  assert.deepEqual(sub.sessions.s1.turns, [], 'subagent prompts are not turns of their own');
});

test('codex: a turn per user message, with offsets', async () => {
  const file = path.join(F, 'codex', 'rollout-c1.jsonl');
  const r = await codex.parseFile(file);
  const s = Object.values(r.sessions)[0];
  assert.equal(s.turns.length, 2);
  assert.match((await readRange(file, s.turns[0][0], s.turns[0][0] + 120)).toString(), /add pagination/);
  assert.match((await readRange(file, s.turns[1][0], s.turns[1][0] + 120)).toString(), /also sort/);
  assert.equal(s.turns[0][1], Date.parse('2026-10-20T11:00:01.000Z'));
  assert.equal(s.turns[1][1], Date.parse('2026-10-20T11:01:00.000Z'));
});

test('codex: a log with task_started and user_message has one turn per prompt, at the user_message', async () => {
  const file = path.join(F, 'codex', 'rollout-mixed.jsonl');
  const s = Object.values((await codex.parseFile(file)).sessions)[0];
  assert.equal(s.turns.length, 2);
  assert.match((await readRange(file, s.turns[0][0], s.turns[0][0] + 120)).toString(), /first ask/);
  assert.match((await readRange(file, s.turns[1][0], s.turns[1][0] + 120)).toString(), /second ask/);
  assert.equal(s.turns[1][1], Date.parse('2026-10-20T12:01:00.500Z'));
});

test('codex: a log with only task_started has a turn at each task_started', async () => {
  const file = path.join(F, 'codex', 'rollout-tasks.jsonl');
  const s = Object.values((await codex.parseFile(file)).sessions)[0];
  assert.equal(s.turns.length, 2);
  for (const t of s.turns) assert.match((await readRange(file, t[0], t[0] + 120)).toString(), /task_started/);
  assert.equal(s.turns[1][1], Date.parse('2026-10-20T13:01:00.000Z'));
});

test('usage and signals are unchanged by the line reader', async () => {
  const r = await claude.parseFile(path.join(F, 'claude', 'proj', 's1.jsonl'));
  assert.equal(r.events.length, 3);
  assert.equal(r.sessions.s1.prompts, 2);
});
