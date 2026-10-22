const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseVmStat, procRows, isOwn, groupApps, parsePsComm, argvFrom } = require('../lib/processes');

test('parseVmStat counts app memory, wired and compressed pages', () => {
  const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     5219.
Pages active:                                 170957.
Pages wired down:                                 64.
Pages purgeable:                                  64.
Anonymous pages:                                 128.
Pages occupied by compressor:                     64.`;
  // (128 - 64) + 64 + 64 = 192 pages of 16 KB = 3 MB
  assert.strictEqual(parseVmStat(out), 3);
});

test('parseVmStat returns null when nothing parses', () => {
  assert.strictEqual(parseVmStat('garbage'), null);
});

test("procRows: only state T (stopped by a signal) is stopped; t (a debugger's stop) and others are not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-procstate-'));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00');
  for (const [pid, state] of [
    [51, 'T'],
    [52, 't'],
    [53, 'S'],
  ]) {
    const d = path.join(root, String(pid));
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'cmdline'), '/home/u/.local/bin/claude'.split(' ').join('\0'));
    fs.writeFileSync(path.join(d, 'stat'), `${pid} (claude) ${state} ${'0 '.repeat(10)}100 0 0 0 0 0 0 0 100 0`);
    fs.writeFileSync(path.join(d, 'status'), 'VmRSS:\t1024 kB\n');
  }
  const stopped = Object.fromEntries(procRows(root, 100).map((r) => [r.pid, r.stopped]));
  assert.deepEqual(stopped, { 51: true, 52: false, 53: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('isOwn: this process, anything run from the ZAAFPulse folder and the judge are not apps; groupApps agrees', () => {
  const r = (pid, args, extra = {}) => ({ pid, cpu: 1, rssKB: 1024, upSec: 5, args, ...extra });
  const claude = '/home/u/.local/bin/claude --resume';
  assert.equal(isOwn(r(process.pid, claude)), true);
  assert.equal(isOwn(r(8, 'node /home/u/ai-command-center/server.js claude')), true);
  assert.equal(isOwn(r(8, 'node /srv/ZAAFPulse/server.js claude')), true);
  assert.equal(isOwn(r(8, claude), new Set([8])), true);
  assert.equal(isOwn(r(8, claude, { cwd: path.join(os.tmpdir(), 'zaafpulse-judge-x1') })), true);
  assert.equal(isOwn(r(8, claude)), false);
  const rows = [r(8, claude), r(9, 'node /srv/zaafpulse/x.js claude'), r(10, claude)];
  assert.deepEqual(
    groupApps(rows, { skip: new Set([10]) }).map((a) => [a.id, a.processes]),
    [['claude', 1]],
  );
});

test('procRows: argv keeps each argument whole, spaces included', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-procargv-'));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 900.00');
  const argv = ['/opt/My Tools/claude', '--resume', 'a b'];
  const d = path.join(root, '61');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'cmdline'), `${argv.join('\0')}\0`);
  fs.writeFileSync(path.join(d, 'stat'), `61 (claude) S ${'0 '.repeat(10)}100 0 0 0 0 0 0 0 100 0`);
  fs.writeFileSync(path.join(d, 'status'), 'VmRSS:\t1024 kB\n');
  const [r] = procRows(root, 100);
  assert.deepEqual(r.argv, argv);
  assert.equal(r.args, argv.join(' '));
  fs.rmSync(root, { recursive: true, force: true });
});

// macOS: ps comm is the executable's full path, so a path with a space is read whole.
test('parsePsComm and argvFrom: the executable path whole, then the other arguments', () => {
  const exe = '/Users/u/Library/Application Support/Claude/claude-code/2.1.308/a9/claude.app/Contents/MacOS/claude';
  const node = '/Users/u/.nvm/versions/node/v24.16.0/bin/node';
  const exes = parsePsComm(`41415 ${exe}\n  1128 ${node}\n\ngarbage\n`);
  assert.equal(exes.get(41415), exe);
  assert.equal(exes.get(1128), node);
  assert.equal(exes.size, 2);
  assert.deepEqual(argvFrom(`${exe} --output-format stream-json`, exe), [exe, '--output-format', 'stream-json']);
  // Run by another name (node from PATH): the first word is that name, the executable is the real path.
  assert.deepEqual(argvFrom('node /usr/local/bin/claude -c', node), [node, '/usr/local/bin/claude', '-c']);
  assert.deepEqual(argvFrom(exe, exe), [exe]);
});
