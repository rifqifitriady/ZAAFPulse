// Private files for the cost ledger. A rewrite is atomic and hardened like saveConfigSection in server.js: a temp file
// of its own (two writers never share one), created 0600 and never an existing file ('wx'), then a rename.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensurePrivateDir } = require('../evals/store');

function writePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function appendPrivate(file, text) {
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, text, { mode: 0o600 });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = { writePrivate, appendPrivate, readJson };
