'use strict';
/* Settings → Users (#settings/users, AI Governance 4): the people who sign in to this dashboard with their own name and
   password, from GET /api/users; add, change the role, disable or enable, reset the password and delete with POST
   /api/users. The owner's page: a reviewer or a viewer never sees it (the server refuses them anyway). Also the
   role banner and the identity line the page chrome shows for whoever is signed in.
   Events are delegated (the CSP allows no inline handler); pure helpers are exported for Node tests, and nothing here
   touches the DOM at load time. Every server or owner string reaches the markup through esc(). */

const USR_ROLES = [
  ['viewer', 'Viewer'],
  ['reviewer', 'Reviewer'],
];
const USR_ROLE_WORDS = { owner: 'Owner', reviewer: 'Reviewer', viewer: 'Viewer' };
const USR = { hooked: false, data: null, reset: null };

/* ---------- pure helpers (exported) ---------- */

/** A role in words: Owner, Reviewer, Viewer (anything else as it is). */
const usrRoleLabel = (role) => USR_ROLE_WORDS[role] || String(role ?? '');
/** A failed api() call as one line: its body's first error text, else the message as it is. */
function usrErrorText(err) {
  const msg = String((err && err.message) || err || '');
  try {
    const body = JSON.parse(msg.replace(/^\d{3}\s+/, ''));
    const first = Array.isArray(body.errors) ? body.errors[0] : body.error;
    if (first) return String(first);
  } catch {
    /* not JSON: show it as it came */
  }
  return msg;
}
/** "2026-11-04 09:05" in this browser's time zone, or "never". */
function usrWhen(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'never';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The one-line banner for a reviewer or a viewer; '' for the owner (or nobody signed in). */
function usrBannerText(me) {
  if (!me || !me.role || me.role === 'owner') return '';
  const what = me.role === 'reviewer' ? 'reviews and approvals' : 'read-only';
  return `Signed in as ${me.display || me.user} · ${usrRoleLabel(me.role)} · ${what}`;
}
/** The identity line in the top bar: "Vera · Viewer". */
const usrWhoText = (me) => (me && me.role ? `${me.display || me.user} · ${usrRoleLabel(me.role)}` : '');
/** The top bar's identity block: shown only with sign-in on and someone signed in; the owner's password is set with the
 * CLI, so only an account gets the Change password link. */
const usrWhoBar = (me, authOn) =>
  authOn && me && me.signedIn && me.role
    ? { show: true, text: usrWhoText(me), password: me.role !== 'owner' }
    : { show: false, text: '', password: false };
/** An account's state in words. */
const usrStateTag = (u) =>
  u.disabled
    ? `<span class="tag warn">${esc('Disabled')}</span>`
    : u.mustChange
      ? `<span class="tag warn">${esc('New password due')}</span>`
      : `<span class="tag">${esc('Active')}</span>`;
/** The accounts' rows, each with its role select and actions. */
function usrRowsHtml(users) {
  if (!users.length)
    return `<tr><td colspan="6" class="muted">${esc('No accounts yet: only the owner signs in.')}</td></tr>`;
  return users
    .map((u) => {
      const roles = USR_ROLES.map(
        ([v, label]) => `<option value="${esc(v)}"${v === u.role ? ' selected' : ''}>${esc(label)}</option>`,
      ).join('');
      return `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.display || '—')}</td><td><select class="input" data-usr-role="${esc(u.name)}" aria-label="${esc(`Role of ${u.name}`)}">${roles}</select></td><td class="mono">${esc(usrWhen(u.lastLoginAt))}</td><td>${usrStateTag(u)}</td><td class="usr-actions"><button class="btn ghost" type="button" data-usr-toggle="${esc(u.name)}">${esc(u.disabled ? 'Enable' : 'Disable')}</button><button class="btn ghost" type="button" data-usr-reset="${esc(u.name)}">${esc('Reset password')}</button><button class="btn ghost" type="button" data-usr-delete="${esc(u.name)}">${esc('Delete')}</button></td></tr>`;
    })
    .join('');
}
/** The form that adds an account. */
function usrAddFormHtml() {
  const roles = USR_ROLES.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  return `<form id="usr-add" class="gov-bar" autocomplete="off">
    <label>${esc('Name')}<input class="input" name="name" required maxlength="32" placeholder="ana.k"></label>
    <label>${esc('Display name')}<input class="input" name="display" maxlength="60" placeholder="Ana K."></label>
    <label>${esc('Role')}<select class="input" name="role">${roles}</select></label>
    <label>${esc('First password')}<input class="input" name="password" type="password" required minlength="12" autocomplete="new-password"></label>
    <button class="btn" type="submit">${esc('Add')}</button>
    <p class="muted gov-note">${esc('Names: 2 to 32 lowercase letters, digits, dots, dashes or underscores. Passwords: at least 12 characters; the person chooses a new one at the first sign-in.')}</p>
  </form>`;
}
/** The form that sets a new password for one account. */
function usrResetFormHtml(name) {
  return `<form id="usr-reset" class="gov-bar" data-usr-name="${esc(name)}" autocomplete="off">
    <label>${esc(`New password for ${name}`)}<input class="input" name="password" type="password" required minlength="12" autocomplete="new-password"></label>
    <button class="btn" type="submit">${esc('Set password')}</button><button class="btn ghost" type="button" data-usr-cancel>${esc('Cancel')}</button>
    <p class="muted gov-note">${esc('Their sessions end now, and they choose a new password at the next sign-in.')}</p>
  </form>`;
}
/** The page's body for GET /api/users: off without sign-in, a warning when the file cannot be read, else the table. */
function usrBodyHtml(d) {
  if (!d || d.state === 'off')
    return `<div class="empty">${esc('Sign-in is off (ZAAFPULSE_AUTH=none), so there are no accounts: everyone who reaches this dashboard is the owner. Turn sign-in on to add people.')}</div>`;
  const banner =
    d.state === 'unreadable'
      ? `<div class="gov-banner">${esc('users.json could not be read: nobody in it can sign in until it is fixed or moved, and nothing is written over it. The owner still signs in.')}</div>`
      : '';
  return `${banner}<div class="table-wrap"><table class="holo-table"><thead><tr><th>${esc('Name')}</th><th>${esc('Display name')}</th><th>${esc('Role')}</th><th>${esc('Last sign-in')}</th><th>${esc('State')}</th><th></th></tr></thead><tbody>${usrRowsHtml(d.users || [])}</tbody></table></div>${d.state === 'ok' ? usrAddFormHtml() : ''}`;
}

/* ---------- the page ---------- */

/** Settings → Users. */
function usrView() {
  return `<div class="holo-deck">${subTabs('settings')}${subHero('SETTINGS · USERS', 'Users', esc('People who sign in to this dashboard with their own name and password. Reviewers also save inventory reviews and approve agent runs; viewers only read, and never see transcripts, dataset examples or secrets. You, the owner, sign in with the admin password, which is changed with zaafpulse set-password on the server.'))}<div id="usr-app">
    <section class="holo panel"><div class="panel-head"><h3>${esc('Accounts')}</h3><span class="meta">${esc('.data/users.json')}</span></div><div id="usr-msg" role="alert"></div><div id="usr-body"><div class="skeleton" style="height:120px"></div></div><div id="usr-reset-host"></div></section>
  </div></div>`;
}
async function usrLoad() {
  const el = $('#usr-body');
  if (!el) return;
  try {
    USR.data = await api('/api/users');
    el.innerHTML = usrBodyHtml(USR.data);
  } catch (e) {
    el.innerHTML = `<div class="gov-banner">${esc(`Could not read the accounts: ${usrErrorText(e)}`)}</div>`;
  }
}
async function usrPost(body, done) {
  const msg = $('#usr-msg');
  if (msg) msg.textContent = '';
  try {
    await api('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (msg) msg.textContent = `Not saved: ${usrErrorText(err)}`;
    return usrLoad(); // a select that changed shows the saved value again
  }
  if (done) done();
  usrLoad();
}
function usrMount(el) {
  el.innerHTML = usrView();
  usrInstallEvents();
  usrLoad();
}
function usrInstallEvents() {
  if (USR.hooked) return;
  USR.hooked = true;
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form || !form.closest || !form.closest('#usr-app')) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.id === 'usr-add')
      usrPost(
        {
          action: 'create',
          name: String(data.get('name') || '')
            .trim()
            .toLowerCase(),
          display: String(data.get('display') || '').trim(),
          role: String(data.get('role') || 'viewer'),
          password: String(data.get('password') || ''),
        },
        () => form.reset(),
      );
    else if (form.id === 'usr-reset')
      usrPost({ action: 'reset', name: form.dataset.usrName, password: String(data.get('password') || '') }, () => {
        const host = $('#usr-reset-host');
        if (host) host.replaceChildren();
      });
    // The body is built; no password stays in the page, whether or not the save succeeds.
    for (const i of form.querySelectorAll('input[type="password"]')) i.value = '';
  });
  document.addEventListener('change', (e) => {
    const sel = e.target && e.target.closest && e.target.closest('#usr-app [data-usr-role]');
    if (sel) usrPost({ action: 'update', name: sel.getAttribute('data-usr-role'), role: sel.value });
  });
  document.addEventListener('click', (e) => {
    const t =
      e.target.closest &&
      e.target.closest(
        '#usr-app [data-usr-toggle], #usr-app [data-usr-reset], #usr-app [data-usr-delete], #usr-app [data-usr-cancel]',
      );
    if (!t) return;
    const host = $('#usr-reset-host');
    if (t.hasAttribute('data-usr-cancel')) return void (host && host.replaceChildren());
    if (t.hasAttribute('data-usr-reset')) {
      if (host) host.innerHTML = usrResetFormHtml(t.getAttribute('data-usr-reset'));
      const input = host && host.querySelector('input[name="password"]');
      if (input) input.focus();
      return;
    }
    const name = t.getAttribute('data-usr-toggle') || t.getAttribute('data-usr-delete');
    const user = ((USR.data && USR.data.users) || []).find((u) => u.name === name);
    if (!user) return;
    if (t.hasAttribute('data-usr-toggle')) return void usrPost({ action: 'update', name, disabled: !user.disabled });
    if (confirm(`Delete ${name}? Their sessions end now; the audit log keeps what they did.`))
      usrPost({ action: 'delete', name });
  });
}

if (typeof module !== 'undefined')
  module.exports = {
    USR,
    USR_ROLES,
    usrRoleLabel,
    usrErrorText,
    usrWhen,
    usrBannerText,
    usrWhoText,
    usrWhoBar,
    usrStateTag,
    usrRowsHtml,
    usrAddFormHtml,
    usrResetFormHtml,
    usrBodyHtml,
    usrView,
  };
