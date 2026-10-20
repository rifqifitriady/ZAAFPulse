// test/trace-lines.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLines, readRange } = require('../lib/trace/lines');

const tmp = (content) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zp-lines-')), 'x.jsonl');
  fs.writeFileSync(f, content);
  return f;
};
const all = async (gen) => {
  const out = [];
  for await (const l of gen) out.push(l);
  return out;
};

test('lines carry exact byte offsets, including multi-byte text and CRLF', async () => {
  const f = tmp('{"a":"é"}\n{"b":2}\r\n{"c":3}');
  const lines = await all(readLines(f));
  assert.deepEqual(
    lines.map((l) => l.text),
    ['{"a":"é"}', '{"b":2}', '{"c":3}'],
  );
  assert.deepEqual(
    lines.map((l) => [l.start, l.end]),
    [
      [0, 11],
      [11, 20],
      [20, 27],
    ],
  );
  for (const l of lines) assert.equal((await readRange(f, l.start, l.end)).toString().trimEnd(), l.text);
});

test('a range starts at a line start and stops before the end offset', async () => {
  const f = tmp('a\nbb\nccc\ndddd\n');
  const lines = await all(readLines(f, { start: 2, end: 9 }));
  assert.deepEqual(
    lines.map((l) => l.text),
    ['bb', 'ccc'],
  );
});

test('lines longer than the read buffer are joined', async () => {
  const long = 'x'.repeat(5000);
  const f = tmp(`${long}\nshort\n`);
  const lines = await all(readLines(f, { highWaterMark: 1024 }));
  assert.equal(lines[0].text.length, 5000);
  assert.equal(lines[1].start, 5001);
});
