// Entry point of the single-file ZAAFPulse executable (Node SEA). The app's files travel inside the
// binary as one compressed asset, with a manifest of their SHA-256 hashes. The first run unpacks them into
// the user's cache folder (one folder per build, so upgrades never mix files); every run then checks that
// folder against the manifest before running bin/zaafpulse.js from it. A changed, missing or added file is
// restored from the binary (or the run stops), so code edited in the cache never runs.
//
// Why unpack at all instead of running from memory: the app reads its own folder at run time (public/,
// skills/, config.example.json, package.json), so the files have to exist on disk. The check on every
// start costs a few milliseconds (CONTRIBUTING.md, "Releases").
//
// The tests load this file outside a SEA; it then only exports its functions. A SEA's main script can
// only require Node's built-in modules, so everything it needs lives here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createRequire } = require('module');

const BUILD_ID = /^[0-9a-f]{12}$/;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fileOf = (dir, rel) => path.join(dir, ...rel.split('/'));

// Every entry under dir as 'a/b.js' paths. Folders are walked; anything else (a file, a link, a junction)
// is listed with whether it is a regular file. Links are never followed.
function listTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else out.push({ rel: r, file: e.isFile() });
    }
  };
  walk(dir, '');
  return out;
}

// What differs between an unpacked folder and the manifest ({ 'bin/zaafpulse.js': '<sha256>', … }):
// [] when every listed file is there unchanged and nothing else is. Each problem is
// { kind: 'changed' | 'missing' | 'extra', rel }.
function verifyTree(dir, manifest) {
  let entries = [];
  try {
    entries = listTree(dir);
  } catch {
    // no folder: every file is missing
  }
  const problems = [];
  const present = new Set();
  for (const { rel, file } of entries) {
    if (!own(manifest, rel)) {
      problems.push({ kind: 'extra', rel });
      continue;
    }
    present.add(rel);
    if (!file || sha256(fs.readFileSync(fileOf(dir, rel))) !== manifest[rel]) problems.push({ kind: 'changed', rel });
  }
  for (const rel of Object.keys(manifest)) if (!present.has(rel)) problems.push({ kind: 'missing', rel });
  return problems;
}

// The packed files ({ path: base64 }) decoded, after checking they are exactly the files of the manifest.
// A mismatch means the binary itself is damaged or was built wrongly; nothing is written then.
function decode(files, manifest) {
  const out = {};
  for (const [rel, b64] of Object.entries(files)) {
    if (rel.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad path in build: ${rel}`);
    const data = Buffer.from(b64, 'base64');
    if (!own(manifest, rel) || sha256(data) !== manifest[rel]) throw new Error(`this build is damaged (${rel})`);
    out[rel] = data;
  }
  for (const rel of Object.keys(manifest)) if (!own(out, rel)) throw new Error(`this build is damaged (${rel})`);
  return out;
}

// Replaces a file by renaming a finished copy over it, so another running copy never reads half a file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The unpacked app is code that runs as this user: each folder must be a real folder (not a link or a
// junction) and, outside Windows, owned by this account and not writable by others; otherwise someone could
// plant files between the check and the run. Node cannot read Windows ACLs; there the default ACL of
// %LOCALAPPDATA% (the user, SYSTEM, Administrators) does that job, and the content check catches anything
// planted before a run.
function checkFolder(p) {
  const st = fs.lstatSync(p);
  const unsafe =
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    (process.platform !== 'win32' && (st.uid !== process.getuid() || (st.mode & 0o022) !== 0));
  if (unsafe)
    throw new Error(`${p} is a link, belongs to another account or is writable by others; remove it and run again.`);
}

const describe = (problems) =>
  problems
    .slice(0, 3)
    .map((p) => `${p.kind} ${p.rel}`)
    .join(', ') + (problems.length > 3 ? ` and ${problems.length - 3} more` : '');

// Makes cacheRoot/<id> an exact copy of the build and returns its path.
//   manifest  { path: sha256 } of every packed file
//   unpack    () => { path: base64 }; called only when files have to be written
//   log       where a repair is reported
function prepare({ cacheRoot, id, manifest, unpack, log = (m) => console.error(m) }) {
  if (!BUILD_ID.test(id)) throw new Error(`bad build id ${id}`);
  const dir = path.join(cacheRoot, id);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  checkFolder(cacheRoot);

  if (!fs.existsSync(dir)) {
    // First run of this build: unpack everything next to it, then move it into place in one step.
    const files = decode(unpack(), manifest);
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [rel, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(fileOf(tmp, rel)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileOf(tmp, rel), data, { mode: 0o600 });
    }
    try {
      fs.renameSync(tmp, dir);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another copy won the race; checked below
    }
    // Older unpacked builds are no longer needed; only folders named like a build id are touched.
    for (const old of fs.readdirSync(cacheRoot))
      if (old !== id && BUILD_ID.test(old) && !fs.lstatSync(path.join(cacheRoot, old)).isSymbolicLink())
        fs.rmSync(path.join(cacheRoot, old), { recursive: true, force: true });
  }
  checkFolder(dir);

  let problems = verifyTree(dir, manifest);
  if (problems.length) {
    log(`ZAAFPulse: the unpacked app in ${dir} differs from this build (${describe(problems)}); restoring it.`);
    const files = decode(unpack(), manifest);
    // Extras go first, so a link put in place of a folder is gone before files are written below it.
    for (const p of problems) if (p.kind === 'extra') fs.rmSync(fileOf(dir, p.rel), { recursive: true, force: true });
    for (const p of problems) {
      if (p.kind === 'extra') continue;
      const file = fileOf(dir, p.rel);
      if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fs.rmSync(file, { recursive: true, force: true });
      writeAtomic(file, files[p.rel]);
    }
    problems = verifyTree(dir, manifest);
    if (problems.length)
      throw new Error(
        `the unpacked app in ${dir} could not be restored (${describe(problems)}); remove that folder and run again.`,
      );
  }
  return dir;
}

// Where builds are unpacked: <cache>/zaafpulse-builds/<id>. Builds live in their own subfolder, so pointing
// ZAAFPULSE_APP_CACHE at an existing folder never puts anything else in reach of the cleanup.
function cacheRootFor(env = process.env) {
  const base =
    env.ZAAFPULSE_APP_CACHE ||
    (process.platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ZAAFPulse', 'app')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches', 'ZAAFPulse', 'app')
        : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'zaafpulse', 'app'));
  return path.join(base, 'zaafpulse-builds');
}

function main(sea) {
  const manifestText = sea.getAsset('manifest.json', 'utf8');
  let dir;
  try {
    dir = prepare({
      cacheRoot: cacheRootFor(),
      id: sha256(manifestText).slice(0, 12),
      manifest: JSON.parse(manifestText).files,
      unpack: () => JSON.parse(zlib.gunzipSync(sea.getAsset('app.json.gz')).toString('utf8')).files,
    });
  } catch (err) {
    console.error(`ZAAFPulse: ${err.message}`);
    process.exit(1);
  }
  createRequire(path.join(dir, 'bin', 'zaafpulse.js'))('./zaafpulse.js');
}

let sea = null;
try {
  sea = require('node:sea');
} catch {
  // Node before 20 has no node:sea; this is then never a SEA.
}
if (sea && sea.isSea()) main(sea);
else module.exports = { listTree, verifyTree, decode, prepare, cacheRootFor, sha256 };
