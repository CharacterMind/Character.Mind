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
  const isCall = notifData.type === 'call';

  if (action === 'decline') {
    // Let any open window know the call was declined so it can queue a miss-call DM
    if (isCall) {
      event.waitUntil(
        clients.matchAll({ type: 'window' }).then(list => {
          for (const c of list) c.postMessage({ type: 'CM_CALL_DECLINED', charId: notifData.charId });
        })
      );
    }
    return;
  }

  const url = notifData.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.startsWith(self.location.origin));
      if (existing && 'focus' in existing) {
        // App is open — send a message so it shows the call UI directly
        if (isCall) {
          existing.postMessage({
            type: 'CM_INCOMING_CALL',
            charId:    notifData.charId,
            charName:  notifData.charName,
            charImage: notifData.charImage,
            charColor: notifData.charColor,
          });
        }
        return existing.navigate(url).then(() => existing.focus());
      }
      // Cold start — open the app; URL carries ?cm_call=charId so it shows the call on load
      return clients.openWindow(url);
    })
  );
});
