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

test('the folders it creates are private (0700)', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-audit-dir-'));
  createAudit(path.join(dir, 'new', 'dir', 'a.jsonl')).record({});
  assert.equal(fs.statSync(path.join(dir, 'new', 'dir')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'new')).mode & 0o777, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tail of a missing file is empty', () => {
  assert.deepEqual(createAudit(path.join(os.tmpdir(), 'acc-none', 'x.jsonl')).tail(), []);
});
