// Price versions: each time the effective pricing (config.pricing: defaults, snapshot, your prices, live list) changes,
// a version { id, from, at, hash, changed, changedCount } is kept with a full copy of that pricing, so every day can be
// priced with the prices in force on it and a past day's cost stays frozen. Files: <dir>/versions.json and <dir>/<id>.json.
const fs = require('fs');
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

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createPriceVersions({ dir = null, now = Date.now } = {}) {
  const indexFile = dir && path.join(dir, 'versions.json');
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const versions = [];
  const bodies = new Map(); // id -> pricing
  const pricers = new Map(); // id -> makePricer(pricing)
  const problems = []; // path-free notes about data that was dropped or recovered at load
  let maxId = 0; // the highest id seen on disk, so a body file is never overwritten
  let seen = null; // the pricing object the last observe compared, so an unchanged config costs no hashing

  // A body file is { id, from, hash, pricing }: self-describing, so the index can be rebuilt from the bodies alone.
  const readBody = (id) => {
    const b = readJson(fileOf(id), null);
    if (!isObj(b) || !isObj(b.pricing)) return null;
    // Keep only model entries that are objects: makePricer would throw on the rest.
    const pricing = {};
    let dropped = 0;
    for (const [k, v] of Object.entries(b.pricing)) {
      if (isObj(v)) pricing[k] = v;
      else dropped++;
    }
    if (dropped) problems.push(`price version ${id} had ${dropped} unusable model entries that were ignored`);
    return { ...b, pricing };
  };
  const shape = (e) => {
    if (!isObj(e) || !Number.isInteger(e.id) || typeof e.from !== 'string' || typeof e.hash !== 'string') return null;
    const changed = Array.isArray(e.changed) ? e.changed.filter((k) => typeof k === 'string') : [];
    const count = Number.isFinite(e.changedCount) ? e.changedCount : changed.length;
    return { id: e.id, from: e.from, at: Number.isFinite(e.at) ? e.at : 0, hash: e.hash, changed, changedCount: count };
  };

  if (dir) {
    let ids = [];
    try {
      ids = fs
        .readdirSync(dir)
        .map((f) => /^(\d+)\.json$/.exec(f))
        .filter(Boolean)
        .map((m) => Number(m[1]));
    } catch {
      /* no folder yet */
    }
    maxId = ids.reduce((a, b) => Math.max(a, b), 0);
    let entries = null;
    if (fs.existsSync(indexFile)) {
      const idx = readJson(indexFile, null);
      if (idx && Array.isArray(idx.versions)) entries = idx.versions;
      else {
        let bad = `${indexFile}.bad`;
        for (let n = 1; fs.existsSync(bad); n++) bad = `${indexFile}.bad.${n}`;
        try {
          fs.renameSync(indexFile, bad);
        } catch {
          /* best effort: the rebuilt index replaces it */
        }
        problems.push('the version index was unreadable: kept aside and rebuilt from the price files');
      }
    }
    if (!entries) {
      // Rebuild from the bodies on disk (or nothing, on a first run).
      entries = [];
      for (const id of ids.sort((a, b) => a - b)) {
        const b = readBody(id);
        if (b && b.id === id) entries.push({ id, from: b.from, hash: b.hash, at: 0 });
        else problems.push(`price file ${id} is unusable and was skipped`);
      }
    }
    for (const raw of entries) {
      const e = shape(raw);
      const body = e && readBody(e.id);
      if (!e || !body) {
        problems.push(`a price version${e ? ` (${e.id})` : ''} is unusable and was dropped`);
        continue;
      }
      if (versions.length && versions[versions.length - 1].id >= e.id) continue;
      if (e.id > maxId) maxId = e.id;
      if (!e.changed.length && !raw.changed && versions.length) {
        const ch = changedKeys(bodies.get(versions[versions.length - 1].id), body.pricing);
        e.changed = ch.slice(0, MAX_CHANGED);
        e.changedCount = ch.length;
      }
      bodies.set(e.id, body.pricing);
      versions.push(e);
    }
  }
  const latest = () => versions[versions.length - 1] || null;
  const pricingOf = (id) => bodies.get(id) || {};
  const make = (pricing, from, at) => {
    const prev = latest();
    const changed = prev ? changedKeys(pricingOf(prev.id), pricing) : [];
    return {
      id: Math.max(maxId, prev ? prev.id : 0) + 1,
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
      if (fs.existsSync(fileOf(v.id))) throw new Error('a price version file already exists and is not overwritten');
      writePrivate(fileOf(v.id), JSON.stringify({ id: v.id, from: v.from, hash: v.hash, pricing: copy }));
      writePrivate(indexFile, JSON.stringify({ version: 1, versions: [...versions, v] }));
    }
    bodies.set(v.id, copy);
    versions.push(v);
    maxId = v.id;
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
    if (!pricers.has(id)) {
      let pricer;
      try {
        pricer = makePricer(pricingOf(id));
      } catch {
        // A shape makePricer cannot take: price with the previous usable version, else with nothing.
        problems.push(`price version ${id} could not be used for pricing`);
        const prev = versions.filter((v) => v.id < id).pop();
        try {
          pricer = prev ? pricerFor(prev.id) : makePricer({});
        } catch {
          pricer = makePricer({});
        }
      }
      pricers.set(id, pricer);
    }
    return pricers.get(id);
  }

  // The version a restate would price with now, without recording it (Cost Control 3b): the latest when its prices
  // hash the same as `pricing`, else null, with a pricer made from `pricing` and the id observe() would give it
  // (`next`), and the hash of `pricing`. Writes nothing, so a preview never adds a version.
  function peek(pricing) {
    const last = latest();
    const copy = JSON.parse(JSON.stringify(pricing || {}));
    const hash = hashOf(copy);
    if (last && last.hash === hash) return { version: last, pricer: pricerFor(last.id), next: last.id, hash };
    let pricer;
    try {
      pricer = makePricer(copy);
    } catch {
      // As pricerFor: a shape makePricer cannot take prices with the latest usable version, else with nothing.
      pricer = last ? pricerFor(last.id) : makePricer({});
    }
    return { version: null, pricer, next: Math.max(maxId, last ? last.id : 0) + 1, hash };
  }

  // Demo: versions held in memory with their prices.
  function seed(list) {
    for (const s of list) {
      const v = make(s.pricing, s.from, s.at);
      bodies.set(v.id, s.pricing);
      versions.push(v);
      maxId = v.id;
    }
  }

  return {
    observe,
    peek,
    versionFor,
    pricerFor,
    seed,
    current: latest,
    problems: () => [...problems],
    list: () => versions.map((v) => ({ ...v, changed: [...v.changed] })),
  };
}

module.exports = { createPriceVersions, hashOf, changedKeys };
