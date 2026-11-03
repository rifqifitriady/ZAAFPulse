// Governance audit log (AI Governance 2): who changed what in ZAAFPulse, when, and with what outcome. Append-only
// monthly files .data/audit/governance-YYYY-MM.jsonl (UTC months; files 0600, folder 0700), one sealed entry per line
// (lib/governance/chain.js), chained across months with a key from the secret store (acc.audit-chain), or from
// .data/audit/chain.key when the store cannot hold it. Whole months older than the retention are deleted, and that is
// an entry too. A write that fails never stops the change it records: the log is then degraded, and the changes it
// missed become one audit.gap entry once writing works again. The server is the only writer; the CLI leaves events in
// pending/ for it (queueEvent). The clock and the key come in from outside.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GENESIS, REKEYED, seal, isEntry, verifyChain } = require('./chain');
const { csvCell } = require('../cost/export');

const SERVICE = 'acc.audit-chain';
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

// Where the chain key comes from: the secret store first, then chain.key. create: true makes one when there is none,
// in the store when it holds it (read back to be sure), else in chain.key. Returns { key, keyed, created } or null;
// `created` is true on the one call that made it. A key that reads is kept in memory.
function keySource({ dir, store = null }) {
  let cached = null;
  const file = path.join(dir, 'chain.key');
  const valid = (text) => {
    const key = Buffer.from(String(text || '').trim(), 'base64');
    return key.length === 32 ? key : null;
  };
  return ({ create = false } = {}) => {
    if (cached) return cached;
    if (store) {
      let key = null;
      try {
        key = valid(store.get(SERVICE));
      } catch {
        /* the store cannot be read: try the file */
      }
      if (key) return (cached = { key, keyed: 'store', created: false });
    }
    let fromFile = null;
    try {
      fromFile = valid(fs.readFileSync(file, 'utf8'));
    } catch {
      /* none yet */
    }
    if (fromFile) return (cached = { key: fromFile, keyed: 'file', created: false });
    if (!create) return null;
    const key = crypto.randomBytes(32);
    const text = key.toString('base64');
    if (store) {
      try {
        store.set(SERVICE, text);
        if (store.get(SERVICE) === text) {
          cached = { key, keyed: 'store', created: false };
          return { ...cached, created: true };
        }
      } catch {
        /* the store cannot hold it: the file below */
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${text}\n`, { mode: 0o600, flag: 'wx' });
    cached = { key, keyed: 'file', created: false };
    return { ...cached, created: true };
  };
}

// The CLI's way in (bin/zaafpulse.js): one event as a file in <dir>/pending, recorded by the server when it next
// starts or runs its daily pass. Never throws; returns the paths it made (a root-run CLI hands them to the data
// folder's owner).
function queueEvent(dir, event, t = Date.now()) {
  const pending = path.join(dir, 'pending');
  const file = path.join(pending, `${t}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ action: event.action, ts: t }), { mode: 0o600, flag: 'wx' });
    return [dir, pending, file];
  } catch {
    return [];
  }
}

function createGovernanceAudit({ dir, getKey, now = Date.now }) {
  let tail; // { seq, mac } of the last entry written, null when there is none, undefined until read
  let degraded = null; // { since, missed } while entries cannot be written
  let restart = null; // 'created' or 'rekeyed' until the entry that says so is written
  let lastVerify = null;

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
  // The last readable entry, from the newest month that has one.
  function readTail() {
    for (const m of months().reverse()) {
      const last = linesOf(m.file)
        .reverse()
        .find((x) => x.entry);
      if (last) return { seq: last.entry.seq, mac: last.entry.mac };
    }
    return null;
  }
  const anyEntries = () => months().some((m) => fs.statSync(m.file).size > 0);

  // Seal one entry after the tail and append it to its month's file.
  function append(fields, k, prev) {
    const t = now();
    const entry = seal(k.key, {
      seq: tail ? tail.seq + 1 : 1,
      ts: new Date(t).toISOString(),
      ...fields,
      ...(k.keyed === 'file' ? { keyed: 'file' } : {}),
      prev: prev || (tail ? tail.mac : GENESIS),
    });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, `governance-${monthOf(t)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    tail = { seq: entry.seq, mac: entry.mac };
    return entry;
  }

  // record({ action, actor, ...fields }) -> the entry written, or null when it could not be (never throws). The
  // fields are written in the order action, actor, then the rest; outcome is 'ok' unless given.
  function record(input) {
    const { action, actor = { via: 'system' }, outcome = 'ok', ...rest } = input || {};
    const fields = { action: String(action || 'unknown'), actor, outcome, ...rest };
    try {
      if (tail === undefined) tail = readTail();
      const k = getKey({ create: true });
      if (k.created) restart = anyEntries() ? REKEYED : 'created';
      if (restart === 'created')
        append({ action: 'audit.key_created', actor: { via: 'system' }, outcome: 'ok', keyed: k.keyed }, k);
      if (restart === REKEYED)
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
      return append(fields, k);
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
    (!q.outcome || e.outcome === q.outcome) &&
    (!q.action || `${e.action} ${e.op || ''}`.toLowerCase().includes(q.action.toLowerCase())) &&
    (q.before == null || e.seq < q.before);

  // list({ from, to, actor, action, outcome, limit, before }) -> { entries, next, skipped }: newest first, at most
  // `limit` (1-500); `next` is the `before` of the next page, or null.
  function list(q = {}) {
    const limit = Math.min(MAX_PAGE, Math.max(1, q.limit || 100));
    const entries = [];
    let skipped = 0;
    let more = false;
    for (const x of newestFirst(q.from, q.to)) {
      if (!x.entry) {
        skipped++;
        continue;
      }
      if (!inRange(x.entry, q.from, q.to) || !matches(x.entry, q)) continue;
      if (entries.length === limit) {
        more = true;
        break;
      }
      entries.push(x.entry);
    }
    return { entries, next: more ? entries[entries.length - 1].seq : null, skipped };
  }

  // export({ from, to, format }) -> { body, type, name }: JSON lines as written (so a copy can be verified), or CSV,
  // oldest first. More than 100,000 entries is a 413.
  function exportOf({ from = null, to = null, format = 'csv' } = {}) {
    const rows = [];
    for (const x of newestFirst(from, to)) {
      if (!x.entry || !inRange(x.entry, from, to)) continue;
      if (rows.length === MAX_EXPORT)
        throw Object.assign(new Error('too many entries; narrow the range'), { status: 413 });
      rows.push(x);
    }
    rows.reverse();
    const day = (t, d) => (t == null ? d : new Date(t).toISOString().slice(0, 10));
    const name = `zaafpulse-audit-${day(from, 'start')}-${day(to, 'now')}.${format}`;
    if (format === 'jsonl')
      return { body: rows.map((x) => `${x.line}\n`).join(''), type: 'application/x-ndjson', name };
    return { body: toCsv(rows.map((x) => x.entry)), type: 'text/csv; charset=utf-8', name };
  }

  // verify() -> { ok, checked, from, to, brokenAt?, reason?, unverified?, rekeyedAt? }, kept as the last result
  // (with `at`) for status() and the Monitors rule.
  function verify() {
    const items = [];
    for (const m of months()) for (const x of linesOf(m.file)) items.push(x.entry);
    const k = getKey({ create: false });
    let r;
    if (!k)
      r = items.length
        ? { ok: false, checked: 0, from: null, to: null, brokenAt: null, reason: 'key missing' }
        : { ok: true, checked: 0, from: null, to: null };
    else {
      r = verifyChain(items, k.key);
      // Lines cut from the end leave a chain that holds together: the last entry this server wrote says otherwise.
      if (r.ok && tail && (r.to === null || r.to < tail.seq))
        r = { ...r, ok: false, brokenAt: r.to === null ? tail.seq : r.to + 1, reason: 'sequence broken' };
    }
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
  // it within the retention stay), then records which went. Returns the deleted months.
  function prune(retentionMonths) {
    const keep = monthsBefore(monthOf(now()), cleanRetention(retentionMonths));
    const gone = [];
    try {
      for (const m of months())
        if (m.month < keep) {
          fs.rmSync(m.file, { force: true });
          gone.push(m.month);
        }
    } catch {
      /* what could not go stays until the next pass */
    }
    if (gone.length)
      record({
        action: 'audit.prune',
        actor: { via: 'system' },
        months: gone,
        retentionMonths: cleanRetention(retentionMonths),
      });
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
      let ev = null;
      try {
        if (fs.statSync(file).size <= 1024) ev = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: removed below */
      }
      if (ev && CLI_ACTIONS.has(ev.action) && Number.isFinite(ev.ts)) {
        const e = record({ action: ev.action, actor: { via: 'cli' }, occurredAt: new Date(ev.ts).toISOString() });
        if (!e) break; // degraded: the rest waits for the next pass
        n++;
      }
      fs.rmSync(file, { force: true });
    }
    return n;
  }

  return { record, list, export: exportOf, verify, status, prune, importPending };
}

// The CSV of an export: one line per entry, the changes as "path: from → to" joined with "; ".
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
      a.keyId || a.rule || a.device || '',
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
