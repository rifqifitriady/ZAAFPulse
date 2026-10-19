'use strict';
// Sign-in page for server mode (kept out of the HTML so the page can run under a strict CSP).
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    if (!s.required || s.signedIn) return location.replace('/');
    // Local mode has no password: the owner opens the dashboard with `zaafpulse open`.
    if (s.mode === 'local') {
      const expired = new URLSearchParams(location.search).has('expired');
      document.getElementById('f').innerHTML =
        '<p class="note" style="font-size:14px;color:#e6ebff">This dashboard only opens for the account that runs ZAAFPulse.</p>' +
        '<p class="note">Run <code>zaafpulse open</code> in a terminal on this machine.' +
        (expired ? ' The sign-in link expired or was already used.' : '') +
        '</p>';
    }
  })
  .catch(() => {});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go');
  const err = document.getElementById('err');
  go.disabled = true;
  err.textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }),
    });
    if (r.ok) return location.replace('/');
    err.textContent = (await r.json().catch(() => ({}))).error || `Sign-in failed (${r.status})`;
  } catch {
    err.textContent = 'The server did not answer.';
  }
  go.disabled = false;
});
