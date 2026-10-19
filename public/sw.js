// Character.Mind service worker — handles push notifications

self.addEventListener('push', event => {
  let data = { title: 'Character.Mind', body: 'Your character is waiting!', icon: '/logo.png', url: '/' };
  try { if (event.data) Object.assign(data, event.data.json()); } catch (_) {}

  const isCall = data.type === 'call';

  const options = {
    body: data.body,
    icon: data.icon || '/logo.png',
    badge: data.badge || '/logo.png',
    data: { url: data.url || '/', type: data.type },
    vibrate: isCall
      ? [500, 200, 500, 200, 500, 200, 500, 200, 500] // ringing pattern
      : [200, 100, 200],
    requireInteraction: isCall, // call stays until tapped
    silent: false,
    actions: isCall ? [
      { action: 'answer', title: '📞 Answer' },
      { action: 'decline', title: '✕ Decline' },
    ] : [],
    tag: isCall ? 'character-call' : undefined,
    renotify: isCall,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
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
