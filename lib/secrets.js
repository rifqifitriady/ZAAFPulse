// Resolves secret references from config.json. Secrets never live in the file itself: a field
// holds { env: 'NAME' } or { keychain: 'service' } and is looked up when a connector is built.
// "keychain" names an item in this OS's secret store (lib/secret-store.js): the macOS Keychain, the
// Linux keyring or the encrypted secret file. Every resolved value is remembered so error messages
// can be masked before anyone sees them.
const { createSecretStore, defaultStore } = require('./secret-store');

function isRef(v) {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && (typeof v.env === 'string' || typeof v.keychain === 'string')
  );
}

function createSecrets({ env = process.env, exec, store } = {}) {
  const known = new Set();
  // exec is the test hook for the Keychain backend; otherwise the OS's own store.
  const backend = store || (exec ? createSecretStore({ backend: 'keychain', exec }) : null);
  const getStore = () => backend || defaultStore();

  function resolve(ref, field = 'secret') {
    if (ref == null) return null;
    if (typeof ref === 'string')
      throw new Error(
        `${field}: plain-text secrets are not allowed in config.json; use { "env": "NAME" } or { "keychain": "service" } (see docs/integrations.md)`,
      );
    if (!isRef(ref)) throw new Error(`${field}: expected { "env": "NAME" } or { "keychain": "service" }`);
    let value = '';
    if (ref.env) {
      value = env[ref.env] || '';
      if (!value) throw new Error(`${field}: environment variable ${ref.env} is not set`);
    } else {
      const s = getStore();
      try {
        value = s.get(ref.keychain) || '';
      } catch (err) {
        throw new Error(`${field}: ${err.message}`);
      }
      if (!value)
        throw new Error(
          `${field}: ${s.id === 'keychain' ? 'Keychain item' : `secret in the ${s.label}`} "${ref.keychain}" not found`,
        );
    }
    if (value.length >= 6) known.add(value);
    return value;
  }

  function mask(text) {
    let s = String(text ?? '');
    for (const v of known) s = s.split(v).join('***');
    return s;
  }

  return { resolve, mask };
}

module.exports = { createSecrets, isRef };
