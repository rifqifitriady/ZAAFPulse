// The single-file build: what gets packed (build-single.js) and how the unpacked copy is checked and
// restored on every start (sea-main.js). Runs outside a SEA; sea-main.js then only exports its functions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const sea = require('../scripts/sea-main');
const build = require('../scripts/build-single');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ID = 'a1b2c3d4e5f6';
const SOURCES = {
  'bin/zaafpulse.js': 'console.log("hi");\n',
  'lib/a.js': 'module.exports = 1;\n',
  'public/index.html': '<!doctype html>\n',
};
const packed = () =>
  Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
const MANIFEST = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, sea.sha256(v)]));
const kinds = (problems) => problems.map((p) => `${p.kind} ${p.rel}`).sort();

function setup() {
  const cacheRoot = path.join(tmp('zp-sea-'), 'zaafpulse-builds');
  const logs = [];
  let unpacks = 0;
  const run = (manifest = MANIFEST, files = packed) =>
    sea.prepare({
      cacheRoot,
      id: ID,
      manifest,
      unpack: () => {
        unpacks++;
        return files();
      },
      log: (m) => logs.push(m),
    });
  return { cacheRoot, dir: path.join(cacheRoot, ID), logs, run, unpacks: () => unpacks };
}

test('sea: first run unpacks the build; later runs only verify it', () => {
  const s = setup();
  assert.equal(s.run(), s.dir);
  assert.equal(s.unpacks(), 1);
  assert.equal(fs.readFileSync(path.join(s.dir, 'lib', 'a.js'), 'utf8'), SOURCES['lib/a.js']);
  assert.deepEqual(sea.verifyTree(s.dir, MANIFEST), []);
  assert.equal(s.run(), s.dir);
  assert.equal(s.unpacks(), 1, 'an intact copy is not unpacked again');
  assert.deepEqual(s.logs, []);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(s.dir).mode & 0o077, 0, 'the unpacked folder is private');
    assert.equal(fs.statSync(path.join(s.dir, 'bin', 'zaafpulse.js')).mode & 0o077, 0);
  }
});

test('sea: verifyTree reports changed, missing and added files', () => {
  const s = setup();
  s.run();
  fs.appendFileSync(path.join(s.dir, 'bin', 'zaafpulse.js'), 'require("child_process").exec("evil");\n');
  fs.rmSync(path.join(s.dir, 'public', 'index.html'));
  fs.writeFileSync(path.join(s.dir, 'lib', 'planted.js'), 'x');
  fs.mkdirSync(path.join(s.dir, 'node_modules', 'fs'), { recursive: true });
  fs.writeFileSync(path.join(s.dir, 'node_modules', 'fs', 'index.js'), 'x');
  assert.deepEqual(kinds(sea.verifyTree(s.dir, MANIFEST)), [
    'changed bin/zaafpulse.js',
    'extra lib/planted.js',
    'extra node_modules/fs/index.js',
    'missing public/index.html',
  ]);
  assert.deepEqual(kinds(sea.verifyTree(path.join(s.cacheRoot, 'nope'), MANIFEST)), [
    'missing bin/zaafpulse.js',
    'missing lib/a.js',
    'missing public/index.html',
  ]);
});

test('sea: a tampered copy is restored from the build before anything runs', () => {
  const s = setup();
  s.run();
  const main = path.join(s.dir, 'bin', 'zaafpulse.js');
  fs.writeFileSync(main, 'tampered');
  fs.writeFileSync(path.join(s.dir, 'lib', 'planted.js'), 'x');
  fs.rmSync(path.join(s.dir, 'lib', 'a.js'));
  assert.equal(s.run(), s.dir);
  assert.equal(s.unpacks(), 2);
  assert.equal(fs.readFileSync(main, 'utf8'), SOURCES['bin/zaafpulse.js']);
  assert.ok(!fs.existsSync(path.join(s.dir, 'lib', 'planted.js')));
  assert.deepEqual(sea.verifyTree(s.dir, MANIFEST), []);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /differs from this build \(.*changed bin\/zaafpulse\.js.*\); restoring it/);
});

test('sea: links in the unpacked copy are removed, never followed', (t) => {
  const s = setup();
  s.run();
  const outside = tmp('zp-outside-');
  fs.writeFileSync(path.join(outside, 'a.js'), 'module.exports = "evil";\n');
  fs.rmSync(path.join(s.dir, 'lib'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(s.dir, 'lib'), 'junction');
  } catch {
    return t.skip('cannot create links here');
  }
  assert.deepEqual(kinds(sea.verifyTree(s.dir, MANIFEST)), ['extra lib', 'missing lib/a.js']);
  s.run();
  assert.ok(fs.lstatSync(path.join(s.dir, 'lib')).isDirectory());
  assert.equal(fs.readFileSync(path.join(s.dir, 'lib', 'a.js'), 'utf8'), SOURCES['lib/a.js']);
  assert.equal(fs.readFileSync(path.join(outside, 'a.js'), 'utf8'), 'module.exports = "evil";\n', 'target untouched');
});

test('sea: a damaged build or an unsafe cache folder stops the run', (t) => {
  const s = setup();
  const bad = () => ({ ...packed(), 'lib/a.js': Buffer.from('other').toString('base64') });
  assert.throws(() => s.run(MANIFEST, bad), /this build is damaged \(lib\/a\.js\)/);
  assert.ok(!fs.existsSync(s.dir), 'nothing is unpacked from a damaged build');
  assert.throws(() => sea.decode({ ...packed(), '../x': '' }, MANIFEST), /bad path in build/);
  const { 'lib/a.js': _, ...missing } = packed();
  assert.throws(() => sea.decode(missing, MANIFEST), /damaged \(lib\/a\.js\)/);
  assert.throws(
    () => sea.prepare({ cacheRoot: s.cacheRoot, id: '../x', manifest: MANIFEST, unpack: packed }),
    /bad build id/,
  );

  if (process.platform === 'win32') return t.skip('owner and mode checks are POSIX only');
  s.run();
  fs.chmodSync(s.dir, 0o777);
  assert.throws(() => s.run(), /writable by others/);
});

test('sea: the cache folder follows ZAAFPULSE_APP_CACHE and stays in its own subfolder', () => {
  assert.equal(sea.cacheRootFor({ ZAAFPULSE_APP_CACHE: '/x/y' }), path.join('/x/y', 'zaafpulse-builds'));
  assert.equal(path.basename(sea.cacheRootFor({})), 'zaafpulse-builds');
});

test('build: the packed files and the manifest agree, and survive a round trip', () => {
  const root = tmp('zp-src-');
  for (const [rel, text] of Object.entries(SOURCES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const { gz, manifest } = build.payload(Object.keys(SOURCES), root);
  const m = JSON.parse(manifest);
  assert.equal(m.version, 1);
  assert.deepEqual(m.files, MANIFEST);
  const { files } = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  const decoded = sea.decode(files, m.files);
  assert.equal(decoded['lib/a.js'].toString(), SOURCES['lib/a.js']);
});

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('build: only committed, tracked files are packed', { skip: !hasGit() && 'git is not installed' }, () => {
  const root = tmp('zp-repo-');
  const g = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      stdio: 'ignore',
    });
  g('init', '-q');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('lib/a.js', '1');
  write('lib/.hidden', 'x');
  write('server.js', '2');
  write('README.md', 'not packed');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  write('lib/untracked.js', 'should never ship');
  assert.deepEqual(build.trackedFiles({ root }), ['lib/a.js', 'server.js']);

  write('lib/a.js', 'edited');
  assert.throws(() => build.trackedFiles({ root }), /uncommitted changes in files that would ship \(.*lib\/a\.js/);
  const warnings = [];
  const files = build.trackedFiles({ root, allowDirty: true, warn: (m) => warnings.push(m) });
  assert.deepEqual(files, ['lib/a.js', 'server.js']);
  assert.match(warnings[0], /uncommitted changes: .*lib\/a\.js/);
  write('README.md', 'edited, not packed');
  write('lib/a.js', '1');
  assert.deepEqual(build.trackedFiles({ root }), ['lib/a.js', 'server.js']);

  assert.throws(() => build.trackedFiles({ root: tmp('zp-nogit-') }), /build from a git checkout/);
});

test('build: this repository packs every file the app needs and nothing untracked', { skip: !hasGit() }, (t) => {
  let files;
  try {
    files = build.trackedFiles({ allowDirty: true, warn: () => {} });
  } catch {
    return t.skip('not a git checkout');
  }
  for (const f of ['bin/zaafpulse.js', 'server.js', 'mcp.js', 'package.json', 'LICENSE', 'scripts/register-mcp.js'])
    assert.ok(files.includes(f), f);
  assert.ok(files.every((f) => build.INCLUDE.some((i) => f === i || f.startsWith(`${i}/`))));
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('node_modules/')));
});
