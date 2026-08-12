/* 每日一封 — Service Worker
 *
 * 它负责的事：
 *   1. 被系统定期唤醒时，检查今天这条发了没，没发就弹通知
 *   2. 点通知时把页面调到前台
 *
 * 注意：唤醒时间由系统决定，我们控制不了。
 * 所以逻辑不是"到几点发"，而是"被叫醒的时候，看看今天欠不欠"。
 */

const CACHE = 'letters-v2';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('letters-') && n !== CACHE)
                           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

/* 离线也能打开 */
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  // messages.js 永远拿最新的，不走缓存
  if(e.request.url.includes('messages.js')){
    e.respondWith(fetch(e.request, {cache:'no-store'}).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

/* ── 今天该发哪条 ── */
const pad = n => String(n).padStart(2, '0');
function todayKey(){
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

async function loadMessages(){
  try{
    const res = await fetch('./messages.js?t=' + Date.now());
    const txt = await res.text();
    // messages.js 里是两个全局赋值，这里就地求值取出来
    const fn = new Function(txt + '; return {MESSAGES: typeof MESSAGES!=="undefined"?MESSAGES:[], START_DATE: typeof START_DATE!=="undefined"?START_DATE:null};');
    return fn();
  }catch(e){
    return { MESSAGES: [], START_DATE: null };
  }
}

const parseKey = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };

function pickFor(dateKey, MESSAGES, START_DATE){
  if(!MESSAGES || !MESSAGES.length) return null;
  const exact = MESSAGES.find(m => m.date === dateKey);
  if(exact) return exact;
  const start = parseKey(START_DATE || dateKey);
  const today = parseKey(dateKey);
  const days = Math.round((today - start) / 86400000);
  const seq = MESSAGES.filter(m => !m.date);
  if(days < 0 || days >= seq.length) return null;
  return seq[days];
}

/* 用 Cache 当小仓库，记住哪天已经通知过了 */
async function alreadySent(key){
  const c = await caches.open('letters-sent');
  const hit = await c.match('/sent/' + key);
  return !!hit;
}
async function markSent(key){
  const c = await caches.open('letters-sent');
  await c.put('/sent/' + key, new Response('1'));
}

async function deliver(){
  const key = todayKey();
  if(await alreadySent(key)) return;

  const { MESSAGES, START_DATE } = await loadMessages();
  const msg = pickFor(key, MESSAGES, START_DATE);
  if(!msg) return;

  await self.registration.showNotification('有一条', {
    body: msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text,
    tag: 'letter-' + key,
    icon: './icon-192.png',
    badge: './icon-mono.png',
    requireInteraction: false
  });
  await markSent(key);
}

self.addEventListener('periodicsync', e => {
  if(e.tag === 'daily-letter') e.waitUntil(deliver());
});

self.addEventListener('sync', e => {
  if(e.tag === 'check-letter') e.waitUntil(deliver());
});

/* 真推送以后要用的话，这里也留着 */
self.addEventListener('push', e => {
  let data = { title:'有一条', body:'' };
  try{ if(e.data) data = e.data.json(); }
  catch(err){ if(e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title || '有一条', {
    body: data.body || '', tag: data.tag || 'letter', icon:'./icon-192.png'
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      for(const c of list){ if('focus' in c) return c.focus(); }
      if(self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
