// Governance audit log (AI Governance 2): the tamper-evident chain, pure (no I/O, no clock). An entry's mac is
// HMAC-SHA256(key, prev + "\n" + canonical JSON of the entry without mac); prev is the mac of the entry before it,
// "genesis" for the first entry ever and "rekeyed" where a new key restarts the chain (the old key was missing).
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

// Checks entries in file order (null where a line did not parse) with the current key. The chain restarts at the last
// "rekeyed" entry: what came before it was sealed with a key that is gone, so it is counted as unverified, not checked.
// The first entry checked keeps whatever prev it has (older months may have been deleted by retention). Returns
// { ok, checked, from, to } plus { brokenAt, reason } at the first entry that fails, and { unverified, rekeyedAt }
// after a rekey.
function verifyChain(items, key) {
  let start = 0;
  for (let i = items.length - 1; i > 0; i--)
    if (isEntry(items[i]) && items[i].prev === REKEYED) {
      start = i;
      break;
    }
  let prev = null;
  let first = null;
  let checked = 0;
  // Where an unreadable line sits: after the entry before it, else just before the next readable one.
  const seqAt = (i) => {
    if (prev) return prev.seq + 1;
    const next = items.slice(i + 1).find(isEntry);
    return next ? Math.max(1, next.seq - 1) : 1;
  };
  const broken = (brokenAt, reason) => ({
    ok: false,
    checked,
    from: first,
    to: prev ? prev.seq : null,
    brokenAt,
    reason,
  });
  for (let i = start; i < items.length; i++) {
    const e = items[i];
    if (!isEntry(e)) return broken(seqAt(i), 'unreadable line');
    if (prev && e.seq !== prev.seq + 1) return broken(prev.seq + 1, 'sequence broken');
    if (prev && e.prev !== prev.mac) return broken(e.seq, 'chain broken');
    if (!macEquals(macOf(key, e), e.mac)) return broken(e.seq, 'entry changed');
    if (first === null) first = e.seq;
    prev = { seq: e.seq, mac: e.mac };
    checked++;
  }
  return {
    ok: true,
    checked,
    from: first,
    to: prev ? prev.seq : null,
    ...(start > 0 ? { unverified: start, rekeyedAt: items[start].seq } : {}),
  };
}

module.exports = { GENESIS, REKEYED, canonical, macOf, seal, isEntry, verifyChain };
