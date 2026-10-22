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
