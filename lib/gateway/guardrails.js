// Gateway guardrails (AI Governance 1): content checks on what the gateway sends to a provider or an integration.
// Three checks: `secrets` and `pii` scan the whole body, `injection` only the new input (D6). Pure: a body and a policy
// in, a new body, the action and the hits out; no I/O, no clock. A hit is { check, label, count }: never the matched
// text. Redaction is deterministic (the same text always becomes the same placeholder), so prompt caches stay valid.
const signals = require('../signals');
const pii = require('../evals/pii');

const CHECKS = ['secrets', 'pii', 'injection'];
const MODES = {
  secrets: ['off', 'log', 'redact', 'block'],
  pii: ['off', 'log', 'redact', 'block'],
  injection: ['off', 'log', 'block'], // nothing to redact
};
const SCOPES = ['external', 'all'];
const DEFAULTS = Object.freeze({ scope: 'external', secrets: 'redact', pii: 'off', injection: 'log' });
const FORMATS = ['openai-chat', 'anthropic', 'responses', 'embeddings', 'arguments'];
// How a block message names each check.
const WORD = { secrets: 'secret', pii: 'personal data', injection: 'prompt injection' };
const PII_KINDS = ['email', 'phone', 'ip'];

// Keys whose string value is structure, not content (ids, roles, names, model ids), and keys whose value is binary data
// or an opaque provider token that must reach the provider unchanged (a thinking signature, encrypted reasoning).
const STRUCTURAL = new Set(['model', 'role', 'type', 'id', 'name', 'tool_choice', 'stop']);
const BINARY = new Set(['b64_json', 'image_url', 'inline_data', 'signature', 'encrypted_content']);
// Signed or encrypted model output: the provider rejects it when changed, so it passes through unscanned.
const OPAQUE = new Set(['thinking', 'redacted_thinking', 'reasoning']);
// A data URL is skipped only when the whole value is base64: text after a short base64 prefix is still checked.
const BASE64_URL = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*;base64,[A-Za-z0-9+/=\s]*$/i;
// Responses API items the model produced: like an assistant message, what comes after them is new input.
const MODEL_ITEMS = new Set([
  'function_call',
  'custom_tool_call',
  'reasoning',
  'web_search_call',
  'file_search_call',
  'computer_call',
  'code_interpreter_call',
  'image_generation_call',
  'local_shell_call',
  'mcp_call',
]);

const oneOf = (list) => `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The global policy from config.json `gateway.guardrails`: a field that is missing or not allowed takes its default.
function cleanPolicy(cfg) {
  const c = isObj(cfg) ? cfg : {};
  const out = { scope: SCOPES.includes(c.scope) ? c.scope : DEFAULTS.scope };
  for (const k of CHECKS) out[k] = MODES[k].includes(c[k]) ? c[k] : DEFAULTS[k];
  return out;
}

// The policy for one call: a mode the key sets wins, one it leaves out comes from the global setting (D4). No key (the
// dashboard, agents run without a key, the judge, dataset replay) is the global setting. Scope is global only.
function resolvePolicy(globalCfg, key) {
  const out = cleanPolicy(globalCfg);
  const own = key && isObj(key.guardrails) ? key.guardrails : {};
  for (const k of CHECKS) if (MODES[k].includes(own[k])) out[k] = own[k];
  return out;
}

// Scope external (the default) leaves calls to private providers (own hardware) alone: nothing leaves the machine.
const inScope = (policy, tier) => policy.scope === 'all' || tier !== 'private';

// The settings route: the fields given are merged onto the current policy; a value that is not allowed is refused.
function cleanSettings(input, current) {
  if (!isObj(input)) return { errors: ['guardrails must be an object'], value: cleanPolicy(current) };
  const errors = [];
  const value = cleanPolicy(current);
  if (input.scope !== undefined) {
    if (SCOPES.includes(input.scope)) value.scope = input.scope;
    else errors.push(`guardrails.scope: ${oneOf(SCOPES)}`);
  }
  for (const k of CHECKS) {
    if (input[k] === undefined) continue;
    if (MODES[k].includes(input[k])) value[k] = input[k];
    else errors.push(`guardrails.${k}: ${oneOf(MODES[k])}`);
  }
  return { errors, value };
}

// A key's own modes: an empty value (or none) means "use the global setting" and is left out of the stored key.
function cleanKeyPolicy(input) {
  if (input === undefined || input === null || input === '') return { errors: [], value: {} };
  if (!isObj(input)) return { errors: ['guardrails must be an object'], value: {} };
  const errors = [];
  const value = {};
  for (const k of CHECKS) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    if (MODES[k].includes(v)) value[k] = v;
    else errors.push(`guardrails.${k}: ${oneOf(MODES[k])}, or empty for the global setting`);
  }
  return { errors, value };
}

// "Blocked by ZAAFPulse guardrails: secret (Anthropic API key). Remove it, or ask the owner to change the policy."
// It names the checks and labels that blocked, never a value.
function blockMessage(hits) {
  const parts = CHECKS.map((c) => [c, hits.filter((h) => h.check === c).map((h) => h.label)])
    .filter(([, labels]) => labels.length)
    .map(([c, labels]) => `${WORD[c]} (${labels.join(', ')})`);
  return `Blocked by ZAAFPulse guardrails: ${parts.join('; ')}. Remove it, or ask the owner to change the policy.`;
}

class GuardrailBlock extends Error {
  constructor(hits) {
    super(blockMessage(hits));
    this.name = 'GuardrailBlock';
    this.hits = hits; // only the hits of the checks in block mode: nothing was sent, so nothing else applied
  }
}

// A private key's pattern matches its BEGIN line only; the key itself runs to the END line (or the end of the text).
function privateKeyEnd(text, from) {
  const m = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(from));
  return m ? from + m.index + m[0].length : text.length;
}

// One string through the checks of a run. `fresh` says whether it is new input (the injection check).
function makeRun(policy) {
  const hits = new Map(); // `${check}|${label}` -> { check, label, count }
  const state = { redacted: false, error: false };
  const add = (check, label, n = 1) => {
    const k = `${check}|${label}`;
    const h = hits.get(k);
    if (h) h.count += n;
    else hits.set(k, { check, label, count: n });
  };
  // A check that throws: in log mode the request goes on (marked); in redact or block mode the caller fails closed.
  const guarded = (check, fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      if (policy[check] !== 'log') throw err;
      state.error = true;
      return fallback;
    }
  };
  function secretsIn(text) {
    const spans = signals.secretSpans(text);
    if (!spans.length) return text;
    let out = '';
    let at = 0;
    for (const sp of spans) {
      if (sp.start < at) continue; // inside a private key block already replaced
      add('secrets', sp.label);
      out += `${text.slice(at, sp.start)}‹secret: ${sp.label}›`;
      at = sp.label === 'Private key' ? privateKeyEnd(text, sp.end) : sp.end;
    }
    if (policy.secrets !== 'redact') return text;
    state.redacted = true;
    return out + text.slice(at);
  }
  function piiIn(text) {
    const counts = {};
    const masked = pii.maskPii(text, { home: false, counts });
    for (const kind of PII_KINDS) if (counts[kind]) add('pii', kind, counts[kind]);
    if (policy.pii !== 'redact' || masked === text) return text;
    state.redacted = true;
    return masked;
  }
  function injectionIn(text) {
    const r = signals.scanInjection(text);
    if (r) for (const label of r.labels) add('injection', label);
  }
  function text(s, fresh) {
    let t = s;
    if (policy.secrets !== 'off') t = guarded('secrets', () => secretsIn(t), t);
    if (policy.pii !== 'off') t = guarded('pii', () => piiIn(t), t);
    if (fresh && policy.injection !== 'off') guarded('injection', () => injectionIn(s));
    return t;
  }
  function finish(value) {
    const list = [...hits.values()];
    const blocking = list.filter((h) => policy[h.check] === 'block');
    if (blocking.length) throw new GuardrailBlock(blocking);
    const action = state.redacted ? 'redacted' : list.length || state.error ? 'logged' : null;
    return { value, action, hits: list, error: state.error };
  }
  return { text, finish };
}

// Every string leaf of a value, copy-on-write: an object or array that holds a changed string is copied (a spread keeps
// any symbol keys), everything else is returned as it is. With `structural` false (MCP arguments) no key is skipped.
// Otherwise skipped: structural keys, the BINARY keys, `data` inside a base64 source, and signed model output.
const structuralKey = (key) => typeof key === 'string' && (STRUCTURAL.has(key) || key.endsWith('_id'));
const skipKey = (obj, k) => BINARY.has(k) || (k === 'data' && obj.type === 'base64');
function walk(value, key, visit, structural) {
  if (typeof value === 'string')
    return (structural && structuralKey(key)) || BASE64_URL.test(value) ? value : visit(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = walk(value[i], key, visit, structural); // a list of strings keeps its key (stop: ['\n'])
      if (v !== value[i]) (out ||= value.slice())[i] = v;
    }
    return out || value;
  }
  if (structural && OPAQUE.has(value.type)) return value;
  let out = null;
  for (const k of Object.keys(value)) {
    if (structural && skipKey(value, k)) continue;
    const v = walk(value[k], k, visit, structural);
    if (v !== value[k]) (out ||= { ...value })[k] = v;
  }
  return out || value;
}

// Index of the last assistant turn in a message (or Responses item) list, or -1. One that ends the list is a prefill
// (the caller asks the model to continue it), not history: the user turn before it is still new input.
function lastAssistant(list, format) {
  const isModel = (m) => isObj(m) && (m.role === 'assistant' || (format === 'responses' && MODEL_ITEMS.has(m.type)));
  for (let i = list.length - 1; i >= 0; i--) {
    if (isModel(list[i]) && i < list.length - 1) return i;
  }
  return -1;
}

// The body that will be sent upstream, checked. `format` is its shape: openai-chat, anthropic, responses, embeddings or
// arguments (MCP tool arguments: secrets and pii only, no key is structural). Returns { body, action, hits, error }:
// `body` a new object (the input is never changed), `action` 'redacted', 'logged' or null, `error` true when a check in
// log mode threw. The result is copy-on-write: it shares every unchanged nested object with the input, so callers
// must not mutate nested fields of `body` in place. Throws GuardrailBlock when a check in block mode found something;
// rethrows a check's own error in redact or
// block mode (the caller refuses the request: fail closed).
function checkBody(body, policy, { format } = {}) {
  if (!FORMATS.includes(format)) throw new Error(`unknown body format "${format}"`);
  const run = makeRun(format === 'arguments' ? { ...policy, injection: 'off' } : policy);
  const structural = format !== 'arguments';
  if (!isObj(body)) {
    const r = run.finish(walk(body, null, (s) => run.text(s, true), structural));
    return { body: r.value, action: r.action, hits: r.hits, error: r.error };
  }
  const listKey =
    format === 'responses' ? 'input' : format === 'openai-chat' || format === 'anthropic' ? 'messages' : '';
  const list = listKey && Array.isArray(body[listKey]) ? body[listKey] : null;
  const last = list ? lastAssistant(list, format) : -1;
  const out = { ...body };
  for (const k of Object.keys(body)) {
    if (structural && BINARY.has(k)) continue;
    if (list && k === listKey) {
      let items = null;
      for (let i = 0; i < list.length; i++) {
        const v = walk(list[i], null, (s) => run.text(s, i > last), structural);
        if (v !== list[i]) (items ||= list.slice())[i] = v;
      }
      if (items) out[k] = items;
    } else out[k] = walk(body[k], k, (s) => run.text(s, last < 0), structural);
  }
  const r = run.finish(out);
  return { body: r.value, action: r.action, hits: r.hits, error: r.error };
}

// One text: `part` 'arguments' (secrets and pii), 'result' (an MCP tool result: injection only) or 'input' (all three).
function checkText(text, policy, { part = 'input' } = {}) {
  const p =
    part === 'result'
      ? { ...policy, secrets: 'off', pii: 'off' }
      : part === 'arguments'
        ? { ...policy, injection: 'off' }
        : policy;
  const run = makeRun(p);
  const r = run.finish(run.text(String(text ?? ''), true));
  return { text: r.value, action: r.action, hits: r.hits, error: r.error };
}

module.exports = {
  CHECKS,
  MODES,
  SCOPES,
  DEFAULTS,
  FORMATS,
  cleanPolicy,
  resolvePolicy,
  inScope,
  cleanSettings,
  cleanKeyPolicy,
  blockMessage,
  checkBody,
  checkText,
  GuardrailBlock,
};
