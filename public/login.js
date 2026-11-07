'use strict';
// Sign-in page (kept out of the HTML so the page can run under a strict CSP). Password mode: a name and a password (no
// name is the admin password). Local mode: the owner opens the dashboard with `zaafpulse open`; accounts sign in here
// with their name. An account whose password must change (a new one, or one the owner reset) chooses a new one here
// before anything else, and any account can come back here (?change=1) to change its own.
const $id = (id) => document.getElementById(id);
const form = $id('f');
let step = 'signin';

// The change-password step: the current password, a new one twice. Static text only; nothing from the server.
function showChange(forced) {
  step = 'change';
  $id('fields').innerHTML =
    '<label for="cur">Current password</label>' +
    '<input id="cur" type="password" autocomplete="current-password" required>' +
    '<label for="nx" style="margin-top:12px">New password</label>' +
    '<input id="nx" type="password" autocomplete="new-password" minlength="12" required>' +
    '<label for="nx2" style="margin-top:12px">New password again</label>' +
    '<input id="nx2" type="password" autocomplete="new-password" minlength="12" required>';
  $id('go').textContent = 'Change password';
  $id('note').textContent = forced
    ? 'Choose your own password before you go on: at least 12 characters.'
    : 'At least 12 characters. Your other sessions end; this one goes on.';
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'link';
  out.id = 'co';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(
      () => {},
    );
    location.replace('/login.html');
  });
  $id('note').after(out);
  $id('cur').focus();
}

fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    const change = new URLSearchParams(location.search).has('change');
    if (!s.required) return location.replace('/');
    if (s.signedIn && s.mustChange) return showChange(true);
    if (s.signedIn && change && s.role !== 'owner') return showChange(false);
    if (s.signedIn) return location.replace('/');
    // Local mode: the owner opens the dashboard with `zaafpulse open`; accounts, if any, sign in here.
    if (s.mode === 'local') {
      const expired = new URLSearchParams(location.search).has('expired');
      const expiredNote = expired ? ' The sign-in link expired or was already used.' : '';
      if (!s.accounts) {
        form.innerHTML =
          '<p class="note" style="font-size:14px;color:#e6ebff">This dashboard only opens for the account that runs ZAAFPulse.</p>' +
          `<p class="note">Run <code>zaafpulse open</code> in a terminal on this machine.${expiredNote}</p>`;
        return;
      }
      $id('nm').placeholder = 'Your account name';
      $id('nm').required = true;
      $id('note').innerHTML =
        `The owner opens this dashboard with <code>zaafpulse open</code> in a terminal on this machine.${expiredNote} ` +
        'Others sign in here with the name and password the owner gave them.';
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = $id('go');
  const err = $id('err');
  go.disabled = true;
  err.textContent = '';
  let mismatch = false;
  try {
    if (step === 'change') {
      if ($id('nx').value !== $id('nx2').value) {
        err.textContent = 'The new passwords do not match.';
        mismatch = true;
      } else {
        const r = await fetch('/api/account/password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ current: $id('cur').value, next: $id('nx').value }),
        });
        if (r.ok) return location.replace('/');
        err.textContent = (await r.json().catch(() => ({}))).error || `Not changed (${r.status})`;
      }
    } else {
      const name = $id('nm').value.trim();
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(name ? { name } : {}), password: $id('pw').value }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.mustChange) showChange(true);
      else if (r.ok) return location.replace('/');
      else err.textContent = body.error || `Sign-in failed (${r.status})`;
    }
  } catch {
    err.textContent = 'The server did not answer.';
  }
  // A password never stays in the page after it was sent.
  // (After a mismatch only the new-password fields are cleared; the name is never cleared.)
  for (const i of form.querySelectorAll('input[type="password"]')) if (!(mismatch && i.id === 'cur')) i.value = '';
  go.disabled = false;
});
