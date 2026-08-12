/* 信 — Service Worker
 *
 * 被系统唤醒时，检查这一刻有没有该发而没发的消息。
 * 时间一律按福州时间（UTC+8）算。
 */

const CACHE = 'letters-v7';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('letters-') && n !== CACHE && n !== 'letters-sent' && n !== 'letters-data')
                           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
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

/* ── 时间：锁死 UTC+8 ── */
const TZ_OFFSET = 8 * 60;
function fzNow(){
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + TZ_OFFSET) * 60000);
}
const pad = n => String(n).padStart(2,'0');
const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseKey = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const toMin = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const toHM  = m => pad(Math.floor(m/60)) + ':' + pad(m%60);

function seeded(str){
  let h = 2166136261;
  for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

async function loadData(){
  // 优先用页面同步过来的那份（可能是用户导入的）
  try{
    const c = await caches.open('letters-data');
    const hit = await c.match('/data/current');
    if(hit){
      const o = await hit.json();
      if(o && o.M && Object.keys(o.M).length) return o;
    }
  }catch(e){}

  try{
    const res = await fetch('./messages.js?t=' + Date.now(), {cache:'no-store'});
    const txt = await res.text();
    const fn = new Function(txt + `;return {
      M: typeof MESSAGES!=="undefined"?MESSAGES:{},
      S: typeof SLOTS!=="undefined"?SLOTS:{},
      D: typeof START_DATE!=="undefined"?START_DATE:null
    };`);
    return fn();
  }catch(e){
    return { M:{}, S:{}, D:null };
  }
}

function planFor(dateKey, M, S, D){
  if(!D) return [];
  const days = Math.round((parseKey(dateKey) - parseKey(D)) / 86400000);
  if(days < 0) return [];
  const out = [];
  for(const name of ['morning','afternoon','evening','wild']){
    const list = M[name], slot = S[name];
    if(!list || !slot || days >= list.length) continue;
    const [lo, hi] = slot.range.map(toMin);
    const at = lo + Math.floor(seeded(dateKey + ':' + name) * (hi - lo + 1));
    out.push({ name, label: slot.label, at: toHM(at), atMin: at, text: list[days] });
  }
  return out.sort((a,b) => a.atMin - b.atMin);
}

/* 记录哪一条已经通知过了 */
async function sentKey(k){
  const c = await caches.open('letters-sent');
  return !!(await c.match('/sent/' + k));
}
async function markSent(k){
  const c = await caches.open('letters-sent');
  await c.put('/sent/' + k, new Response('1'));
}

async function deliver(){
  const now = fzNow();
  const dateKey = keyOf(now);
  const nowMin = now.getHours()*60 + now.getMinutes();

  const { M, S, D } = await loadData();
  const plan = planFor(dateKey, M, S, D);

  // 已经到点、还没通知过的，全部补上（通常只有一条）
  for(const p of plan){
    if(p.atMin > nowMin) continue;
    const id = dateKey + '_' + p.name;
    if(await sentKey(id)) continue;

    await self.registration.showNotification('有一条', {
      body: p.text.length > 80 ? p.text.slice(0,80) + '…' : p.text,
      tag: 'letter-' + id,
      icon: './icon-192.png',
      badge: './icon-mono.png'
    });
    await markSent(id);
  }
}

/* 页面把当前生效的内容同步进来 */
self.addEventListener('message', e => {
  if(e.data && e.data.type === 'sync-data'){
    e.waitUntil((async () => {
      const c = await caches.open('letters-data');
      await c.put('/data/current', new Response(JSON.stringify({
        M: e.data.M, S: e.data.S, D: e.data.D
      }), { headers: {'Content-Type':'application/json'} }));
    })());
  }
});

self.addEventListener('periodicsync', e => {
  if(e.tag === 'daily-letter') e.waitUntil(deliver());
});
self.addEventListener('sync', e => {
  if(e.tag === 'check-letter') e.waitUntil(deliver());
});

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
