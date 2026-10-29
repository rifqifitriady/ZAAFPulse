// Cost Control 5: the weekly digest setting, config.json "cost.digest" ({ enabled }, off by default). Validated with
// the cost settings (lib/cost/rules.js), saved through POST /api/cost/settings, and edited in Settings → Cost's
// "Weekly digest" panel (public/costsettings.js), whose Save sends the saved settings with only `digest` replaced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const R = require('../lib/cost/rules');
const { createCostApi } = require('../lib/cost/api');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const V = require('../public/costview');
Object.assign(global, V);
const U = require('../public/costsettings');

const HOME = path.join(path.parse(process.cwd()).root, 'Users', 'owner');
const SOURCES = ['claude', 'codex', 'gateway', 'judge', 'replay', 'collab'];

test('rules: the digest is off by default, a boolean when set, and anything else names the field', () => {
  assert.deepEqual(R.defaults().digest, { enabled: false });
  assert.deepEqual(R.validate({}).value.digest, { enabled: false });
  assert.deepEqual(R.validate({ digest: { enabled: true } }).value.digest, { enabled: true });
  assert.deepEqual(R.validate({ digest: null }).value.digest, { enabled: false });
  for (const bad of [{ enabled: 'yes' }, {}, { enabled: true, day: 'monday' }, [], 'on'])
    assert.deepEqual(R.validate({ digest: bad }).errors, ['digest: { "enabled": true or false }'], JSON.stringify(bad));
  const s = R.settingsOf({ digest: { enabled: 1 } });
  assert.equal(s.error, R.SETTINGS_INVALID, 'a bad digest makes the section invalid, as any field does');
  assert.deepEqual(s.value.digest, { enabled: false });
});

test('api: the settings answer carries the digest and a Save stores it normalized', async () => {
  let saved = { centers: [{ id: 'acme', name: 'Acme' }] };
  const api = createCostApi({
    cost: { retag: () => {} },
    settings: { get: () => saved, save: (v) => (saved = v) },
    home: HOME,
  });
  const call = async (method, body) => {
    const r = await api.route({
      method,
      path: '/api/cost/settings',
      query: new URLSearchParams(),
      contentType: 'application/json',
      readBody: async () => JSON.stringify(body),
    });
    return r;
  };
  assert.deepEqual((await call('GET')).body.settings.digest, { enabled: false });
  const ok = await call('POST', { ...saved, digest: { enabled: true } });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved.digest, { enabled: true });
  assert.deepEqual((await call('GET')).body.settings.digest, { enabled: true });
  const bad = await call('POST', { ...saved, digest: { enabled: 'on' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.reasons, ['digest: { "enabled": true or false }']);
});

test('settings page: the Weekly digest panel, its Off and On, its Save body, and other Saves keep it', () => {
  assert.deepEqual(
    U.COST_SET_PANELS.map(([p]) => p),
    ['rules', 'billing', 'currency', 'digest', 'restate'],
  );
  assert.deepEqual(U.COST_SET_PANELS[3], ['digest', 'Weekly digest']);
  const saved = {
    centers: [],
    keyCenters: {},
    folderRules: [],
    billing: {},
    currency: null,
    digest: { enabled: true },
  };
  assert.deepEqual(U.costSetFromSaved('digest', saved, SOURCES), { digest: { enabled: true } });
  assert.deepEqual(U.costSetFromSaved('digest', {}, SOURCES), { digest: { enabled: false } });
  const body = U.costSetBody('digest', saved, { digest: { enabled: false } }, SOURCES);
  assert.deepEqual(body, { ...saved, digest: { enabled: false } });
  assert.deepEqual(
    U.costSetBody('rules', saved, U.costSetFromSaved('rules', saved, SOURCES), SOURCES).digest,
    { enabled: true },
    'a rules Save sends the saved digest',
  );
  assert.deepEqual(U.costSetBody('billing', {}, U.costSetFromSaved('billing', {}, SOURCES), SOURCES).digest, {
    enabled: false,
  });
  assert.equal(U.costSetDirty('digest', saved, { digest: { enabled: false } }, SOURCES), true);
  assert.equal(U.costSetDirty('digest', saved, { digest: { enabled: true } }, SOURCES), false);
  const st = { answer: { settings: saved, sources: SOURCES }, drafts: {} };
  const html = U.costSetDigestHtml(st);
  assert.match(html, /data-cost-set-act="digest-on" data-on="off" aria-pressed="false">Off</);
  assert.match(html, /data-cost-set-act="digest-on" data-on="on" aria-pressed="true">On</);
  assert.match(html, /no project folders and no text/);
  assert.match(html, /href="#settings\/monitors"/);
  assert.match(
    U.costSetDigestHtml({ ...st, drafts: { digest: { digest: { enabled: false } } } }),
    /data-on="off" aria-pressed="true"/,
  );
});
