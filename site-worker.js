// allegrowmusic.com – serves the website's files (see wrangler.toml), plus one job of its own:
// Firebase sign-in runs through our own address. Requests to /__/auth/… and /__/firebase/… are passed to the
// project's Firebase address, so Google's sign-in screen shows allegrowmusic.com instead of the Firebase one.
const FIREBASE_AUTH = 'https://music-practice-tracker-d77f7.firebaseapp.com';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__/auth/') || url.pathname.startsWith('/__/firebase/')) {
      const headers = new Headers(req.headers);
      headers.delete('host');                                        // Firebase picks the site by this, so it must be its own
      const init = { method: req.method, headers, redirect: 'manual' };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = req.body;
      return fetch(FIREBASE_AUTH + url.pathname + url.search, init);
    }
    return env.ASSETS.fetch(req);
  }
};
