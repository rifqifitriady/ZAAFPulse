const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAudit } = require('../lib/audit');

test('records and tails newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-audit-'));
  const a = createAudit(path.join(dir, 'sub', 'mcp-audit.jsonl'));
  a.record({ tool: 'one' });
  a.record({ tool: 'two' });
  a.record({ tool: 'three' });
  assert.deepEqual(
    a.tail(2).map((e) => e.tool),
    ['three', 'two'],
  );
});

test('tail of a missing file is empty', () => {
  assert.deepEqual(createAudit(path.join(os.tmpdir(), 'acc-none', 'x.jsonl')).tail(), []);
});
