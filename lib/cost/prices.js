// Price versions: each time the effective pricing (config.pricing: defaults, snapshot, your prices, live list) changes,
// a version { id, from, at, hash, changed, changedCount } is kept with a full copy of that pricing, so every day can be
// priced with the prices in force on it and a past day's cost stays frozen. Files: <dir>/versions.json and <dir>/<id>.json.
const path = require('path');
const crypto = require('crypto');
const { makePricer } = require('../pricing');
const { writePrivate, readJson } = require('./files');

const MAX_CHANGED = 100;

// JSON with object keys sorted, so the same prices always hash the same.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
const hashOf = (pricing) => crypto.createHash('sha256').update(stable(pricing)).digest('hex').slice(0, 16);
function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => stable((a || {})[k]) !== stable((b || {})[k])).sort();
}

function createPriceVersions({ dir = null, now = Date.now } = {}) {
  const indexFile = dir && path.join(dir, 'versions.json');
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const loaded = dir ? readJson(indexFile, null) : null;
  const versions = loaded && Array.isArray(loaded.versions) ? loaded.versions : [];
  const bodies = new Map(); // id -> pricing
  const pricers = new Map(); // id -> makePricer(pricing)
  let seen = null; // the pricing object the last observe compared, so an unchanged config costs no hashing
  const latest = () => versions[versions.length - 1] || null;
  const pricingOf = (id) => {
    if (!bodies.has(id)) bodies.set(id, dir ? readJson(fileOf(id), {}) : {});
    return bodies.get(id);
  };
  const make = (pricing, from, at) => {
    const prev = latest();
    const changed = prev ? changedKeys(pricingOf(prev.id), pricing) : [];
    return {
      id: prev ? prev.id + 1 : 1,
      from: prev && prev.from > from ? prev.from : from,
      at,
      hash: hashOf(pricing),
      changed: changed.slice(0, MAX_CHANGED),
      changedCount: changed.length,
    };
  };

  function observe(pricing, day) {
    const last = latest();
    if (pricing === seen && last) return last;
    const copy = JSON.parse(JSON.stringify(pricing || {}));
    if (last && last.hash === hashOf(copy)) {
      seen = pricing;
      return last;
    }
    const v = make(copy, day, now());
    if (dir) {
      writePrivate(fileOf(v.id), JSON.stringify(copy));
      writePrivate(indexFile, JSON.stringify({ version: 1, versions: [...versions, v] }));
    }
    bodies.set(v.id, copy);
    versions.push(v);
    seen = pricing;
    return v;
  }

  // The version in force on `day`: the newest whose `from` is on or before it. A day before the first version (history
  // read on the first run) gets the first one: past prices were never kept.
  function versionFor(day) {
    let hit = versions[0] || null;
    for (const v of versions) if (v.from <= day) hit = v;
    return hit;
  }

  function pricerFor(id) {
    if (!pricers.has(id)) pricers.set(id, makePricer(pricingOf(id)));
    return pricers.get(id);
  }

  // Demo: versions held in memory with their prices.
  function seed(list) {
    for (const s of list) {
      const v = make(s.pricing, s.from, s.at);
      bodies.set(v.id, s.pricing);
      versions.push(v);
    }
  }

  return {
    observe,
    versionFor,
    pricerFor,
    seed,
    current: latest,
    list: () => versions.map((v) => ({ ...v, changed: [...v.changed] })),
  };
}

module.exports = { createPriceVersions, hashOf, changedKeys };
