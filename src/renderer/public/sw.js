/* Minimal service worker for the remote (phone/browser) client.
 *
 * Strategy: network-first with cache fallback. The data lives on the Mac —
 * offline, the best we can do is paint the shell; every fresh load must hit
 * the server so a `npm run ship` on the Mac is picked up immediately.
 * The WebSocket at /ws never touches this handler (not a fetch).
 */
const CACHE = 'kairos-shell-v1'

self.addEventListener('install', (event) => {
  // precache the shell: the first page load happens before this worker
  // controls the page, so nothing would land in the cache until a revisit
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add('/'))
      .catch(() => {})
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => {})
        }
        return response
      })
      .catch(async () => {
        const hit = await caches.match(request)
        if (hit) return hit
        // offline navigation with no exact match → the cached shell
        if (request.mode === 'navigate') {
          const shell = await caches.match('/')
          if (shell) return shell
        }
        return Response.error()
      })
  )
})
