// BeastChain service worker
// Bump this version whenever you upload a new build; the old cache is then
// thrown away automatically so players get the new version instead of a
// stale copy from their phone.
const CACHE = 'beastchain-v1';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache live data: game sync (ntfy) and the photo/fact lookups.
  // These must always go to the network so play stays in sync.
  const isLiveData =
    url.hostname.includes('ntfy.sh') ||
    url.hostname.includes('wikipedia.org') ||
    url.hostname.includes('wikidata.org') ||
    url.hostname.includes('wikimedia.org') ||
    url.hostname.includes('inaturalist.org');
  if (isLiveData) return; // let the browser handle it normally

  // App shell: network first (so a fresh upload is picked up straight away),
  // falling back to the cached copy when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

// ---------- real push notifications ----------
// Fires even when the app is fully closed, because the browser itself wakes
// the service worker when a push message arrives from the notify-turn
// function. This is what makes notifications reliable on a locked phone,
// unlike the in-app fallback which needs the page to still be running.
self.addEventListener('push', (event) => {
  let payload = { title: 'BeastChain', body: 'Jouw beurt!' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) { /* keep default payload */ }

  const options = {
    body: payload.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'beastchain-turn',
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(payload.title || 'BeastChain', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
