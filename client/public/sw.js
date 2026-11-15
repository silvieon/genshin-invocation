// Service worker: makes card artwork fast and resilient, at zero server cost.
//
//  * Card images from the gi-tcg static-data API are cached forever
//    (cache-first), so each image is downloaded once per device.
//  * Card data JSON from that API is served stale-while-revalidate.
//  * If the primary image API fails, the card-face filename from genshin-db
//    (/carddb/images.json, generated at build time) is used to fetch the same
//    official art from a mirror.
//
// Requests to this app's own origin are never intercepted, so app updates are
// always picked up normally.

const ART_CACHE = "gi-art-v1";
const DATA_CACHE = "gi-data-v1";
const KNOWN_CACHES = [ART_CACHE, DATA_CACHE];
const PRIMARY = "https://static-data.piovium.org/api/v5/";
const MIRROR = "https://gi.yatta.moe/assets/UI/gcg/";

let fallbackNames = null;
async function fallbackName(id) {
  if (!fallbackNames) {
    fallbackNames = fetch("/carddb/images.json")
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return (await fallbackNames)[id];
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (!KNOWN_CACHES.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = request.url;
  if (url.startsWith(PRIMARY + "image/")) event.respondWith(image(request));
  else if (url.startsWith(PRIMARY)) event.respondWith(data(request));
  else if (url.startsWith(MIRROR)) event.respondWith(cacheFirst(ART_CACHE, url));
  else {
    // web-ui-core 0.21 asks for a few board decorations under a name that doesn't exist upstream
    // (e.g. CardCountHintBlue.svg.webp, published as CardCountHintBlue.webp).
    const fixed = url.match(/^(https:\/\/ui-assets\.piovium\.org\/(?:Card|Dice)CountHint(?:Blue|Yellow))\.svg\.webp$/);
    if (fixed) event.respondWith(fetch(`${fixed[1]}.webp`, { mode: "no-cors" }));
  }
});

async function fetchCors(url) {
  // Always fetch in CORS mode so the response is readable, cacheable, and usable by both fetch() and <img>.
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function cacheFirst(cacheName, url) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetchCors(url);
  cache.put(url, res.clone()).catch(() => {});
  return res;
}

async function image(request) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = await fetchCors(request.url);
    cache.put(request.url, res.clone()).catch(() => {});
    return res;
  } catch (primaryError) {
    const path = new URL(request.url).pathname;
    const byId = path.match(/\/image\/(\d+)$/);
    const raw = path.match(/\/image\/raw\/([\w-]+)$/);
    const name = byId ? await fallbackName(byId[1]) : raw ? raw[1] : undefined;
    if (name) {
      try {
        const res = await fetchCors(`${MIRROR}${name}.png`);
        // Store under the original URL so the next lookup is a cache hit.
        cache.put(request.url, res.clone()).catch(() => {});
        return res;
      } catch {
        // fall through
      }
    }
    return Response.error();
  }
}

async function data(request) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(request.url);
  const refresh = fetchCors(request.url)
    .then((res) => {
      cache.put(request.url, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  return (await refresh) ?? Response.error();
}
