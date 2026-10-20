const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Indexer, CACHE_VERSION } = require('../lib/indexer');
const claude = require('../lib/claude');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-index-'));

// A small synthetic Claude Code transcript: prompts, assistant replies with tool calls, results.
function writeSession(file, turns, seed = 1) {
  const lines = [];
  let t = Date.parse('2026-10-01T09:00:00Z') + seed * 1e6;
  const iso = () => new Date((t += 5000)).toISOString();
  for (let i = 0; i < turns; i++) {
    const base = { sessionId: `s${seed}`, cwd: '/w/app' };
    lines.push({
      ...base,
      type: 'user',
      timestamp: iso(),
      message: { role: 'user', content: `add tests for module ${i}` },
    });
    lines.push({
      ...base,
      type: 'assistant',
      requestId: `r${seed}_${i}`,
      timestamp: iso(),
      message: {
        id: `m${seed}_${i}`,
        role: 'assistant',
        model: 'claude-opus-4-1',
        content: [
          { type: 'text', text: `Reading \`src/m${i}.ts\` first.` },
          {
            type: 'tool_use',
            id: `tu${seed}_${i}`,
            name: i % 3 ? 'Read' : 'Bash',
            input: i % 3 ? { file_path: `/w/app/src/m${i}.ts` } : { command: 'rm -rf dist && npm test' },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 100 + i, cache_read_input_tokens: 1000 },
      },
    });
    lines.push({
      ...base,
      type: 'user',
      timestamp: iso(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `tu${seed}_${i}`,
            is_error: i % 7 === 0,
            content: i % 7 ? `export const m${i} = ${i};\n`.repeat(30) : 'File does not exist.',
          },
        ],
      },
    });
  }
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function setup(n = 4, turns = 40) {
  const dir = tmp();
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `session-${i}.jsonl`);
    writeSession(f, turns + i * 10, i + 1);
    files.push(f);
  }
  const src = { id: 'claude', listFiles: () => files.filter((f) => fs.existsSync(f)), parseFile: claude.parseFile };
  return { dir, files, src, cache: path.join(tmp(), 'index.json') };
}

test('indexer: worker threads give the same results as parsing in this thread', async () => {
  const { files, src } = setup(4);
  const a = new Indexer([src], path.join(tmp(), 'index.json'), { workers: 2, workerMinBytes: 0 });
  await a.refresh();
  const b = new Indexer([src], path.join(tmp(), 'index.json'), { workers: 0 });
  await b.refresh();
  assert.ok(a.state.workers >= 1, 'no worker started');
  assert.strictEqual(b.state.workers, 0);
  assert.strictEqual(a.state.errors, 0);
  for (const f of files) assert.deepStrictEqual(a.files[f].result, b.files[f].result);
  assert.ok(a.files[files[0]].result.signals.events.some((e) => e.kind === 'risky'));
});

test('indexer: a worker that cannot start falls back to this thread', async () => {
  const { files, src } = setup(3);
  const broken = path.join(tmp(), 'broken-worker.js');
  fs.writeFileSync(broken, "throw new Error('no workers here');\n");
  const ix = new Indexer([src], path.join(tmp(), 'index.json'), {
    workers: 2,
    workerMinBytes: 0,
    workerScript: broken,
  });
  await ix.refresh();
  assert.strictEqual(ix.state.workers, 0);
  assert.strictEqual(ix.state.errors, 0);
  assert.strictEqual(Object.keys(ix.files).length, files.length);
  assert.ok(files.every((f) => ix.files[f].result.events.length > 0));
});

test('indexer: sources without a module file are parsed in this thread', async () => {
  const { src, files } = setup(3);
  const wrapped = { ...src, parseFile: (f) => claude.parseFile(f) }; // not an export of any module
  const ix = new Indexer([wrapped], path.join(tmp(), 'index.json'), { workers: 2, workerMinBytes: 0 });
  await ix.refresh();
  assert.strictEqual(ix.state.workers, 0);
  assert.strictEqual(Object.keys(ix.files).length, files.length);
});

test('indexer: changes go to a journal that a new process reads back', async () => {
  const { files, src, cache } = setup(3, 10);
  const ix = new Indexer([src], cache, { workers: 0 });
  await ix.refresh();
  assert.ok(fs.existsSync(cache));
  assert.ok(!fs.existsSync(cache + '.journal'));
  const base = fs.readFileSync(cache, 'utf8');

  // One session grows, one is deleted: only those entries are written, the base stays as it was.
  fs.appendFileSync(
    files[0],
    JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'lanjut' },
    }) + '\n',
  );
  fs.rmSync(files[2]);
  await ix.refresh();
  assert.strictEqual(fs.readFileSync(cache, 'utf8'), base);
  const journal = fs
    .readFileSync(cache + '.journal', 'utf8')
    .trim()
    .split('\n');
  assert.strictEqual(journal.length, 2);

  const again = new Indexer([src], cache, { workers: 0 });
  assert.deepStrictEqual(Object.keys(again.files).sort(), Object.keys(ix.files).sort());
  assert.deepStrictEqual(again.files[files[0]], ix.files[files[0]]);
  assert.ok(!again.files[files[2]]);
  await again.refresh();
  assert.strictEqual(again.state.total, 0, 'reloaded cache should need no re-parse');
});

test('indexer: a torn journal line or an old generation is ignored', async () => {
  const { files, src, cache } = setup(2, 10);
  const ix = new Indexer([src], cache, { workers: 0 });
  await ix.refresh();
  const entry = ix.files[files[0]];
  fs.writeFileSync(
    cache + '.journal',
    JSON.stringify({ v: CACHE_VERSION, g: ix.gen - 1, f: files[0], e: null }) +
      '\n' +
      '{"v":' +
      CACHE_VERSION +
      ',"g":',
  );
  const again = new Indexer([src], cache, { workers: 0 });
  assert.deepStrictEqual(again.files[files[0]], entry);
});

test('indexer: a large journal is folded into a new base', async () => {
  const { files, src, cache } = setup(2, 10);
  const ix = new Indexer([src], cache, { workers: 0 });
  await ix.refresh();
  const gen = ix.gen;
  ix.baseBytes = 1; // pretend the base is tiny so the next write compacts
  ix.journalBytes = 9e6;
  fs.appendFileSync(
    files[1],
    JSON.stringify({
      type: 'user',
      sessionId: 's2',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'ok' },
    }) + '\n',
  );
  await ix.refresh();
  assert.strictEqual(ix.gen, gen + 1);
  assert.ok(!fs.existsSync(cache + '.journal'));
  const again = new Indexer([src], cache, { workers: 0 });
  assert.deepStrictEqual(again.files[files[1]], ix.files[files[1]]);
});

test('indexer: a cache from another version is not used', async () => {
  const { src, cache } = setup(1, 5);
  fs.writeFileSync(cache, JSON.stringify({ version: CACHE_VERSION - 1, files: { x: { result: {} } } }));
  const ix = new Indexer([src], cache, { workers: 0 });
  assert.deepStrictEqual(ix.files, {});
});
