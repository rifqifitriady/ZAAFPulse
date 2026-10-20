// Reads JSONL by byte range and reports where each line sits in the file. The explorer stores only
// these offsets in the index, then reads back just the turns it shows (never the whole file).
const fs = require('fs');

// `maxLine` (bytes) stops a line that never ends from being buffered whole: the read fails with a 413.
// The reader returns right after the line that reaches `end`, so it never buffers the line after it.
async function* readLines(file, { start = 0, end = Infinity, highWaterMark = 1 << 20, maxLine = Infinity } = {}) {
  if (start >= end) return;
  const tooLong = () => Object.assign(new Error('log line too large'), { status: 413 });
  const stream = fs.createReadStream(file, { start, highWaterMark });
  let pending = []; // buffers of the current, unfinished line
  let pendingLen = 0;
  let lineStart = start;
  try {
    for await (const chunk of stream) {
      let from = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
        if (pendingLen + i - from > maxLine) throw tooLong();
        pending.push(chunk.subarray(from, i));
        const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen + i - from);
        const lineEnd = lineStart + buf.length + 1;
        let text = buf.toString('utf8');
        if (text.endsWith('\r')) text = text.slice(0, -1);
        yield { text, start: lineStart, end: lineEnd };
        if (lineEnd >= end) return;
        lineStart = lineEnd;
        pending = [];
        pendingLen = 0;
        from = i + 1;
      }
      if (from < chunk.length) {
        pending.push(chunk.subarray(from));
        pendingLen += chunk.length - from;
        if (pendingLen > maxLine) throw tooLong();
      }
    }
    if (pendingLen && lineStart < end) {
      let text = Buffer.concat(pending, pendingLen).toString('utf8');
      if (text.endsWith('\r')) text = text.slice(0, -1);
      yield { text, start: lineStart, end: lineStart + pendingLen };
    }
  } finally {
    stream.destroy();
  }
}

async function readRange(file, start, end) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

module.exports = { readLines, readRange };
