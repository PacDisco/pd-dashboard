// lead-alerts/sw.js — service worker for the Lead Alerts phone app.
//
// - push: show the notification and set the red number on the app icon
// - notificationclick: open (or focus) the app at the alert
// - fetch: keep the app shell available offline; never cache /api
//
// Bump VERSION when the shell changes so phones pick up the new files.

const VERSION = "lead-alerts-v2";
const SHELL = [
  "/lead-alerts/",
  "/lead-alerts/manifest.webmanifest",
  "/lead-alerts/icon-192.png",
  "/lead-alerts/icon-badge.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("lead-alerts-") && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/lead-alerts/")) return;   // /api, identity, etc. go straight to the network
  // Network first, so a deploy shows up immediately; cache when offline.
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(event.request.mode === "navigate" ? "/lead-alerts/" : event.request, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(event.request.mode === "navigate" ? "/lead-alerts/" : event.request);
      return hit || Response.error();
    }
  })());
});

async function setBadge(n) {
  try {
    if (!self.navigator || !("setAppBadge" in self.navigator)) return;
    if (n > 0) await self.navigator.setAppBadge(n);
    else await self.navigator.clearAppBadge();
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Lead Alerts", body: event.data && event.data.text() }; }
  const title = data.title || "New lead";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "/lead-alerts/icon-192.png",
    badge: "/lead-alerts/icon-badge.png",     // Android status-bar glyph
    data: { url: data.url || "/lead-alerts/" },
    timestamp: Date.now(),
  };
  event.waitUntil((async () => {
    // iOS requires every push to show a notification, so this always runs.
    await self.registration.showNotification(title, options);
    await setBadge(Number(data.badge) || 0);
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: "lead-alerts:push", data });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/lead-alerts/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith("/lead-alerts/")) {
        await w.focus();
        w.postMessage({ type: "lead-alerts:open", url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
