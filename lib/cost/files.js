// Private files for the cost ledger. A rewrite is atomic and hardened like saveConfigSection in server.js: a temp file
// of its own (two writers never share one), created 0600 and never an existing file ('wx'), synced, then a rename.
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

// The data reaches the disk before the rename, and the rename before the caller goes on: after a power loss the file
// is the old copy or the new one, never empty or torn (a lost cursors.json would make the logs be read again).
function writePrivate(file, data) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* already failing */
      }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  syncDir(dir);
}

// The rename is kept once the folder's entry is on disk. Windows cannot open a folder for this; some file systems
// refuse it (EINVAL): best effort, the file itself is already synced.
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== null)
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
  }
}

// Moves a file that does not read as it should to a `.bad` name of its own (never over an earlier one), so it is kept
// for a look by hand and the next save starts clean.
function setAside(file) {
  let bad = `${file}.bad`;
  for (let n = 1; fs.existsSync(bad); n++) bad = `${file}.bad.${n}`;
  try {
    fs.renameSync(file, bad);
  } catch {
    /* best effort: the next save replaces it */
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

module.exports = { writePrivate, appendPrivate, readJson, setAside };
