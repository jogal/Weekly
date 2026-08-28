const CACHE = "weekly-quest-v31";
const ASSETS = [
  "./tracker.html",
  "./gym.html",
  "./js/training-core.mjs",
  "./js/training-data.mjs",
  "./js/training-plan.mjs",
  "./music.html",
  "./spots.html",
  "./manifest.json",
  "./gym-manifest.json",
  "./music-manifest.json",
  "./spots-manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
  "./sprites/novice.png",
  "./sprites/monk.png",
  "./sprites/whitemage.png",
  "./sprites/blackmage.png",
  "./sprites/bard.png",
  "./sprites/chef.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first with background refresh; fonts and same-origin GETs get cached at runtime
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const cacheable = e.request.url.startsWith(self.location.origin)
    || e.request.url.includes("fonts.googleapis.com")
    || e.request.url.includes("fonts.gstatic.com");
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok && cacheable) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
