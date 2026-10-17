// Resolves secret references from config.json. Secrets never live in the file itself: a field
// holds { env: 'NAME' } or { keychain: 'service' } and is looked up when a connector is built.
// Every resolved value is remembered so error messages can be masked before anyone sees them.
const { execFileSync } = require('child_process');

function isRef(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (typeof v.env === 'string' || typeof v.keychain === 'string');
}

function createSecrets({ env = process.env, exec = execFileSync } = {}) {
  const known = new Set();

  function resolve(ref, field = 'secret') {
    if (ref == null) return null;
    if (typeof ref === 'string') throw new Error(`${field}: plain-text secrets are not allowed in config.json; use { "env": "NAME" } or { "keychain": "service" } (see docs/integrations.md)`);
    if (!isRef(ref)) throw new Error(`${field}: expected { "env": "NAME" } or { "keychain": "service" }`);
    let value = '';
    if (ref.env) {
      value = env[ref.env] || '';
      if (!value) throw new Error(`${field}: environment variable ${ref.env} is not set`);
    } else {
      try { value = String(exec('security', ['find-generic-password', '-s', ref.keychain, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { value = ''; }
      if (!value) throw new Error(`${field}: Keychain item "${ref.keychain}" not found`);
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
