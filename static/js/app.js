// ============ STATE ============
let pinnedTasks = lsGetJSON('pinnedTasks', []);
let taskLocations = lsGetJSON('taskLocations', {});
let clientsMap = {};

let savedProfileName = lsGet('profileName', '');
let currentTheme = lsGet('theme', 'dark');

function applyTheme(theme) {
    currentTheme = theme;
    lsSet('theme', theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.bsTheme = theme;

    const nav = document.getElementById('mainNavbar');
    if (theme === 'light') {
        nav.classList.remove('navbar-dark', 'bg-dark');
        nav.classList.add('navbar-light', 'bg-white');
    } else {
        nav.classList.remove('navbar-light', 'bg-white');
        nav.classList.add('navbar-dark', 'bg-dark');
    }

    const toggle = document.getElementById('themeToggle');
    if (toggle) {
        toggle.classList.toggle('active', theme === 'light');
        toggle.setAttribute('aria-checked', theme === 'light');
    }
    const label = document.getElementById('themeLabel');
    if (label) label.textContent = theme === 'light' ? '\u0421\u0432\u0435\u0442\u043B\u0430\u044F' : '\u0422\u0451\u043C\u043D\u0430\u044F';

    updateProfileAvatar();
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

function toggleMarkMyTasks() {
    const el = document.getElementById('markMyTasksToggle');
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on);
    saveProfile();
}

function toggleNotifyOnlyMine() {
    const el = document.getElementById('notifyOnlyMineToggle');
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on);
    saveProfile();
}

function openSettings(firstLogin) {
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    const titleEl = document.querySelector('#settingsModal .modal-title');
    if (firstLogin) {
        titleEl.innerHTML = '<i class="bi bi-person-check me-2"></i>\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C! \u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438';
    } else {
        titleEl.innerHTML = '<i class="bi bi-gear me-2"></i>\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438';
    }
    document.getElementById('profileName').value = savedProfileName;
    const markOn = lsGet('markMyTasks', '') === 'true';
    document.getElementById('markMyTasksToggle').classList.toggle('active', markOn);
    document.getElementById('markMyTasksToggle').setAttribute('aria-checked', markOn);
    document.getElementById('myTaskKeywords').value = lsGet('myTaskKeywords', '');
    const notifyOn = lsGet('notifyOnlyMine', '') === 'true';
    document.getElementById('notifyOnlyMineToggle').classList.toggle('active', notifyOn);
    document.getElementById('notifyOnlyMineToggle').setAttribute('aria-checked', notifyOn);
    document.getElementById('themeToggle').classList.toggle('active', currentTheme === 'light');
    document.getElementById('themeToggle').setAttribute('aria-checked', currentTheme === 'light');

    const ws = document.getElementById('settingsWarehouse');
    const saved = lsGet('defaultWarehouse', '');
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            ws.innerHTML = '<option value="">\u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D</option>' +
                data.map(s => `<option value="${s.guid}" ${s.guid === saved ? 'selected' : ''}>${s.name}</option>`).join('');
        });

    modal.show();
}

function loadProfile() {
    return fetchDeduped('/api/profile', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const p = data.profile;
            if (!p) return;
            for (const key of Object.keys(p)) {
                if (p[key]) lsSet(key, p[key]);
            }
            if (p.profileName && p.profileName !== savedProfileName) {
                savedProfileName = p.profileName;
            }
            if (p.defaultWarehouse) {
                lsSet('defaultWarehouse', p.defaultWarehouse);
            }
            if (p.theme && p.theme !== currentTheme) {
                applyTheme(p.theme);
            }
            updateProfileAvatar();
            const profileNameInput = document.getElementById('profileName');
            if (profileNameInput && !profileNameInput.value && savedProfileName) {
                profileNameInput.value = savedProfileName;
            }
        })
        .catch(() => {});
}

function saveProfile() {
    savedProfileName = document.getElementById('profileName').value.trim();
    lsSet('profileName', savedProfileName);
    const warehouseGuid = document.getElementById('settingsWarehouse').value;
    lsSet('defaultWarehouse', warehouseGuid);
    const markMyTasks = document.getElementById('markMyTasksToggle').classList.contains('active') ? 'true' : '';
    lsSet('markMyTasks', markMyTasks);
    const myTaskKeywords = document.getElementById('myTaskKeywords').value.trim();
    lsSet('myTaskKeywords', myTaskKeywords);
    const notifyOnlyMine = document.getElementById('notifyOnlyMineToggle').classList.contains('active') ? 'true' : '';
    lsSet('notifyOnlyMine', notifyOnlyMine);
    updateProfileAvatar();

    fetch('/api/profile', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            profile: {
                profileName: savedProfileName,
                defaultWarehouse: warehouseGuid,
                theme: currentTheme,
                markMyTasks: markMyTasks,
                myTaskKeywords: myTaskKeywords,
                notifyOnlyMine: notifyOnlyMine,
            }
        })
    }).catch(() => {});
}

function clearUserCache() {
    showConfirm('\u0412\u044B \u0443\u0432\u0435\u0440\u0435\u043D\u044B, \u0447\u0442\u043E \u0445\u043E\u0442\u0438\u0442\u0435 \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u043A\u0435\u0448? \u042D\u0442\u043E \u0443\u0434\u0430\u043B\u0438\u0442 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F, \u0441\u043D\u0438\u043C\u043A\u0438 \u0441\u043A\u043B\u0430\u0434\u043E\u0432, push-\u043F\u043E\u0434\u043F\u0438\u0441\u043A\u0438 \u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C. \u041F\u043E\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u044B\u0439 \u0432\u0445\u043E\u0434.')
        .then(ok => {
            if (!ok) return;
            const btn = document.querySelector('button[onclick="clearUserCache()"]');
            if (btn) btn.disabled = true;

            fetch('/api/profile/clear-cache', {method: 'POST'})
                .then(checkAuth).then(r => r.json())
                .then(data => {
                    if (data.success) {
                        showAlert('\u041A\u0435\u0448 \u043E\u0447\u0438\u0449\u0435\u043D. \u0412\u044B \u0431\u0443\u0434\u0435\u0442\u0435 \u043F\u0435\u0440\u0435\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u044B \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443 \u0432\u0445\u043E\u0434\u0430.', 'success');
                        window.location.href = '/logout';
                    } else {
                        showAlert('\u041E\u0448\u0438\u0431\u043A\u0430: ' + (data.error || '\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430'), 'danger');
                    }
                })
                .catch(err => {
                    showAlert('\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u043E\u0447\u0438\u0441\u0442\u043A\u0435 \u043A\u0435\u0448\u0430: ' + err.message, 'danger');
                })
                .finally(() => {
                    if (btn) btn.disabled = false;
                });
        });
}

function updateProfileAvatar() {
    const avatar = document.getElementById('profileAvatar');
    if (!avatar) return;
    const name = savedProfileName || '?';
    avatar.textContent = name.charAt(0).toUpperCase();
    if (savedProfileName) {
        avatar.classList.add('has-name');
        avatar.title = savedProfileName;
    } else {
        avatar.classList.remove('has-name');
        avatar.title = '\u041F\u0440\u043E\u0444\u0438\u043B\u044C';
    }
}

// ============ NOTIFICATIONS ============
function renderNotifications(list, container) {
    if (!list || !list.length) {
        container.innerHTML = '<div class="text-muted small p-2">\u041D\u0435\u0442 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0439</div>';
        return;
    }
    container.innerHTML = list.map(n => {
        const typeClass = n.type === 'warehouse_arrival' ? 'type-arrival'
            : n.type === 'warehouse_writeoff' ? 'type-writeoff'
            : n.type === 'task_deadline' ? 'type-deadline'
            : n.type === 'new_task' ? 'type-new-task'
            : 'type-default';
        return `
        <div class="notification-card mb-1 ${typeClass}">
            <div class="notif-title">${esc(n.title)}</div>
            <div class="notif-description">${esc(n.description).replace(/\n/g, '<br>')}</div>
            <div class="notif-time">${timeAgo(n.created_at)}</div>
            ${n.type === 'warehouse_arrival' ? `<button class="notif-broken-btn" onclick="markArrivalBroken(${n.id}, this)" title="\u041E\u0442\u043C\u0435\u0442\u0438\u0442\u044C \u0432\u0435\u0441\u044C \u0442\u043E\u0432\u0430\u0440 \u043A\u0430\u043A \u0441\u043B\u043E\u043C\u0430\u043D\u043D\u044B\u0439">\uD83D\uDDD1\uFE0F</button>` : ''}
            <button class="btn-close notif-close" onclick="dismissNotification(${n.id})"></button>
        </div>`;
    }).join('');
}

function updateNotifBadge(list) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    const count = list && list.length ? list.length : 0;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

function loadNotifications(storageGuid, checkTasks) {
    const container = document.getElementById('notificationsList');
    if (!container) return;

    const params = [];
    if (storageGuid) params.push('storage=' + encodeURIComponent(storageGuid));
    if (checkTasks) params.push('check_tasks=1');
    const url = '/api/notifications' + (params.length ? '?' + params.join('&') : '');
    fetchDeduped(url, undefined, 30000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(list => {
            renderNotifications(list, container);
            updateNotifBadge(list);
            const dropdownList = document.getElementById('notifDropdownList');
            if (dropdownList) renderNotifications(list, dropdownList);
        })
        .catch(() => {
            container.innerHTML = '<div class="text-muted small">\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438</div>';
            updateNotifBadge(null);
        });
}

function toggleMobileNotifications() {
    const el = document.getElementById('notifDropdown');
    if (!el) return;
    el.classList.toggle('show');
}

document.addEventListener('click', function(e) {
    const dd = document.getElementById('notifDropdown');
    const bell = document.getElementById('notifBell');
    if (dd && dd.classList.contains('show') && !dd.contains(e.target) && !bell?.contains(e.target)) {
        dd.classList.remove('show');
    }
});

function dismissAllNotifications() {
    const container = document.getElementById('notificationsList');
    if (container) container.innerHTML = '<div class="text-muted small">\u041E\u0447\u0438\u0441\u0442\u043A\u0430...</div>';
    const storage = document.getElementById('storageSelect')?.value || '';
    for (const key of reqCache.keys()) {
        if (key.startsWith('/api/notifications')) reqCache.delete(key);
    }
    document.getElementById('notifDropdown')?.classList.remove('show');
    fetch('/api/notifications/dismiss-all', {method: 'POST'})
        .then(checkAuth)
        .then(() => { loadNotifications(storage); })
        .catch(() => {
            if (container) container.innerHTML = '<div class="text-muted small">\u041E\u0448\u0438\u0431\u043A\u0430</div>';
        });
}

function markArrivalBroken(notifId, btn) {
    if (!confirm('\u041E\u0442\u043C\u0435\u0442\u0438\u0442\u044C \u0432\u0435\u0441\u044C \u043F\u043E\u0441\u0442\u0443\u043F\u0438\u0432\u0448\u0438\u0439 \u0442\u043E\u0432\u0430\u0440 \u043A\u0430\u043A \u0441\u043B\u043E\u043C\u0430\u043D\u043D\u044B\u0439?')) return;
    btn.disabled = true;
    const storage = document.getElementById('storageSelect')?.value || '';
    fetch(`/api/notifications/${notifId}/mark-broken`, {method: 'POST'})
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            if (data.ok) {
                dismissNotification(notifId);
                if (typeof loadBalances === 'function') loadBalances();
            }
        })
        .catch(() => { btn.disabled = false; });
}

function dismissNotification(id) {
    const storage = document.getElementById('storageSelect')?.value || '';
    const container = document.getElementById('notificationsList');
    fetch(`/api/notifications/${id}/dismiss`, {method: 'POST'})
        .then(checkAuth)
        .then(() => {
            for (const key of reqCache.keys()) {
                if (key.startsWith('/api/notifications')) reqCache.delete(key);
            }
            loadNotifications(storage);
        })
        .catch(() => {
            if (container) {
                container.innerHTML = '<div class="text-muted small">\u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u0440\u0438 \u043E\u0447\u0438\u0441\u0442\u043A\u0435</div>';
                setTimeout(() => loadNotifications(storage), 2000);
            }
        });
}

// ============ ANNOUNCEMENTS ============
function loadAnnouncements() {
    const container = document.getElementById('announcementsList');
    if (!container) return;

    fetchDeduped('/api/announcements', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(list => {
            if (!list || !list.length) {
                container.innerHTML = '<div class="text-muted small">\u041D\u0435\u0442 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0439</div>';
                return;
            }
            container.innerHTML = list.map(a => `
                <div class="announcement-card mb-1">
                    <div class="ann-title">${esc(a.title)}</div>
                    <div class="ann-content">${esc(a.content)}</div>
                    <div class="ann-time">${timeAgo(a.created_at)}</div>
                </div>
            `).join('');
        })
        .catch(() => {
            container.innerHTML = '<div class="text-muted small">\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438</div>';
        });
}

function toggleAnnouncements() {
    const list = document.getElementById('announcementsList');
    const icon = document.getElementById('annToggleIcon');
    if (!list || !icon) return;
    const collapsed = list.classList.toggle('announcements-collapsed');
    icon.className = 'bi bi-chevron-' + (collapsed ? 'up' : 'down');
}

// ============ WEB PUSH ============
async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || document.body.classList.contains('login-page')) return;
    try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        const resp = await fetch('/api/push/vapid-public-key');
        const { publicKey } = await resp.json();
        if (!publicKey) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
            });
        }
        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub.toJSON()),
        });
    } catch (e) {
        console.warn('Push init failed', e);
    }
}

// ============ ANDROID BACK BUTTON ============
document.addEventListener('shown.bs.modal', () => {
    history.pushState(null, '');
});
window.addEventListener('popstate', () => {
    const modal = document.querySelector('.modal.show');
    if (modal) bootstrap.Modal.getInstance(modal)?.hide();
});

// ============ STARTUP ============
function runStartup() {
    const ov = document.getElementById('startupOverlay');
    if (!ov) return;
    if (sessionStorage.getItem('startupDone')) {
        ov.style.display = 'none';
        return;
    }
    setTimeout(() => {
        ov.classList.add('hide');
        sessionStorage.setItem('startupDone', '1');
        setTimeout(() => {
            ov.style.display = 'none';
        }, 600);
    }, 1600);
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    if (document.body.classList.contains('login-page')) return;

    runStartup();
    initPushNotifications();
    applyTheme(currentTheme);
    updateProfileAvatar();

    loadProfile();

    loadNotifications('', true);
    loadAnnouncements();

    setInterval(() => { if (isWorkingHours()) loadNotifications('', true); }, 600000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isWorkingHours()) {
            const now = Date.now();
            for (const [key, entry] of reqCache) {
                if (now - entry.ts > 30 * 60 * 1000) reqCache.delete(key);
            }
            loadNotifications('', true);
        }
    });

    window.addEventListener('scroll', () => {
        const btn = document.getElementById('scrollTopBtn');
        if (btn) btn.classList.toggle('show', window.scrollY > 400);
    });
});

// ============ PWA INSTALL ============
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    const section = document.getElementById('installAppSection');
    if (section) section.classList.remove('d-none');
});
window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const section = document.getElementById('installAppSection');
    if (section) section.classList.add('d-none');
});

function installApp() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(result => {
        deferredPrompt = null;
        const section = document.getElementById('installAppSection');
        if (section) section.classList.add('d-none');
    });
}
