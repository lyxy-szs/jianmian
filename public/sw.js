/* 仅缓存静态壳与已访问页面；业务数据始终通过 API 获取，绝不写入 Cache Storage。 */
const CACHE = 'interview-shell-v1';
const PRECACHE = [
  '/',
  '/styles/base.css',
  '/shared/theme-init.js',
  '/shared/theme.mjs',
  '/shared/api.mjs',
  '/shared/dom.mjs',
  '/shared/toast.mjs',
  '/shared/store.mjs',
  '/shared/sync.mjs',
  '/app/index.mjs',
  '/app/join.mjs',
  '/app/board.mjs',
  '/app/candidate.mjs',
  '/app/report.mjs',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 网络优先、离线回退缓存：保证在线时拿到最新静态资源，离线时仍能重开访问过的页面。
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return new Response('离线且该页面尚未缓存。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }),
  );
});
