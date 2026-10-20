// Reads JSONL by byte range and reports where each line sits in the file. The explorer stores only
// these offsets in the index, then reads back just the turns it shows (never the whole file).
const fs = require('fs');

async function* readLines(file, { start = 0, end = Infinity, highWaterMark = 1 << 20 } = {}) {
  const stream = fs.createReadStream(file, { start, highWaterMark });
  let pending = []; // buffers of the current, unfinished line
  let pendingLen = 0;
  let lineStart = start;
  for await (const chunk of stream) {
    let from = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
      pending.push(chunk.subarray(from, i));
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen + i - from);
      const lineEnd = lineStart + buf.length + 1;
      if (lineStart >= end) {
        stream.destroy();
        return;
      }
      let text = buf.toString('utf8');
      if (text.endsWith('\r')) text = text.slice(0, -1);
      yield { text, start: lineStart, end: lineEnd };
      lineStart = lineEnd;
      pending = [];
      pendingLen = 0;
      from = i + 1;
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from));
      pendingLen += chunk.length - from;
    }
  }
  if (pendingLen && lineStart < end) {
    let text = Buffer.concat(pending, pendingLen).toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    yield { text, start: lineStart, end: lineStart + pendingLen };
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
