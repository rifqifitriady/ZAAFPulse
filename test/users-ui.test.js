// Dashboard users and roles (AI Governance 4) in the browser files, without a browser: Settings → Users
// (public/usersview.js), the role banner and the identity line, the review drawer for reviewers with the accounts'
// names suggested (public/governanceview.js), the 403 messages and the hidden owner controls (public/app.js), the
// sign-in page's name field and change-password step (public/login.html, public/login.js); and an audit of
// usersview.js for server or owner text put into markup without esc() (S1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

global.esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
global.subHero = (eyebrow, title, sub) => `<div class="hero">${eyebrow}|${title}|${sub}</div>`;
global.subTabs = (route) => `<nav class="subtabs">${route}</nav>`;
const U = require('../public/usersview');
const G = require('../public/governanceview');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

test('the banner and the identity line say who is signed in and what the role may do', () => {
  assert.equal(
    U.usrBannerText({ user: 'vera', role: 'viewer', display: 'Vera' }),
    'Signed in as Vera · Viewer · read-only',
  );
  assert.equal(
    U.usrBannerText({ user: 'rex', role: 'reviewer', display: '' }),
    'Signed in as rex · Reviewer · reviews and approvals',
  );
  assert.equal(U.usrBannerText({ user: 'owner', role: 'owner', display: 'Rifqi' }), '');
  assert.equal(U.usrBannerText(null), '');
  assert.equal(U.usrWhoText({ user: 'vera', role: 'viewer', display: 'Vera' }), 'Vera · Viewer');
  assert.equal(U.usrWhoText({ user: 'owner', role: 'owner', display: 'Rifqi' }), 'Rifqi · Owner');
  assert.equal(U.usrRoleLabel('reviewer'), 'Reviewer');
  assert.equal(U.usrWhen(null), 'never');
  assert.match(U.usrWhen('2026-11-04T09:05:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(
    U.usrErrorText(new Error('400 {"error":"name: already taken","errors":["name: already taken"]}')),
    'name: already taken',
  );
});

test('Settings → Users: off without sign-in, a warning for an unreadable file, else the accounts and the add form', () => {
  assert.match(
    U.usrBodyHtml({ state: 'off', users: [] }),
    /Sign-in is off \(ZAAFPULSE_AUTH=none\), so there are no accounts/,
  );
  const bad = U.usrBodyHtml({ state: 'unreadable', users: [] });
  assert.match(bad, /<div class="gov-banner">users\.json could not be read: nobody in it can sign in/);
  assert.ok(!bad.includes('id="usr-add"'), 'nothing is added over an unreadable file');
  const users = [
    { name: 'rex', display: 'Rex', role: 'reviewer', lastLoginAt: null, disabled: false, mustChange: true },
    {
      name: 'vera',
      display: '',
      role: 'viewer',
      lastLoginAt: '2026-11-04T09:00:00Z',
      disabled: true,
      mustChange: false,
    },
  ];
  const html = U.usrBodyHtml({ state: 'ok', users });
  assert.match(html, /<th>Name<\/th><th>Display name<\/th><th>Role<\/th><th>Last sign-in<\/th><th>State<\/th>/);
  assert.match(
    html,
    /<select class="input" data-usr-role="rex" aria-label="Role of rex"><option value="viewer">Viewer<\/option><option value="reviewer" selected>Reviewer<\/option><\/select>/,
  );
  assert.match(html, /<span class="tag warn">New password due<\/span>/);
  assert.match(html, /<span class="tag warn">Disabled<\/span>/);
  assert.match(html, /data-usr-toggle="vera">Enable<\/button>/);
  assert.match(html, /data-usr-toggle="rex">Disable<\/button>/);
  assert.match(
    html,
    /data-usr-reset="rex">Reset password<\/button><button class="btn ghost" type="button" data-usr-delete="rex">Delete<\/button>/,
  );
  assert.match(html, /<form id="usr-add"/);
  assert.match(html, /name="password" type="password" required minlength="12" autocomplete="new-password"/);
  assert.match(U.usrBodyHtml({ state: 'ok', users: [] }), /No accounts yet: only the owner signs in\./);
  assert.match(U.usrResetFormHtml('rex'), /<form id="usr-reset" class="gov-bar" data-usr-name="rex"/);
  assert.match(
    U.usrView(),
    /SETTINGS · USERS\|Users\|People who sign in to this dashboard with their own name and password\./,
  );
  assert.match(U.usrView(), /<nav class="subtabs">settings<\/nav>/);
});

test('the Inventory review: the button and the drawer for the owner and reviewers only; the owner field suggests names', () => {
  assert.deepEqual(
    [null, 'owner', 'reviewer', 'viewer'].map((r) => G.govCanReview(r)),
    [true, true, true, false],
  );
  const item = {
    id: 'app:claude',
    kind: 'app',
    name: 'Claude Code',
    where: ['running'],
    state: 'running',
    status: 'unreviewed',
  };
  assert.match(G.govInvRowsHtml([item]), /data-gov-review="app:claude">Review<\/button>/);
  assert.ok(!G.govInvRowsHtml([item], false).includes('data-gov-review'), 'a viewer gets no Review button');
  const form = G.govReviewFormHtml(item, ['Rifqi', 'Ana <x>']);
  assert.match(form, /name="owner" maxlength="200" value="" autocomplete="off" list="gov-owner-names">/);
  assert.match(
    form,
    /<datalist id="gov-owner-names"><option value="Rifqi"><\/option><option value="Ana &lt;x&gt;"><\/option><\/datalist>/,
  );
  assert.match(G.govReviewFormHtml(item), /<datalist id="gov-owner-names"><\/datalist>/);
});

test('wiring: the script, the Users sub-link, the top bar, the banner, the 403 messages and the hidden owner controls', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('usersview.js') > html.indexOf('governanceview.js'));
  assert.ok(html.indexOf('usersview.js') < html.indexOf('src="app.js"'));
  assert.match(html, /<a class="nav-sub" href="#settings\/users" data-route="settings\/users">Users<\/a>/);
  assert.match(html, /<div class="nav-label" id="nav-prefs">PREFERENCES<\/div>/);
  assert.match(
    html,
    /<div class="topbar-who" id="topbar-who" hidden><span id="who-text"><\/span> <a class="link-btn" id="who-password" href="\/login\.html\?change=1">Change password<\/a> <button class="link-btn" type="button" id="who-out">Sign out<\/button><\/div>/,
  );
  assert.match(
    html,
    /<div class="role-banner" id="role-banner" role="status" hidden><\/div>\s*<div class="content" id="view"/,
  );
  assert.match(read('iso.js'), /settings: \[\s*\['', 'Preferences'\],\s*\['users', 'Users'\],\s*\]/);
  const app = read('app.js');
  assert.match(app, /if \(error === 'change your password first'\) \{\s*location\.href = '\/login\.html';/);
  assert.match(app, /if \(error === 'your role cannot do this'\) throw new Error\('Your role cannot do this'\);/);
  assert.match(app, /return state\.sub === 'users' \? usrMount\(el\) : viewSettings\(el\);/);
  assert.match(app, /holoEmpty\('Settings and Users are for the owner of this dashboard\.'\)/);
  assert.match(
    app,
    /for \(const el of \$\$\('nav a\[data-route\^="settings"\], #nav-prefs, #rescan'\)\) el\.hidden = true;/,
  );
  assert.match(app, /banner\.textContent = usrBannerText\(ZP\.me\);/);
  assert.ok(read('styles.css').includes('.role-banner'));
});

test('the sign-in page: a name field, the change-password step, and the routes it calls', () => {
  const html = read('login.html');
  assert.match(
    html,
    /<label for="nm">Name<\/label>\s*<input id="nm" name="name" autocomplete="username"[^>]*placeholder="Empty for the admin password"/,
  );
  assert.match(html, /<label for="pw" style="margin-top:12px">Password<\/label>/);
  assert.ok(!html.includes('Admin password<'));
  const js = read('login.js');
  assert.match(js, /body: JSON\.stringify\(\{ \.\.\.\(name \? \{ name \} : \{\}\), password: \$id\('pw'\)\.value \}\)/);
  assert.match(js, /fetch\('\/api\/account\/password'/);
  assert.match(js, /'Choose your own password before you go on: at least 12 characters\.'/);
  assert.match(js, /if \(s\.signedIn && s\.mustChange\) return showChange\(true\);/);
  assert.match(js, /Others sign in here with the name and password the owner gave them\./);
  assert.match(js, /The new passwords do not match\./);
});

test('usersview.js puts no server or owner text into markup unescaped (S1) and loads in Node', () => {
  const x = '<x>';
  const users = [{ name: x, display: x, role: x, lastLoginAt: x, disabled: false, mustChange: false }];
  const html = [U.usrBodyHtml({ state: 'ok', users }), U.usrResetFormHtml(x), U.usrRowsHtml(users)].join('');
  assert.ok(!html.includes('<x>'), 'a field reached the markup unescaped');
  const src = read('usersview.js');
  for (const m of src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g))
    assert.match(m[1].trim(), /^(usr[A-Z]\w*Html\(|usrView\(|`)/, `innerHTML from ${m[1].trim().slice(0, 40)}`);
  for (const m of src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm))
    assert.match(m[1], /^(usr|USR)/, m[1]);
  assert.equal(typeof document, 'undefined', 'loaded above with no DOM at all');
});

test('hidden is not defeated by author CSS, and the identity block shows only where it should', () => {
  const css = read('styles.css');
  assert.match(css, /\.topbar-who\[hidden\],\s*nav a\[hidden\],\s*\.icon-btn\[hidden\]\s*\{\s*display: none;\s*\}/);
  const me = (role) => ({ signedIn: true, user: 'u', role, display: 'U' });
  assert.deepEqual(U.usrWhoBar(me('owner'), true), { show: true, text: 'U · Owner', password: false }); // local or password mode
  assert.deepEqual(U.usrWhoBar(me('viewer'), true), { show: true, text: 'U · Viewer', password: true });
  assert.equal(U.usrWhoBar(me('owner'), false).show, false, 'none mode: no identity, no Sign out');
  assert.equal(U.usrWhoBar(null, true).show, false);
  assert.equal(U.usrWhoBar({ signedIn: false }, true).show, false);
  assert.match(read('app.js'), /<div class="holo-deck">\$\{subTabs\('settings'\)\}<div class="hero">/);
  const js = read('login.js');
  assert.match(js, /out\.textContent = 'Sign out'/);
  assert.match(js, /mismatch && i\.id === 'cur'/);
});
