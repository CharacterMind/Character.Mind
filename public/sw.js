// Character.Mind Service Worker — push notifications & incoming character calls

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch (_) { return; }

  if (data.type === 'incoming_call') {
    const opts = {
      body: `${data.charName} is calling you…`,
      icon: data.charImage || '/logo-icon.svg',
      badge: '/logo-icon.svg',
      vibrate: [400, 100, 400, 100, 400],
      requireInteraction: true,
      tag: `call-${data.callId}`,
      data: { charId: data.charId, callId: data.callId, charName: data.charName, charImage: data.charImage || '' },
      actions: [
        { action: 'accept', title: '✓ Accept' },
        { action: 'decline', title: '✕ Decline' },
      ],
    };
    e.waitUntil(self.registration.showNotification(`📞 ${data.charName}`, opts));
  }
});

self.addEventListener('notificationclick', e => {
  const { action, notification } = e;
  const { charId, callId, charName } = notification.data || {};
  notification.close();

  if (action === 'decline') {
    e.waitUntil(Promise.resolve());
    return;
  }

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin)) {
          c.focus();
          c.postMessage({ type: 'CM_INCOMING_CALL', charId, callId, charName, charImage: notification.data.charImage || '' });
          return;
        }
      }
      return clients.openWindow(`/?cm_call=${encodeURIComponent(charId)}`);
    }),
  );
});
