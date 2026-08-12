// 通知测试用的 Service Worker
// 现在它只做两件事：装上、以及点击通知时关掉它。
// 以后加真正的推送时，push 事件的处理也写在这里。

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

// —— 以后接真推送时会用到这一段 ——
self.addEventListener('push', event => {
  let data = { title: '新消息', body: '' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || '新消息', {
      body: data.body || '',
      tag: data.tag || 'msg'
    })
  );
});
