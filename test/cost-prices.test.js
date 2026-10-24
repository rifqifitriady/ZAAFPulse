// test/cost-prices.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPriceVersions, hashOf } = require('../lib/cost/prices');
const { writePrivate } = require('../lib/cost/files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zp-cost-prices-'));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const sum = (parts) => parts.reduce((a, b) => a + b, 0);
const mode = (p) => fs.statSync(p).mode & 0o777;

test('observe: the first prices are version 1; equal prices add nothing; a change adds a version from that day', () => {
  let t = 1000;
  const A = { m: { input: 1, output: 2 } };
  const p = createPriceVersions({ now: () => t });
  const v1 = p.observe(A, '2026-10-20');
  assert.deepEqual(v1, { id: 1, from: '2026-10-20', at: 1000, hash: hashOf(A), changed: [], changedCount: 0 });
  assert.equal(p.observe(A, '2026-10-21'), v1, 'the same object');
  assert.equal(p.observe({ m: { output: 2, input: 1 } }, '2026-10-21').id, 1, 'equal prices in a new object');
  t = 2000;
  const v2 = p.observe({ m: { input: 1, output: 3 }, n: { input: 5 } }, '2026-10-22');
  assert.deepEqual([v2.id, v2.from, v2.at, v2.changed, v2.changedCount], [2, '2026-10-22', 2000, ['m', 'n'], 2]);
  assert.equal(
    p.versionFor('2026-10-01').id,
    1,
    'before the first version: the first (history priced on the first run)',
  );
  assert.equal(p.versionFor('2026-10-21').id, 1);
  assert.equal(p.versionFor('2026-10-22').id, 2);
  assert.equal(p.versionFor('2026-12-01').id, 2);
  p.observe({ m: { input: 9 } }, '2026-10-22');
  assert.equal(p.versionFor('2026-10-22').id, 3, 'the newest version of a day wins');
  const v4 = p.observe({ m: { input: 8 } }, '2026-10-19');
  assert.equal(v4.from, '2026-10-22', 'a clock that went back never dates a version earlier');
  assert.equal(p.current().id, 4);
  assert.equal(createPriceVersions().versionFor('2026-10-22'), null, 'no versions yet');
});

test('versions persist in prices/ (folder 0700, files 0600, no temp file left) and price with their own table', () => {
  const dir = path.join(tmp(), 'cost', 'prices');
  const p = createPriceVersions({ dir });
  p.observe({ 'claude-sonnet-5-5': { input: 2, output: 10 } }, '2026-10-21');
  p.observe({ 'claude-sonnet-5-5': { input: 4, output: 20 } }, '2026-10-22');
  const again = createPriceVersions({ dir });
  assert.deepEqual(
    again.list().map((v) => [v.id, v.from]),
    [
      [1, '2026-10-21'],
      [2, '2026-10-22'],
    ],
  );
  near(sum(again.pricerFor(1).parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0, null)), 0.003);
  near(sum(again.pricerFor(2).parts('claude-sonnet-5-5', 1000, 100, 0, 0, 0, null)), 0.006);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.json', '2.json', 'versions.json']);
  if (process.platform !== 'win32') {
    assert.equal(mode(dir), 0o700);
    for (const f of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, f)), 0o600, f);
  }
});

test('memory mode writes nothing; seed adds demo versions with their hash and changed keys', () => {
  const p = createPriceVersions();
  p.seed([
    { from: '2026-10-01', at: 1, pricing: { a: { input: 3 } } },
    { from: '2026-10-11', at: 2, pricing: { a: { input: 2 } } },
  ]);
  assert.deepEqual(
    p.list().map((v) => [v.id, v.from, v.changed]),
    [
      [1, '2026-10-01', []],
      [2, '2026-10-11', ['a']],
    ],
  );
  assert.equal(p.list()[1].hash, hashOf({ a: { input: 2 } }));
  assert.equal(p.versionFor('2026-10-05').id, 1);
});

test('writePrivate: 0600, replaces the file, and leaves no temp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'x.json');
  writePrivate(file, 'one');
  writePrivate(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  if (process.platform !== 'win32') assert.equal(mode(file), 0o600);
  assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }), 'key order does not change the hash');
});

test('writePrivate tightens an existing looser folder to 0700', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'prices');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  createPriceVersions({ dir }).observe({ m: { input: 1 } }, '2026-10-21');
  assert.equal(mode(dir), 0o700);
});

test('a corrupt versions.json is kept aside and rebuilt from the bodies; ids never reuse a body file', () => {
  const dir = path.join(tmp(), 'prices');
  const p = createPriceVersions({ dir });
  p.observe({ m: { input: 1 } }, '2026-10-20');
  p.observe({ m: { input: 2 } }, '2026-10-21');
  const before = [1, 2].map((i) => fs.readFileSync(path.join(dir, `${i}.json`), 'utf8'));
  fs.writeFileSync(path.join(dir, 'versions.json'), '{ truncated');
  const again = createPriceVersions({ dir });
  assert.deepEqual(
    again.list().map((v) => [v.id, v.from, v.changed]),
    [
      [1, '2026-10-20', []],
      [2, '2026-10-21', ['m']],
    ],
  );
  assert.ok(fs.existsSync(path.join(dir, 'versions.json.bad')));
  assert.equal(again.problems().length, 1);
  assert.ok(!again.problems().join('').includes(dir), 'no path in the report');
  assert.equal(again.observe({ m: { input: 3 } }, '2026-10-22').id, 3);
  assert.deepEqual(
    [1, 2].map((i) => fs.readFileSync(path.join(dir, `${i}.json`), 'utf8')),
    before,
  );
  fs.writeFileSync(path.join(dir, 'versions.json'), '[1]');
  createPriceVersions({ dir });
  assert.ok(fs.existsSync(path.join(dir, 'versions.json.bad.1')), 'a unique name when .bad exists');
});

test('unusable bodies and entries are dropped and reported; nothing throws', () => {
  const dir = path.join(tmp(), 'prices');
  const p = createPriceVersions({ dir });
  p.observe({ m: { input: 1 } }, '2026-10-20');
  p.observe({ m: { input: 2 } }, '2026-10-21');
  p.observe({ m: { input: 3 } }, '2026-10-22');
  p.observe({ m: { input: 4 } }, '2026-10-23');
  fs.writeFileSync(path.join(dir, '2.json'), 'null');
  fs.rmSync(path.join(dir, '3.json'));
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8'));
  delete idx.versions[3].changed;
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify(idx));
  const again = createPriceVersions({ dir });
  assert.deepEqual(
    again.list().map((v) => v.id),
    [1, 4],
  );
  assert.ok(Array.isArray(again.list()[1].changed));
  assert.equal(again.versionFor('2026-10-22').id, 1, 'falls back to the previous usable version');
  assert.equal(again.problems().length, 2);
  assert.ok(!again.problems().join('').includes(dir));
  near(sum(again.pricerFor(1).parts('m', 1000, 0, 0, 0, 0, null)), 0.001);
  assert.equal(again.observe({ m: { input: 5 } }, '2026-10-24').id, 5);
});
