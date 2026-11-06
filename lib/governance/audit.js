// Governance audit log (AI Governance 2): who changed what in ZAAFPulse, when, and with what outcome. Append-only
// monthly files .data/audit/governance-YYYY-MM.jsonl (UTC months; files 0600, folder 0700), one sealed entry per line
// (lib/governance/chain.js), chained across months with a key from the secret store (acc.audit-chain), or from
// .data/audit/chain.key when the store cannot hold it (or a lost key was replaced). Whole months older than the
// retention are deleted, and that is an entry too. A write that fails never stops the change it records: the log is
// then degraded, and the changes it missed become one audit.gap entry once writing works again. The server is the only
// writer; the CLI leaves events in pending/ for it (queueEvent). The clock and the key come in from outside.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GENESIS, REKEYED, seal, isEntry, partsOf, verifyChain } = require('./chain');
const { csvCell } = require('../cost/export');

const SERVICE = 'acc.audit-chain';
const PROBE = `${SERVICE}.probe`; // written to see that the store works before its silence counts as "no key"
const PROBE_EVERY = 60 * 1000;
const FILE = /^governance-(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;
const RETENTION = { default: 12, min: 6, max: 120 };
const MAX_PAGE = 500;
const MAX_EXPORT = 100000;
// What the CLI may leave for the server to record (bin/zaafpulse.js set-password).
const CLI_ACTIONS = new Set(['auth.password_set']);
const MAX_PENDING = 100;

const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
// The month `n` months before YYYY-MM.
function monthsBefore(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}
// retentionMonths from config.json: a whole number from 6 to 120, else 12.
const cleanRetention = (v) => (Number.isInteger(v) && v >= RETENTION.min && v <= RETENTION.max ? v : RETENTION.default);

// The folder, made 0700 or tightened to it when it was there with looser modes (Windows has no such modes).
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* not ours to change, or Windows */
  }
}

// Where the chain key comes from. getKey({ keyed }) reads only that source ('store': the secret store's
// acc.audit-chain, 'file': chain.key), the one the chain's last part was sealed with; without `keyed` (no entries
// yet) the store first, then the file. Returns { key, keyed, created } or null; a key that reads is kept in memory.
// create: true makes a key when there is none, and `created` is true on the one call that made it:
// - the first key ever goes to the store when its slot is empty for sure (read back to be sure), else to chain.key;
// - a key that cannot be read while entries exist is replaced only when it is gone for sure: a store that fails
//   answers null too (a locked Keychain, a timeout), so the store must prove it works and still have nothing, and
//   chain.key must not exist. The new key goes to chain.key, never to the store's slot (the old key may come back).
//   That proof (a probe write and a second read) runs at most once a minute while the key cannot be read, so a hung
//   keyring does not hold up every change; the calls between are degraded.
// A source that is there but does not read as a key is never "gone": a store read that throws (the file store's
// "cannot be decrypted" after ZAAFPULSE_MASTER_KEY changed), a slot or a chain.key holding something else, or a
// chain.key that cannot be opened. Such a call is degraded, and nothing is written over it.
function keySource({ dir, store = null, now = Date.now }) {
  const cache = {};
  let probedAt = null; // when the store was last probed for a key that would not read
  const file = path.join(dir, 'chain.key');
  const valid = (text) => {
    const key = Buffer.from(String(text || '').trim(), 'base64');
    return key.length === 32 ? key : null;
  };
  // { key } from the store; { key: null, there: true } when it threw or holds something that is not a key, and
  // { key: null } when it answered nothing.
  const fromStore = () => {
    if (!store) return { key: null };
    let text;
    try {
      text = store.get(SERVICE);
    } catch {
      return { key: null, there: true };
    }
    const key = valid(text);
    return key ? { key } : { key: null, there: text !== null && text !== undefined && text !== '' };
  };
  // { key } from chain.key, or { absent: true } when there is no such file (a file that is there but does not read
  // as a key is neither, and is never written over).
  const fromFile = () => {
    try {
      return { key: valid(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      return { key: null, absent: err.code === 'ENOENT' };
    }
  };
  // The store works: a value written under another name reads back.
  const storeWorks = () => {
    if (!store) return false;
    try {
      const probe = crypto.randomBytes(16).toString('hex');
      store.set(PROBE, probe);
      return store.get(PROBE) === probe;
    } catch {
      return false;
    }
  };
  // { k } (the cached { key, keyed, created }) or { k: null, there } as fromStore says.
  const read = (keyed) => {
    if (cache[keyed]) return { k: cache[keyed] };
    const r = keyed === 'store' ? fromStore() : fromFile();
    if (r.key) return { k: (cache[keyed] = { key: r.key, keyed, created: false }) };
    return { k: null, there: keyed === 'store' ? !!r.there : !r.absent };
  };
  const made = (key, keyed) => {
    cache[keyed] = { key, keyed, created: false };
    return { ...cache[keyed], created: true };
  };
  const toFile = (key) => {
    ensureDir(dir);
    fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    return made(key, 'file');
  };
  return ({ create = false, keyed } = {}) => {
    if (keyed) {
      const r = read(keyed);
      if (r.k) probedAt = null;
      if (r.k || !create || r.there) return r.k;
      if (keyed === 'store' && store) {
        const t = now();
        if (probedAt !== null && t >= probedAt && t - probedAt < PROBE_EVERY) return null;
        probedAt = t;
        // A read that failed once may work now that the store has shown it works.
        const works = storeWorks();
        const again = read('store');
        if (again.k) {
          probedAt = null;
          return again.k;
        }
        if (!works || again.there) return null;
      }
      return fromFile().absent ? toFile(crypto.randomBytes(32)) : null;
    }
    const s = read('store');
    if (s.k) return s.k;
    const f = read('file');
    if (f.k || !create) return f.k;
    if (s.there) return null; // a store key that is there but does not read is never written over
    const key = crypto.randomBytes(32);
    const text = key.toString('base64');
    if (storeWorks()) {
      const again = read('store');
      if (again.k) return again.k;
      if (again.there) return null;
      try {
        store.set(SERVICE, text);
        if (store.get(SERVICE) === text) return made(key, 'store');
      } catch {
        /* the store cannot hold it: the file below */
      }
    }
    return toFile(key);
  };
}

// The CLI's way in (bin/zaafpulse.js): one event as a file in <dir>/pending, recorded by the server when it next
// starts or runs its daily pass. Never throws; returns the paths it made (a root-run CLI hands them to the data
// folder's owner). The file is written under a name importPending does not read, then renamed, so a pass running at
// the same time never reads half of it.
function queueEvent(dir, event, t = Date.now()) {
  const pending = path.join(dir, 'pending');
  const file = path.join(pending, `${t}-${crypto.randomBytes(4).toString('hex')}.json`);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ action: event.action, ts: t }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    return [dir, pending, file];
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to tidy */
    }
    return [];
  }
}

// The chain's own fields: a caller cannot set them.
const CHAIN_FIELDS = ['seq', 'ts', 'prev', 'mac', 'keyed'];
const isKeyEntry = (e) => e.action === 'audit.key_created' || e.action === 'audit.rekey';
// The key source the chain's last part was sealed with: the `keyed` of the latest audit.key_created or audit.rekey
// entry, else (that entry went with its month) the latest entry's own mark, as entries sealed with chain.key carry
// keyed: "file". Undefined when there is no entry.
function keyedOf(items) {
  const entries = items.filter(isEntry);
  const at = entries.findLast(isKeyEntry) || entries[entries.length - 1];
  return at ? (at.keyed === 'file' ? 'file' : 'store') : undefined;
}

// Lines deleted from the start: the first line kept must be entry 1 (prev "genesis") while no month has been pruned,
// else the entry the latest audit.prune says the kept months start from (keptFrom). Checked on the first line even when
// a rekey starts the checked part later. An unreadable first line is verifyChain's to report.
// A log that starts at entry 1 starts with its audit.key_created, and one keyed in chain.key only while the store holds
// no key (storeKey: the store's key, or null): anything else at entry 1 is a log written again from scratch.
function headBroken(items, storeKey) {
  const first = items[0];
  if (!isEntry(first)) return null;
  const pruned = items.findLast((e) => isEntry(e) && e.action === 'audit.prune' && Number.isInteger(e.keptFrom));
  const expected = pruned ? pruned.keptFrom : 1;
  const at = (brokenAt, reason) => ({ ok: false, checked: 0, from: null, to: null, brokenAt, reason });
  if (first.seq !== expected || (!pruned && first.prev !== GENESIS)) return at(expected, 'sequence broken');
  if (first.seq === 1 && first.prev === GENESIS) {
    if (first.action !== 'audit.key_created') return at(1, 'chain broken');
    if (first.keyed === 'file' && storeKey()) return at(1, 'chain broken');
  }
  return null;
}

function createGovernanceAudit({ dir, getKey, now = Date.now }) {
  let tail; // { seq, mac, keyed } of the last entry written, null when there is none, undefined until read
  let newest = null; // the newest month that has a file
  let degraded = null; // { since, missed } while entries cannot be written
  let restart = null; // { kind: 'created' | 'rekeyed', k } until the entry that says so is written
  let lastVerify = null;
  let keyFailed = false; // a record or a verify found no key since the last entry written
  let recheck = null; // the verify set to run once the key reads again
  const imported = new Set(); // pending files recorded by this process (in case one cannot be removed)

  // The month files, oldest first: [{ month, file }].
  function months() {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .map((n) => n.match(FILE))
      .filter(Boolean)
      .map((m) => ({ month: m[1], file: path.join(dir, m[0]) }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));
  }
  // One month's lines: { line, entry } where entry is null for a line that does not parse as an entry.
  function linesOf(file) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        let entry = null;
        try {
          entry = JSON.parse(line);
        } catch {
          /* counted where it is read */
        }
        return { line, entry: isEntry(entry) ? entry : null };
      });
  }
  // The last readable entry, from the newest month that has one, with the key source of its part of the chain.
  function readTail() {
    const all = months();
    newest = all.length ? all[all.length - 1].month : null;
    for (const m of all.reverse()) {
      const entries = linesOf(m.file).map((x) => x.entry);
      const last = entries.findLast(Boolean);
      if (last) return { seq: last.seq, mac: last.mac, keyed: keyedOf(entries) };
    }
    return null;
  }
  const anyEntries = () => months().some((m) => fs.statSync(m.file).size > 0);

  // Where the last line of an open file ends without its "\n" (a crash or a full disk mid-write), cuts that line off,
  // unless it is the entry the chain goes on from (only its "\n" is missing, so it gets one). Such a line never parsed,
  // so its seq was never handed to a caller. Returns the size the file has now.
  function mendEnd(fd, size) {
    const buf = Buffer.alloc(64 * 1024);
    let start = 0;
    for (let end = size; end > 0;) {
      const from = Math.max(0, end - buf.length);
      const n = fs.readSync(fd, buf, 0, end - from, from);
      const i = n > 0 ? buf.lastIndexOf(0x0a, n - 1) : -1;
      if (i >= 0) {
        start = from + i + 1;
        break;
      }
      end = from;
    }
    if (start === size) return size;
    const rest = Buffer.alloc(size - start);
    fs.readSync(fd, rest, 0, rest.length, start);
    let entry = null;
    try {
      entry = JSON.parse(rest.toString('utf8'));
    } catch {
      /* a torn line */
    }
    if (isEntry(entry) && tail && entry.seq === tail.seq && entry.mac === tail.mac) {
      writeAll(fd, Buffer.from('\n'), size);
      return size + 1;
    }
    fs.ftruncateSync(fd, start);
    return start;
  }
  // Writes at an explicit position: the file is not opened in append mode (see openLine).
  function writeAll(fd, buf, at) {
    for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off, at + off);
  }
  // Not 'a+': on Windows an append-mode handle has no write access, so the mend and the cut-back (ftruncate) fail there.
  function openLine(file) {
    try {
      return fs.openSync(file, 'r+');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return fs.openSync(file, 'wx', 0o600);
    }
  }
  // Appends one line to a month file, after mending its end; a write that fails is cut back off, so the next line
  // never runs into it.
  function writeLine(file, line) {
    const fd = openLine(file);
    try {
      let size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) size = mendEnd(fd, size);
      try {
        writeAll(fd, Buffer.from(line), size);
      } catch (err) {
        try {
          fs.ftruncateSync(fd, size);
        } catch {
          /* mended before the next line */
        }
        throw err;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  // The end of a month file the chain is leaving (the next entry starts a new month) is mended too.
  function mendFile(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r+');
      const size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) mendEnd(fd, size);
    } catch {
      /* verify reports what is left */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // Seal one entry after the tail and append it to its month's file: the month of now, or the newest month that has a
  // file when the clock stepped back (verify reads the months in order, so a later seq never goes to an earlier month).
  function append(fields, k, prev) {
    const t = now();
    const entry = seal(k.key, {
      seq: tail ? tail.seq + 1 : 1,
      ts: new Date(t).toISOString(),
      ...fields,
      ...(k.keyed === 'file' ? { keyed: 'file' } : {}),
      prev: prev || (tail ? tail.mac : GENESIS),
    });
    ensureDir(dir);
    const month = newest && newest > monthOf(t) ? newest : monthOf(t);
    if (newest && newest !== month) mendFile(path.join(dir, `governance-${newest}.jsonl`));
    writeLine(path.join(dir, `governance-${month}.jsonl`), `${JSON.stringify(entry)}\n`);
    newest = month;
    tail = { seq: entry.seq, mac: entry.mac, keyed: k.keyed };
    return entry;
  }

  // record({ action, actor, ...fields }) -> the entry written, or null when it could not be (never throws). The
  // fields are written in the order action, actor, then the rest; outcome is 'ok' unless given. The chain's own
  // fields (seq, ts, prev, mac, keyed) are the store's, never the caller's. A key that cannot be read is a write that
  // fails (degraded), tried again on the next call; only a key that is gone for sure is replaced (keySource). The
  // first entry written once the key reads again is followed by a verify (run just after the call, setImmediate).
  function record(input) {
    const { action, actor = { via: 'system' }, outcome = 'ok', ...rest } = input || {};
    for (const f of CHAIN_FIELDS) delete rest[f];
    const fields = { action: String(action || 'unknown'), actor, outcome, ...rest };
    try {
      if (tail === undefined) tail = readTail();
      let k = restart && restart.k;
      if (!k) {
        k = getKey({ create: true, keyed: tail ? tail.keyed : undefined });
        if (!k) {
          keyFailed = true;
          throw new Error('the audit key cannot be read');
        }
        // A new log starts with audit.key_created, also when its key was already there (another data folder
        // shares the store): verify takes a first entry that is anything else for a log written again by hand.
        if (k.created) restart = { kind: anyEntries() ? REKEYED : 'created', k };
        else if (tail === null && !anyEntries()) restart = { kind: 'created', k };
      }
      if (restart && restart.kind === 'created')
        append({ action: 'audit.key_created', actor: { via: 'system' }, outcome: 'ok', keyed: k.keyed }, k);
      if (restart && restart.kind === REKEYED)
        append(
          { action: 'audit.rekey', actor: { via: 'system' }, outcome: 'ok', reason: 'key missing', keyed: k.keyed },
          k,
          REKEYED,
        );
      restart = null;
      if (degraded) {
        append(
          {
            action: 'audit.gap',
            actor: { via: 'system' },
            outcome: 'error',
            missed: degraded.missed,
            since: new Date(degraded.since).toISOString(),
          },
          k,
        );
        degraded = null;
      }
      const e = append(fields, k);
      // The key reads again after a failure: the last verify (key missing, or none while degraded) is out of date, so
      // verify runs now rather than at the next daily pass.
      // Right after this request, not inside it: a verify reads every kept month.
      if (keyFailed && !recheck) {
        keyFailed = false; // once: a verify that still finds no key does not run again on every entry
        recheck = setImmediate(() => {
          recheck = null;
          try {
            verify();
          } catch {
            /* the daily pass tries again */
          }
          keyFailed = false;
        });
      }
      return e;
    } catch {
      if (!degraded) degraded = { since: now(), missed: 0 };
      degraded.missed++;
      return null;
    }
  }

  // Every readable month, newest first, between two times; `skipped` counts lines that did not parse.
  function* newestFirst(from, to) {
    for (const m of months().reverse()) {
      if ((to != null && m.month > monthOf(to)) || (from != null && m.month < monthOf(from))) continue;
      for (const x of linesOf(m.file).reverse()) yield x;
    }
  }
  const inRange = (e, from, to) => {
    const t = Date.parse(e.ts);
    return (from == null || t >= from) && (to == null || t <= to);
  };
  const matches = (e, q) =>
    (!q.actor || (e.actor && (e.actor.via === q.actor || e.actor.keyId === q.actor))) &&
    (!q.user || (e.actor && e.actor.user === q.user)) &&
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.action || `${e.action} ${e.op || ''}`.toLowerCase().includes(q.action.toLowerCase())) &&
    (q.before == null || e.seq < q.before);

  // list({ from, to, actor, user, action, outcome, limit, before }) -> { entries, next, skipped }: newest first, at
  // most `limit` (1-500); `next` is the `before` of the next page, or null.
  function list(q = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(q.limit) || 100));
    const entries = [];
    let skipped = 0;
    let more = false;
    for (const x of newestFirst(q.from, q.to)) {
      if (!x.entry) {
        skipped++;
        continue;
      }
      if (!inRange(x.entry, q.from, q.to) || !matches(x.entry, q)) continue;
      if (entries.length >= limit) {
        more = true;
        break;
      }
      entries.push(x.entry);
    }
    return { entries, next: more ? entries[entries.length - 1].seq : null, skipped };
  }

  // export({ from, to, format, user, view }) -> { body, type, name }: JSON lines as written (so a copy can be
  // verified), or CSV, oldest first; only the account `user`'s entries when it is given. `view(entry)` is the entry as
  // the reader may see it: a line whose entry it changes is written again from the new entry. More than 100,000
  // entries is a 413.
  function exportOf({ from = null, to = null, format = 'csv', user = null, view = null } = {}) {
    const rows = [];
    for (const x of newestFirst(from, to)) {
      if (!x.entry || !inRange(x.entry, from, to) || !matches(x.entry, { user })) continue;
      if (rows.length === MAX_EXPORT)
        throw Object.assign(new Error('too many entries; narrow the range'), { status: 413 });
      rows.push(x);
    }
    rows.reverse();
    const day = (t, d) => (t == null ? d : new Date(t).toISOString().slice(0, 10));
    const name = `zaafpulse-audit-${day(from, 'start')}-${day(to, 'now')}.${format}`;
    const seen = (x) => (view ? view(x.entry) : x.entry);
    if (format === 'jsonl')
      return {
        body: rows.map((x) => `${seen(x) === x.entry ? x.line : JSON.stringify(seen(x))}\n`).join(''),
        type: 'application/x-ndjson',
        name,
      };
    return { body: toCsv(rows.map(seen)), type: 'text/csv; charset=utf-8', name };
  }

  // verify() -> { ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }, kept as the last result
  // (with `at`) for status() and the Monitors rule.
  // Every part of the chain (partsOf: a new one at each rekey) is checked with the key it names: "store" with the
  // store's acc.audit-chain, "file" with chain.key, which only the newest part keyed in it can still have (a rekey
  // writes chain.key only when there is none). A part whose key cannot be read is unverified; when that is the newest
  // part, the result is `key missing`. The first part is checked with the store's key whenever that key reads,
  // whatever its entries say: a rekeyed key always goes to chain.key, so only the first part can be store-sealed, and
  // a mark of "file" is what a file-writer would write on entries they sealed again.
  function verify() {
    const items = [];
    for (const m of months()) for (const x of linesOf(m.file)) items.push(x.entry);
    const keys = {};
    const keyOf = (keyed) => {
      if (!(keyed in keys)) {
        const k = getKey({ create: false, keyed });
        keys[keyed] = k ? k.key : null;
      }
      return keys[keyed];
    };
    const parts = partsOf(items);
    const lastFile = parts.findLast((p) => p.keyed === 'file');
    const keyFor = (p) =>
      (p.index === 0 && keyOf('store')) ||
      (p.keyed === 'store' ? keyOf('store') : p.index === lastFile.index ? keyOf('file') : null);
    let r;
    if (!items.length) r = { ok: true, checked: 0, from: null, to: null };
    else if (!keyFor(parts[parts.length - 1]))
      r = { ok: false, checked: 0, from: null, to: null, brokenAt: null, reason: 'key missing' };
    else {
      r = headBroken(items, () => keyOf('store')) || verifyChain(items, keyFor);
      // Lines cut from the end leave a chain that holds together: the last entry this server wrote says otherwise.
      if (r.ok && tail && (r.to === null || r.to < tail.seq))
        r = { ...r, ok: false, brokenAt: r.to === null ? tail.seq : r.to + 1, reason: 'sequence broken' };
    }
    if (r.reason === 'key missing') keyFailed = true;
    lastVerify = { ...r, at: new Date(now()).toISOString() };
    return r;
  }

  // status() -> { months: [{ month, bytes }] newest first, bytes, degraded, lastVerify }. Reads no key.
  function status() {
    let list = [];
    try {
      list = months()
        .reverse()
        .map((m) => ({ month: m.month, bytes: fs.statSync(m.file).size }));
    } catch {
      /* unreadable folder: degraded says why soon enough */
    }
    return {
      months: list,
      bytes: list.reduce((a, m) => a + m.bytes, 0),
      degraded: degraded ? { since: new Date(degraded.since).toISOString(), missed: degraded.missed } : null,
      lastVerify,
    };
  }

  // Deletes the whole months that ended more than `retentionMonths` months ago (the current month and the ones before
  // it within the retention stay). The audit.prune entry comes first, with `keptFrom`: the seq after the last entry of
  // the months deleted, so lines deleted from the head of a month that stays still show; only when the deleted months
  // hold no entry, the first seq of the months that stay, else the next seq. verify expects the kept months to start
  // there. No entry, no deleting: a degraded log keeps its months until a pass can say so. Returns the deleted months.
  function prune(retentionMonths) {
    const retention = cleanRetention(retentionMonths);
    const keep = monthsBefore(monthOf(now()), retention);
    const gone = [];
    try {
      if (tail === undefined) tail = readTail();
      const all = months();
      const old = all.filter((m) => m.month < keep);
      if (!old.length) return gone;
      const lastGone = [...old]
        .reverse()
        .map((m) => (linesOf(m.file).findLast((x) => x.entry) || {}).entry)
        .find(Boolean);
      const firstKept = lastGone
        ? null
        : all
            .filter((m) => m.month >= keep)
            .map((m) => (linesOf(m.file).find((x) => x.entry) || {}).entry)
            .find(Boolean);
      const keptFrom = lastGone ? lastGone.seq + 1 : firstKept ? firstKept.seq : tail ? tail.seq + 1 : 1;
      const going = old.map((m) => m.month);
      const e = record({
        action: 'audit.prune',
        actor: { via: 'system' },
        months: going,
        retentionMonths: retention,
        keptFrom,
      });
      if (!e) return gone;
      for (const m of old) {
        fs.rmSync(m.file, { force: true });
        gone.push(m.month);
      }
    } catch {
      /* what could not go stays until the next pass */
    }
    return gone;
  }

  // Records the CLI's events (queueEvent), oldest first; a file is removed once its entry is written.
  function importPending() {
    const pending = path.join(dir, 'pending');
    let names = [];
    try {
      names = fs.readdirSync(pending).filter((n) => /^\d{1,15}-[0-9a-f]{8}\.json$/.test(n));
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names.sort().slice(0, MAX_PENDING)) {
      const file = path.join(pending, name);
      // Each file on its own: one that is unreadable, not an event, or timed outside the dates (a hand-made ts of
      // 1e20) is removed below unrecorded, and never stops the files after it or the rest of the daily pass.
      try {
        const ev = fs.statSync(file).size <= 1024 ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
        const at = ev && CLI_ACTIONS.has(ev.action) && Number.isFinite(ev.ts) ? new Date(ev.ts) : null;
        if (at && Number.isFinite(at.getTime()) && !imported.has(name)) {
          const e = record({ action: ev.action, actor: { via: 'cli' }, occurredAt: at.toISOString() });
          if (!e) break; // degraded: the rest waits for the next pass
          imported.add(name);
          n++;
        }
      } catch {
        /* not an event that can be recorded: removed below */
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* tried again on the next pass; `imported` keeps it from being recorded twice */
      }
    }
    return n;
  }

  return { record, list, export: exportOf, verify, status, prune, importPending };
}

// The CSV of an export: one line per entry, the changes as "path: from → to" joined with "; ". actor_id is the
// account of a dashboard entry (AI Governance 4), else the key, the rule or the device.
const CSV_COLUMNS = [
  'seq',
  'time',
  'actor',
  'actor_id',
  'ip',
  'action',
  'op',
  'target_type',
  'target_id',
  'target_name',
  'outcome',
  'status',
  'changes',
  'prev',
  'mac',
];
function toCsv(entries) {
  const line = (cells) => `${cells.map((c) => csvCell(c)).join(',')}\r\n`;
  const show = (v) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v));
  let out = line(CSV_COLUMNS);
  for (const e of entries) {
    const a = e.actor || {};
    const t = e.target || {};
    out += line([
      e.seq,
      e.ts,
      a.via,
      (a.via === 'dashboard' && a.user) || a.keyId || a.rule || a.device || '',
      a.ip || '',
      e.action,
      e.op || '',
      t.type || '',
      t.id || '',
      t.name || '',
      e.outcome || '',
      e.status ?? '',
      (e.changes || []).map((c) => `${c.path}: ${show(c.from)} → ${show(c.to)}`).join('; '),
      e.prev,
      e.mac,
    ]);
  }
  return out;
}

module.exports = {
  createGovernanceAudit,
  keySource,
  queueEvent,
  cleanRetention,
  monthOf,
  monthsBefore,
  RETENTION,
  SERVICE,
  CSV_COLUMNS,
};
