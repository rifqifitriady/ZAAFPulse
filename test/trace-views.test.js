const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrace } = require('../lib/trace');
const { traceView } = require('../lib/trace/views');
const { createLocal } = require('../lib/local');

async function demoSkeleton() {
  const t = createTrace({ demo: true });
  const row = t.sessions({ range: 30 }).find((r) => r.source === 'claude');
  return t.session(row.key);
}

async function demoRow() {
  const t = createTrace({ demo: true });
  return t.sessions({ range: 30 }).find((r) => r.source === 'claude');
}

test('views: topology, critical path, errors and one span, without text or content ids', async () => {
  const sk = await demoSkeleton();
  const topo = traceView(sk, 'topology');
  assert.equal(topo.spans.length, sk.spans.length);
  assert.equal(topo.truncated, false);
  assert.deepEqual(Object.keys(topo.spans[0]).sort(), ['id', 'kind', 'ms', 'name', 'parent', 'status']);
  const cp = traceView(sk, 'critical_path');
  assert.ok(cp.sections.length > 0);
  assert.ok(cp.totalMs > 0);
  const err = traceView(sk, 'errors');
  assert.equal(err.rootCause.name, 'execute_tool Bash');
  assert.ok(err.failed.some((f) => f.name === 'execute_tool Bash'));
  const bash = sk.spans.find((s) => s.name === 'execute_tool Bash' && s.status === 'error');
  const one = traceView(sk, 'span', bash.id);
  assert.equal(one.onCriticalPath, true);
  assert.deepEqual(one.tool, { name: 'Bash' });
  assert.ok(Number.isFinite(one.selfMs));
  assert.equal(one.tool.target, undefined);
  for (const v of [topo, cp, err, one]) assert.doesNotMatch(JSON.stringify(v), /"target"|"npm"/);
  const project = (await demoRow()).project;
  assert.ok(project, 'the demo row has a project');
  for (const v of [topo, cp, err, one]) assert.ok(!JSON.stringify(v).includes(project));
  for (const v of [topo, cp, err, one]) assert.doesNotMatch(JSON.stringify(v), /ci_[0-9a-f]{16}|FAIL src|apiKey|"text"|"result"/);
  assert.throws(() => traceView(sk, 'span', 'nope'), /unknown span/);
  assert.throws(() => traceView(sk, 'everything'), /view must be/);
});

test('local.traceGet reads a session that traceSessions listed', async () => {
  const indexer = { version: 1, state: {}, results: () => [], refresh: async () => {} };
  const local = createLocal({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-views-')), indexer, contentOff: true, demo: true });
  const row = (await local.traceSessions({})).find((r) => r.source === 'claude');
  const r = await local.traceGet({ key: row.key, view: 'errors' });
  assert.equal(r.rootCause.name, 'execute_tool Bash');
});

// okResult pretty-prints with JSON.stringify(x, null, 2) and cuts at 50 KB.
const asMcp = (v) => JSON.stringify(v, null, 2);

test('views: a huge topology and failed list stay under the MCP result cap and say truncated', () => {
  const name = 'x'.repeat(80);
  const spans = Array.from({ length: 3000 }, (_, i) => ({
    id: `s${i}`, parent: i ? 's0' : null, kind: 'tool', name, start: 0, end: 5, status: i % 5 === 0 ? 'error' : 'ok', error: 'boom '.repeat(10),
  }));
  const topo = traceView({ spans }, 'topology');
  assert.ok(asMcp(topo).length < 50000);
  assert.deepEqual(JSON.parse(asMcp(topo)).truncated, true);
  const failing = spans.slice(0, 600).map((s) => ({ ...s, status: 'error' }));
  const err = traceView({ spans: failing }, 'errors');
  assert.ok(asMcp(err).length < 50000);
  assert.equal(JSON.parse(asMcp(err)).truncated, true);
  assert.equal(traceView({ spans: spans.slice(0, 3) }, 'errors').truncated, false);
});

const bytesOf = (v) => Buffer.byteLength(asMcp(v));

for (const [label, mk] of [
  ['short names', (i) => `s${i}`],
  ['non-ASCII names', (i) => `ツール${i}`.repeat(4)],
]) {
  test(`views: ${label} are measured in bytes as the MCP result is serialized`, () => {
    const spans = Array.from({ length: 3000 }, (_, i) => ({
      id: `span-${i}`, parent: 'span-0', kind: 'tool', name: mk(i), start: 0, end: 1, status: 'error', error: null,
    }));
    for (const [view, key] of [['errors', 'failed'], ['topology', 'spans']]) {
      const v = traceView({ spans }, view);
      assert.ok(bytesOf(v) <= 51200, `${view} is ${bytesOf(v)} bytes`);
      assert.ok(bytesOf(v) <= 45000, `${view} leaves room under the cap: ${bytesOf(v)} bytes`);
      const back = JSON.parse(asMcp(v));
      assert.equal(back.truncated, true);
      assert.ok(back[key].length > 0 && back[key].length < 3000);
    }
  });
}

test('local.traceGet rejects a bad turn and an unknown key without a path', async () => {
  const indexer = { version: 1, state: {}, results: () => [], refresh: async () => {} };
  const local = createLocal({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'zp-views-')), indexer, contentOff: true, demo: true });
  const row = (await local.traceSessions({})).find((r) => r.source === 'claude');
  await assert.rejects(local.traceGet({ key: row.key, view: 'topology', turn: -1 }), /bad turn/);
  await assert.rejects(local.traceGet({ key: row.key, view: 'topology', turn: 1.5 }), /bad turn/);
  await assert.rejects(local.traceGet({ key: 'nope', view: 'topology' }), (e) => /unknown session/.test(e.message) && !/[\\/]/.test(e.message));
});
