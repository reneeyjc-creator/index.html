/* LEEJUNHO CALENDAR service worker */
const CACHE = 'junho-v1';

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.add('/').catch(function(){}); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase 即時連線/驗證:完全不攔截
  if(url.hostname.indexOf('firestore.googleapis.com') > -1 ||
     url.hostname.indexOf('identitytoolkit') > -1 ||
     url.hostname.indexOf('securetoken') > -1) return;

  // 頁面本體:network-first(部署新版一上線就吃到,離線才退回快取)
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(function(res){
        const copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put('/', copy); });
        return res;
      }).catch(function(){ return caches.match('/'); })
    );
    return;
  }

  // 字型 / SDK / 照片:cache-first + 背景更新
  if(url.hostname.indexOf('gstatic.com') > -1 ||
     url.hostname.indexOf('googleapis.com') > -1 ||
     url.hostname.indexOf('firebasestorage') > -1){
    e.respondWith(
      caches.match(req).then(function(hit){
        const net = fetch(req).then(function(res){
          if(res && (res.status === 200 || res.type === 'opaque')){
            const copy = res.clone();
            caches.open(CACHE).then(function(c){ c.put(req, copy); });
          }
          return res;
        }).catch(function(){ return hit; });
        return hit || net;
      })
    );
  }
});
