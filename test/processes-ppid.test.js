// Process rows carry the parent's pid, so a local model server's helpers (Ollama's runners, its llama-server) count
// toward the server instead of being taken for a server of their own (lib/runtimes/state.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePsRows, procRows, rows, parseWinRows } = require('../lib/processes');

test('parsePsRows: pid, parent pid, cpu, memory, age, stopped and the command line', () => {
  const out = [
    '  101     1   0.5  20480    01:02:03 Ss   /opt/homebrew/opt/ollama/bin/ollama serve',
    '  202   101  12.0 409600       00:42 S    /opt/homebrew/Cellar/ollama/0.12.6/bin/ollama runner --model /x/blob',
    '  303   300   0.0   1024  2-00:00:01 T    /Applications/LM Studio.app/Contents/MacOS/LM Studio',
    'garbage',
    '',
  ].join('\n');
  const r = parsePsRows(out);
  assert.deepEqual(
    r.map((x) => [x.pid, x.ppid, x.cpu, x.rssKB, x.upSec, x.stopped]),
    [
      [101, 1, 0.5, 20480, 3723, false],
      [202, 101, 12, 409600, 42, false],
      [303, 300, 0, 1024, 172801, true],
    ],
  );
  assert.equal(r[2].args, '/Applications/LM Studio.app/Contents/MacOS/LM Studio');
});

test('procRows: the parent pid is the field after the state letter', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-procppid-'));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00');
  const d = path.join(root, '71');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'cmdline'), ['/usr/local/bin/ollama', 'runner', '--port', '40001'].join('\0'));
  fs.writeFileSync(path.join(d, 'stat'), `71 (ollama) S 70 ${'0 '.repeat(9)}100 0 0 0 0 0 0 0 100 0`);
  fs.writeFileSync(path.join(d, 'status'), 'VmRSS:\t1024 kB\n');
  const [r] = procRows(root, 100);
  assert.equal(r.pid, 71);
  assert.equal(r.ppid, 70);
  assert.equal(r.args, '/usr/local/bin/ollama runner --port 40001');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rows: this process is listed with its parent', { skip: process.platform === 'win32' }, async () => {
  const me = (await rows()).find((r) => r.pid === process.pid);
  assert.ok(me, 'this test process is in the table');
  assert.equal(me.ppid, process.ppid);
});

test('parseWinRows: ExecutablePath becomes argv[0] (the program only); rows without it keep only args', () => {
  const exe = 'C:\\Program Files\\Ollama\\ollama.exe';
  const [a, b, c] = parseWinRows(
    [`7\t10000000\t2048\t10\t"${exe}" serve\t${exe}`, '8\t1\t1024\t10\tC:\\bin\\x.exe --a\t', '9\t1\t1024\t10\tC:\\bin\\y.exe'].join('\r\n'),
  );
  assert.equal(a.args, `"${exe}" serve`);
  assert.deepEqual(a.argv, [exe]);
  assert.equal(a.pid, 7);
  assert.equal(b.argv, undefined);
  assert.equal(b.args, 'C:\\bin\\x.exe --a');
  assert.equal(c.argv, undefined);
  assert.equal(c.args, 'C:\\bin\\y.exe');
});
