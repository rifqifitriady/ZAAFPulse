const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  /* Node < 22.5 */
}
const { createKiro } = require('../lib/trace/kiro');
const { createGemini } = require('../lib/trace/gemini');
const { createAntigravity } = require('../lib/trace/antigravity');
const { validate, totals } = require('../lib/trace/model');

const F = path.join(__dirname, 'fixtures', 'trace');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `zp-${p}-`));
// Built at runtime so no secret-shaped string sits in the repo.
const SECRET = ['sk', 'ant', 'Ab3dE7gH1jK5mN9pQ2sT4vX6zC8'].join('-');
const cleanup = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

/* ---------- Kiro ---------- */

function kiroSession(root, sess, meta, lines) {
  const d = path.join(root, 'ws1', sess);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ id: sess, workspacePaths: ['/w/app'], createdAt: '2026-10-19T09:00:00Z', lastModifiedAt: '2026-10-19T09:01:00Z', ...meta }));
  fs.writeFileSync(path.join(d, 'messages.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''));
}

test('kiro: turns per execution, tool calls paired with their results', async () => {
  const k = createKiro({ root: path.join(F, 'kiro') });
  const rows = k.sessions();
  assert.equal(rows.length, 2);
  const r = rows.find((x) => x.id === 'sess_k1');
  assert.equal(r.source, 'kiro');
  assert.equal(r.title, 'Fix the login redirect');
  assert.equal(r.project, 'demo-app');
  assert.equal(r.turns, 2);
  assert.equal(r.tools, 3);
  assert.equal(r.errors, 1);
  assert.equal(r.cost, null);
  assert.equal(r.flags.errors, true);
  assert.equal(rows[0].id, 'sess_k1', 'newest first');

  const a = await k.skeleton(null, 'sess_k1', { turn: 0 });
  const b = await k.skeleton(null, 'sess_k1', { turn: 1 });
  assert.deepEqual(validate(a.spans), []);
  assert.deepEqual(validate(b.spans), []);
  assert.equal(a.turns.length, 2);
  const tools = [...a.spans, ...b.spans].filter((s) => s.kind === 'tool');
  assert.equal(tools.length, 3);
  assert.equal(tools.filter((s) => s.status === 'error').length, 1);
  assert.equal(totals([...a.spans, ...b.spans.filter((s) => s.kind === 'tool')]).errors, 1);
  const failed = tools.find((s) => s.status === 'error');
  assert.equal(failed.name, 'execute_tool executeBash');
  assert.equal(failed.tool.target, 'npm');
  assert.equal(failed.end - failed.start, 5000, 'duration comes from the line');
  assert.equal(a.spans.find((s) => s.kind === 'tool').tool.target, 'login.js');
  assert.ok(tools.every((s) => s.text === null && s.usage === null && s.cost === null));
  assert.equal(b.spans.filter((s) => s.kind === 'tool').length, 1);
  assert.equal(a.session.source, 'kiro');
});

test('kiro: a user message payload starts a turn; a call without a result is unknown', async () => {
  const k = createKiro({ root: path.join(F, 'kiro') });
  const r = k.sessions().find((x) => x.id === 'sess_k2');
  assert.equal(r.turns, 2);
  assert.equal(r.tools, 2);
  assert.equal(r.errors, 0);
  const last = await k.skeleton(null, 'sess_k2', {});
  assert.deepEqual(validate(last.spans), []);
  assert.equal(last.spans.find((s) => s.kind === 'turn').name, 'turn 2');
  assert.equal(last.spans.find((s) => s.kind === 'tool').status, 'unknown');
  const first = await k.skeleton(null, 'sess_k2', { turn: 0 });
  assert.equal(first.spans.find((s) => s.kind === 'tool').status, 'ok');
});

test('kiro: unknown ids are a 404 and lines without an execution id join the current turn', async () => {
  const root = tmp('kiro');
  const L = (t, p) => ({ id: t, timestamp: `2026-10-19T09:00:0${t}Z`, payload: p });
  kiroSession(root, 'sess_x', {}, [
    L(1, { type: 'tool_call', toolCallId: 'a', toolName: 'readFile', args: {}, status: 'completed', executionId: 'e1' }),
    L(2, { type: 'tool_result', toolCallId: 'a', success: true, durationMs: 10 }),
    L(3, { type: 'tool_call', toolCallId: 'b', toolName: 'readFile', args: {}, status: 'failed', executionId: 'e2' }),
  ]);
  const k = createKiro({ root });
  try {
    await assert.rejects(k.skeleton(null, 'nope', {}), (e) => e.status === 404 && e.message === 'unknown session');
    assert.equal(k.sessions()[0].turns, 2);
    const sk = await k.skeleton(null, 'sess_x', { turn: 0 });
    assert.equal(sk.spans.filter((s) => s.kind === 'tool')[0].status, 'ok');
    const sk2 = await k.skeleton(null, 'sess_x', { turn: 1 });
    assert.equal(sk2.spans.find((s) => s.kind === 'tool').status, 'error', 'a failed status with no result is an error');
  } finally {
    cleanup(root);
  }
});

test('kiro: the title is masked, one line and at most 80 characters', () => {
  const root = tmp('kiro');
  kiroSession(root, 'sess_t', { title: `deploy with ${SECRET}\nthen ${'long '.repeat(40)}` }, []);
  try {
    const [r] = createKiro({ root }).sessions();
    assert.ok(!r.title.includes(SECRET) && !r.title.includes(SECRET.slice(0, 20)));
    assert.match(r.title, /hidden/);
    assert.ok(!/\n/.test(r.title));
    assert.ok(r.title.length <= 80);
  } finally {
    cleanup(root);
  }
});

test('kiro: listings are cached for 30 s and capped at 500, newest first', () => {
  const root = tmp('kiro');
  for (let i = 0; i < 502; i++) kiroSession(root, `sess_${i}`, { lastModifiedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }, []);
  try {
    const k = createKiro({ root });
    const rows = k.sessions();
    assert.equal(rows.length, 500);
    assert.equal(rows[0].id, 'sess_501');
    assert.ok(!rows.some((r) => r.id === 'sess_0'));
    kiroSession(root, 'sess_new', {}, []);
    assert.equal(k.sessions().length, 500);
    assert.equal(createKiro({ root, ttl: 0 }).sessions().length, 500);
    const small = tmp('kiro');
    try {
      kiroSession(small, 'sess_a', {}, []);
      const k2 = createKiro({ root: small });
      assert.equal(k2.sessions().length, 1);
      kiroSession(small, 'sess_b', {}, []);
      assert.equal(k2.sessions().length, 1, 'cached');
      assert.equal(createKiro({ root: small }).sessions().length, 2);
    } finally {
      cleanup(small);
    }
  } finally {
    cleanup(root);
  }
});

test('kiro: available reports a missing folder', () => {
  assert.deepEqual(createKiro({ root: path.join(os.tmpdir(), 'zp-no-such-kiro') }).available(), { ok: false, reason: 'not installed' });
  assert.equal(createKiro({ root: path.join(F, 'kiro') }).available().ok, true);
  assert.equal(createKiro({ root: path.join(F, 'kiro') }).id, 'kiro');
});

/* ---------- Gemini CLI ---------- */

test('gemini: chat spans carry the usage, tool calls hang under their turn', async () => {
  const g = createGemini({ root: path.join(F, 'gemini') });
  const rows = g.sessions();
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, 'gemini');
  assert.equal(r.id, 'g-sess-1');
  assert.equal(r.title, 'Summarise the build script');
  assert.equal(r.turns, 2);
  assert.equal(r.tools, 2);
  assert.equal(r.errors, 1);
  assert.equal(r.cost, null);
  const a = await g.skeleton(null, r.id, { turn: 0 });
  assert.deepEqual(validate(a.spans), []);
  const chat = a.spans.find((s) => s.kind === 'chat');
  assert.equal(chat.model, 'gemini-2.5-pro');
  assert.deepEqual([chat.usage.input, chat.usage.output, chat.usage.cacheRead], [1200, 80, 400]);
  assert.equal(chat.text, null);
  const tools = a.spans.filter((s) => s.kind === 'tool');
  assert.deepEqual(tools.map((s) => s.status), ['ok', 'error']);
  assert.equal(tools[0].tool.target, 'build.sh');
  assert.equal(tools[1].tool.target, 'sh');
  const b = await g.skeleton(null, r.id, { turn: 1 });
  assert.deepEqual(validate(b.spans), []);
  assert.equal(b.spans.find((s) => s.kind === 'chat').usage.input, 2000);
  assert.equal(totals(b.spans).tools, 0);
  await assert.rejects(g.skeleton(null, 'nope', {}), (e) => e.status === 404);
});

test('gemini: the title is the masked first user message, null without one', () => {
  const root = tmp('gem');
  const dir = path.join(root, 'h1', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const msgs = [{ type: 'user', content: `use ${SECRET} please`, timestamp: '2026-10-19T09:00:00Z' }];
  fs.writeFileSync(path.join(dir, 'session-a.json'), JSON.stringify({ sessionId: 'a', messages: msgs }));
  fs.writeFileSync(path.join(dir, 'session-b.json'), JSON.stringify({ sessionId: 'b', messages: [{ type: 'gemini', content: 'hi' }] }));
  fs.writeFileSync(path.join(dir, 'session-c.json'), '{ not json');
  try {
    const rows = createGemini({ root }).sessions();
    assert.equal(rows.length, 2, 'an unreadable file is skipped');
    const a = rows.find((r) => r.id === 'a');
    assert.ok(!a.title.includes(SECRET) && !a.title.includes('Ab3dE7gH1jK5'));
    assert.match(a.title, /hidden/);
    assert.equal(rows.find((r) => r.id === 'b').title, null);
  } finally {
    cleanup(root);
  }
});

test('gemini: available reports a missing folder', () => {
  assert.deepEqual(createGemini({ root: path.join(os.tmpdir(), 'zp-no-such-gemini') }).available(), { ok: false, reason: 'not installed' });
  assert.equal(createGemini({ root: path.join(F, 'gemini') }).available().ok, true);
});

/* ---------- Antigravity ---------- */

// The real table, as read from the reference machine.
const SCHEMA = 'CREATE TABLE `conversation_summaries` (`conversation_id` text, `title` text NOT NULL DEFAULT "", `preview` text NOT NULL DEFAULT "", `step_count` integer NOT NULL DEFAULT 0, `last_modified_time` datetime NOT NULL, `workspace_uris` text NOT NULL, `status` text NOT NULL DEFAULT "", `source` text NOT NULL DEFAULT "", `project_id` text NOT NULL DEFAULT "", `agent_name` text NOT NULL DEFAULT "", `parent_conversation_id` text NOT NULL DEFAULT "", `nesting_depth` integer NOT NULL DEFAULT 0, `battle_id` text NOT NULL DEFAULT "", `winning_conversation_id` text NOT NULL DEFAULT "", `not_fully_idle` numeric NOT NULL DEFAULT false, `killed` numeric NOT NULL DEFAULT false, `last_user_input_time` datetime NOT NULL, `last_user_input_step_index` integer NOT NULL DEFAULT -1, `app_data_dir` text NOT NULL DEFAULT "", `raw_summary` blob, `group_id` text NOT NULL DEFAULT "", PRIMARY KEY (`conversation_id`))';
const ROWS = [
  // id, title, steps, agent, parent, depth, killed, modified, last input
  ['p', 'landing page', 34, 'main', '', 0, 0, '2026-10-19T10:00:00Z', '2026-10-19T09:00:00Z'],
  ['c1', 'sub a', 5, 'helper', 'p', 1, 0, '2026-10-19T09:30:00Z', '2026-10-19T09:10:00Z'],
  ['c2', 'sub b', 3, 'helper', 'p', 1, 0, '2026-10-19T09:40:00Z', '2026-10-19T09:20:00Z'],
];
function makeDb(db, rows = ROWS) {
  const w = new sqlite.DatabaseSync(db);
  w.exec(SCHEMA);
  const ins = w.prepare("INSERT INTO conversation_summaries (conversation_id, title, step_count, agent_name, parent_conversation_id, nesting_depth, killed, last_modified_time, last_user_input_time, workspace_uris, preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[\"file:///w/landing\"]', 'PREVIEW-TEXT')");
  for (const r of rows) ins.run(...r);
  return w;
}

test('antigravity: conversation level, read-only', { skip: !sqlite }, async () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  makeDb(db).close();
  const before = fs.statSync(db).mtimeMs;
  try {
    const a = createAntigravity({ files: [db] });
    assert.deepEqual(a.available(), { ok: true, reason: null });
    const rows = a.sessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].turns, 1);
    assert.equal(rows[0].id, 'p');
    assert.equal(rows[0].title, 'landing page');
    assert.equal(rows[0].project, 'landing');
    assert.equal(rows[0].cost, null);
    const sk = await a.skeleton(null, rows[0].id, {});
    assert.deepEqual(validate(sk.spans), []);
    const kids = sk.spans.filter((s) => s.kind === 'agent');
    assert.equal(kids.length, 2);
    assert.ok(kids.every((s) => /\d+ steps/.test(s.tool.target) && s.text === null && s.parent === sk.spans[0].id));
    assert.match(kids.find((s) => s.tool.target.startsWith('5')).tool.target, /^5 steps/);
    assert.equal(sk.spans.length, 3);
    assert.equal(JSON.stringify(sk).includes('PREVIEW-TEXT'), false, 'the preview text is never read');
    await assert.rejects(a.skeleton(null, 'c1', {}), (e) => e.status === 404, 'a sub-conversation is not a session of its own');
    assert.equal(fs.statSync(db).mtimeMs, before);
  } finally {
    cleanup(dir);
  }
});

test('antigravity: opens a WAL database while its writer is still running, without touching it', { skip: !sqlite }, () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  const w = makeDb(db);
  try {
    w.exec('PRAGMA journal_mode=WAL');
    w.exec("UPDATE conversation_summaries SET title = 'in the wal' WHERE conversation_id = 'p'");
    const before = fs.statSync(db).mtimeMs;
    const rows = createAntigravity({ files: [db] }).sessions();
    assert.equal(rows.length, 1);
    assert.equal(fs.statSync(db).mtimeMs, before);
  } finally {
    w.close();
    cleanup(dir);
  }
});

test('antigravity: a locked database is read from a copy that is deleted afterwards', { skip: !sqlite }, () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  const w = makeDb(db);
  const copies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zp-agcopy-'));
  const had = copies().length;
  try {
    w.exec('BEGIN EXCLUSIVE');
    const rows = createAntigravity({ files: [db] }).sessions();
    assert.equal(rows.length, 1);
    assert.equal(copies().length, had, 'no copy left behind');
  } finally {
    w.close();
    cleanup(dir);
  }
});

test('antigravity: masked title, killed means error, an orphan child is its own session', { skip: !sqlite }, async () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  makeDb(db, [
    ['p', `fix ${SECRET}\nnow`, 4, 'main', '', 0, 0, '2026-10-19T10:00:00Z', '2026-10-19T09:00:00Z'],
    ['c1', 'child', 2, 'helper', 'p', 1, 1, '2026-10-19T09:30:00Z', '2026-10-19T09:10:00Z'],
    ['g1', 'grandchild', 1, 'helper', 'c1', 2, 0, '2026-10-19T09:31:00Z', '2026-10-19T09:20:00Z'],
    ['o', 'orphan', 1, 'main', 'gone', 1, 0, '2026-10-18T10:00:00Z', '2026-10-18T09:00:00Z'],
  ]).close();
  try {
    const a = createAntigravity({ files: [db, path.join(dir, 'missing.db')] });
    const rows = a.sessions();
    assert.deepEqual(rows.map((r) => r.id), ['p', 'o']);
    assert.ok(!rows[0].title.includes(SECRET) && !rows[0].title.includes('Ab3dE7gH1jK5'));
    assert.match(rows[0].title, /hidden/);
    assert.ok(!/\n/.test(rows[0].title) && rows[0].title.length <= 80);
    assert.equal(rows[0].errors, 1);
    assert.equal(rows[0].flags.errors, true);
    const sk = await a.skeleton(null, 'p', {});
    assert.deepEqual(validate(sk.spans), []);
    const agents = sk.spans.filter((s) => s.kind === 'agent');
    assert.equal(agents.length, 2);
    assert.equal(agents.find((s) => s.name.includes('helper') && s.status === 'error').parent, sk.spans[0].id);
    assert.equal(agents.find((s) => s.status === 'ok').parent, agents.find((s) => s.status === 'error').id);
    assert.equal(JSON.stringify(sk).includes('Ab3dE7gH1jK5'), false);
  } finally {
    cleanup(dir);
  }
});

test('antigravity: reports why it is unavailable', () => {
  const missing = createAntigravity({ files: [path.join(os.tmpdir(), 'zp-no-such.db')] }).available();
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, sqlite ? 'not installed' : 'needs Node 22.5 or newer');
});

/* ---------- Defaults ---------- */

test('the default instances touch no disk when required', () => {
  const names = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'openSync', 'realpathSync', 'opendirSync', 'accessSync'];
  const orig = {};
  let hits = 0;
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function (...a) {
      if (/[\\/]\.(kiro|gemini)/.test(String(a[0]))) hits++;
      return orig[n].apply(this, a);
    };
  }
  const mods = ['kiro', 'gemini', 'antigravity'].map((n) => require.resolve(`../lib/trace/${n}`));
  try {
    for (const m of mods) delete require.cache[m];
    const loaded = mods.map((m) => require(m));
    assert.equal(hits, 0);
    assert.deepEqual(loaded.map((m) => m.id), ['kiro', 'gemini', 'antigravity']);
    for (const m of loaded) assert.equal(typeof m.available, 'function');
  } finally {
    for (const n of names) fs[n] = orig[n];
  }
});
