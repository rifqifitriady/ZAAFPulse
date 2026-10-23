// The dataset example: its limits, masking, size caps and validation. Datasets are the one place a copy of
// transcript text is kept (because the owner saved it), so every text field is masked before it is stored.
const crypto = require('crypto');
const sig = require('../signals');
const { MARK } = require('../evals/judge');
const registry = require('../evals/registry');

const LIMITS = {
  examples: 1000, // per dataset
  datasets: 100,
  field: 65536, // characters per text field
  messages: 50, // per example
  tools: 100, // per example
  tags: 20, // per example
  toolName: 200,
  name: 80, // dataset display name
  exampleBytes: 1048576, // serialized size of one example
  importBytes: 16777216, // request body of an import
  addItems: 50, // items in one add request
};
const ROLES = ['system', 'user', 'assistant', 'tool'];
// `import` and `settings` are routes; the rest are Windows device names, which cannot be file names there
// (`con.jsonl` is still the console).
const RESERVED = new Set([
  'import',
  'settings',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG = /^[\p{L}\p{N}_.:-]{1,40}$/u;
const EXAMPLE_ID = /^ex_[0-9a-f]{16}$/;

// Live-looking secrets become `‹<label> hidden›`, the same spans scanSecrets reports.
function maskText(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const sp of sig.secretSpans(s)) {
    out += s.slice(last, sp.start) + `‹${sp.label} hidden›`;
    last = sp.end;
  }
  return out + s.slice(last);
}

// Head and tail around a marker, never cutting a surrogate pair in half.
function capField(text, max = LIMITS.field) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const gap = `\n${MARK}\n`;
  const half = Math.max(0, Math.floor((max - gap.length) / 2));
  let head = s.slice(0, half);
  let tail = s.slice(s.length - half);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  if (/^[\udc00-\udfff]/.test(tail)) tail = tail.slice(1);
  return head + gap + tail;
}

function validSlug(slug) {
  return typeof slug === 'string' && SLUG.test(slug) && !RESERVED.has(slug);
}

function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s && validSlug(s) ? s : null;
}

// Source identifiers are masked and bounded the same way on save and in the lookup key, so a masked id still
// matches itself (masking is idempotent).
const idField = (v) => maskText(v).slice(0, 200);

// What makes two examples "the same turn" when auto-adding and when saving from a trace.
function sourceKey(source) {
  if (!source || typeof source !== 'object') return null;
  return `${idField(source.source)}|${idField(source.session)}|${source.turn}`;
}

// Tags: a list of short plain words. A tag that holds a secret is refused, not masked: the mask text would not
// pass the tag pattern anyway.
function cleanTags(tags, limits = LIMITS) {
  if (!Array.isArray(tags)) return { ok: false, reason: 'tags must be a list' };
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string' || !TAG.test(tag) || sig.secretSpans(tag).length) {
      return { ok: false, reason: 'tags may only hold letters, numbers and _ . : - (1 to 40 characters)' };
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > limits.tags) return { ok: false, reason: `at most ${limits.tags} tags` };
  return { ok: true, tags: out };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newId = () => 'ex_' + crypto.randomBytes(8).toString('hex');

// Validates one example and builds a fresh object field by field, so unknown keys never reach the store.
// Non-strict (examples the server built): text is masked, then over-long text is cut to head + tail.
// Strict (import): text longer than the field limit before masking is rejected rather than trimmed.
function cleanExample(raw, { strict = false, now = Date.now, limits = LIMITS } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isObj(raw)) return fail('example must be an object');

  // null means "too long in strict mode"; callers turn that into the path-specific reason.
  const text = (value) => {
    if (strict && value.length > limits.field) return null;
    return capField(maskText(value), limits.field);
  };
  const tooLong = (path) => fail(`${path} is longer than 64 KB`);

  // source
  let source = null;
  if (raw.source != null) {
    const s = raw.source;
    if (!isObj(s)) return fail('source must be an object or null');
    if (typeof s.source !== 'string' || !s.source) return fail('source.source must be text');
    if (typeof s.session !== 'string' || !s.session) return fail('source.session must be text');
    if (typeof s.turn !== 'number' || !Number.isFinite(s.turn)) return fail('source.turn must be a number');
    if (s.span != null && typeof s.span !== 'string') return fail('source.span must be text or null');
    // Opaque trace identifiers, but an import can put any text here: masked and bounded like sourceKey does.
    source = {
      source: idField(s.source),
      session: idField(s.session),
      turn: s.turn,
      span: s.span == null ? null : idField(s.span),
    };
  }

  // input
  if (!isObj(raw.input)) return fail('input must be an object');
  let system = null;
  if (raw.input.system != null) {
    if (typeof raw.input.system !== 'string') return fail('input.system must be text or null');
    system = text(raw.input.system);
    if (system === null) return tooLong('input.system');
  }
  const rawMessages = raw.input.messages;
  if (!Array.isArray(rawMessages) || !rawMessages.length) return fail('input.messages needs at least one message');
  if (rawMessages.length > limits.messages) return fail(`input.messages has more than ${limits.messages} messages`);
  const messages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    const at = `input.messages[${i}]`;
    if (!isObj(m)) return fail(`${at} must be an object`);
    if (!ROLES.includes(m.role)) return fail(`${at}.role must be one of ${ROLES.join(', ')}`);
    if (typeof m.text !== 'string') return fail(`${at}.text must be text`);
    const t = text(m.text);
    if (t === null) return tooLong(`${at}.text`);
    const msg = { role: m.role, text: t };
    if (m.role === 'tool' && typeof m.name === 'string' && m.name) {
      msg.name = maskText(m.name).slice(0, limits.toolName);
    }
    messages.push(msg);
  }
  if (!messages.some((m) => m.role === 'user')) return fail('input.messages needs a user message');
  const rawTools = raw.input.tools == null ? [] : raw.input.tools;
  if (!Array.isArray(rawTools)) return fail('input.tools must be a list');
  if (rawTools.length > limits.tools) return fail(`input.tools has more than ${limits.tools} tools`);
  const tools = [];
  for (let i = 0; i < rawTools.length; i++) {
    const t = rawTools[i];
    const at = `input.tools[${i}]`;
    if (!isObj(t) || typeof t.name !== 'string' || !t.name) return fail(`${at}.name must be text`);
    if (t.description != null && typeof t.description !== 'string') return fail(`${at}.description must be text`);
    const description = text(t.description || '');
    if (description === null) return tooLong(`${at}.description`);
    tools.push({ name: maskText(t.name).slice(0, limits.toolName), description });
  }

  // output
  if (!isObj(raw.output) || typeof raw.output.text !== 'string') return fail('output.text must be text');
  const outText = text(raw.output.text);
  if (outText === null) return tooLong('output.text');
  if (raw.output.model != null && typeof raw.output.model !== 'string')
    return fail('output.model must be text or null');
  const output = { text: outText, model: raw.output.model == null ? null : maskText(raw.output.model).slice(0, 200) };

  // reference
  let reference = null;
  if (raw.reference != null) {
    if (!isObj(raw.reference) || typeof raw.reference.text !== 'string') return fail('reference.text must be text');
    const r = text(raw.reference.text);
    if (r === null) return tooLong('reference.text');
    reference = { text: r };
  }

  // tags
  let tags = [];
  if (raw.tags != null) {
    const t = cleanTags(raw.tags, limits);
    if (!t.ok) return fail(t.reason);
    tags = t.tags;
  }

  // evals: evaluator id -> one of its labels
  const evals = {};
  if (raw.evals != null) {
    if (!isObj(raw.evals)) return fail('evals must be an object');
    for (const [id, label] of Object.entries(raw.evals)) {
      const ev = registry.get(id);
      if (!ev) return fail(`evals has an unknown evaluator`);
      if (!registry.validLabel(ev, label)) return fail(`evals.${id} has an unknown label`);
      evals[id] = label;
    }
  }

  if (raw.feedback != null && raw.feedback !== 'good' && raw.feedback !== 'bad') {
    return fail('feedback must be good, bad or null');
  }

  const t = now();
  const example = {
    id: typeof raw.id === 'string' && EXAMPLE_ID.test(raw.id) ? raw.id : newId(),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : t,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : t,
    source,
    input: { system, messages, tools },
    output,
    reference,
    tags,
    evals,
    feedback: raw.feedback || null,
  };
  if (Buffer.byteLength(JSON.stringify(example)) > limits.exampleBytes) return fail('example is too large');
  return { ok: true, example };
}

module.exports = {
  LIMITS,
  ROLES,
  MARK,
  RESERVED,
  maskText,
  capField,
  slugify,
  validSlug,
  sourceKey,
  cleanTags,
  cleanExample,
};
