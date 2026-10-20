// A stored secret only goes back to the addresses it was saved for. Integrations, second-brain sources
// and gateway providers describe where an entry sends its secrets as { kind, urls }: kind is the type,
// flavor or sign-in method, urls every address it calls with the built-in defaults applied. An edit
// that keeps a stored secret must stay within those: same kind, and no origin that was not there before.
const { originOf } = require('./secrets');

// Origins of a list of URLs. One that does not parse stands for itself, so it never matches a real one.
function origins(urls) {
  const out = new Set();
  for (const u of urls || []) if (u) out.add(originOf(u) || `invalid:${u}`);
  return out;
}

// Whether a secret input keeps the current secret: explicitly ("keep"), by default (no input), or by
// naming the same item or variable again (the only reference the dashboard accepts). "store" pastes a
// new value and "none" drops it.
function keepsSecret(input, current) {
  if (!current) return false;
  const mode = input && input.mode;
  return mode !== 'store' && mode !== 'none';
}

// Why a kept secret may not move from `before` to `after`, or null when it stays where it was saved:
// { kind: true } when the kind changed, else { added: [origins] } for addresses it would newly reach.
function secretMove(before, after) {
  if ((before.kind || '') !== (after.kind || '')) return { kind: true, added: [] };
  const old = origins(before.urls);
  const added = [...origins(after.urls)].filter((o) => !old.has(o));
  return added.length ? { kind: false, added } : null;
}

// The reason in words, for the error that asks for the secret again.
function moveReason(move, { kind = 'type', url = 'URL' } = {}) {
  return move.kind ? `the ${kind} changed` : `the ${url} changed (now also ${move.added.join(', ')})`;
}

module.exports = { origins, keepsSecret, secretMove, moveReason };
