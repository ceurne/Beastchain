// BeastChain service worker
// Bump this version whenever you upload a new build; the old cache is then
// thrown away automatically so players get the new version instead of a
// stale copy from their phone.
const CACHE = 'beastchain-v24';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Safari/WebKit refuses to use a service-worker-served response for a
// top-level navigation if that response went through an HTTP redirect at any
// point (Response.redirected === true) -- even though its final body and
// status are completely normal. If a cached copy was ever produced by a
// fetch that followed a redirect (e.g. a canonicalising "/" <-> "/index.html"
// redirect at the edge), every later navigation served from that cache entry
// fails outright on iOS with "Response served by service worker has
// redirections". Rebuilding a plain Response strips that flag for good.
async function stripRedirectFlag(res){
  if(!res.redirected) return res;
  const buf = await res.clone().arrayBuffer();
  return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(APP_SHELL.map((url) =>
        fetch(url, { cache: 'no-store' })
          .then((res) => res && res.status === 200 ? stripRedirectFlag(res) : null)
          .then((clean) => clean ? cache.put(url, clean) : null)
          .catch(() => {}) // one missing/failed asset shouldn't block the rest from installing
      )))
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

  // Same fix as stripRedirectFlag() above, just reusing the size-check's
  // already-read body instead of cloning and reading it a second time.
  function stripRedirectFlagFromBuf(res, buf){
    if(!res.redirected) return res;
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  async function fetchAppShellWithRetries(attemptsLeft){
    const res = await fetch(req, { cache: 'no-store' });
    if(res && res.status === 200){
      const buf = await res.clone().arrayBuffer();
      if(buf.byteLength >= MIN_APP_SHELL_BYTES){
        const clean = stripRedirectFlagFromBuf(res, buf);
        const cache = await caches.open(CACHE);
        cache.put(req, clean.clone()).catch(() => {});
        return clean;
      }
      // Truncated download. Usually a passing connection hiccup -- try again
      // a couple of times before giving up, since a retry alone often just
      // succeeds cleanly rather than needing to fall back to anything.
      if(attemptsLeft > 0) return fetchAppShellWithRetries(attemptsLeft - 1);
      const cachedGood = await caches.match('./index.html');
      return cachedGood || res;
    }
    return res;
  }

  // Fetches a fresh copy purely to refresh the cache for NEXT launch --
  // never blocks anything on-screen right now, and only overwrites the
  // cache if the download is actually complete (same size guard as above).
  async function revalidateAppShellInBackground(attemptsLeft){
    try{
      const res = await fetch(req, { cache: 'no-store' });
      if(res && res.status === 200){
        const buf = await res.clone().arrayBuffer();
        if(buf.byteLength >= MIN_APP_SHELL_BYTES){
          const clean = stripRedirectFlagFromBuf(res, buf);
          const cache = await caches.open(CACHE);
          await cache.put(req, clean);
          return;
        }
        if(attemptsLeft > 0) return revalidateAppShellInBackground(attemptsLeft - 1);
      }
    }catch(e){ /* offline or flaky -- next launch just tries again */ }
  }

  if (isAppShellDoc) {
    // Cache-first voor de app-pagina zelf: die staat dan METEEN klaar zodra
    // WebKit de eerste keer iets probeert te tekenen, in plaats van eerst een
    // heel netwerk-rondje (soms 1-2s, extra lang vlak na het koud opstarten
    // van de radio) te moeten afwachten voor er ook maar iets te parsen valt
    // -- dat netwerk-wachten was de grootste resterende oorzaak van de witte
    // flits, groter dan de losse animatie/CSS-optimalisaties die al gedaan
    // waren. Een nieuwe versie wordt op de achtergrond opgehaald en klaargezet
    // voor de VOLGENDE keer opstarten. Alleen als er nog helemaal niks in
    // cache zit (allereerste bezoek, of na het wissen van site-data) wordt er
    // alsnog op het netwerk gewacht, want dan is er simpelweg niets te tonen.
    event.respondWith(
      caches.match(req).then((cached) => {
        if(cached){
          event.waitUntil(revalidateAppShellInBackground(2));
          return cached;
        }
        return fetchAppShellWithRetries(2).catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Alle andere requests: ongewijzigd network-first, met een fallback naar de
  // cache bij offline of een mislukte fetch.
  event.respondWith(
    fetch(req)
      .then(async (res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const clean = await stripRedirectFlag(res);
          caches.open(CACHE).then((cache) => cache.put(req, clean.clone())).catch(() => {});
          return clean;
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
