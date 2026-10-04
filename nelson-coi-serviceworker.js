// Copyright (c) 2016-present Allan CORNET (Nelson)
// SPDX-License-Identifier: LGPL-3.0-or-later

const ISOLATION_HEADERS = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const BUILD_ID = new URL(self.location.href).searchParams.get("build") || "dev";
const CACHE_NAME = `nelson-wasm-${BUILD_ID}`;

function withIsolationHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withBuild(reference) {
  const url = new URL(reference, self.registration.scope);
  if (BUILD_ID && !url.searchParams.has("build")) {
    url.searchParams.set("build", BUILD_ID);
  }
  return url;
}

async function putIfAvailable(cache, reference) {
  const url = withBuild(reference);
  try {
    const response = await fetch(url, { cache: "reload" });
    if (!response.ok) return;
    await cache.put(url, withIsolationHeaders(response.clone()));
  } catch {
    // Offline install remains best-effort; the regular fetch path can still
    // populate the cache once the resource becomes reachable.
  }
}

async function precacheStartup() {
  const cache = await caches.open(CACHE_NAME);
  await putIfAvailable(cache, "index.html?runtime=wasm");
  await putIfAvailable(cache, "manifest.webmanifest");
  await putIfAvailable(cache, "nelson-pwa-icon.png");

  let manifestResponse;
  try {
    manifestResponse = await fetch(withBuild("manifest.json"), {
      cache: "reload",
    });
  } catch {
    return;
  }
  if (!manifestResponse.ok) return;
  await cache.put(
    withBuild("manifest.json"),
    withIsolationHeaders(manifestResponse.clone())
  );

  const manifest = await manifestResponse.json();
  const startupFiles = Array.isArray(manifest?.delivery?.startup)
    ? manifest.delivery.startup.flatMap((group) =>
        Array.isArray(group.files) ? group.files : []
      )
    : [];
  await Promise.all(
    [...new Set(startupFiles)].map((file) => putIfAvailable(cache, file))
  );
}

async function removeOldCaches() {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith("nelson-wasm-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await precacheStartup();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await removeOldCaches();
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (
    event.request.cache === "only-if-cached" &&
    event.request.mode !== "same-origin"
  )
    return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          await cache.put(
            event.request,
            withIsolationHeaders(response.clone())
          );
        }
        return withIsolationHeaders(response);
      } catch (error) {
        const cached = await cache.match(event.request);
        if (cached) return withIsolationHeaders(cached);
        throw error;
      }
    })()
  );
});
