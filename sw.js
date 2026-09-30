const CACHE_NAME = 'rgs-store-v1.4.0';
const ASSETS = ['./index.html'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('SW cache addAll failed', err);
      });
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // GET only, and skip firebase/cloudinary/tesseract cdn
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('firestore.googleapis.com') || 
      url.includes('firebase') || 
      url.includes('cloudinary.com') || 
      url.includes('jsdelivr.net') ||
      url.includes('googleapis.com')) {
    return; // let browser handle directly, don't cache
  }

  e.respondWith(
    fetch(e.request).then(networkRes => {
      // cache good responses
      if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
        const clone = networkRes.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      }
      return networkRes;
    }).catch(() => {
      // offline -> try cache
      return caches.match(e.request).then(cached => {
        if (cached) return cached;
        // if navigation request, fallback to index.html
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return null;
      });
    })
  );
});
