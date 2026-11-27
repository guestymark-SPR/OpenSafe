'use strict';
// Offline support: keep the app's own files cached. Item data lives in IndexedDB, not here.
const CACHE = 'opensafe-capture-v17';
// The room-scan engine is large (about 15 MB) and only fetched when first used. It lives in its own
// cache, kept across app updates, so it isn't downloaded again each time the app changes.
const ENGINE_CACHE = 'opensafe-detector-1.2.3';
// Files shared to Capture from other apps wait here until the app saves them (see app.js).
const SHARED = 'opensafe-shared';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== ENGINE_CACHE && k !== SHARED).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates arrive when online), cache as fallback (so it works offline).
// "Share" from another app (a PDF, photo or email): keep the files, then open the app to ask what to do.
async function receiveShare(req) {
  const id = 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    const fd = await req.formData();
    const files = fd.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0).slice(0, 30);
    const text = [fd.get('title'), fd.get('text'), fd.get('url')].filter(x => typeof x === 'string' && x.trim()).join('\n');
    if (!files.length && text) files.push(new File([text], 'Shared text.txt', { type: 'text/plain' }));
    const c = await caches.open(SHARED);
    let i = 0;
    for (const f of files) {
      await c.put(new Request(`./shared/${id}/${i++}`), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'file'), 'X-At': new Date().toISOString() } }));
    }
  } catch (_) { /* the app says nothing arrived */ }
  return Response.redirect('./?shared=' + id, 303);
}
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.includes('/detector/')) {
    e.respondWith(caches.open(ENGINE_CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
