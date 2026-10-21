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

test('with end on a line boundary, the huge line after it is never read', async () => {
  const f = tmp('{"a":1}\n{"b":2}\n');
  // two small lines, then a 50 MB line with no newline (sparse file)
  const size = fs.statSync(f).size;
  fs.truncateSync(f, size + 50 * 1024 * 1024);
  const made = [];
  const orig = fs.createReadStream;
  fs.createReadStream = (...a) => {
    const s = orig(...a);
    made.push(s);
    return s;
  };
  try {
    const lines = await all(readLines(f, { start: 0, end: 16 }));
    assert.deepEqual(
      lines.map((l) => l.text),
      ['{"a":1}', '{"b":2}'],
    );
  } finally {
    fs.createReadStream = orig;
  }
  assert.equal(made.length, 1);
  assert.ok(made[0].bytesRead < 8 * 1024 * 1024, `read ${made[0].bytesRead} bytes`);
});

test('an empty or reversed range reads nothing', async () => {
  const f = tmp('a\nb\n');
  assert.deepEqual(await all(readLines(f, { start: 2, end: 2 })), []);
  assert.deepEqual(await all(readLines(f, { start: 2, end: 1 })), []);
});

test('maxLine stops a line that is too long with a 413 instead of buffering it', async () => {
  const f = tmp('ok\n' + 'x'.repeat(5000));
  const got = [];
  await assert.rejects(
    (async () => {
      for await (const l of readLines(f, { highWaterMark: 1024, maxLine: 2000 })) got.push(l.text);
    })(),
    { status: 413 },
  );
  assert.deepEqual(got, ['ok']);
  const g = tmp('x'.repeat(100) + '\n');
  await assert.rejects(all(readLines(g, { maxLine: 50 })), { status: 413 });
  assert.equal((await all(readLines(g, { maxLine: 100 }))).length, 1);
});
