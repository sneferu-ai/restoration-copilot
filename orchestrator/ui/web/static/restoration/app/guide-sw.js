// guide-sw.js — Bay Guide service worker (spec §9.5, OBL-28).
// Cache-first for app shell + assets, network-first for bundle/flags API.
// Registered from guide/index.html with a stable path (un-hashed).
// Lives in src/public/ so Vite copies it to the output dir on each build
// (emptyOutDir:true would delete a hand-placed file).

const CACHE = "guide-v1";
const SHELL = [
  "/static/restoration/app/guide/index.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // Network-first for API calls (bundle, flags) — always try fresh data
  if (url.pathname.startsWith("/guide/") && (url.pathname.endsWith("/bundle") || url.pathname.endsWith("/flags"))) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, fonts, images)
  if (url.pathname.startsWith("/static/restoration/app/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        });
      }),
    );
    return;
  }

  // Passthrough for everything else
});
