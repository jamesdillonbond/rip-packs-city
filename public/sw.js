// Rip Packs City — Service Worker (cache-first for static, network-first for API)
const CACHE_NAME = "rpc-v1";
const STATIC_ASSETS = ["/offline.html", "/rip-packs-city-logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Skip non-GET and chrome-extension requests
  if (request.method !== "GET" || request.url.startsWith("chrome-extension")) return;

  // Network-first for API calls and navigation
  if (request.url.includes("/api/") || request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => {
        if (request.mode === "navigate") {
          return caches.match("/offline.html");
        }
        return new Response(JSON.stringify({ error: "Offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});
