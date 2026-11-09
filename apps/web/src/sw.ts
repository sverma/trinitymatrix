/// <reference lib="webworker" />

const sw = globalThis as unknown as ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
};

const shellCache = "trinitymatrix-shell-v1";
const runtimeCache = "trinitymatrix-static-v1";
const legacyCaches = new Set(["rm-assets-v1", "/token"]);
const precacheManifest = (self as unknown as ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string }>;
}).__WB_MANIFEST;
const shellUrls = [...new Set(precacheManifest.map(({ url }) => url).concat("/offline.html"))];

sw.addEventListener("install", (event) => {
  event.waitUntil(caches.open(shellCache).then((cache) => cache.addAll(shellUrls)));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => legacyCaches.has(key) || (key.startsWith("trinitymatrix-") && ![shellCache, runtimeCache].includes(key)))
    .map((key) => caches.delete(key)))));
});

sw.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void sw.skipWaiting();
});

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== sw.location.origin) return;
  if (["/api/", "/ws", "/healthz", "/readyz", "/metrics"].some((path) => url.pathname.startsWith(path))) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.match(request)) ?? (await caches.match("/offline.html"))!));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) void caches.open(runtimeCache).then((cache) => cache.put(request, response.clone()));
      return response;
    }));
  }
});
