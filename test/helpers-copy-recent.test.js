// copyRecent (test/helpers.js): fixtures with fixed dates stay inside "the last N days" whatever today's date is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyRecent } = require('./helpers');

test('copyRecent moves every timestamp by one amount so the newest lands a day before now', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-recent-src-'));
  fs.mkdirSync(path.join(src, 'a'));
  fs.writeFileSync(path.join(src, 'a', 'one.jsonl'), '{"timestamp":"2026-10-18T08:00:00.000Z"}\n');
  fs.writeFileSync(path.join(src, 'two.json'), '{"createdAt":"2026-10-19T09:30:00Z","n":"no date here"}');
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-recent-dst-')), 'copy');
  const now = Date.parse('2030-01-10T00:00:00.000Z');
  copyRecent(src, dest, { now });
  assert.match(fs.readFileSync(path.join(dest, 'two.json'), 'utf8'), /"createdAt":"2030-01-09T00:00:00.000Z"/);
  // 25.5 hours before the newest one, as in the source.
  assert.match(fs.readFileSync(path.join(dest, 'a', 'one.jsonl'), 'utf8'), /"timestamp":"2030-01-07T22:30:00.000Z"/);
  assert.match(fs.readFileSync(path.join(src, 'two.json'), 'utf8'), /2026-10-19T09:30:00Z/, 'the source is untouched');
});
