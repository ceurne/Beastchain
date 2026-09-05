// BeastChain service worker
// Bump this version whenever you upload a new build; the old cache is then
// thrown away automatically so players get the new version instead of a
// stale copy from their phone.
const CACHE = 'beastchain-v3';

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

  // The main app page is a single large file (a couple of MB, since it
  // bundles the world map and all animal data). If a download gets cut
  // short partway through -- a flaky connection right as a new version was
  // uploaded -- fetch() can still resolve with a 200 response whose body
  // is truncated, and that broken copy would otherwise get cached as if it
  // were fine, causing a blank white screen on next launch until the app is
  // deleted and reinstalled. A minimum-size sanity check catches this: a
  // real index.html here should always be at least ~200KB.
  const isAppShellDoc = url.origin === self.location.origin &&
    (url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname === '/index.html');
  const MIN_APP_SHELL_BYTES = 200000;

  async function fetchAppShellWithRetries(attemptsLeft){
    const res = await fetch(req, { cache: 'no-store' });
    if(res && res.status === 200){
      const buf = await res.clone().arrayBuffer();
      if(buf.byteLength >= MIN_APP_SHELL_BYTES) return res;
      // Truncated download. Usually a passing connection hiccup -- try again
      // a couple of times before giving up, since a retry alone often just
      // succeeds cleanly rather than needing to fall back to anything.
      if(attemptsLeft > 0) return fetchAppShellWithRetries(attemptsLeft - 1);
      const cachedGood = await caches.match('./index.html');
      return cachedGood || res;
    }
    return res;
  }

  // App shell: network first (so a fresh upload is picked up straight away),
  // falling back to the cached copy when offline or when the fetch itself
  // errors out.
  event.respondWith(
    (isAppShellDoc ? fetchAppShellWithRetries(2) : fetch(req))
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

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Als de app al open EN actief in beeld staat, hoeft de systeemmelding
      // er niet ook nog eens overheen -- de speler ziet de nieuwe zet dan
      // toch al via de gewone, live synchronisatie in de app zelf.
      const appAlreadyOpenAndFocused = clientList.some((client) => client.focused);
      if (appAlreadyOpenAndFocused) return;
      return self.registration.showNotification(payload.title || 'BeastChain', options);
    })
  );
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
