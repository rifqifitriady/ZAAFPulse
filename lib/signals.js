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

module.exports = { CATEGORY, classifyError, isExternalTool, scanInjection, scanSecrets, scanRisky, isCorrection, snippet, SignalSink };
