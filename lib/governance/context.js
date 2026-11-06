// Governance audit log (AI Governance 2): who is acting, carried with the request through AsyncLocalStorage, so the
// module routers and the gateway need no new parameter. server.js runs every request in runAs(null, …); the dashboard
// sign-in check and the gateway's key check then fill in the actor with setActor. Work started by that request
// (awaits, timers, a collaboration run) sees the same actor; anything else (scheduled passes) has none.
//   { via: 'dashboard', mode, device, ip }  { via: 'apikey', keyId }  { via: 'cli' }  { via: 'system' }
//   { via: 'rule', rule }
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// Runs fn with its own actor slot (null until setActor fills it).
const runAs = (actor, fn) => als.run({ actor: actor || null }, fn);
// Sets the actor of the request this runs in; nothing outside runAs.
function setActor(actor) {
  const s = als.getStore();
  if (s) s.actor = actor;
}
// The actor of the request this runs in, or null.
function actor() {
  const s = als.getStore();
  return (s && s.actor) || null;
}

// The request this runs in recorded a change (a config.change, a password change, a run approval): its own request
// entry is then a change too (server.js keeps every one of those).
function noteChange() {
  const s = als.getStore();
  if (s) s.changed = true;
}
const changed = () => {
  const s = als.getStore();
  return !!(s && s.changed);
};

module.exports = { runAs, setActor, actor, noteChange, changed };
