// Allegrow – sign-in options, shared by the family app (index.html) and the studio (teacher.html).
// Only Firebase's free methods: Google, Microsoft, Yahoo and email + password.
// (Phone codes need the paid plan; email sign-in links are capped at 5 a day; Apple needs a paid developer account.)
//
// Microsoft and Yahoo each need a one-time app registration before they work; flip them on here once that's done.
const SIGNIN_PROVIDERS = { google: true, microsoft: false, yahoo: false, email: true };

const SIGNIN_LOGOS = {
  google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.4-.4-3.5z"/></svg>',
  microsoft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F25022" d="M2 2h9.5v9.5H2z"/><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z"/><path fill="#00A4EF" d="M2 12.5h9.5V22H2z"/><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z"/></svg>',
  yahoo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="#6001D2"/><path fill="#fff" d="M5 7.5h3l2.2 5.4 2.3-5.4h2.9l-4.2 9.3V20H8.4v-3.2zM16.2 7h3.1l-2.4 6h-2.4zM15 14.2h2.3V16H15z"/></svg>'
};
const SIGNIN_NAMES = { google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo' };

function signinCss() {
  if (document.getElementById('signinCss')) return;
  const st = document.createElement('style'); st.id = 'signinCss';
  st.textContent = `
  .si { display: grid; gap: 10px; text-align: left; }
  .si .siBtn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 12px 16px; border-radius: 14px;
    background: var(--card); color: var(--ink); border: 1.5px solid var(--line); font: inherit; font-weight: 600; font-size: 15.5px; cursor: pointer; }
  .si .siBtn:hover { border-color: var(--muted); }
  .si .siBtn svg { width: 20px; height: 20px; flex: none; }
  .si .siOr { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; margin: 4px 0; }
  .si .siOr::before, .si .siOr::after { content: ''; flex: 1; height: 1px; background: var(--line); }
  .si input { width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; padding: 12px 14px; border-radius: 12px; border: 1.5px solid var(--line);
    background: var(--soft, var(--card)); color: var(--ink); }
  .si .siMain { width: 100%; padding: 13px 16px; border-radius: 14px; border: 0; background: var(--ink); color: var(--card); font: inherit; font-weight: 700; font-size: 15.5px; cursor: pointer; }
  .si .siLinks { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 13.5px; }
  .si .siLinks button { background: none; border: 0; padding: 4px 0; color: var(--accent); font: inherit; font-weight: 600; cursor: pointer; }
  .si .siMsg { font-size: 13.5px; min-height: 1.2em; color: var(--danger); }
  .si .siMsg.ok { color: var(--good, var(--ink)); }
  .siOverlay { position: fixed; inset: 0; z-index: 50; background: rgba(20, 23, 31, .5); display: flex; align-items: flex-start; justify-content: center; padding: 20px 16px; overflow-y: auto; }
  .siOverlay .siCard { background: var(--card); color: var(--ink); border-radius: 22px; padding: 22px 20px 18px; width: 100%; max-width: 400px; margin: auto 0; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
  .siOverlay h2 { margin: 0 0 4px; font-size: 21px; } .siOverlay .siIntro { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
  .siOverlay .siClose { margin-top: 8px; width: 100%; background: none; border: 0; color: var(--muted); font: inherit; font-weight: 600; padding: 8px; cursor: pointer; }`;
  document.head.append(st);
}

const SIGNIN_ERRORS = {
  'auth/invalid-credential': 'That email or password isn’t right.', 'auth/wrong-password': 'That email or password isn’t right.',
  'auth/user-not-found': 'That email or password isn’t right.', 'auth/invalid-email': 'Please check the email address.',
  'auth/email-already-in-use': 'There’s already an account with this email – sign in instead.',
  'auth/weak-password': 'Use at least 8 characters for the password.',
  'auth/account-exists-with-different-credential': 'This email already signs in another way (for example with Google). Please use that.',
  'auth/operation-not-allowed': 'That sign-in option isn’t switched on yet.', 'auth/too-many-requests': 'Too many tries. Please wait a few minutes.',
  'auth/network-request-failed': 'Couldn’t connect. Check the internet connection.'
};
const signinError = e => SIGNIN_ERRORS[e?.code] || 'Sign-in didn’t work. Please try again.';

// Draws the options into `box`. onDone(user) runs after a successful sign-in.
// verify: send new email accounts (and any unverified address) a verification link – needed before we email them.
function renderSignIn(box, { A, auth, onDone, verify = false }) {
  signinCss();
  let mode = 'choose';                      // choose | email | create | reset
  const draw = (msg = '', ok = false) => {
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const email = box.querySelector('#siEmail')?.value || '';
    box.innerHTML = `<div class="si">${mode === 'choose' ? `
      ${['google', 'microsoft', 'yahoo'].filter(p => SIGNIN_PROVIDERS[p]).map(p => `<button type="button" class="siBtn" data-si="${p}">${SIGNIN_LOGOS[p]}Continue with ${SIGNIN_NAMES[p]}</button>`).join('')}
      ${SIGNIN_PROVIDERS.email ? `<div class="siOr">or</div><button type="button" class="siBtn" data-si-mode="email">Continue with email</button>` : ''}`
    : `<input type="email" id="siEmail" autocomplete="email" placeholder="Email address" value="${esc(email)}" aria-label="Email address">
      ${mode === 'reset' ? '' : `<input type="password" id="siPass" autocomplete="${mode === 'create' ? 'new-password' : 'current-password'}" placeholder="${mode === 'create' ? 'Choose a password (8+ characters)' : 'Password'}" aria-label="Password">`}
      <button type="button" class="siMain" id="siGo">${{ email: 'Sign in', create: 'Create account', reset: 'Email me a reset link' }[mode]}</button>
      <div class="siLinks">
        ${mode === 'email' ? '<button type="button" data-si-mode="create">New here? Create an account</button><button type="button" data-si-mode="reset">Forgot password?</button>'
          : '<button type="button" data-si-mode="email">I already have an account</button>'}
        <button type="button" data-si-mode="choose">Other ways to sign in</button></div>`}
      <div class="siMsg ${ok ? 'ok' : ''}" id="siMsg">${esc(msg)}</div></div>`;
    box.querySelectorAll('[data-si-mode]').forEach(b => b.onclick = () => { mode = b.dataset.siMode; draw(); box.querySelector('#siEmail')?.focus(); });
    box.querySelectorAll('[data-si]').forEach(b => b.onclick = () => oauth(b.dataset.si));
    const go = box.querySelector('#siGo'); if (go) go.onclick = submit;
    box.querySelectorAll('input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') submit(); });
  };
  const finish = async user => {
    if (verify && user && !user.emailVerified && user.email) { try { await A.sendEmailVerification(user); } catch (e) { console.error(e); } }
    onDone?.(user);
  };
  async function oauth(p) {
    const provider = p === 'google' ? new A.GoogleAuthProvider() : new A.OAuthProvider(p === 'microsoft' ? 'microsoft.com' : 'yahoo.com');
    if (p === 'google') provider.setCustomParameters({ prompt: 'select_account' });
    if (p === 'microsoft') provider.setCustomParameters({ prompt: 'select_account', tenant: 'common' });   // personal and school/work accounts
    if (p !== 'google') { provider.addScope('email'); provider.addScope('profile'); }
    try { await finish((await A.signInWithPopup(auth, provider)).user); }
    catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') return A.signInWithRedirect(auth, provider);
      console.error(e); draw(signinError(e));
    }
  }
  async function submit() {
    const email = box.querySelector('#siEmail').value.trim(), pass = box.querySelector('#siPass')?.value || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return draw('Please enter your email address.');
    try {
      if (mode === 'reset') { await A.sendPasswordResetEmail(auth, email); mode = 'email'; return draw(`If there’s an account for ${email}, a reset link is on its way. Check your inbox (and spam).`, true); }
      if (mode === 'create') {
        if (pass.length < 8) return draw('Use at least 8 characters for the password.');
        return finish((await A.createUserWithEmailAndPassword(auth, email, pass)).user);
      }
      if (!pass) return draw('Please enter your password.');
      finish((await A.signInWithEmailAndPassword(auth, email, pass)).user);
    } catch (e) { console.error(e); draw(signinError(e)); }
  }
  draw();
}

// A sign-in window over the page. Resolves with the signed-in user, or null if closed.
function signInDialog({ A, auth, title = 'Sign in', intro = '', verify = false }) {
  signinCss();
  return new Promise(resolve => {
    const ov = document.createElement('div'); ov.className = 'siOverlay';
    ov.innerHTML = `<div class="siCard" role="dialog" aria-modal="true"><h2>${title}</h2>${intro ? `<p class="siIntro">${intro}</p>` : ''}<div class="siBox"></div>
      <button type="button" class="siClose">Cancel</button></div>`;
    document.body.append(ov);
    const close = user => { ov.remove(); resolve(user || null); };
    ov.querySelector('.siClose').onclick = () => close(null);
    ov.onclick = e => { if (e.target === ov) close(null); };
    renderSignIn(ov.querySelector('.siBox'), { A, auth, verify, onDone: close });
  });
}
