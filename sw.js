/* 앱 셸만 캐시한다. 기상청 API(apis.data.go.kr) 등 외부 요청은 절대 캐시하지 않는다. */
var CACHE = 'wo-shell-v1';
var SHELL = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './lib.js',
  './sample-data.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // 외부 출처(특히 apis.data.go.kr)는 관여하지 않음 -> 브라우저 기본 동작, 캐시 없음
  if (url.hostname === 'apis.data.go.kr' || url.origin !== self.location.origin) return;

  // 같은 출처 앱 셸: 네트워크 우선(config.js 키 교체가 바로 반영되도록), 오프라인이면 캐시
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
