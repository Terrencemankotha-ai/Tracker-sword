/* Abraham Sword Tracker - service worker
   App shell: cache-first (works offline). Data: network-first, falls back to the last saved copy. */
const VERSION = 'ats-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png', 'icons/apple-touch-icon.png'];
const DATA = 'data/inflation.json';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const live = [DATA, 'data/news.json'].find((d) => url.pathname.endsWith('/' + d));
  if (live) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(live, copy)); }
      return r;
    }).catch(() => caches.match(live).then((r) => r || Response.error())));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});

/* Android/Chrome: background check roughly hourly once the app is installed. */
async function backgroundCheck() {
  const cache = await caches.open(VERSION);
  const oldRes = await cache.match(DATA);
  const old = oldRes ? await oldRes.json() : null;
  const r = await fetch(DATA + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return;
  const next = await r.clone().json();
  await cache.put(DATA, r);
  if (!old) return;
  const fresh = next.latest.filter((n) => {
    const o = old.latest.find((x) => x.code === n.code);
    return o && (o.period !== n.period || o.headline !== n.headline);
  });
  if (!fresh.length) return;
  const body = fresh.map((n) => `${n.code}: ${n.headline.toFixed(1)}%`).join(' · ');
  await self.registration.showNotification('New inflation figure', { body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: 'cpi', renotify: true });
  (await self.clients.matchAll()).forEach((c) => c.postMessage({ type: 'data-updated' }));
}

self.addEventListener('periodicsync', (e) => { if (e.tag === 'cpi-check') e.waitUntil(backgroundCheck()); });

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    const c = cs.find((x) => 'focus' in x);
    return c ? c.focus() : self.clients.openWindow('./');
  }));
});
