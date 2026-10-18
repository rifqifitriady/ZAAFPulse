// Detectors for quality and safety signals in agent logs. These are heuristics over
// what the logs record, not ground-truth accuracy: each one names what it matched.

const INJECTION = [
  { id: 'override', label: 'Instruction override', re: /ignore (all |any )?(of )?(the )?(previous|prior|above|earlier) (instructions|prompts|directions|rules)|disregard (all |any )?(the )?(previous|prior|above) (instructions|context|rules)/i },
  { id: 'persona', label: 'Persona hijack', re: /you are now (DAN|in developer mode|an? (unrestricted|unfiltered|jailbroken))|enable developer mode|act as (DAN|an unrestricted)/i },
  { id: 'exfil', label: 'Exfiltration request', re: /(send|post|upload|exfiltrate|forward) (the |your |all )?(api keys?|credentials|secrets|env(ironment)? variables|ssh keys?|tokens?) to/i },
  { id: 'hidden', label: 'Hide-from-user instruction', re: /do not (tell|inform|reveal (this )?to|mention (this )?to) the user|without (telling|informing|alerting) the user/i },
  { id: 'roletag', label: 'Fake role tags', re: /<\/?(system|im_start|im_end)>|\[\/?INST\]|BEGIN SYSTEM PROMPT|<\|im_start\|>/i },
  { id: 'command', label: 'Command injection', re: /(run|execute) (the following|this) (command|script) (immediately|now|without (asking|confirmation))/i },
];

const SECRETS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI API key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const RISKY = [
  ['Recursive force delete', /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b/],
  ['Force push', /git\s+push\b[^\n;&|]*(--force\b|\s-f\b)/],
  ['Hard reset', /git\s+reset\s+--hard/],
  ['Pipe to shell', /(curl|wget)[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/],
  ['sudo', /(^|[;&|]\s*)sudo\s/],
  ['World-writable permissions', /chmod\s+(-R\s+)?777/],
  ['Kill processes', /\bkill(all)?\s+-9\b|\bpkill\b/],
  ['Drop database objects', /\bdrop\s+(table|database|schema)\b/i],
  ['Raw disk write', /\bdd\s+if=|\bmkfs\./],
];

// Prompts that ask the model to fix or redo its own output (English and Indonesian).
// A prompt where the person corrects their own input ("saya salah mengisi") does not count.
const CORRECTION = /(^|[\s,.;:!?(])(kamu (salah|keliru|lupa)|(ini|itu|nya|yang|bagian ini) salah|salah (ambil|mengambil|tempat|paham|menggambar)|masih (belum|salah|error|gagal|sering|kurang|tidak|gak|nggak|melenceng)|perbaiki|tolong perbaiki|try again|coba lagi|ulangi|gambar ulang|buat ulang|melenceng|tidak (sesuai|bisa dibuka|lengkap|muncul|jalan|berfungsi|keluar|benar|tepat)|belum (sesuai|berjalan|jalan|muncul|benar|berhasil|sejajar)|kok (berhenti|masih|tidak|gak|nggak)|kenapa (kamu|masih|tidak|malah)|seharusnya|wrong|that'?s not (it|right|what)|not what i (asked|wanted|meant)|still (broken|not working|wrong|failing)|(doesn'?t|didn'?t|does not|did not) work|you (forgot|missed|broke)|fix (this|it|that|the))(?=$|[\s,.;:!?)])/i;
const SELF_CORRECTION = /\bsaya (yang )?salah\b|\bmy (mistake|bad)\b|\bi (made a )?(typo|mistake)\b/i;

function isCorrection(text) {
  const t = text.trim().slice(0, 300);
  return CORRECTION.test(t) && !SELF_CORRECTION.test(t);
}

const CATEGORY = {
  hallucination: 'Hallucination signal',
  process: 'Skipped a required step',
  execution: 'Command or test failed',
  environment: 'Network, timeout or environment',
  rejection: 'Rejected by you or a guardrail',
  other: 'Other tool error',
};

// Returns [category, kind] for a failed tool result.
function classifyError(text, tool) {
  if (/doesn'?t want to proceed|was rejected|denied by|Permission for this|permission request failed|user (declined|rejected)|blocked by (a )?hook/i.test(text)) return ['rejection', 'Rejected by you or a guardrail'];
  if (/File does not exist|No such file or directory|ENOENT|path does not exist|does not exist\. Note: your current working directory|Not a directory/i.test(text)) return ['hallucination', 'Path that does not exist'];
  if (/String to replace not found|old_string (was )?not found|no match(es)? for old_string/i.test(text)) return ['hallucination', 'Edit text not in the file'];
  if (/InputValidationError|Invalid arguments|Input validation error|-32602|No such tool|Unknown tool|unexpected (parameter|argument)|is not a valid (enum|option)/i.test(text)) return ['hallucination', 'Invalid tool arguments'];
  if (tool === 'WebFetch' && /\b404\b|Not Found|ENOTFOUND/i.test(text)) return ['hallucination', 'URL that does not exist'];
  if (/has not been read yet|Read it first|modified since (it was )?(last )?read/i.test(text)) return ['process', 'Edited without reading first'];
  if (/timed? ?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|certificate|socket hang up|rate.?limit|\b(429|502|503|529)\b|overloaded|AbortError|interrupted|no verdict|maxContentLength|Browser pane|No site is open|session ended/i.test(text)) return ['environment', 'Network, timeout or environment'];
  if (/Exit code [1-9]|Traceback|exit_code":[1-9]|Script failed|\bFAIL\b|Error:/i.test(text)) return ['execution', 'Command or test failed'];
  return ['other', 'Other tool error'];
}

const isExternalTool = (name) => /^(WebFetch|WebSearch|web_search|web_fetch|browser)/i.test(name || '') || /^mcp__/.test(name || '');

function scanInjection(text) {
  for (const p of INJECTION) {
    const m = p.re.exec(text);
    if (m) return { id: p.id, label: p.label, at: m.index, match: m[0] };
  }
  return null;
}

function scanSecrets(text) {
  const found = [];
  for (const [label, re] of SECRETS) if (re.test(text)) found.push(label);
  return found;
}

function scanRisky(cmd) {
  const found = [];
  for (const [label, re] of RISKY) if (re.test(cmd)) found.push(label);
  return found;
}

// Masks anything secret-shaped and trims to a short single line.
function snippet(text, at = 0, len = 160) {
  let s = String(text || '');
  if (at > 60) s = '…' + s.slice(at - 60);
  s = s.replace(/\s+/g, ' ').trim();
  for (const [, re] of SECRETS) s = s.replace(new RegExp(re.source, 'g'), (m) => m.slice(0, 6) + '•••');
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

// Collects counts per local day and a capped list of notable events for one log file.
class SignalSink {
  constructor(tool) {
    this.tool = tool;
    this.days = {};
    this.events = [];
    this.perKind = {};
  }

  day(ts) {
    const d = new Date(ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return (this.days[k] ||= { calls: 0, results: 0, failures: 0, cats: {}, kinds: {} });
  }

  // Any numeric counter (calls, results, external, injExternal, secrets, risky, ...).
  count(ts, field, n = 1) {
    if (!Number.isFinite(ts)) return;
    const d = this.day(ts);
    d[field] = (d[field] || 0) + n;
  }

  failure(ts, category, kind) {
    if (!Number.isFinite(ts)) return;
    const d = this.day(ts);
    d.failures++;
    d.cats[category] = (d.cats[category] || 0) + 1;
    d.kinds[kind] = (d.kinds[kind] || 0) + 1;
  }

  event(ev) {
    const cap = ev.kind === 'error' ? 150 : 60;
    const n = (this.perKind[ev.kind] = (this.perKind[ev.kind] || 0) + 1);
    if (n <= cap) this.events.push({ ...ev, tool: ev.tool || this.tool });
  }

  result() {
    return { days: this.days, events: this.events };
  }
}

// Answer relevance and faithfulness per turn (a typed prompt and everything the model did until the
// next one), computed locally without a judge model and without keeping any text:
//  - relevance: the share of the prompt's key terms (words minus stop words, plus paths, identifiers
//    and numbers) that the reply and the turn's tool calls address; half of the terms counts as fully
//    relevant, because a good answer never repeats every word of the question.
//  - faithfulness: of the checkable references in the reply (file names, `identifiers`, URLs and
//    numbers with three or more digits, decimals or %), the share that appeared in the session's
//    context: your prompts, tool inputs and tool results. A reference seen nowhere is unsupported.
const STOP = new Set(('the and for are but not you your with this that from have has had was were will would could should can what when where which who how why '
  + 'all any into onto out over under than then them they their there these those its it\'s our ours his her him she was been being does did done doing just only also very more most '
  + 'please make sure need want like use using used let lets about again still yes yeah okay one two get got put see show tell give take try '
  + 'yang dan di ke dari untuk dengan ini itu ada atau juga sudah belum akan bisa harus agar supaya pada dalam sebagai karena jadi saja lagi tidak bukan kalau jika maka '
  + 'saya aku kamu anda kita kami mereka dia nya lah kah pun ya oke tolong buat buatkan lakukan coba mau ingin sekarang nanti semua setiap tersebut seperti sama lebih '
  + 'apa apakah bagaimana kenapa mengapa dimana kapan siapa berapa mana bagian hal cara').split(' '));
const PATH_RE = /(?:[\w.-]+\/)*[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift|rb|php|c|h|cpp|cs|json|md|yml|yaml|toml|ini|css|scss|html|sh|sql|txt|csv|png|svg)\b/gi;
const URL_RE = /https?:\/\/[^\s)<>"'`\]]+/gi;
const TICK_RE = /`([^`\n]{3,60})`/g;
const NUM_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?%?(?![\w])/g;
const termsOf = (text) => [...new Set((String(text).toLowerCase().match(/[a-z0-9À-ɏ_]{3,}/g) || []).filter((w) => !STOP.has(w) && !/^\d+$/.test(w)))];
const normNum = (n) => n.replace(/,/g, '').replace(/\.0+%?$/, (m) => (m.endsWith('%') ? '%' : ''));
// Checkable references in a piece of text, normalised so a full path and its file name match.
function references(text) {
  const s = String(text || ''); const out = new Set();
  for (const m of s.match(URL_RE) || []) out.add(`url:${m.replace(/[.,;:!?]+$/, '').replace(/\/$/, '').toLowerCase()}`);
  const noUrl = s.replace(URL_RE, ' ');
  for (const m of noUrl.match(PATH_RE) || []) out.add(`file:${m.split('/').pop().toLowerCase()}`);
  for (const m of noUrl.matchAll(TICK_RE)) { const t = m[1].trim(); if (/^[\w.$:/@-]+$/.test(t) && !/^\d/.test(t)) out.add(`id:${t.split('/').pop().replace(/\(\)$/, '').toLowerCase()}`); }
  for (const m of noUrl.match(NUM_RE) || []) { const n = normNum(m); if (n.replace(/[^\d]/g, '').length >= 3 || /[.%]/.test(n)) out.add(`num:${n}`); }
  return out;
}
const CONTEXT_CAP = 60000; const TEXT_CAP = 40000;
class TurnGrader {
  constructor(sink) { this.sink = sink; this.ctx = new Map(); this.turn = null; }
  context(sid) { let c = this.ctx.get(sid); if (!c) { c = { refs: new Set(), words: new Set() }; this.ctx.set(sid, c); } return c; }
  // Everything the model could ground a reply in: prompts, tool inputs and tool results.
  learn(sid, text) {
    const c = this.context(sid); const s = String(text || '').slice(0, TEXT_CAP);
    if (c.refs.size < CONTEXT_CAP) for (const r of references(s)) c.refs.add(r);
    if (c.words.size < CONTEXT_CAP) for (const w of s.toLowerCase().match(/[\w.$@-]{3,}/g) || []) c.words.add(w.replace(/[.]+$/, ''));
  }
  prompt(ts, sid, text) { this.close(); this.learn(sid, text); this.turn = { ts, sid, prompt: String(text || '').slice(0, TEXT_CAP), reply: '', work: '' }; }
  reply(text) { if (this.turn) this.turn.reply += `\n${String(text || '').slice(0, TEXT_CAP)}`; }
  toolInput(sid, text) { this.learn(sid, text); if (this.turn) this.turn.work += `\n${String(text || '').slice(0, 4000)}`; }
  toolResult(sid, text) { this.learn(sid, text); }
  close() {
    const t = this.turn; this.turn = null;
    if (!t || !t.reply.trim()) return;
    const c = this.context(t.sid);
    // Relevance: prompts with fewer than 3 key terms ("ok", "lanjut") are not graded.
    const terms = [...termsOf(t.prompt), ...[...references(t.prompt)].map((r) => r.split(':').slice(1).join(':'))].slice(0, 40);
    if (terms.length >= 3) {
      const corpus = `${t.reply}\n${t.work}`.toLowerCase();
      const hit = terms.filter((w) => corpus.includes(w)).length;
      const score = Math.min(1, (hit / terms.length) * 2);
      this.sink.count(t.ts, 'relTurns'); this.sink.count(t.ts, 'relSum', score);
      if (score < 0.3) this.sink.event({ ts: t.ts, sid: t.sid, kind: 'relevance', label: `Low relevance · ${Math.round(score * 100)}%`, text: snippet(t.prompt, 0, 140) });
    }
    // Faithfulness: references in the reply that the context never showed.
    const claims = [...references(t.reply)];
    if (claims.length) {
      const grounded = (r) => { const v = r.slice(r.indexOf(':') + 1); return c.refs.has(r) || c.words.has(v) || (r.startsWith('num:') && c.words.has(v.replace('%', ''))) || (r.startsWith('url:') && [...c.refs].some((x) => x.startsWith('url:') && (x.startsWith(r) || r.startsWith(x)))); };
      const missing = claims.filter((r) => !grounded(r));
      this.sink.count(t.ts, 'faithClaims', claims.length); this.sink.count(t.ts, 'faithGrounded', claims.length - missing.length);
      if (missing.length) this.sink.event({ ts: t.ts, sid: t.sid, kind: 'unsupported', label: `${missing.length} of ${claims.length} references unsupported`, text: snippet(missing.map((r) => r.slice(r.indexOf(':') + 1)).join(' · '), 0, 160) });
    }
  }
}

module.exports = { CATEGORY, classifyError, isExternalTool, scanInjection, scanSecrets, scanRisky, isCorrection, snippet, SignalSink, TurnGrader, references, termsOf };
