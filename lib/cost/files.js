// Private files for the cost ledger. A rewrite is atomic and hardened like saveConfigSection in server.js: a temp file
// of its own (two writers never share one), created 0600 and never an existing file ('wx'), then a rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensurePrivateDir } = require('../evals/store');

// ensurePrivateDir leaves an existing folder as it is, so tighten one that is looser than 0700 (older build, manual mkdir).
function ensureDir(dir) {
  ensurePrivateDir(dir);
  if (process.platform === 'win32') return;
  try {
    if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours: best effort */
  }
}

function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// A crash mid-append can leave a torn last line. End it first, through the same descriptor, so the text appended now
// starts a line of its own instead of being glued to the torn one (and lost with it when the file is read back).
function appendPrivate(file, text) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    const { size } = fs.fstatSync(fd);
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    fs.writeSync(fd, lead + text);
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = { writePrivate, appendPrivate, readJson };
