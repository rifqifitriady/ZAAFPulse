// Collectors: raw records → normalized usage events, and the one pricing formula every source shares.
// Who counts what (no call is counted twice):
//  - the log index: Claude Code and Codex transcripts, deduplicated with the Overview's key (resumed and forked sessions
//    copy earlier responses; lib/aggregate.js dedupeEvents keeps one);
//  - the gateway log: every call that went through the gateway, including dataset replay (agent "replay"), external
//    judge calls (agent "judge") and collaboration runs (runId). Experiment records and run totals repeat these lines
//    and are never read;
//  - judge-calls.jsonl: judge calls that did not go through the gateway (Ollama, LM Studio, the Claude Code CLI, which
//    runs with --no-session-persistence and so leaves no transcript).
// Events carry numbers and names only, never text.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { dedupeEvents, mergeSessions } = require('../aggregate');
const { tilde } = require('../logroots');

const LOCAL_PROVIDER = { claude: 'anthropic', codex: 'openai' };
const GATEWAY_KIND = { chat: 'chat', embeddings: 'embed', agent: 'agent' };
const FREE_JUDGE = new Set(['ollama', 'lmstudio']); // the judge's own local servers
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

// Codex desktop gives each chat its own dated folder; one project, as on the Overview.
const projectOf = (p, home) =>
  typeof p === 'string' && p
    ? tilde(p.replace(/([\\/]Documents[\\/]Codex)[\\/]\d{4}-\d{2}-\d{2}(?:[\\/].*)?$/, '$1'), home)
    : null;

// `home` defaults to the owner's home folder: tilde('/x', '') would turn every absolute path into ~/x.
function localEvents(results, { home = os.homedir() } = {}) {
  const sessions = mergeSessions(results);
  const out = [];
  for (const e of dedupeEvents(results, sessions)) {
    const provider = LOCAL_PROVIDER[e[1]];
    if (!provider || !Number.isFinite(e[0])) continue;
    const s = sessions.get(`${e[1]}:${e[2]}`) || {};
    const x = e[11] || {};
    out.push({
      ts: e[0],
      source: e[1],
      provider,
      model: String(e[3] || ''),
      tokens: { in: n(e[4]), out: n(e[5]), cacheRead: n(e[6]), cacheWrite5m: n(e[7]), cacheWrite1h: n(e[8]) },
      webSearches: n(x.ws),
      geo: x.geo === 'us' ? 'us' : null,
      project: projectOf(s.project, home),
      keyId: null,
      agent: null,
      kind: 'chat',
      estimated: false,
      free: false,
    });
  }
  return out;
}

// Claude Code or Codex on this machine pointed at the gateway: the local collector counts the call from its own logs.
// The same tools on another machine have no logs here, so their lines (no `local`) are kept, as are old untagged lines.
const LOCAL_CLIENTS = new Set(['claude-code', 'codex']);
const fromLocalClient = (line) => LOCAL_CLIENTS.has(line.client) && line.local === true;

const wellFormed = (line) => !!line && typeof line === 'object' && Number.isFinite(line.ts);
// Whether the ledger takes a gateway line at all: lines another collector already counts are dropped here.
const takenFromGateway = (line) => wellFormed(line) && !fromLocalClient(line);

// One gateway log line (lib/gateway/usage.js). `input` is the whole prompt (cached and cache-written tokens included);
// lines carry no cache writes, web searches or geo today, and these optional fields are read when a line has them.
// `counts.skippedLocalClients`, when given, counts the lines left to the local collector (for the status).
function gatewayEvent(line, { isPrivate = () => false, counts = null } = {}) {
  if (!takenFromGateway(line)) {
    // A well-formed line is dropped only as a local client's.
    if (counts && wellFormed(line)) counts.skippedLocalClients = (counts.skippedLocalClients || 0) + 1;
    return null;
  }
  const input = n(line.input);
  const out = n(line.output);
  if (!input && !out) return null; // a failed attempt: nothing was used
  const cached = Math.min(n(line.cached), input);
  const cw5m = Math.min(n(line.cacheWrite5m), input - cached);
  const cw1h = Math.min(n(line.cacheWrite1h), input - cached - cw5m);
  const run = !!str(line.runId, 80);
  const source = run ? 'collab' : line.agent === 'judge' ? 'judge' : line.agent === 'replay' ? 'replay' : 'gateway';
  const kind = run ? 'run' : source !== 'gateway' ? source : GATEWAY_KIND[line.kind] || 'chat';
  const provider = str(line.provider, 80);
  return {
    ts: line.ts,
    source,
    provider,
    model: String(line.routedTo || line.model || ''),
    tokens: { in: input - cached - cw5m - cw1h, out, cacheRead: cached, cacheWrite5m: cw5m, cacheWrite1h: cw1h },
    webSearches: n(line.webSearches),
    geo: line.geo === 'us' ? 'us' : null,
    project: null,
    keyId: line.keyId && line.keyId !== 'dashboard' ? str(line.keyId, 64) : null,
    agent: source === 'gateway' || source === 'collab' ? str(line.agent, 80) : null,
    kind,
    estimated: false,
    free: !!provider && !!isPrivate(provider),
  };
}

// What the eval engine reports for one answered judge call, as a judge-calls.jsonl line. Claude Code's `input` holds
// the cached and cache-written tokens too; its split is in usage.cacheRead / usage.cacheWrite.
function judgeLine({ kind, provider, model, usage } = {}, ts) {
  if (kind === 'external' || !usage || typeof kind !== 'string') return null;
  const input = n(usage.input);
  const cacheRead = Math.min(n(usage.cacheRead), input);
  const cacheWrite5m = Math.min(n(usage.cacheWrite), input - cacheRead);
  return {
    ts,
    kind: kind.slice(0, 20),
    provider: str(provider, 40),
    model: String(model || '').slice(0, 100),
    in: input - cacheRead - cacheWrite5m,
    out: n(usage.output),
    cacheRead,
    cacheWrite5m,
  };
}

function judgeEvent(line) {
  if (!line || !Number.isFinite(line.ts) || typeof line.model !== 'string') return null;
  const tokens = {
    in: n(line.in),
    out: n(line.out),
    cacheRead: n(line.cacheRead),
    cacheWrite5m: n(line.cacheWrite5m),
    cacheWrite1h: 0,
  };
  if (!tokens.in && !tokens.out && !tokens.cacheRead && !tokens.cacheWrite5m) return null;
  return {
    ts: line.ts,
    source: 'judge',
    provider: str(line.provider, 40),
    model: line.model,
    tokens,
    webSearches: 0,
    geo: null,
    project: null,
    keyId: null,
    agent: null,
    kind: 'judge',
    estimated: false,
    free: FREE_JUDGE.has(line.kind),
  };
}

// The list price of one event with the shared pricer (cache writes 5m/1h, prompt-length tiers, web search, US geo): the
// same formula for every source. A model on the owner's own hardware costs 0; a model with no price is unpriced.
function priceEvent(pricer, ev) {
  if (ev.free) return { listUSD: 0, unpriced: false, estimated: false };
  if (!ev.model || !pricer.priced(ev.model)) return { listUSD: 0, unpriced: true, estimated: false };
  const t = ev.tokens;
  const extra = ev.webSearches || ev.geo ? { ws: ev.webSearches || 0, geo: ev.geo } : null;
  const p = pricer.parts(ev.model, t.in, t.out, t.cacheRead, t.cacheWrite5m, t.cacheWrite1h, extra);
  return { listUSD: p[0] + p[1] + p[2] + p[3] + p[4], unpriced: false, estimated: pricer.estimated(ev.model) };
}

// A file is named by a hash of its first line, so a rotation (file → file.1) can be told from new data. Only the first
// 4096 bytes are hashed: a longer first line is named by them. null while the file has no complete line.
function headAt(fd) {
  const buf = Buffer.alloc(4096);
  const len = fs.readSync(fd, buf, 0, buf.length, 0);
  const nl = buf.subarray(0, len).indexOf(10);
  if (nl < 0 && len < buf.length) return null;
  return crypto
    .createHash('sha256')
    .update(buf.subarray(0, nl < 0 ? len : nl))
    .digest('hex')
    .slice(0, 16);
}

// One open of `file` (null when it does not exist). The head, the size and the lines all come from this one file
// descriptor, so a rotation by another process during a pass cannot mix two generations of the log.
function withLog(file, use) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return use(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const headOf = (file) => withLog(file, headAt);

// The complete lines of an open file from `offset` to `size`; `end` is the offset just past the last newline, so a
// partial last line is read on a later pass once it is complete.
function linesAt(fd, offset, size) {
  if (size <= offset) return { rows: [], bad: 0, end: offset };
  const buf = Buffer.alloc(size - offset);
  const got = fs.readSync(fd, buf, 0, buf.length, offset);
  const last = buf.subarray(0, got).lastIndexOf(10);
  if (last < 0) return { rows: [], bad: 0, end: offset };
  const rows = [];
  let bad = 0;
  for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && !Array.isArray(r)) rows.push(r);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { rows, bad, end: offset + last + 1 };
}

// New complete lines of an append-only log since `cursor` ({ head, offset }; none on the first run). See R11.
// `from(head, size)` picks where to start in one generation, or null to skip it.
function readNew(file, cursor) {
  const c = cursor && Number.isFinite(cursor.offset) && cursor.offset >= 0 ? cursor : null;
  const known = c ? (c.head ?? null) : undefined;
  const read = (f, from) =>
    withLog(f, (fd) => {
      const head = headAt(fd);
      const size = fs.fstatSync(fd).size;
      const at = from(head, size);
      return { head, ...(at === null ? { rows: [], bad: 0, end: 0 } : linesAt(fd, at, size)) };
    });
  // The current file first: the same generation goes on from the offset (from 0 when it is now shorter); any other
  // file is new and read from 0.
  const now = read(file, (head, size) => (head === known ? (size < c.offset ? 0 : c.offset) : 0)) || {
    head: null,
    rows: [],
    bad: 0,
    end: 0,
  };
  // Then .1: the rest of the generation this cursor was in, or all of it on the first run. The current file is read
  // first on purpose: a .1 with the head just read is that same file, rotated meanwhile, and is skipped, so one pass
  // never reads a generation twice. (Reading .1 first would instead lose the generation that rotated in between.)
  // With a cursor this holds already: .1 is read only with the cursor's head, which the current file does not have.
  let old = null;
  if (!c) old = read(`${file}.1`, (head) => (head !== null && head === now.head ? null : 0));
  else if (now.head !== known && c.head) old = read(`${file}.1`, (head) => (head === c.head ? c.offset : null));
  const parts = old ? [old, now] : [now];
  return {
    rows: parts.flatMap((p) => p.rows),
    bad: parts.reduce((a, p) => a + p.bad, 0),
    cursor: { head: now.head, offset: now.end },
  };
}

module.exports = { localEvents, gatewayEvent, judgeLine, judgeEvent, priceEvent, readNew, headOf, projectOf };
