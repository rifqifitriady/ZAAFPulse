const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVmStat } = require('../lib/processes');

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
