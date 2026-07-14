self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) =>
      Promise.allSettled(clients.map((client) => client.navigate(client.url)))
    )
  );
});
