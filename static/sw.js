self.addEventListener('push', event => {
    let data = { title: 'Mr.Check', body: '' };
    try {
        data = event.json();
    } catch (e) {
        // ignore
    }
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/static/icon.png',
        tag: 'mrcheck-notification',
        requireInteraction: true,
    });
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = event.data?.json()?.url || '/';
    clients.openWindow(url);
});
