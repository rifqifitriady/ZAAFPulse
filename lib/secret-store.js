// Where pasted secrets (provider keys, integration tokens, second-brain tokens) are kept, per OS:
//   keychain   macOS login Keychain (the `security` tool)
//   libsecret  Linux desktop keyring: GNOME Keyring / KWallet through `secret-tool`
//   file       AES-256-GCM encrypted file in the data folder: headless Linux servers, Docker and Windows.
//              The 32-byte key comes from ZAAFPULSE_MASTER_KEY (or ZAAFPULSE_MASTER_KEY_FILE), else from
//              .data/secret.key, readable only by this user; on Windows that key is sealed with DPAPI.
// ZAAFPULSE_SECRET_STORE=keychain|libsecret|file picks one explicitly. config.json only ever holds the
// reference ({ "keychain": "<service>" }, a name kept for compatibility), never the value.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const KEYCHAIN_ACCOUNT = 'ai-command-center';
const LABELS = { keychain: 'macOS Keychain', libsecret: 'system keyring (libsecret)', file: 'encrypted secret file' };

function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}
function pickBackend(env = process.env, platform = process.platform) {
  const forced = env.ZAAFPULSE_SECRET_STORE;
  if (forced && LABELS[forced]) return forced;
  if (platform === 'darwin') return 'keychain';
  const desktop = env.DBUS_SESSION_BUS_ADDRESS && (env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP);
  if (platform === 'linux' && desktop && has('secret-tool')) return 'libsecret';
  return 'file';
}

function keychainBackend({ exec = execFileSync } = {}) {
  return {
    get(service) {
      try {
        return (
          String(
            exec('security', ['find-generic-password', '-s', service, '-w'], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }),
          ).trim() || null
        );
      } catch {
        return null;
      }
    },
    // The value goes over stdin (security -i), never on the command line. security -i reads one command
    // per line, so a newline in either part would start a second command: refuse control characters.
    set(service, value) {
      if (/[\x00-\x1f\x7f]/.test(service) || /[\x00-\x1f\x7f]/.test(value))
        throw new Error('a secret cannot contain line breaks or control characters');
      const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const r = spawnSync('security', ['-i'], {
        input: `add-generic-password -U -a ${KEYCHAIN_ACCOUNT} -s ${q(service)} -w ${q(value)}\n`,
        encoding: 'utf8',
      });
      if (r.status !== 0 || /error/i.test(r.stderr || ''))
        throw new Error(`could not store "${service}" in the Keychain`);
    },
  };
}

function libsecretBackend() {
  return {
    get(service) {
      const r = spawnSync('secret-tool', ['lookup', 'service', 'zaafpulse', 'key', service], {
        encoding: 'utf8',
        timeout: 5000,
      });
      return r.status === 0 ? r.stdout.replace(/\n$/, '') || null : null;
    },
    set(service, value) {
      const r = spawnSync(
        'secret-tool',
        ['store', `--label=ZAAFPulse ${service}`, 'service', 'zaafpulse', 'key', service],
        { input: value, encoding: 'utf8', timeout: 15000 },
      );
      if (r.status !== 0)
        throw new Error(
          `could not store "${service}" in the system keyring (${(r.stderr || '').trim() || `exit ${r.status}`})`,
        );
    },
  };
}

// DPAPI (Windows): seal or open bytes for the current Windows user through PowerShell, input on stdin.
function dpapi(op, b64) {
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: b64,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (r.status !== 0 || !r.stdout.trim())
    throw new Error(`Windows DPAPI ${op} failed: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`);
  return r.stdout.trim();
}

function fileBackend({
  dir,
  env = process.env,
  platform = process.platform,
  seal = (b64) => dpapi('Protect', b64),
  unseal = (b64) => dpapi('Unprotect', b64),
}) {
  const file = path.join(dir, 'secrets.json');
  const keyFile = path.join(dir, 'secret.key');
  let key = null;
  function masterKey() {
    if (key) return key;
    const fromEnv =
      env.ZAAFPULSE_MASTER_KEY ||
      (env.ZAAFPULSE_MASTER_KEY_FILE ? fs.readFileSync(env.ZAAFPULSE_MASTER_KEY_FILE, 'utf8').trim() : '');
    if (fromEnv) {
      if (fromEnv.length < 16) throw new Error('ZAAFPULSE_MASTER_KEY must be at least 16 characters');
      return (key = crypto.createHash('sha256').update(fromEnv).digest());
    }
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(keyFile)) {
      const t = fs.readFileSync(keyFile, 'utf8').trim();
      key = Buffer.from(t.startsWith('dpapi:') ? unseal(t.slice(6)) : t, 'base64');
    } else {
      key = crypto.randomBytes(32);
      const b64 = key.toString('base64');
      fs.writeFileSync(keyFile, platform === 'win32' ? `dpapi:${seal(b64)}\n` : `${b64}\n`, { mode: 0o600 });
    }
    if (key.length !== 32) throw new Error(`${keyFile} is not a valid key`);
    return key;
  }
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { v: 1, items: {} };
    }
  };
  return {
    get(service) {
      const item = read().items[service];
      if (!item) return null;
      const [iv, tag, data] = item.split('.').map((x) => Buffer.from(x, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), iv);
      d.setAuthTag(tag);
      d.setAAD(Buffer.from(service));
      try {
        return Buffer.concat([d.update(data), d.final()]).toString('utf8');
      } catch {
        throw new Error(`secret "${service}" cannot be decrypted (was the master key changed?)`);
      }
    },
    set(service, value) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
      c.setAAD(Buffer.from(service));
      const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
      const all = read();
      all.items[service] = [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

function createSecretStore({ backend, dir, env = process.env, platform = process.platform, exec } = {}) {
  const id = backend || pickBackend(env, platform);
  const impl =
    id === 'keychain'
      ? keychainBackend({ exec })
      : id === 'libsecret'
        ? libsecretBackend()
        : fileBackend({ dir: dir || path.join(require('./platform').dataDir(env), '.data'), env, platform });
  return { id, label: LABELS[id], ...impl };
}

let shared = null;
const defaultStore = () => (shared ||= createSecretStore());

module.exports = { createSecretStore, defaultStore, pickBackend, LABELS };
