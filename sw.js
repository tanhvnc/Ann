const CACHE_NAME = 'debt-tracker-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/logo1.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use catch to avoid failing the whole install if some files are missing
      return cache.addAll(ASSETS_TO_CACHE).catch(err => console.log('Cache addAll error:', err));
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
