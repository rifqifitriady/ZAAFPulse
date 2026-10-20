// The one span shape every trace source produces. Names and kinds follow the OTel GenAI conventions
// (invoke_agent / chat / execute_tool), so an export bridge can map spans one to one later.
const crypto = require('crypto');
const sig = require('../signals');

const spanId = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

function span(f) {
  return { parent: null, status: 'ok', usage: null, cost: null, tool: null, signals: [], text: null, model: null, provider: null, end: null, ...f };
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

// The program a shell command runs, as a short label: no leading NAME=value assignments (they often hold
// keys, and a quoted value may span several words), no env/sudo/nohup/time prefixes or their options, no
// argument and no directory. Null when nothing is left, a quote never closes, or the label looks like a secret.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'sudo', 'nohup', 'time']);
// Options of a wrapper that take the next token as their value.
const WITH_VALUE = {
  sudo: new Set(['-u', '-g', '-C', '-h', '-p', '--user', '--group', '--close-from', '--host', '--prompt']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
};
const quotes = (tok, q) => tok.split(q).length - 1;

function commandName(cmd) {
  if (typeof cmd !== 'string') return null;
  const toks = cmd.trim().slice(0, 4096).split(/\s+/);
  let wrapper = null;
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    if (!raw) continue;
    if (ASSIGNMENT.test(raw)) {
      // A quoted value can hold spaces: skip every token up to the one that closes the quote.
      const q = (/["']/.exec(raw.slice(raw.indexOf('=') + 1)) || [])[0];
      let open = q && quotes(raw, q) % 2 === 1;
      while (open) {
        if (++i >= toks.length) return null;
        if (quotes(toks[i], q) % 2 === 1) open = false;
      }
      continue;
    }
    const tok = raw.replace(/^[("'`]+|[)"'`;]+$/g, '');
    if (!tok) continue;
    const name = tok.split(/[\\/]/).pop();
    if (WRAPPERS.has(name)) {
      wrapper = name;
      continue;
    }
    if (wrapper && tok.startsWith('-')) {
      if (WITH_VALUE[wrapper] && WITH_VALUE[wrapper].has(tok)) i++; // the option's value is not the program
      continue;
    }
    const out = name.slice(0, 80);
    return out && !sig.secretSpans(out).length ? out : null;
  }
  return null;
}

module.exports = { spanId, span, validate, totals, commandName };
