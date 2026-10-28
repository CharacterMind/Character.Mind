// Character.Mind service worker — handles push notifications

self.addEventListener('push', event => {
  let data = { title: 'Character.Mind', body: 'Your character is waiting!', icon: '/logo.png', url: '/' };
  try { if (event.data) Object.assign(data, event.data.json()); } catch (_) {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Suppress if the app tab is already visible — user is already looking at it
      const hasVisibleTab = windowClients.some(c => c.visibilityState === 'visible');
      if (hasVisibleTab && data.type !== 'call') return;

      const isCall = data.type === 'call';
      const isGroup = data.type === 'group';

      const options = {
        body: data.body,
        icon: data.icon || '/logo.png',
        badge: '/logo.png',
        data: { url: data.url || '/', type: data.type, charId: data.charId, groupId: data.groupId },
        vibrate: isCall
          ? [500, 200, 500, 200, 500, 200, 500, 200, 500] // ringing pattern
          : isGroup
            ? [200, 100, 200, 100, 200]  // double-pulse for group
            : [200, 100, 200],
        requireInteraction: isCall,
        silent: false,
        actions: isCall ? [
          { action: 'answer', title: '📞 Answer' },
          { action: 'decline', title: '✕ Decline' },
        ] : [],
        tag: data.tag || (isCall ? 'character-call' : isGroup ? `group-${data.groupId}` : `chat-${data.charId}`),
        renotify: isCall,
      };

      return self.registration.showNotification(data.title, options);
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const action = event.action;

  // Declined — just close
  if (action === 'decline') return;

  const url = notifData.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
