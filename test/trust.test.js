const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trusted } = require('../lib/trust');

const POSIX = process.platform !== 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-trust-'));
const file = (dir, mode) => {
  const f = path.join(dir, 'tool');
  fs.writeFileSync(f, '#!/bin/sh\n');
  fs.chmodSync(f, mode);
  return f;
};

test('trusted: our own file in our own folder, group-writable allowed', { skip: !POSIX }, () => {
  const d = tmp();
  assert.equal(trusted(file(d, 0o755)), true);
  assert.equal(trusted(file(d, 0o775)), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('trusted: not a file writable by everyone, nor one in a folder writable by everyone', { skip: !POSIX }, () => {
  const d = tmp();
  assert.equal(trusted(file(d, 0o777)), false);
  const w = tmp();
  const f = file(w, 0o755);
  fs.chmodSync(w, 0o777);
  assert.equal(trusted(f), false);
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(w, { recursive: true, force: true });
});

test('trusted: a link is judged by the real file behind it too; a missing file is not trusted', { skip: !POSIX }, () => {
  const real = tmp();
  const f = file(real, 0o777);
  const d = tmp();
  const link = path.join(d, 'link');
  fs.symlinkSync(f, link);
  assert.equal(trusted(link), false);
  assert.equal(trusted(path.join(d, 'missing')), false);
  fs.rmSync(real, { recursive: true, force: true });
  fs.rmSync(d, { recursive: true, force: true });
});

test('trusted: Windows has no such check', () => {
  assert.equal(trusted('C:\\x\\missing.exe', { platform: 'win32' }), true);
});
