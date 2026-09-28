// Allegrow service worker: lets the installed app open instantly and work without a connection.
//  • Pages: network first (so updates show up right away), falling back to the saved copy when offline.
//  • Our own files: served from the saved copy, refreshed in the background.
//  • Libraries, fonts and the sound model from their CDNs (versioned, never change): saved once, then reused.
//  • Database, sign-in and email-service requests are never touched – they always go to the network.
const VERSION = 'allegrow-v15';          // bump when the app's own files change
const CDN_CACHE = 'allegrow-cdn';       // versioned library files: kept across updates
const SHELL = ['./', './app', './studio', './moved.js?v=1', './badges.js?v=7', './signin.js?v=1', './manifest.webmanifest', './manifest-studio.webmanifest',
               './brand/allegrow-icon.svg', './brand/png/allegrow-icon-192.png', './brand/png/apple-touch-icon.png'];
const CDN = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com', 'cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CDN_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  const own = url.origin === self.location.origin;
  if (req.mode === 'navigate' && own) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./app'))));
    return;
  }
  if (own) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const fresh = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
    return;
  }
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.open(CDN_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
});
