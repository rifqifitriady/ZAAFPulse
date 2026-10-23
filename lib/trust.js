// Whether a program found on its own may be run. On POSIX the file and its folder (also of the real file behind a
// link) must belong to this user or root and must not be writable by everyone, so another user cannot swap it.
// Writable by the group is allowed: it is what umask 002 (Ubuntu's default) gives every install. Windows: true.
const fs = require('fs');
const path = require('path');

function trusted(f, { platform = process.platform } = {}) {
  if (platform === 'win32' || typeof process.getuid !== 'function') return true;
  const uid = process.getuid();
  try {
    for (const p of new Set([f, fs.realpathSync(f)])) {
      for (const x of [p, path.dirname(p)]) {
        const st = fs.statSync(x);
        if (st.mode & 0o002 || (st.uid !== uid && st.uid !== 0)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { trusted };
