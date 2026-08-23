/* LEEJUNHO CALENDAR service worker */

/* 三個快取分開放，因為它們的淘汰時機完全不同：
   - SHELL  頁面本體。network-first，所以新版一上線就吃得到，快取只是離線後備。
   - ASSETS 字型與 Firebase SDK。網址本身帶版本，改版時舊的用不到了才需要清。
   - PHOTOS 照片。跟前兩者不同，不該隨改版被清掉——那等於每次部署都要重新下載一輪。
   要清掉字型／SDK 的舊entry時，把 BUILD 往上加一號就好；PHOTOS 不受影響。 */
const BUILD  = 'v3';
const SHELL  = 'junho-shell-' + BUILD;
const ASSETS = 'junho-assets-' + BUILD;
const PHOTOS = 'junho-photos';
/* v2026.08.23：縮圖從 Firestore 的 base64 搬到 Storage 之後，也會走
   firebasestorage 這條路。如果跟原圖擠同一個快取，250 個位置會被四千多張
   縮圖瞬間塞滿，原圖一張都留不住。分開放，兩者的存取模式本來就不同：
   縮圖小而多、幾乎每次瀏覽都會用到；原圖大而少、只有點開燈箱才需要。 */
const THUMBS = 'junho-thumbs';
const KEEP   = [SHELL, ASSETS, PHOTOS, THUMBS];

/* 照片快取上限。跨網域圖片多半是 opaque response，瀏覽器計算配額時會把它們
   墊到遠大於實際大小（Chrome 是每筆數 MB 起跳）。不設上限的話，累積到撞上
   origin 配額時整個 Cache Storage 會被連鍋端掉，連頁面本體的快取都一起沒。 */
const PHOTO_MAX = 250;
/* 縮圖約 8–15KB，比原圖小一個量級，但 opaque response 的配額灌水是按筆數算的，
   不是按實際大小，所以還是得設上限。600 筆大致覆蓋照片牆捲動兩三個月的量。
   真的撞到配額就把這個數字往下調。 */
const THUMB_MAX = 600;

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(function(c){ return c.add('/').catch(function(){}); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){
        return k.indexOf('junho-') === 0 && KEEP.indexOf(k) === -1;
      }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

/* Cache API 沒有 LRU，keys() 是插入順序，所以砍最前面的等於砍最舊寫入的那批。
   對照片來說夠用了——真正常看的會在被淘汰後再被重新寫入排到隊尾。 */
function trim(cacheName, max){
  return caches.open(cacheName).then(function(c){
    return c.keys().then(function(keys){
      if(keys.length <= max) return;
      return Promise.all(keys.slice(0, keys.length - max).map(function(k){ return c.delete(k); }));
    });
  });
}

function putSafe(cacheName, req, res){
  /* opaque(status 0) 是跨網域無 CORS 的正常情況，要收；
     但 404 / 500 這種真正的錯誤頁絕對不能寫進快取，
     否則之後離線開啟拿到的就是那張錯誤頁，而且會一直卡在那裡。 */
  if(!res) return;
  if(res.type !== 'opaque' && !res.ok) return;
  const copy = res.clone();
  caches.open(cacheName).then(function(c){
    return c.put(req, copy);
  }).then(function(){
    if(cacheName === PHOTOS) return trim(PHOTOS, PHOTO_MAX);
    if(cacheName === THUMBS) return trim(THUMBS, THUMB_MAX);
  }).catch(function(){});
}

self.addEventListener('fetch', function(e){
  const req = e.request;
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const host = url.hostname;

  /* Firestore 即時連線與驗證：完全不攔截。
     這些是長連線與帶憑證的請求，攔了只會壞事。 */
  if(host.indexOf('firestore.googleapis.com') > -1 ||
     host.indexOf('firebaseinstallations.googleapis.com') > -1 ||
     host.indexOf('identitytoolkit') > -1 ||
     host.indexOf('securetoken') > -1) return;

  /* 頁面本體：network-first。有網路一律吃新版，離線才退回快取。 */
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(function(res){
        putSafe(SHELL, '/', res);
        return res;
      }).catch(function(){
        return caches.match('/', {cacheName: SHELL}).then(function(hit){
          return hit || Response.error();
        });
      })
    );
    return;
  }

  /* Storage：縮圖與原圖分流。
     Firebase 下載網址把路徑編碼在 /o/ 後面，thumbs/xxx.jpg 會變成
     /o/thumbs%2Fxxx.jpg，所以認 'thumbs%2F' 就能區分。 */
  if(host.indexOf('firebasestorage') > -1){
    var isThumb = url.pathname.toLowerCase().indexOf('thumbs%2f') > -1;
    e.respondWith(swr(req, isThumb ? THUMBS : PHOTOS));
    return;
  }

  /* 字型、Firebase SDK，以及 manifest.json 之類的同源小檔 */
  if(host.indexOf('gstatic.com') > -1 ||
     host.indexOf('googleapis.com') > -1 ||
     url.origin === self.location.origin){
    e.respondWith(swr(req, ASSETS));
  }
});

/* stale-while-revalidate：先給快取（有的話），同時在背景抓新的寫回去。
   沒快取就等網路；網路也失敗才回快取（此時多半是 undefined，交給瀏覽器報錯）。 */
function swr(req, cacheName){
  return caches.match(req, {cacheName: cacheName}).then(function(hit){
    const net = fetch(req).then(function(res){
      putSafe(cacheName, req, res);
      return res;
    }).catch(function(){ return hit; });
    return hit || net;
  });
}
