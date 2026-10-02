// PaperLink — v4.57 Service Worker：装到桌面后秒开、断网也能打开应用壳
//
// 策略：
//  - 静态资源（html/js/css/图标/manifest）：缓存优先 + 后台静默更新（stale-while-revalidate）
//  - 页面导航：网络优先，断网时回落缓存（电梯里/弱网也能进应用看已缓存内容）
//  - /api/ 与跨域请求：一律不接管（信件/房间是实时数据，必须走网络）
const CACHE = "paperlink-v457";
const CORE = [
  "/", "/index.html", "/home.html", "/hall.html", "/join.html", "/me.html", "/admin.html",
  "/manifest.webmanifest",
  "/css/paperlink.css",
  "/js/shared.js", "/js/room.js", "/js/home.js", "/js/hall.js", "/js/join.js", "/js/me.js",
  "/js/admin.js", "/js/inkpad.js", "/js/canvasui.js", "/js/canvasui-cu.js", "/js/fx.js",
  "/js/glass.js", "/js/voice.js",
  "/icons/icon-192-v2.png", "/icons/icon-512-v2.png", "/icons/icon-180-v2.png", "/icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // 跨域不接管
  if (url.pathname.startsWith("/api/")) return;    // 实时接口永远走网络
  if (req.mode === "navigate") {
    // 导航：网络优先，断了回缓存
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match("/index.html")) || Response.error();
      }
    })());
    return;
  }
  // 静态：命中缓存先给（秒开），后台静默拉新版覆盖
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const freshP = fetch(req)
      .then((fresh) => {
        if (fresh && (fresh.ok || fresh.type === "opaque")) cache.put(req, fresh.clone());
        return fresh;
      })
      .catch(() => null);
    if (hit) { freshP.catch(() => {}); return hit; }
    return (await freshP) || Response.error();
  })());
});
