// test/cost-collect.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/cost/collect');
const { makePricer, eventParts } = require('../lib/pricing');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);
const sess = (tool, project) => ({ tool, project, tools: {}, skills: {}, agents: {}, prompts: 0, subagentFiles: 0 });

test('local events: one per API response, a resumed copy once, the folder with ~, provider and extras', () => {
  const row = (sid) => [
    1000,
    'claude',
    sid,
    'claude-sonnet-5-5',
    10,
    5,
    1,
    2,
    3,
    0,
    'msg_1:req_1',
    { ws: 2, geo: 'us' },
  ];
  const a = { events: [row('s1')], sessions: { s1: sess('claude', path.join(HOME, 'work', 'acme')) } };
  const b = { events: [row('s2')], sessions: { s2: sess('claude', path.join(HOME, 'work', 'acme')) } };
  const codex = [2000, 'codex', 'c1', 'gpt-6.1-sol', 7, 1, 0, 0, 0, 0, null, null];
  const c = {
    events: [codex, [...codex]],
    sessions: { c1: sess('codex', path.join(HOME, 'Documents', 'Codex', '2026-10-20', 'chat-1')) },
  };
  const out = C.localEvents([a, b, c], { home: HOME });
  assert.equal(out.length, 3, 'the resumed copy once; keyless Codex rows are all kept');
  assert.deepEqual(out[0], {
    ts: 1000,
    source: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    tokens: { in: 10, out: 5, cacheRead: 1, cacheWrite5m: 2, cacheWrite1h: 3 },
    webSearches: 2,
    geo: 'us',
    project: '~/work/acme',
    keyId: null,
    agent: null,
    kind: 'chat',
    estimated: false,
    free: false,
  });
  assert.equal(out[1].provider, 'openai');
  assert.equal(out[1].project, '~/Documents/Codex', 'Codex desktop chats are one project, as on the Overview');
});

test('gateway lines: source, kind, agent and key; prompt minus cache; failed attempts skipped; private is free', () => {
  const base = { ts: 5, keyId: 'key_a', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', kind: 'chat' };
  const ev = C.gatewayEvent({
    ...base,
    input: 1000,
    cached: 300,
    output: 50,
    routedTo: 'openrouter/anthropic/claude-opus-5.5',
  });
  assert.deepEqual(
    [ev.source, ev.kind, ev.keyId, ev.agent, ev.model, ev.free],
    ['gateway', 'chat', 'key_a', null, 'openrouter/anthropic/claude-opus-5.5', false],
  );
  assert.deepEqual(ev.tokens, { in: 700, out: 50, cacheRead: 300, cacheWrite5m: 0, cacheWrite1h: 0 });
  const kinds = [
    [{ agent: 'replay', kind: 'agent', keyId: 'dashboard' }, ['replay', 'replay', null, null]],
    [{ agent: 'judge', kind: 'agent', keyId: 'dashboard' }, ['judge', 'judge', null, null]],
    [{ agent: 'planner', kind: 'agent', runId: 'run_1', keyId: 'dashboard' }, ['collab', 'run', null, 'planner']],
    [{ agent: 'coder', kind: 'agent' }, ['gateway', 'agent', 'key_a', 'coder']],
    [{ kind: 'embeddings' }, ['gateway', 'embed', 'key_a', null]],
  ];
  for (const [extra, want] of kinds) {
    const e = C.gatewayEvent({ ...base, input: 10, output: 1, ...extra });
    assert.deepEqual([e.source, e.kind, e.keyId, e.agent], want, JSON.stringify(extra));
  }
  assert.equal(C.gatewayEvent({ ...base, status: 599, error: 'down' }), null, 'no tokens: a failed attempt');
  assert.equal(C.gatewayEvent({ input: 5 }), null, 'no timestamp');
  const local = C.gatewayEvent(
    { ...base, provider: 'ollama', input: 5, output: 5 },
    { isPrivate: (id) => id === 'ollama' },
  );
  assert.equal(local.free, true);
});

test('judge calls: external ones are left to the gateway log; Claude Code usage is split; local judges are free', () => {
  assert.equal(
    C.judgeLine({ kind: 'external', provider: 'openrouter', model: 'x', usage: { input: 1, output: 1 } }, 9),
    null,
  );
  const line = C.judgeLine(
    {
      kind: 'claude-cli',
      provider: 'claude-code',
      model: 'claude-haiku-5-5',
      usage: { input: 1602, output: 40, cost: 0.0005, cacheRead: 100, cacheWrite: 1500 },
    },
    9,
  );
  assert.deepEqual(line, {
    ts: 9,
    kind: 'claude-cli',
    provider: 'claude-code',
    model: 'claude-haiku-5-5',
    in: 2,
    out: 40,
    cacheRead: 100,
    cacheWrite5m: 1500,
  });
  const ev = C.judgeEvent(line);
  assert.deepEqual([ev.source, ev.kind, ev.provider, ev.free], ['judge', 'judge', 'claude-code', false]);
  assert.deepEqual(ev.tokens, { in: 2, out: 40, cacheRead: 100, cacheWrite5m: 1500, cacheWrite1h: 0 });
  const ollama = C.judgeEvent(
    C.judgeLine({ kind: 'ollama', provider: 'ollama', model: 'qwen3:8b', usage: { input: 9, output: 3 } }, 1),
  );
  assert.equal(ollama.free, true);
  assert.equal(C.judgeEvent({ ts: 1, model: 'm', in: 0, out: 0 }), null);
});

test('the shared pricer: a gateway line costs what a local event with the same tokens costs (cache writes, tiers, web search, geo)', () => {
  const pricer = makePricer({
    'claude-x': {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      webSearch: 0.01,
      tiers: [{ above: 200000, input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
    },
    codex: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, estimate: true },
  });
  // The second case is over the 200,000-token tier (150,000 + 60,000 + 1,000 prompt tokens).
  for (const [inp, out, cr, w5, w1] of [
    [1000, 200, 3000, 400, 100],
    [150000, 900, 60000, 1000, 0],
  ]) {
    const local = [1, 'claude', 's', 'claude-x', inp, out, cr, w5, w1, 0, 'k', { ws: 3, geo: 'us' }];
    const want = eventParts(pricer, local).reduce((a, b) => a + b, 0);
    const line = {
      ts: 1,
      provider: 'anthropic',
      model: 'anthropic/claude-x',
      kind: 'chat',
      status: 200,
      input: inp + cr + w5 + w1,
      cached: cr,
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      output: out,
      webSearches: 3,
      geo: 'us',
    };
    near(C.priceEvent(pricer, C.gatewayEvent(line)).listUSD, want);
    near(C.priceEvent(pricer, C.localEvents([{ events: [local], sessions: {} }], { home: HOME })[0]).listUSD, want);
  }
  const ev = (model, free = false) => ({
    model,
    free,
    tokens: { in: 10, out: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    webSearches: 0,
    geo: null,
  });
  assert.deepEqual(C.priceEvent(pricer, ev('nope')), { listUSD: 0, unpriced: true, estimated: false });
  assert.deepEqual(C.priceEvent(pricer, ev('claude-x', true)), { listUSD: 0, unpriced: false, estimated: false });
  assert.equal(C.priceEvent(pricer, ev('codex')).estimated, true);
});

test('readNew: the first run reads the rotated file too; then only new complete lines; a rotation is followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-read-'));
  const f = path.join(dir, 'log.jsonl');
  const L = (n) => JSON.stringify({ n }) + '\n';
  let r = C.readNew(f, undefined);
  assert.deepEqual([r.rows, r.cursor], [[], { head: null, offset: 0 }]);
  fs.writeFileSync(f + '.1', L(1));
  fs.writeFileSync(f, L(2) + L(3) + '{"n":4');
  r = C.readNew(f, undefined);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [1, 2, 3],
    'a torn last line waits',
  );
  fs.appendFileSync(f, '}\nnot json\n');
  r = C.readNew(f, r.cursor);
  assert.deepEqual([r.rows.map((x) => x.n), r.bad], [[4], 1]);
  fs.appendFileSync(f, L(5));
  fs.renameSync(f, f + '.1'); // lib/gateway/store.js rotates at 10 MB
  fs.writeFileSync(f, L(6));
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [5, 6],
  );
  fs.writeFileSync(f, L(7)); // a file this cursor does not know: read from the start, once
  fs.rmSync(f + '.1');
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [7],
  );
  assert.deepEqual(C.readNew(f, r.cursor).rows, []);
});

test('readNew: a rotation by another process between the head and the data reads every line exactly once', () => {
  // Another process (the dataset CLI's gateway) can rename the log to .1 at any moment of a pass. Each case rotates
  // right after the reader's first read (the head) or its second (the data) of the file.
  for (const after of [1, 2]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-race-'));
    const f = path.join(dir, 'log.jsonl');
    const L = (n) => JSON.stringify({ n }) + '\n';
    const seen = [];
    fs.writeFileSync(f, L(1) + L(2) + L(3));
    let r = C.readNew(f, undefined);
    seen.push(...r.rows.map((x) => x.n));
    fs.appendFileSync(f, L(4));
    const real = fs.readSync;
    let calls = 0;
    fs.readSync = (...args) => {
      const got = real(...args);
      if (++calls === after) {
        fs.renameSync(f, f + '.1');
        fs.writeFileSync(f, L(5));
      }
      return got;
    };
    try {
      r = C.readNew(f, r.cursor);
    } finally {
      fs.readSync = real;
    }
    assert.ok(calls >= after, 'the rotation happened during the pass');
    seen.push(...r.rows.map((x) => x.n));
    for (const more of [L(6), L(7)]) {
      fs.appendFileSync(f, more);
      r = C.readNew(f, r.cursor);
      seen.push(...r.rows.map((x) => x.n));
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7], `rotated after read ${after}`);
  }
});

test('readNew: a partial line is read once it is complete, also when the file was rotated meanwhile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-torn-'));
  const f = path.join(dir, 'log.jsonl');
  const L = (n) => JSON.stringify({ n }) + '\n';
  fs.writeFileSync(f, L(1) + '{"n":');
  let r = C.readNew(f, undefined);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [1],
  );
  fs.appendFileSync(f, '2}\n{"n"');
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [2],
  );
  fs.appendFileSync(f, ':3}\n');
  fs.renameSync(f, f + '.1');
  fs.writeFileSync(f, L(4) + '{"n":5');
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [3, 4],
  );
  fs.appendFileSync(f, '}\n');
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [5],
  );
});

test('readNew: a first line longer than 4096 bytes still names the file, so its rotation is followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-long-'));
  const f = path.join(dir, 'log.jsonl');
  const L = (n, pad = '') => JSON.stringify({ n, pad }) + '\n';
  fs.writeFileSync(f, L(1, 'x'.repeat(5000)));
  assert.notEqual(C.headOf(f), null);
  let r = C.readNew(f, undefined);
  fs.appendFileSync(f, L(2));
  fs.renameSync(f, f + '.1');
  fs.writeFileSync(f, L(3, 'y'.repeat(5000)));
  r = C.readNew(f, r.cursor);
  assert.deepEqual(
    r.rows.map((x) => x.n),
    [2, 3],
  );
});

test('readNew: on the first run, a rotation between the current file and .1 does not read one generation twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-first-'));
  const f = path.join(dir, 'log.jsonl');
  const L = (n) => JSON.stringify({ n }) + '\n';
  fs.writeFileSync(f + '.1', L(1) + L(2));
  fs.writeFileSync(f, L(3) + L(4));
  // The rotation happens as the reader opens .1: the current file (3, 4) becomes .1, replacing (1, 2) on disk.
  const real = fs.openSync;
  let fired = false;
  fs.openSync = (p, ...rest) => {
    if (!fired && p === f + '.1') {
      fired = true;
      fs.renameSync(f, f + '.1');
      fs.writeFileSync(f, L(5));
    }
    return real(p, ...rest);
  };
  let r;
  try {
    r = C.readNew(f, undefined);
  } finally {
    fs.openSync = real;
  }
  assert.ok(fired, 'the rotation happened during the pass');
  const seen = r.rows.map((x) => x.n);
  for (const more of [L(6), L(7)]) {
    fs.appendFileSync(f, more);
    r = C.readNew(f, r.cursor);
    seen.push(...r.rows.map((x) => x.n));
  }
  r = C.readNew(f, r.cursor);
  seen.push(...r.rows.map((x) => x.n));
  // 1 and 2 were deleted by the rotation before they could be read; every line still on disk comes out once.
  assert.deepEqual(seen, [3, 4, 5, 6, 7]);
});

// Claude Code and Codex on this machine are counted from their own logs; the same tools elsewhere only via the gateway.
test('gateway lines: local Claude Code and Codex are skipped and counted as such; remote ones and old lines are kept', () => {
  const base = { ts: 5, keyId: 'key_a', provider: 'openrouter', model: 'claude-sonnet-5.5', input: 10, output: 2 };
  const lines = [
    { ...base, client: 'claude-code', local: true },
    { ...base, client: 'codex', local: true },
    { ...base, client: 'claude-code' },
    { ...base },
  ];
  const counts = { skippedLocalClients: 0 };
  const events = lines.map((l) => C.gatewayEvent(l, { counts })).filter(Boolean);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.source), ['gateway', 'gateway']);
  assert.equal(counts.skippedLocalClients, 2);
  assert.ok(C.gatewayEvent({ ...base, local: true }), 'another client on this machine is kept');
  assert.ok(C.gatewayEvent({ ...base, client: 'codex', local: 'true' }), 'only local: true');
  assert.equal(C.gatewayEvent({ ...base, client: 'codex', local: true }), null, 'skipped with no counter too');
});
