#!/usr/bin/env node
// Builds single-file ZAAFPulse executables with Node's SEA (single executable application) support.
//   npm ci                                               once: installs postject, the injector (lockfile-pinned)
//   node scripts/build-single.js                         this machine's OS and CPU
//   node scripts/build-single.js linux-x64 win-x64 ...   any of: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win-x64 win-arm64
//   --allow-dirty                                        build with uncommitted changes (local testing only)
// Each target starts from the official Node.js binary for that platform (same version as the one running
// this script, checked against nodejs.org's SHA256SUMS; a local Homebrew or distro build would not be
// portable), and the app is injected with postject.
// Only files tracked by git are packed, and the build stops when any of them has uncommitted changes, so an
// untracked or edited file never ships. The blob also carries manifest.json, the SHA-256 of every packed
// file, which sea-main.js checks the unpacked copy against on every start.
// macOS binaries are ad-hoc signed and must be built on a Mac (codesign). Output goes to dist/.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = process.version; // the blob must come from the same Node version as the target binary
const INCLUDE = [
  'bin',
  'lib',
  'public',
  'skills',
  'scripts/register-mcp.js',
  'server.js',
  'mcp.js',
  'package.json',
  'config.example.json',
  'LICENSE',
];
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const git = (root, args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// The files to pack: tracked by git, under INCLUDE, no dot-files (as before), sorted.
// Refuses a tree whose packed files (or sea-main.js) differ from the last commit, unless allowDirty.
function trackedFiles({ root = ROOT, allowDirty = false, warn = (m) => console.warn(m) } = {}) {
  let listed;
  try {
    listed = git(root, ['ls-files', '-z', '--', ...INCLUDE]);
  } catch {
    throw new Error('build from a git checkout: the files to pack are taken from `git ls-files`');
  }
  const dirty = git(root, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=no',
    '--',
    ...INCLUDE,
    'scripts/sea-main.js',
  ])
    .split('\0')
    .filter(Boolean);
  if (dirty.length && !allowDirty)
    throw new Error(
      `uncommitted changes in files that would ship (${dirty.slice(0, 5).join(', ')}); commit them, or pass --allow-dirty for a local test build`,
    );
  if (dirty.length) warn(`warning: building with uncommitted changes: ${dirty.join(', ')}`);
  return listed
    .split('\0')
    .filter((rel) => rel && !rel.split('/').some((p) => p.startsWith('.')))
    .sort();
}

// The app asset (gzip of { files: { path: base64 } }) and its manifest ({ files: { path: sha256 } }).
function payload(rels, root = ROOT) {
  const files = {};
  const manifest = {};
  for (const rel of rels) {
    const data = fs.readFileSync(path.join(root, ...rel.split('/')));
    files[rel] = data.toString('base64');
    manifest[rel] = sha256(data);
  }
  return {
    gz: zlib.gzipSync(JSON.stringify({ files }), { level: 9 }),
    manifest: JSON.stringify({ version: 1, files: manifest }),
  };
}

// postject from node_modules (installed by `npm ci`, so the lockfile's integrity hash was checked), run
// with this Node; never fetched at build time.
function postjectCli() {
  try {
    return require.resolve('postject/dist/cli.js', { paths: [ROOT] });
  } catch {
    throw new Error('postject is not installed: run `npm ci` first (it is a pinned devDependency)');
  }
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

// The official node binary for a target, from nodejs.org (verified).
async function nodeBinary(target, work) {
  const [osName, arch] = target.split('-');
  const name = osName === 'win' ? `node-${VERSION}-win-${arch}.zip` : `node-${VERSION}-${osName}-${arch}.tar.gz`;
  const base = `https://nodejs.org/dist/${VERSION}`;
  const sums = path.join(work, 'SHASUMS256.txt');
  if (!fs.existsSync(sums)) await download(`${base}/SHASUMS256.txt`, sums);
  const want = fs
    .readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.endsWith(`  ${name}`));
  if (!want) throw new Error(`no ${name} for ${VERSION}`);
  const archive = path.join(work, name);
  await download(`${base}/${name}`, archive);
  if (sha256(fs.readFileSync(archive)) !== want.split(/\s+/)[0]) throw new Error(`checksum mismatch for ${name}`);
  const out = path.join(work, target);
  fs.mkdirSync(out, { recursive: true });
  // GNU tar (Linux) cannot read .zip; bsdtar (macOS, Windows) reads both.
  if (name.endsWith('.zip') && process.platform === 'linux') sh('unzip', ['-q', archive, '-d', out]);
  else sh('tar', ['-xf', archive, '-C', out]);
  const dir = path.join(out, name.replace(/\.(zip|tar\.gz)$/, ''));
  return osName === 'win' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
}

async function main(argv) {
  const allowDirty = argv.includes('--allow-dirty');
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--allow-dirty');
  if (unknown.length) throw new Error(`unknown option ${unknown[0]}`);
  const here = `${{ darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`;
  const names = argv.filter((a) => !a.startsWith('--'));
  const targets = names.length ? names : [here];
  const postject = postjectCli();

  fs.mkdirSync(DIST, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-sea-'));
  const { gz, manifest } = payload(trackedFiles({ allowDirty }));
  fs.writeFileSync(path.join(work, 'app.json.gz'), gz);
  fs.writeFileSync(path.join(work, 'manifest.json'), manifest);
  fs.writeFileSync(
    path.join(work, 'sea-config.json'),
    JSON.stringify({
      main: path.join(__dirname, 'sea-main.js'),
      output: path.join(work, 'sea.blob'),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false, // portable across targets
      assets: { 'app.json.gz': path.join(work, 'app.json.gz'), 'manifest.json': path.join(work, 'manifest.json') },
    }),
  );
  sh(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')]);
  const version = require('../package.json').version;
  const sums = [];
  for (const target of targets) {
    if (target.startsWith('darwin') && process.platform !== 'darwin')
      throw new Error('macOS targets must be built on a Mac (codesign)');
    const src = await nodeBinary(target, work);
    const out = path.join(DIST, `zaafpulse-${version}-${target}${target.startsWith('win') ? '.exe' : ''}`);
    fs.copyFileSync(src, out);
    fs.chmodSync(out, 0o755);
    if (target.startsWith('darwin')) sh('codesign', ['--remove-signature', out]);
    sh(process.execPath, [
      postject,
      out,
      'NODE_SEA_BLOB',
      path.join(work, 'sea.blob'),
      '--sentinel-fuse',
      FUSE,
      ...(target.startsWith('darwin') ? ['--macho-segment-name', 'NODE_SEA'] : []),
    ]);
    if (target.startsWith('darwin')) sh('codesign', ['--sign', '-', out]);
    sums.push(`${sha256(fs.readFileSync(out))}  ${path.basename(out)}`);
    console.log(`built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
  }
  fs.appendFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  fs.rmSync(work, { recursive: true, force: true });
}

if (require.main === module)
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
else module.exports = { INCLUDE, trackedFiles, payload };
