#!/usr/bin/env node
// Builds single-file ZAAFPulse executables with Node's SEA (single executable application) support.
//   node scripts/build-single.js                         this machine's OS and CPU
//   node scripts/build-single.js linux-x64 win-x64 ...   any of: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win-x64 win-arm64
// Each target starts from the official Node.js binary for that platform (same version as the one running
// this script, checked against nodejs.org's SHA256SUMS; a local Homebrew or distro build would not be
// portable), and the app is injected with postject.
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
const here = `${{ darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform]}-${process.arch}`;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [here];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function payload() {
  const files = {};
  const add = (rel) => {
    const abs = path.join(ROOT, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(abs)) if (!n.startsWith('.')) add(`${rel}/${n}`);
      return;
    }
    files[rel] = fs.readFileSync(abs).toString('base64');
  };
  INCLUDE.forEach(add);
  return zlib.gzipSync(JSON.stringify({ files }), { level: 9 });
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
  const got = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (got !== want.split(/\s+/)[0]) throw new Error(`checksum mismatch for ${name}`);
  const out = path.join(work, target);
  fs.mkdirSync(out, { recursive: true });
  // GNU tar (Linux) cannot read .zip; bsdtar (macOS, Windows) reads both.
  if (name.endsWith('.zip') && process.platform === 'linux') sh('unzip', ['-q', archive, '-d', out]);
  else sh('tar', ['-xf', archive, '-C', out]);
  const dir = path.join(out, name.replace(/\.(zip|tar\.gz)$/, ''));
  return osName === 'win' ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node');
}

(async () => {
  fs.mkdirSync(DIST, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-sea-'));
  fs.writeFileSync(path.join(work, 'app.json.gz'), payload());
  fs.writeFileSync(
    path.join(work, 'sea-config.json'),
    JSON.stringify({
      main: path.join(__dirname, 'sea-main.js'),
      output: path.join(work, 'sea.blob'),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false, // portable across targets
      assets: { 'app.json.gz': path.join(work, 'app.json.gz') },
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
    sh(
      'npx',
      [
        '--yes',
        'postject@1.0.0-alpha.6',
        out,
        'NODE_SEA_BLOB',
        path.join(work, 'sea.blob'),
        '--sentinel-fuse',
        FUSE,
        ...(target.startsWith('darwin') ? ['--macho-segment-name', 'NODE_SEA'] : []),
      ],
      { shell: process.platform === 'win32' },
    );
    if (target.startsWith('darwin')) sh('codesign', ['--sign', '-', out]);
    sums.push(`${crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')}  ${path.basename(out)}`);
    console.log(`built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
  }
  fs.appendFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  fs.rmSync(work, { recursive: true, force: true });
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
