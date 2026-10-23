// Temporary CI diagnostic: who owns the node that runs the tests, and is it world-writable?
const test = require('node:test');
const fs = require('fs');
const path = require('path');
test('diag: node location trust', (t) => {
  const real = fs.realpathSync(process.execPath);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const p of [process.execPath, path.dirname(process.execPath), real, path.dirname(real)]) {
    const st = fs.statSync(p);
    t.diagnostic(`DIAG ${p} uid=${st.uid} mode=${(st.mode & 0o7777).toString(8)} myuid=${uid}`);
  }
});
