// SPDX-License-Identifier: GPL-3.0-only
// No automatic app launches or network requests: installation must not loop.
const token = window.location.hash.slice(1);
const valid = token.length <= 2048 && /^[A-Za-z0-9_-]+\.[a-f0-9]{128}$/.test(token);
if (valid) {
  document.getElementById('heading').textContent = 'You’re invited.';
  document.getElementById('intro').textContent = 'Install and set up LinkUp, then return to this page to open your friend’s invitation.';
  document.getElementById('invitation').hidden = false;
  const appLink = `common://invite?token=${token}`;
  document.getElementById('open').href = appLink;
  document.getElementById('code').value = appLink;
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(appLink);
      document.getElementById('copy-status').textContent = 'Copied. Paste it in LinkUp → Friends → Add a friend.';
    } catch {
      const field = document.getElementById('code');
      field.focus(); field.select();
      document.getElementById('copy-status').textContent = 'Select and copy the invitation above, then paste it in LinkUp.';
    }
  });
} else if (token) {
  document.getElementById('error').hidden = false;
}
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.getElementById('availability').textContent = 'LinkUp is currently available for Android. iPhone support is still being built.';
  document.getElementById('download').hidden = true;
  document.getElementById('install-help').hidden = true;
}
