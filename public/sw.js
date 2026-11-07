// 웹 푸시 수신 + 알림 표시 + 알림에서 바로 답장하기
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// 서버가 보낸 푸시 (앱이 닫혀 있어도 도착)
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: '쉿!그널', body: event.data?.text() };
  }
  // iOS는 푸시마다 알림을 꼭 띄워야 구독이 유지되므로 항상 표시한다
  event.waitUntil(
    self.registration.showNotification(msg.title || '쉿!그널', {
      body: msg.body,
      tag: msg.tag,
      data: msg.data,
      actions: msg.actions,
      requireInteraction: msg.requireInteraction,
      renotify: Boolean(msg.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [120, 60, 120],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const { id, token, kind, slug, url = '/' } = event.notification.data || {};
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // 알림의 액션 버튼(사과 / 저희 집 아님)을 누른 경우: 앱을 열지 않고 바로 답장
      if (event.action && id && token && slug) {
        const res = await fetch(`/api/b/${slug}/alerts/${id}/reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, reply: event.action }),
        });
        if (res.ok) {
          const alert = await res.json();
          windows.forEach((w) => w.postMessage({ type: 'replied', alert }));
          return;
        }
      }

      // 알림 본문을 누른 경우: 앱을 열고 받은 알림이면 답장 화면, 관리사무소 답변이면 문의 창 표시
      const win = windows.find((w) => new URL(w.url).pathname.startsWith(url)) || windows[0];
      if (win) {
        await win.focus();
        if (id && kind === 'alert') win.postMessage({ type: 'open-alert', id });
        if (kind === 'chat') win.postMessage({ type: 'open-chat' });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
