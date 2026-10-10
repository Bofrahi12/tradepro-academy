self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('fetch', e => {
  // Cache-first for static assets
  if (e.request.url.match(/\.(css|js|png|jpg|svg|woff2?)$/)) {
    e.respondWith(
      caches.open('tradepro-v1').then(cache =>
        cache.match(e.request).then(res =>
          res || fetch(e.request).then(r => { cache.put(e.request, r.clone()); return r; })
        )
      )
    );
  }
});