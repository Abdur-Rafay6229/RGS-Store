const CACHE = 'rgs-v11';
const ASSETS = ['./', './index.html', './manifest.json', './icon.png', './icon-192.png'];

// Install event — app shell cache karo.
// Agar koi asset fail ho jaye (missing file, network glitch) to pura install
// fail na ho: baaki assets tab bhi cache ho jayenge.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

// Activate event — purana cache delete karo
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Pages (navigations) → network first: taaki naya update turant mile,
  // offline ho to cache se chale
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Sirf 200 cache karo — warna 404/500 wali page cache me chali jaati thi
          // aur user ko offline hone par bhi wahi error page dikhta tha.
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (r) => r || caches.match('./index.html')
          ).then((r) => r || Response.error())
        )
    );
    return;
  }

  // Baaki assets (icons, manifest, scripts) → cache first, miss ho to network.
  // Offline + cache miss hone par index.html (HTML) mat bhejo — wo galat
  // content-type ke saath script/style ki jagah chalega. Network error do.
  e.respondWith(
    caches.match(req).then(
      (r) =>
        r ||
        fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => Response.error())
    )
  );
});
