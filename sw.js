const CACHE = "weekly-quest-v82";
const ASSETS = [
  "./tracker.html",
  "./css/private-sync.css",
  "./js/private-sync-client.mjs",
  "./js/private-sync-protocol.mjs",
  "./js/private-sync-stats.mjs",
  "./js/private-sync-ui.mjs",
  "./gym.html",
  "./css/gym-quest.css",
  "./css/weekly-theme.css",
  "./js/gym-quest.mjs",
  "./js/habit-core.mjs",
  "./js/quest-core.mjs",
  "./js/todo-core.mjs",
  "./js/pwa-update.js",
  "./js/backup-file.js",
  "./js/monk-companion.mjs",
  "./sprites/monk-idle/lv1.webp",
  "./sprites/monk-idle/lv10.webp",
  "./sprites/monk-idle/lv20.webp",
  "./sprites/monk-idle/lv30.webp",
  "./sprites/monk-idle/lv40.webp",
  "./sprites/monk-actions/lv1.webp",
  "./sprites/monk-actions/lv10.webp",
  "./sprites/monk-actions/lv20.webp",
  "./sprites/monk-actions/lv30.webp",
  "./sprites/monk-actions/lv40.webp",
  "./js/training-core.mjs",
  "./js/training-targets.mjs",
  "./js/training-data.mjs",
  "./js/training-plan.mjs",
  "./js/ai-coach.mjs",
  "./manifest.json",
  "./gym-manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
  "./icon-quest-192.png",
  "./icon-quest-512.png",
  "./icons/avatar/novice.png",
  "./sprites/novice.png",
  "./sprites/monk.png",
  "./sprites/monk-room.svg",
  "./sprites/monk_lv1x2.png",
  "./sprites/monk_lv10x2.png",
  "./sprites/monk_lv20x2.png",
  "./sprites/monk_lv30x2.png",
  "./sprites/monk_lv40x2.png",
  "./sprites/whitemage.png",
  "./sprites/blackmage.png",
  "./sprites/bard.png",
  "./sprites/chef.png",
  "./css/reading.css",
  "./js/reading-core.mjs",
  "./js/reading-ui.mjs",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

const isPrivateRoute = url => /^\/(?:api|auth)(?:\/|$)/.test(new URL(url).pathname);

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      // Also scrub private responses from the retained cache (older workers cached every GET).
      .then(() => caches.open(CACHE))
      .then(async cache => {
        const requests = await cache.keys();
        await Promise.all(requests.filter(request => isPrivateRoute(request.url)).map(request => cache.delete(request)));
      })
      .then(() => self.clients.claim())
  );
});

// Prove to the new frontend that a legacy cache-all worker is no longer in control.
self.addEventListener("message", e => {
  if (e.data?.type === "weekly-private-sync-cache-check" && e.data.version === 1) {
    e.ports?.[0]?.postMessage({ type: "weekly-private-sync-cache-safe", version: 1 });
  }
});

// Cache-first with background refresh; fonts and same-origin GETs get cached at runtime
self.addEventListener("fetch", e => {
  // Never read from or write to a cache for OAuth, session, or sync routes.
  // Let the browser use the network even when an old cache has a matching response.
  if (isPrivateRoute(e.request.url)) return;
  if (e.request.method !== "GET") return;
  const cacheable = new URL(e.request.url).origin === self.location.origin
    || e.request.url.includes("fonts.googleapis.com")
    || e.request.url.includes("fonts.gstatic.com");
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok && cacheable && !res.redirected && !/(?:private|no-store)/i.test(res.headers.get("Cache-Control") || "")) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
