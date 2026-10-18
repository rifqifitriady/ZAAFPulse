// Entry point of the single-file ZAAFPulse executable (Node SEA). The app's files travel inside the
// binary as one compressed asset; the first run unpacks them into the user's cache folder (one folder
// per build, so upgrades never mix files) and then runs bin/zaafpulse.js from there.
const sea = require('node:sea');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createRequire } = require('module');

const raw = Buffer.from(sea.getAsset('app.json.gz'));
const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
const cacheRoot = process.env.ZAAFPULSE_APP_CACHE
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ZAAFPulse', 'app')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ZAAFPulse', 'app')
      : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'zaafpulse', 'app'));
const dir = path.join(cacheRoot, id);

if (!fs.existsSync(path.join(dir, '.complete'))) {
  const { files } = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  const tmp = `${dir}.tmp-${process.pid}`;
  for (const [rel, b64] of Object.entries(files)) {
    const f = path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(path.join(tmp, '.complete'), new Date().toISOString());
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // another copy won the race
  // Older unpacked builds are no longer needed.
  for (const old of fs.readdirSync(cacheRoot)) if (old !== id && !old.includes('.tmp-')) fs.rmSync(path.join(cacheRoot, old), { recursive: true, force: true });
}

createRequire(path.join(dir, 'bin', 'zaafpulse.js'))('./zaafpulse.js');
