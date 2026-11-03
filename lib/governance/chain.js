// Governance audit log (AI Governance 2): the tamper-evident chain, pure (no I/O, no clock). An entry's mac is
// HMAC-SHA256(key, prev + "\n" + canonical JSON of the entry without mac); prev is the mac of the entry before it,
// "genesis" for the first entry ever and "rekeyed" where a new key restarts the chain (the old key was missing).
// Every part between rekeys is checked with the key it names.
const crypto = require('crypto');

const GENESIS = 'genesis';
const REKEYED = 'rekeyed';
const MAC = /^[0-9a-f]{64}$/;

// JSON with the keys of every object sorted and no spaces: the same entry always gives the same text. An undefined
// field is left out, as JSON.stringify does when the line is written.
function canonical(v) {
  if (v === undefined || v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// The mac of an entry (its own mac field, if any, is not part of it).
// It is computed over the entry as JSON writes it (a Date as its text, a function left out), so the line read back
// from the file gives the same mac as the entry that was sealed.
function macOf(key, entry) {
  const { mac, ...rest } = JSON.parse(JSON.stringify(entry));
  return crypto
    .createHmac('sha256', key)
    .update(`${rest.prev}\n${canonical(rest)}`)
    .digest('hex');
}

// Constant-time comparison of two 64-character hex macs.
const macEquals = (a, b) => crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// The entry with its mac added.
const seal = (key, entry) => ({ ...entry, mac: macOf(key, entry) });

const isEntry = (e) =>
  !!e &&
  typeof e === 'object' &&
  !Array.isArray(e) &&
  Number.isInteger(e.seq) &&
  e.seq >= 1 &&
  typeof e.prev === 'string' &&
  typeof e.mac === 'string' &&
  MAC.test(e.mac);

// The parts of a chain, in file order: a new part starts at every "rekeyed" entry. Each part says the key it was
// sealed with (keyed): "file" (chain.key) when its first readable entry carries keyed: "file", else "store".
// [{ index, start, end, keyed }], start and end being indexes into items (end not included).
function partsOf(items) {
  const parts = [];
  items.forEach((e, i) => {
    if (i === 0 || (isEntry(e) && e.prev === REKEYED)) {
      if (parts.length) parts[parts.length - 1].end = i;
      parts.push({ index: parts.length, start: i, end: items.length, keyed: 'store' });
    }
  });
  for (const p of parts) {
    const first = items.slice(p.start, p.end).find(isEntry);
    if (first && first.keyed === 'file') p.keyed = 'file';
  }
  return parts;
}

// Checks entries in file order (null where a line did not parse). keyOf is the key of every part, or a function
// (part, parts) -> the key that part was sealed with, null when it cannot be read: each part is checked with its own
// key, so a part after a rekey vouches for nothing before it. A part whose key cannot be read is still checked for
// its order (seq and prev) and counted as unverified. The first entry keeps whatever prev it has (older months may
// have been deleted by retention). Returns { ok, checked, from, to } (the entries checked with a key) plus
// { brokenAt, reason } at the first entry that fails; { unverified } when a part could not be checked; and, when the
// chain holds a rekey, { rekeyedAt, rekeyedTs }: the seq and time of the latest one (a rekey always shows, as a
// file-writer could seal one of their own and replace what follows it). Its time is the later of its own ts and the
// ts of the entry before it, so a forged rekey cannot be dated back past the entries it follows.
function verifyChain(items, keyOf) {
  const parts = partsOf(items);
  const keyFor = typeof keyOf === 'function' ? keyOf : () => keyOf;
  let prev = null; // the entry before, checked or not
  let first = null;
  let last = null;
  let checked = 0;
  let unverified = 0;
  let rekey = null; // the latest "rekeyed" entry
  let rekeyTs = null; // its time, never before the entry before it
  // Where an unreadable line sits: after the entry before it, else just before the next readable one.
  const seqAt = (i) => {
    if (prev) return prev.seq + 1;
    const next = items.slice(i + 1).find(isEntry);
    return next ? Math.max(1, next.seq - 1) : 1;
  };
  const broken = (brokenAt, reason) => ({ ok: false, checked, from: first, to: last, brokenAt, reason });
  for (const part of parts) {
    const key = keyFor(part, parts);
    if (part.index > 0) {
      rekey = items[part.start];
      const times = [rekey, items[part.start - 1]]
        .map((e) => (isEntry(e) && typeof e.ts === 'string' ? e.ts : null))
        .filter((ts) => ts !== null && Number.isFinite(Date.parse(ts)));
      rekeyTs = times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
    }
    for (let i = part.start; i < part.end; i++) {
      const e = items[i];
      if (!isEntry(e)) return broken(seqAt(i), 'unreadable line');
      if (prev && e.seq !== prev.seq + 1) return broken(prev.seq + 1, 'sequence broken');
      if (prev && i > part.start && e.prev !== prev.mac) return broken(e.seq, 'chain broken');
      if (key) {
        if (!macEquals(macOf(key, e), e.mac)) return broken(e.seq, 'entry changed');
        if (first === null) first = e.seq;
        last = e.seq;
        checked++;
      } else unverified++;
      prev = { seq: e.seq, mac: e.mac };
    }
  }
  return {
    ok: true,
    checked,
    from: first,
    to: last,
    ...(unverified ? { unverified } : {}),
    ...(rekey ? { rekeyedAt: rekey.seq, rekeyedTs: rekeyTs } : {}),
  };
}

module.exports = { GENESIS, REKEYED, canonical, macOf, seal, isEntry, partsOf, verifyChain };
