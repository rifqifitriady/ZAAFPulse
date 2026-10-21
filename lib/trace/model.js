// The one span shape every trace source produces. Names and kinds follow the OTel GenAI conventions
// (invoke_agent / chat / execute_tool), so an export bridge can map spans one to one later.
const crypto = require('crypto');
const sig = require('../signals');

const spanId = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

function span(f) {
  return { parent: null, status: 'ok', usage: null, cost: null, tool: null, signals: [], text: null, model: null, provider: null, end: null, ...f };
}

// A title or a label from a log is text: masked with the same patterns as span text, folded to one line and
// cut to 80 characters. Tool names, file names, subagent types and model names go through it too, since they
// stay on show when content is off.
const MAX_TITLE = 80;
const MAX_TEXT = 4096; // how much of a text field is looked at
function maskTitle(text) {
  if (typeof text !== 'string') return null;
  text = text.trimStart().slice(0, MAX_TEXT);
  if (!text) return null;
  let out = '';
  let last = 0;
  for (const sp of sig.secretSpans(text)) {
    out += text.slice(last, sp.start) + `\u2039${sp.label} hidden\u203a`;
    last = sp.end;
  }
  out = (out + text.slice(last)).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1); // do not end on half a surrogate pair
  return out.trim() || null;
}

function validate(spans) {
  const ids = new Map(spans.map((s) => [s.id, s]));
  const out = [];
  const roots = spans.filter((s) => !s.parent);
  if (roots.length !== 1) out.push(`expected one root, found ${roots.length}`);
  for (const s of spans) {
    if (s.parent && !ids.has(s.parent)) out.push(`${s.id}: parent ${s.parent} missing`);
    const p = s.parent && ids.get(s.parent);
    if (p && Number.isFinite(p.start) && Number.isFinite(s.start) && s.start < p.start) out.push(`${s.id}: starts before its parent`);
  }
  return out;
}

function totals(spans) {
  const t = { input: 0, output: 0, cacheRead: 0, cost: 0, tools: 0, errors: 0 };
  for (const s of spans) {
    if (s.usage) {
      t.input += s.usage.input || 0;
      t.output += s.usage.output || 0;
      t.cacheRead += s.usage.cacheRead || 0;
    }
    if (s.cost) t.cost += s.cost;
    if (s.kind === 'tool') t.tools++;
    if (s.status === 'error') t.errors++;
  }
  return t;
}

// The program a shell command runs, as a short label. It fails closed: anything that is not a plain program
// name comes back null. Leading NAME=value assignments (they often hold keys; a quoted value may span several
// words) and env/sudo/nohup/time prefixes with their options are skipped, then only the program's basename
// is returned, and only if it is made of safe characters and does not look like a secret.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/; // `_` is allowed inside a name (pip_audit), never first
const UNPARSABLE = /\\|\$\(|`/; // text before the program that this does not try to understand
const WRAPPERS = new Set(['env', 'sudo', 'nohup', 'time']);
// Options of a wrapper that take the next token as their value.
const WITH_VALUE = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '--user', '--group', '--close-from', '--host', '--prompt']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  time: new Set(['-f', '-o', '--format', '--output']),
  nohup: new Set(),
};
const quotes = (tok, q) => tok.split(q).length - 1;

function commandName(cmd) {
  if (typeof cmd !== 'string') return null;
  const toks = cmd.trim().slice(0, 4096).split(/\s+/);
  let wrapper = null;
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    if (!raw) continue;
    const tok = raw.replace(/^[("'`]+|[)"'`;]+$/g, '');
    if (!tok) continue;
    if (ASSIGNMENT.test(raw) || ASSIGNMENT.test(tok)) {
      if (UNPARSABLE.test(raw)) return null;
      // A quoted value can hold spaces: skip every token up to the one that closes the quote.
      const q = (/["']/.exec(raw) || [])[0];
      let open = q && quotes(raw, q) % 2 === 1;
      while (open) {
        if (++i >= toks.length || UNPARSABLE.test(toks[i])) return null;
        if (quotes(toks[i], q) % 2 === 1) open = false;
      }
      continue;
    }
    const name = tok.split(/[\\/]/).pop();
    if (WRAPPERS.has(name)) {
      wrapper = name;
      continue;
    }
    if (wrapper && tok.startsWith('-')) {
      if (UNPARSABLE.test(raw)) return null;
      if (WITH_VALUE[wrapper].has(tok)) {
        if (++i >= toks.length || UNPARSABLE.test(toks[i])) return null; // the option's value is not the program
      }
      continue;
    }
    return NAME.test(name) && !sig.secretSpans(name).length ? name : null;
  }
  return null;
}

module.exports = { spanId, span, validate, totals, commandName, maskTitle };
