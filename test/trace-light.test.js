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
const crypto = require('crypto');
const { createKiro } = require('../lib/trace/kiro');
const { createGemini } = require('../lib/trace/gemini');
const { createAntigravity } = require('../lib/trace/antigravity');
const { validate, totals, commandName } = require('../lib/trace/model');
const L = require('../lib/trace/light');

// Read-only opens need Node 22.12; earlier Node would open the database read-write.
const [major, minor] = process.versions.node.split('.').map(Number);
const sqliteOk = !!sqlite && (major > 22 || (major === 22 && minor >= 12));

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
  for (let i = 0; i < 502; i++) {
    kiroSession(root, `sess_${i}`, { lastModifiedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }, []);
    const at = new Date(Date.UTC(2026, 0, 1) + i * 1000);
    fs.utimesSync(path.join(root, 'ws1', `sess_${i}`, 'messages.jsonl'), at, at);
  }
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

test('antigravity: conversation level, read-only', { skip: !sqliteOk }, async () => {
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

test('antigravity: opens a WAL database while its writer is still running, without touching its file', { skip: !sqliteOk }, () => {
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

test('antigravity: a locked database is read from a copy that is deleted afterwards', { skip: !sqliteOk }, () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  const w = makeDb(db);
  const copies = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zp-agcopy-'));
  const had = copies().length;
  try {
    w.exec('BEGIN EXCLUSIVE');
    let copied = 0;
    const rows = createAntigravity({ files: [db], onCopy: () => copied++ }).sessions();
    assert.equal(rows.length, 1);
    assert.equal(copied, 1, 'the copy branch ran');
    assert.equal(copies().length, had, 'no copy left behind');
  } finally {
    w.close();
    cleanup(dir);
  }
});

test('antigravity: masked title, killed means error, an orphan child is its own session', { skip: !sqliteOk }, async () => {
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
  assert.equal(missing.reason, sqliteOk ? 'not installed' : 'needs Node 22.12 or newer');
});

test('antigravity: below Node 22.12 nothing opens the database (earlier 22.x ignores readOnly)', () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  fs.writeFileSync(db, 'not a database');
  let opened = 0;
  const stub = {
    DatabaseSync: class {
      constructor(file, opts) {
        opened++;
        if (opts && opts.readOnly) throw new Error('unable to open database file'); // what a Node that honours readOnly does
      }
    },
  };
  try {
    for (const v of ['22.5.0', '22.9.1', '22.11.0', '20.18.0', '18.20.4']) {
      const a = createAntigravity({ files: [db], version: v, sqlite: stub });
      assert.deepEqual(a.available(), { ok: false, reason: 'needs Node 22.12 or newer' }, v);
      assert.deepEqual(a.sessions(), []);
    }
    assert.equal(opened, 0);
    for (const v of ['22.12.0', '22.20.1', '23.0.0', '24.16.0']) assert.equal(createAntigravity({ files: [db], version: v, sqlite: stub }).available().ok, true, v);
  } finally {
    cleanup(dir);
  }
});

test('antigravity: a Node that ignores readOnly makes the source unavailable, once, leaving no probe folder', () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  fs.writeFileSync(db, 'x');
  const probes = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('zp-agprobe-'));
  const had = probes().length;
  let opened = 0;
  const lenient = {
    DatabaseSync: class {
      constructor(file) {
        opened++;
        fs.writeFileSync(file, ''); // ignores readOnly: creates the file like a read-write open
      }
      close() {}
      prepare() {
        throw new Error('must not be queried');
      }
    },
  };
  try {
    const a = createAntigravity({ files: [db], sqlite: lenient });
    assert.deepEqual(a.available(), { ok: false, reason: 'read-only SQLite not supported by this Node' });
    assert.deepEqual(a.sessions(), []);
    assert.equal(opened, 1, 'the probe ran once and the database was never opened');
    assert.equal(probes().length, had);
    // a stand-in that throws but still leaves a file behind is no better
    const messy = { DatabaseSync: class { constructor(file) { fs.writeFileSync(file, ''); throw new Error('boom'); } } };
    assert.equal(createAntigravity({ files: [db], sqlite: messy }).available().ok, false);
    assert.equal(probes().length, had);
  } finally {
    cleanup(dir);
  }
});

const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

test('antigravity: a WAL database whose writer has gone is read without changing the db or the -wal', { skip: !sqliteOk }, () => {
  const live = tmp('ag');
  const dir = tmp('ag');
  const w = makeDb(path.join(live, 'conversation_summaries.db'));
  try {
    w.exec('PRAGMA journal_mode=WAL');
    w.exec('PRAGMA wal_autocheckpoint=0');
    w.exec("UPDATE conversation_summaries SET title = 'in the wal' WHERE conversation_id = 'p'");
    // What a crashed or killed app leaves behind: the main file and a -wal that was never checkpointed.
    const db = path.join(dir, 'conversation_summaries.db');
    fs.copyFileSync(path.join(live, 'conversation_summaries.db'), db);
    fs.copyFileSync(path.join(live, 'conversation_summaries.db-wal'), `${db}-wal`);
    assert.ok(fs.statSync(`${db}-wal`).size > 0);
    const before = { db: sha(db), wal: sha(`${db}-wal`), dbSize: fs.statSync(db).size, walSize: fs.statSync(`${db}-wal`).size };
    const rows = createAntigravity({ files: [db] }).sessions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'in the wal', 'the -wal is read');
    assert.equal(sha(db), before.db);
    assert.equal(sha(`${db}-wal`), before.wal);
    assert.equal(fs.statSync(db).size, before.dbSize);
    assert.equal(fs.statSync(`${db}-wal`).size, before.walSize);
  } finally {
    w.close();
    cleanup(live, dir);
  }
});

test('antigravity: SQLITE_CANTOPEN on the read-only open falls back to a copy', { skip: !sqliteOk }, () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  makeDb(db).close();
  const real = sqlite.DatabaseSync;
  const stub = {
    DatabaseSync: class extends real {
      constructor(file, opts) {
        if (opts && opts.readOnly) throw Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });
        super(file, opts);
      }
    },
  };
  const copied = [];
  try {
    const rows = createAntigravity({ files: [db], sqlite: stub, onCopy: (f) => copied.push(f) }).sessions();
    assert.equal(rows.length, 1);
    assert.deepEqual(copied, [db]);
  } finally {
    cleanup(dir);
  }
});

test('antigravity: a root beyond the 500 cap can still be opened; self-parents and cycles keep their conversations', { skip: !sqliteOk }, async () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  const rows = [];
  for (let i = 0; i < 502; i++) rows.push([`r${i}`, `root ${i}`, 1, 'main', '', 0, 0, new Date(Date.UTC(2026, 5, 1) + i * 60000).toISOString(), new Date(Date.UTC(2026, 5, 1) + i * 60000).toISOString()]);
  rows.push(['self', 'self parent', 1, 'main', 'self', 1, 0, '2026-01-01T01:00:00Z', '2026-01-01T00:00:00Z']);
  rows.push(['x', 'cycle x', 1, 'a', 'y', 1, 0, '2026-01-02T02:00:00Z', '2026-01-02T01:00:00Z']);
  rows.push(['y', 'cycle y', 1, 'b', 'z', 1, 0, '2026-01-02T03:00:00Z', '2026-01-02T01:30:00Z']);
  rows.push(['z', 'cycle z', 1, 'c', 'x', 1, 0, '2026-01-02T04:00:00Z', '2026-01-02T01:45:00Z']);
  const w = makeDb(db, []);
  w.exec('BEGIN');
  const ins = w.prepare("INSERT INTO conversation_summaries (conversation_id, title, step_count, agent_name, parent_conversation_id, nesting_depth, killed, last_modified_time, last_user_input_time, workspace_uris) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')");
  for (const r of rows) ins.run(...r);
  w.exec('COMMIT');
  w.close();
  try {
    const a = createAntigravity({ files: [db], minRefresh: 0 });
    const list = a.sessions();
    assert.equal(list.length, 500);
    assert.ok(!list.some((r) => r.id === 'r0'), 'r0 is the oldest, past the cap');
    const sk = await a.skeleton(null, 'r0', {});
    assert.equal(sk.session.id, 'r0');
    assert.deepEqual(validate(sk.spans), []);
    await assert.rejects(a.skeleton(null, 'nope', {}), (e) => e.status === 404 && e.message === 'unknown session');
    const self = await a.skeleton(null, 'self', {});
    assert.equal(self.spans.length, 1, 'a self-parent is a plain root');
    // x is the oldest of the ring x -> y -> z -> x: it is the root, the others hang below it.
    const ring = await a.skeleton(null, 'x', {});
    assert.deepEqual(validate(ring.spans), []);
    assert.deepEqual(ring.spans.map((s) => s.name), ['invoke_agent a', 'invoke_agent c', 'invoke_agent b']);
    await assert.rejects(a.skeleton(null, 'y', {}), (e) => e.status === 404);
  } finally {
    cleanup(dir);
  }
});

test('antigravity: agent names are masked and capped', { skip: !sqliteOk }, async () => {
  const dir = tmp('ag');
  const db = path.join(dir, 'conversation_summaries.db');
  makeDb(db, [
    ['p', 't', 1, 'main', '', 0, 0, '2026-10-19T10:00:00Z', '2026-10-19T09:00:00Z'],
    ['c', 't', 1, `${SECRET} ${'n'.repeat(200)}`, 'p', 1, 0, '2026-10-19T09:30:00Z', '2026-10-19T09:10:00Z'],
  ]).close();
  try {
    const sk = await createAntigravity({ files: [db] }).skeleton(null, 'p', {});
    const kid = sk.spans[1];
    assert.ok(!JSON.stringify(sk).includes('Ab3dE7gH1jK5'));
    assert.ok(kid.tool.name.length <= 80 && kid.name.length <= 80 + 'invoke_agent '.length);
  } finally {
    cleanup(dir);
  }
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

/* ---------- Command names, bounded listings, odd input ---------- */

test('commandName: skips env assignments and wrappers, keeps only the program', () => {
  assert.equal(commandName(`API_KEY=${SECRET} node deploy.js`), 'node');
  assert.equal(commandName('sudo env FOO=1 /usr/bin/git push'), 'git');
  assert.equal(commandName('nohup time -p ./run.sh --flag'), 'run.sh');
  assert.equal(commandName('FOO=1 BAR=2'), null);
  assert.equal(commandName('"C:\\tools\\node.exe" x'), 'node.exe');
  assert.equal(commandName(SECRET), null, 'a program name that is itself a key is not shown');
  assert.equal(commandName(''), null);
  // a quoted value with spaces is skipped whole
  assert.equal(commandName("PASSWORD='my secret pass' ./run"), 'run');
  assert.equal(commandName("PASSWORD='a b c' ./run"), 'run');
  assert.equal(commandName('API_KEY="abc def" node'), 'node');
  assert.equal(commandName('X="a b" node app.js'), 'node');
  assert.equal(commandName('A="x y" B=2 node'), 'node');
  assert.equal(commandName("Y='unterminated a b"), null);
  // only NAME= is an assignment: a path with = in it is a program
  assert.equal(commandName('/data/dir=x/tool run'), 'tool');
  // wrapper options that take a value
  assert.equal(commandName('sudo -u bob git push'), 'git');
  assert.equal(commandName('sudo -g staff -p prompt: make'), 'make');
  assert.equal(commandName('env -u FOO -C /tmp make'), 'make');
  assert.equal(commandName(null), null);
});

test('kiro and gemini name a command tool by its program', async () => {
  const root = tmp('kiro');
  const L1 = (t, p) => ({ id: t, timestamp: `2026-10-19T09:00:0${t}Z`, payload: p });
  kiroSession(root, 'sess_c', {}, [
    L1(1, { type: 'tool_call', toolCallId: 'a', toolName: 'executeBash', args: { command: `API_KEY=${SECRET} node deploy.js` }, status: 'completed', executionId: 'e1' }),
    L1(2, { type: 'tool_call', toolCallId: 'b', toolName: 'executeBash', args: { command: 'sudo env FOO=1 /usr/bin/git push' }, status: 'completed', executionId: 'e1' }),
  ]);
  const gem = tmp('gem');
  fs.mkdirSync(path.join(gem, 'h', 'chats'), { recursive: true });
  const call = (id, command) => ({ id, name: 'run_shell_command', args: { command }, status: 'success' });
  fs.writeFileSync(
    path.join(gem, 'h', 'chats', 'session-c.json'),
    JSON.stringify({ sessionId: 'c', messages: [{ type: 'user', content: 'go', timestamp: '2026-10-19T09:00:00Z' }, { type: 'gemini', content: '', timestamp: '2026-10-19T09:00:05Z', toolCalls: [call('1', `API_KEY=${SECRET} node deploy.js`), call('2', 'sudo env FOO=1 /usr/bin/git push')] }] }),
  );
  try {
    for (const sk of [await createKiro({ root }).skeleton(null, 'sess_c', {}), await createGemini({ root: gem }).skeleton(null, 'c', {})]) {
      assert.deepEqual(sk.spans.filter((s) => s.kind === 'tool').map((s) => s.tool.target), ['node', 'git']);
      assert.equal(JSON.stringify(sk).includes('Ab3dE7gH1jK5'), false);
    }
  } finally {
    cleanup(root, gem);
  }
});

test('a forced refresh runs at most once per interval', () => {
  let builds = 0;
  const get = L.cache(() => ++builds, { ttl: 60000, minRefresh: 5000 });
  get();
  for (let i = 0; i < 20; i++) get(true);
  assert.equal(builds, 1, 'twenty unknown ids, one scan');
  const free = L.cache(() => ++builds, { ttl: 60000, minRefresh: 0 });
  free();
  free(true);
  assert.equal(builds, 3);
});

test('kiro: unknown ids do not rescan the folder every time', async () => {
  const root = tmp('kiro');
  kiroSession(root, 'sess_a', {}, []);
  const k = createKiro({ root });
  try {
    k.sessions();
    kiroSession(root, 'sess_b', {}, []);
    for (let i = 0; i < 3; i++) await assert.rejects(k.skeleton(null, 'sess_b', {}), (e) => e.status === 404);
    const k2 = createKiro({ root, minRefresh: 0 });
    k2.sessions();
    kiroSession(root, 'sess_c', {}, []);
    assert.equal((await k2.skeleton(null, 'sess_c', {})).session.id, 'sess_c');
  } finally {
    cleanup(root);
  }
});

test('kiro: only the newest 500 sessions are parsed, and a messages file over 50 MB is skipped', () => {
  const root = tmp('kiro');
  for (let i = 0; i < 503; i++) {
    kiroSession(root, `sess_${i}`, {}, []);
    const at = new Date(Date.UTC(2026, 0, 1) + i * 1000);
    fs.utimesSync(path.join(root, 'ws1', `sess_${i}`, 'messages.jsonl'), at, at);
  }
  const big = path.join(root, 'ws1', 'sess_big', 'messages.jsonl');
  kiroSession(root, 'sess_big', {}, []);
  fs.truncateSync(big, L.MAX_FILE + 1);
  const opened = [];
  const orig = fs.openSync;
  fs.openSync = function (f, ...a) {
    if (String(f).endsWith('messages.jsonl')) opened.push(String(f));
    return orig.call(this, f, ...a);
  };
  try {
    const rows = createKiro({ root }).sessions();
    assert.equal(rows.length, 500);
    assert.equal(opened.length, 500, 'older sessions are statted, not read');
    assert.ok(!opened.includes(big) && !rows.some((r) => r.id === 'sess_big'));
  } finally {
    fs.openSync = orig;
    cleanup(root);
  }
});

test('turn option: NaN, strings, null and a missing options argument all mean the last turn', async () => {
  const k = createKiro({ root: path.join(F, 'kiro') });
  const g = createGemini({ root: path.join(F, 'gemini') });
  for (const [a, id] of [[k, 'sess_k1'], [g, 'g-sess-1']]) {
    for (const opts of [undefined, null, {}, { turn: NaN }, { turn: 'x' }, { turn: 1.5 }, { turn: null }, { turn: 99 }]) {
      const sk = await a.skeleton(null, id, opts);
      assert.equal(sk.spans.find((s) => s.kind === 'turn').name, 'turn 2', JSON.stringify(opts));
    }
    assert.equal((await a.skeleton(null, id, { turn: -3 })).spans.find((s) => s.kind === 'turn').name, 'turn 1');
  }
});

test('gemini: first non-empty prompt titles the session, huge text is bounded, odd names and tokens are tamed', async () => {
  const gem = tmp('gem');
  fs.mkdirSync(path.join(gem, 'h', 'chats'), { recursive: true });
  const msgs = [
    { type: 'user', content: '   ', timestamp: '2026-10-19T09:00:00Z' },
    { type: 'user', content: [{ text: '' }], timestamp: '2026-10-19T09:00:01Z' },
    { type: 'user', content: `${'x'.repeat(2000000)} ${SECRET}`, timestamp: '2026-10-19T09:00:02Z' },
    { type: 'gemini', content: '', model: `${SECRET}-${'m'.repeat(200)}`, tokens: { input: 'lots', output: null, cached: -5, total: {} }, timestamp: '2026-10-19T09:00:05Z', toolCalls: [{ name: 'n'.repeat(300), status: 'success' }] },
  ];
  fs.writeFileSync(path.join(gem, 'h', 'chats', 'session-t.json'), JSON.stringify({ sessionId: 't', messages: msgs }));
  try {
    const g = createGemini({ root: gem });
    const [r] = g.sessions();
    assert.ok(r.title.startsWith('xxx') && r.title.length === 80);
    const sk = await g.skeleton(null, 't', { turn: 2 });
    const chat = sk.spans.find((s) => s.kind === 'chat');
    assert.deepEqual(chat.usage, { input: 0, output: 0, cacheRead: 0 });
    assert.ok(chat.model.length <= 80 && !chat.model.includes('Ab3dE7gH1jK5'));
    assert.ok(sk.spans.find((s) => s.kind === 'tool').tool.name.length <= 80);
  } finally {
    cleanup(gem);
  }
});
