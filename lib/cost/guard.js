// The gateway's real-time budget check (Cost Control 2). Before the gateway forwards a request to a route target it
// asks check(); a blocking budget in scope that is used up refuses it, and the gateway answers 402 naming only that
// budget. Spent is the service's: the ledger total for the period plus the calls recorded since the last pass, so a
// budget blocks at once. A call already in flight finishes, so a budget can pass its amount by the calls in flight.
// Fail open: a budget whose spent cannot be computed (no_data, a read that throws) lets the request through, and the
// reason is kept for the status. Blocking every client because of a broken file is the worse failure.
const { normalizeModel } = require('../pricing');

// The ledger's source for a gateway call (lib/cost/collect.js gatewayEvent).
const sourceOf = ({ runId, agent }) =>
  runId ? 'collab' : agent === 'judge' ? 'judge' : agent === 'replay' ? 'replay' : 'gateway';

function createGuard({ service }) {
  // A dashboard call has no key: only global, model and provider budgets reach it.
  function applies(b, ctx) {
    if (b.enforce !== 'block') return false;
    const s = b.scope;
    if (s === 'global') return true;
    if (s.dim === 'key') return !!ctx.keyId && ctx.keyId === s.value;
    if (s.dim === 'center') return !!ctx.keyId && service.keyCenter(ctx.keyId) === s.value;
    if (s.dim === 'model') return !!ctx.model && ctx.model === s.value;
    if (s.dim === 'provider') return !!ctx.provider && ctx.provider === s.value;
    if (s.dim === 'source') return !!ctx.keyId && s.value === 'gateway' && ctx.source === 'gateway';
    return false;
  }

  function check(input = {}) {
    const keyId = input.keyId && input.keyId !== 'dashboard' ? String(input.keyId) : null;
    const ctx = {
      keyId,
      model: normalizeModel(input.model) || null,
      provider: typeof input.provider === 'string' && input.provider ? input.provider : null,
      source: sourceOf(input),
    };
    let list;
    try {
      list = service.list().budgets;
    } catch {
      service.reportGuard('the budgets could not be read, so requests are allowed');
      return null;
    }
    let problem = null;
    for (const b of list) {
      let v;
      try {
        if (!applies(b, ctx)) continue;
        v = service.evaluateOne(b);
      } catch {
        problem = `budget "${b.name}" could not be checked, so its requests are allowed`;
        continue;
      }
      if (v.state === 'no_data') {
        problem = `budget "${b.name}" has no data (${v.reason}), so its requests are allowed`;
        continue;
      }
      if (v.state === 'exceeded') {
        service.reportGuard(problem);
        return { budget: b.id, message: `budget "${b.name}" is used up for this ${b.period}` };
      }
    }
    service.reportGuard(problem);
    return null;
  }

  // A key whose spend a blocking budget counts may use only models that have a price (as a key's budgetUSD did):
  // otherwise the budget could be run past at a cost of $0.
  function keyLimited(keyId) {
    try {
      return service.list().budgets.some(
        (b) =>
          b.enforce === 'block' &&
          b.scope !== 'global' &&
          ((b.scope.dim === 'key' && b.scope.value === keyId) ||
            (b.scope.dim === 'center' && service.keyCenter(keyId) === b.scope.value)),
      );
    } catch {
      return false;
    }
  }

  return { check, keyLimited };
}

module.exports = { createGuard };
