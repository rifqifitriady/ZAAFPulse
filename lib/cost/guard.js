// The gateway's real-time budget check (Cost Control 2). Before the gateway forwards a request to a route target it
// asks check(); a blocking budget in scope that is used up refuses it, and the gateway answers 402 naming only that
// budget. Spent is the service's: the ledger total for the period plus the calls recorded since the last pass, so a
// budget blocks at once. A call already in flight finishes, so a budget can pass its amount by the calls in flight.
// Fail open: a budget whose spent cannot be computed (no_data, a read that throws) lets the request through, and the
// reason is kept for the status. Blocking every client because of a broken file is the worse failure.
// The reasons are kept per budget: a check that does not reach a budget (another route target, another client) never
// clears its reason; only that budget evaluating again does, so a budget letting requests through stays in the status.
const { normalizeModel } = require('../pricing');

// The ledger's source for a gateway call (lib/cost/collect.js gatewayEvent).
const sourceOf = ({ runId, agent }) =>
  runId ? 'collab' : agent === 'judge' ? 'judge' : agent === 'replay' ? 'replay' : 'gateway';

const LIST = Symbol('list'); // the reason the budget list did not read (budget ids are strings, so no clash)
// The reason a check failed outside the guard's own reads (or the gateway's call to it threw): fail open, one fixed
// path-free reason, cleared by the next check that works.
const FAULT = Symbol('fault');
const FAULT_REASON = 'the budget check failed, so requests are allowed';

function createGuard({ service, now = Date.now }) {
  const problems = new Map(); // budget id | LIST -> { budget, reason, since }
  const note = (key, reason) => {
    const was = problems.get(key);
    problems.set(key, { budget: typeof key === 'symbol' ? null : key, reason, since: was ? was.since : now() });
  };
  // The status: the first reason (with how many more) as the summary, and every budget failing open as a list.
  function report() {
    const list = [...problems.values()].map((p) => ({ ...p }));
    const more = list.length > 1 ? ` (and ${list.length - 1} more)` : '';
    service.reportGuard(list.length ? list[0].reason + more : null, list);
  }
  // A status that cannot be kept must not turn a fail-open check into a throw.
  function safeReport() {
    try {
      report();
    } catch {
      /* the status stays as it was */
    }
  }
  function failed() {
    note(FAULT, FAULT_REASON);
    safeReport();
  }

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
    try {
      const r = checkOnce(input);
      if (problems.delete(FAULT)) safeReport();
      return r;
    } catch {
      failed();
      return null;
    }
  }
  function checkOnce(input) {
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
      // A budget no longer listed, or no longer blocking, can no longer let a request through.
      const blocking = new Set(list.filter((b) => b.enforce === 'block').map((b) => b.id));
      for (const k of problems.keys()) if (typeof k !== 'symbol' && !blocking.has(k)) problems.delete(k);
    } catch {
      note(LIST, 'the budgets could not be read, so requests are allowed');
      report();
      return null;
    }
    problems.delete(LIST);
    for (const b of list) {
      let v;
      try {
        if (!applies(b, ctx)) continue;
        v = service.evaluateOne(b, undefined, { forecast: false });
      } catch {
        note(b.id, `budget "${b.name}" could not be checked, so its requests are allowed`);
        continue;
      }
      if (v.state === 'no_data') {
        note(b.id, `budget "${b.name}" has no data (${v.reason}), so its requests are allowed`);
        continue;
      }
      problems.delete(b.id);
      if (v.state === 'exceeded') {
        report();
        return { budget: b.id, message: `budget "${b.name}" is used up for this ${b.period}` };
      }
    }
    report();
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
      failed();
      return false;
    }
  }

  return { check, keyLimited, failed };
}

module.exports = { createGuard };
