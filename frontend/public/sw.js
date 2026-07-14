self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await self.caches.keys();
    await Promise.allSettled(cacheNames.map((cacheName) => self.caches.delete(cacheName)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.allSettled(clients.map((client) => client.navigate(client.url)));
  })());
});
