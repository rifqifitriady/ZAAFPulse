// Performance check for the trace registry (P1, P2): a 300 MB Claude session must show its last turn in
// under 3 s and a page of any text in under 100 ms, without reading the file whole. It writes a large file
// and takes a minute or so, so it only runs with ZAAFPULSE_PERF=1 (see docs/performance.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeParser = require('../lib/claude');
const { createTrace } = require('../lib/trace');

const TURNS = 200;
const PER_TURN = 100; // lines: 1 prompt, 49 tool calls, 49 tool results, 1 reply
const TARGET = 300 * 1024 * 1024;

// A tool result of about 31 KB: numbered, code-like lines, different in every call.
function bigResult(n) {
  const rows = [];
  for (let i = 0; i < 430; i++) rows.push(`${String(i).padStart(5)}  const value${n}_${i} = compute(${n}, ${i}); // line ${i} of result ${n}`);
  return rows.join('\n');
}

function writeSession(file) {
  const fd = fs.openSync(file, 'w');
  const t0 = Date.parse('2026-10-20T08:00:00Z');
  let ts = t0;
  let lines = 0;
  const out = [];
  const flush = () => {
    if (out.length) fs.writeSync(fd, out.join(''));
    out.length = 0;
  };
  const push = (o) => {
    out.push(JSON.stringify(o) + '\n');
    lines++;
    ts += 1000;
    if (out.length >= 200) flush();
  };
  const stamp = () => new Date(ts).toISOString();
  for (let t = 0; t < TURNS; t++) {
    push({ type: 'user', sessionId: 'perf1', uuid: `u${t}`, timestamp: stamp(), cwd: '/w/perf', message: { role: 'user', content: `turn ${t}: please look at module ${t} and fix what is wrong` } });
    for (let k = 0; k < 49; k++) {
      const id = `tu_${t}_${k}`;
      push({ type: 'assistant', sessionId: 'perf1', uuid: `a${t}_${k}`, timestamp: stamp(), requestId: `r${t}_${k}`, message: { id: `msg_${t}_${k}`, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/w/perf/src/m${t}_${k}.js` } }] } });
      push({ type: 'user', sessionId: 'perf1', uuid: `r${t}_${k}`, timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: bigResult(t * 50 + k) }] } });
    }
    push({ type: 'assistant', sessionId: 'perf1', uuid: `f${t}`, timestamp: stamp(), requestId: `rf${t}`, message: { id: `msg_f${t}`, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: `Done with module ${t}.` }] } });
  }
  flush();
  fs.closeSync(fd);
  return lines;
}

const ms = (since) => Number(process.hrtime.bigint() - since) / 1e6;

test('a 300 MB session: last turn under 3 s, a content page under 100 ms', { skip: process.env.ZAAFPULSE_PERF !== '1' && 'set ZAAFPULSE_PERF=1 to run', timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-perf-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const file = path.join(proj, 'perf1.jsonl');
  try {
    let t = process.hrtime.bigint();
    const lines = writeSession(file);
    const size = fs.statSync(file).size;
    console.log(`generated ${lines} lines, ${(size / 1048576).toFixed(0)} MB in ${ms(t).toFixed(0)} ms`);
    assert.ok(size >= TARGET * 0.9, `file is ${size} bytes`);

    t = process.hrtime.bigint();
    const entry = { file, source: 'claude', size, mtimeMs: fs.statSync(file).mtimeMs, result: await claudeParser.parseFile(file) };
    console.log(`indexed in ${ms(t).toFixed(0)} ms`);

    const trace = createTrace({ indexer: { entries: () => [entry] }, light: [], roots: [dir] });
    const [row] = trace.sessions({});
    assert.equal(row.turns, TURNS);

    t = process.hrtime.bigint();
    const sk = await trace.session(row.key);
    const skeletonMs = ms(t);
    console.log(`last-turn skeleton: ${skeletonMs.toFixed(0)} ms (${sk.spans.length} spans, ${trace.stats().workers} in a worker)`);
    assert.ok(skeletonMs < 3000, `skeleton took ${skeletonMs} ms`);
    assert.equal(sk.spans.filter((s) => s.kind === 'tool').length, 49);

    // The same turn built on the main thread, for comparison (not asserted).
    const inline = createTrace({ indexer: { entries: () => [entry] }, light: [], roots: [dir], workerMinBytes: Infinity });
    t = process.hrtime.bigint();
    await inline.session(inline.sessions({})[0].key);
    console.log(`last-turn skeleton in the main thread: ${ms(t).toFixed(0)} ms`);

    const tool = sk.spans.find((s) => s.kind === 'tool');
    t = process.hrtime.bigint();
    const page = await trace.content(tool.result, {});
    const contentMs = ms(t);
    console.log(`content page: ${contentMs.toFixed(1)} ms (${page.text.length} of ${page.total} characters)`);
    assert.ok(contentMs < 100, `content page took ${contentMs} ms`);
    assert.ok(page.total > 30000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
