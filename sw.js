const CACHE_NAME = 'debt-tracker-v2';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/logo1.png',
  '/style.css',
  '/app.js',
  '/libs/supabase-js.js',
  '/libs/tailwind.js',
  '/libs/chart.js',
  '/libs/fullcalendar.js',
  '/libs/sortable.js'
];

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

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
