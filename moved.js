// AlleGrow moved from sergcast07.github.io/practice-timer/ to allegrowmusic.com (September 2026).
// Loaded first on every page, before anything else runs.
//
// On the OLD address it forwards each page to the same page at the new one. The family app's data lives in this
// browser under the old address, so it travels along inside the link (#import=…) – the part after # never reaches
// any server. An app installed on a home screen from the old address keeps working instead, and explains how to move
// (its storage is separate from the browser's, so a link can't carry the data into a newly installed app).
//
// On the NEW address it takes in what the old one sent, before the family app reads its storage.
(function () {
  const NEW = 'https://allegrowmusic.com/';
  const KEYS = /^(pt-|sens$|grace$|musicOnly$)/;
  const b64enc = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64dec = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

  if (/(^|\.)github\.io$/.test(location.hostname)) {
    const page = location.pathname.replace(/^\/practice-timer\/?/, '');
    const MAP = { '': 'app', 'index.html': 'app', 'app.html': 'app', 'teacher.html': 'studio', 'studio.html': 'studio',
                  'landing.html': '', 'privacy.html': 'privacy', 'terms.html': 'terms' };
    const to = page in MAP ? MAP[page] : page, family = to === 'app';
    if (family && (matchMedia('(display-mode: standalone)').matches || navigator.standalone)) {
      if (page !== 'app.html') location.replace('app.html' + location.search + location.hash);   // its start page is now the about page
      window.ALLEGROW_OLD_HOME = true; return;
    }
    let hash = location.hash.replace(/^#/, '');
    if (family) {
      let synced = false; try { synced = !!JSON.parse(localStorage.getItem('pt-family')); } catch {}
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        // A synced family's history is already in the cloud; only bring what's on this device alone
        if (KEYS.test(k) && !(synced && /^pt-(log|stats|manual)$/.test(k))) data[k] = localStorage.getItem(k);
      }
      if (Object.keys(data).length) hash = 'import=' + b64enc(JSON.stringify(data)) + (hash ? '&' + hash : '');
    }
    document.documentElement.style.visibility = 'hidden';
    location.replace(NEW + to + location.search.replace(/^\?export$/, '') + (hash ? '#' + hash : ''));
    return;
  }

  const m = location.hash.match(/import=([A-Za-z0-9_-]+)/);
  if (!m) return;
  try {
    const data = JSON.parse(b64dec(m[1]));
    let mine = []; try { mine = JSON.parse(localStorage.getItem('pt-kids')) || []; } catch {}
    if (!mine.length || confirm('Replace the players and practice history on this device with the ones from the old AlleGrow address?')) {
      for (const [k, v] of Object.entries(data)) if (KEYS.test(k) && typeof v === 'string') localStorage.setItem(k, v);
      localStorage.setItem('pt-moved-in', JSON.stringify(new Date().toISOString()));
    }
  } catch (e) { console.error('AlleGrow: couldn’t bring data over', e); }
  const rest = location.hash.replace(/^#/, '').replace(/(^|&)import=[A-Za-z0-9_-]+/, '').replace(/^&/, '');
  history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
})();
