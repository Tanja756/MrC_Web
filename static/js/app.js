// ============ STATE ============
let pinnedTasks = lsGetJSON('pinnedTasks', []);
let taskLocations = lsGetJSON('taskLocations', {});
let clientsMap = {};

let savedProfileName = lsGet('profileName', '');
let currentTheme = lsGet('theme', 'dark');
// ============ РАЗДЕЛЕНИЕ ПАРАМЕТРОВ ПРОФИЛЯ ============
// Параметры, важные для работы сервера: синхронизируются через /api/profile.
// Сервер читает их при push-уведомлениях (myTaskKeywords, notifyOnlyMine,
// notifyAllWarehouses) и возвратах на склад (defaultWarehouse).
const SERVER_PROFILE_KEYS = [
    'profileName', 'defaultWarehouse', 'myTaskKeywords', 'notifyOnlyMine',
    'notifyAllWarehouses'
];
// Параметры, которые сервер только отдаёт (файл аватара хранится на сервере).
const SERVER_READONLY_PROFILE_KEYS = ['avatarUrl'];
// Настройки конкретного устройства (theme, markMyTasks, merryMilkman,
// defaultDepartment): живут в localStorage и при обычной работе с сервера не
// перезаписываются, поэтому не конфликтуют при входе под одним пользователем
// с разных устройств. Сервер хранит их как резервную копию: она применяется
// только когда на устройстве настройки ещё нет (первый вход, очистка данных
// браузера) — см. loadProfile().
const SERVER_BACKUP_LOCAL_KEYS = ['theme', 'markMyTasks', 'merryMilkman', 'defaultDepartment'];
// Из настроек-резервных копий строковые параметры восстанавливаем и когда
// локальное значение пустое ('' = «не настроено»), а переключатели — только
// когда ключа нет вовсе (у них '' означает «выключено»).
const SERVER_BACKUP_STRING_KEYS = ['profileName', 'myTaskKeywords', 'defaultWarehouse', 'defaultDepartment'];
// Переключатели хранятся в localStorage как 'true' (включено) или '' (выключено).
const LOCAL_BOOLEAN_KEYS = ['markMyTasks', 'merryMilkman', 'notifyOnlyMine', 'notifyAllWarehouses'];

function lsRaw(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

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
    saveProfile();
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

function toggleNotifyAllWarehouses() {
    const el = document.getElementById('notifyAllWarehousesToggle');
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on);
    saveProfile();
}

function toggleMerryMilkman() {
    const el = document.getElementById('merryMilkmanToggle');
    const on = !el.classList.contains('active');
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', on);
    saveProfile();
    applyMerryMilkman();
}

var __currentMerryEffect = null;

function applyMerryMilkman() {
    var isOn = lsGet('merryMilkman', '') === 'true';

    if (window.__funEffectsCleanup) {
        window.__funEffectsCleanup.forEach(function(fn) { fn(); });
        window.__funEffectsCleanup.length = 0;
    }
    document.querySelectorAll('[data-fun]').forEach(function(el) { el.remove(); });
    __currentMerryEffect = null;

    if (!isOn) return;

    var chosen = 'confetti';
    __currentMerryEffect = chosen;

    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/static/fun-effects/confetti/effect.css';
    link.dataset.fun = chosen;
    document.head.appendChild(link);

    var script = document.createElement('script');
    script.src = '/static/fun-effects/confetti/effect.js';
    script.dataset.fun = chosen;
    document.body.appendChild(script);
}

function openProfileModal() {
    const modal = new bootstrap.Modal(document.getElementById('profileModal'));
    document.getElementById('profileName').value = savedProfileName;
    const avatar = document.getElementById('profileAvatarPreview');
    const avatarUrl = lsGet('avatarUrl', '');
    let avatarImg = avatar.querySelector('img');
    if (avatarUrl) {
        if (avatarImg) {
            avatarImg.src = avatarUrl;
        } else {
            avatar.innerHTML = '<img src="' + avatarUrl + '" class="profile-avatar-img">';
        }
    } else {
        const name = savedProfileName || '?';
        avatar.textContent = name.charAt(0).toUpperCase();
    }
    document.getElementById('removeAvatarBtn').style.display = avatarUrl ? '' : 'none';
    const mmOn = lsGet('merryMilkman', '') === 'true';
    const mmEl = document.getElementById('merryMilkmanToggle');
    if (mmEl) {
        mmEl.classList.toggle('active', mmOn);
        mmEl.setAttribute('aria-checked', mmOn);
    }
    modal.show();
}

function openSettings(firstLogin) {
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    if (firstLogin) {
        document.querySelector('#settingsModal .modal-title').innerHTML = '<i class="bi bi-person-check me-2"></i>\u0414\u043E\u0431\u0440\u043E \u043F\u043E\u0436\u0430\u043B\u043E\u0432\u0430\u0442\u044C! \u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438';
    }
    document.getElementById('themeToggle').classList.toggle('active', currentTheme === 'light');
    document.getElementById('themeToggle').setAttribute('aria-checked', currentTheme === 'light');

    const ws = document.getElementById('settingsWarehouse');
    const saved = lsGet('defaultWarehouse', '');
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            ws.innerHTML = '<option value="">Не выбран</option>' +
                data.map(s => `<option value="${s.guid}" ${s.guid === saved ? 'selected' : ''}>${s.name}</option>`).join('');
        });

    modal.show();
}

function openNotificationsModal() {
    const modal = new bootstrap.Modal(document.getElementById('notificationsModal'));
    const markOn = lsGet('markMyTasks', '') === 'true';
    document.getElementById('markMyTasksToggle').classList.toggle('active', markOn);
    document.getElementById('markMyTasksToggle').setAttribute('aria-checked', markOn);
    document.getElementById('myTaskKeywords').value = lsGet('myTaskKeywords', '');
    const notifyOn = lsGet('notifyOnlyMine', '') === 'true';
    document.getElementById('notifyOnlyMineToggle').classList.toggle('active', notifyOn);
    document.getElementById('notifyOnlyMineToggle').setAttribute('aria-checked', notifyOn);
    const notifyAll = lsGet('notifyAllWarehouses', 'true') === 'true';
    document.getElementById('notifyAllWarehousesToggle').classList.toggle('active', notifyAll);
    document.getElementById('notifyAllWarehousesToggle').setAttribute('aria-checked', notifyAll);
    modal.show();
}

function loadProfile() {
    return fetchDeduped('/api/profile', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const p = data.profile;
            if (!p) return;
            // Синхронизируемые с сервером параметры + настройки устройства:
            // применяем значение с сервера ТОЛЬКО если на этом устройстве ключа
            // ещё нет (первый вход на устройстве, очистка данных браузера).
            // Уже сохранённые на устройстве значения не перезаписываются —
            // у каждого устройства свои настройки, конфликтов между
            // устройствами при входе под одним пользователем нет.
            const restoreKeys = SERVER_PROFILE_KEYS.concat(SERVER_BACKUP_LOCAL_KEYS);
            let themeRestored = false;
            for (const key of restoreKeys) {
                if (p[key] === undefined || p[key] === null) continue;
                const localVal = lsRaw(key);
                // Пустое значение строковой настройки считаем «не настроено»
                // и тоже восстанавливаем; '' у переключателя — это «выключено».
                const canRestore = localVal === null ||
                    (localVal === '' && SERVER_BACKUP_STRING_KEYS.includes(key));
                if (!canRestore) continue;
                const val = LOCAL_BOOLEAN_KEYS.includes(key)
                    ? (p[key] === 'true' || p[key] === true ? 'true' : '')
                    : String(p[key]);
                lsSet(key, val);
                if (key === 'theme') themeRestored = true;
            }
            // Параметры, которые сервер только отдаёт (avatarUrl): источник
            // истины — сервер, значение всегда берём оттуда.
            for (const key of SERVER_READONLY_PROFILE_KEYS) {
                if (p[key] !== undefined && p[key] !== null) lsSet(key, p[key]);
            }
            if (p.profileName && p.profileName !== savedProfileName) {
                savedProfileName = p.profileName;
            }
            if (themeRestored) applyTheme(lsGet('theme', 'dark'));
            updateProfileAvatar();
            const menuName = document.getElementById('menuProfileName');
            if (menuName && savedProfileName) menuName.textContent = savedProfileName;
        })
        .catch(() => {});
}

function saveProfile() {
    const pNameEl = document.getElementById('profileName');
    if (pNameEl) {
        savedProfileName = pNameEl.value.trim();
        lsSet('profileName', savedProfileName);
    }
    const warehouseEl = document.getElementById('settingsWarehouse');
    if (warehouseEl) lsSet('defaultWarehouse', warehouseEl.value);
    const mmtEl = document.getElementById('markMyTasksToggle');
    if (mmtEl) lsSet('markMyTasks', mmtEl.classList.contains('active') ? 'true' : '');
    const kwEl = document.getElementById('myTaskKeywords');
    if (kwEl) lsSet('myTaskKeywords', kwEl.value.trim());
    const nomEl = document.getElementById('notifyOnlyMineToggle');
    if (nomEl) lsSet('notifyOnlyMine', nomEl.classList.contains('active') ? 'true' : '');
    const nawEl = document.getElementById('notifyAllWarehousesToggle');
    if (nawEl) lsSet('notifyAllWarehouses', nawEl.classList.contains('active') ? 'true' : '');
    const mmEl = document.getElementById('merryMilkmanToggle');
    if (mmEl) lsSet('merryMilkman', mmEl.classList.contains('active') ? 'true' : '');
    updateProfileAvatar();

    // На сервер отправляем параметры, важные для его работы, и настройки
    // устройства — сервер хранит их как резервную копию, чтобы восстановить
    // на новом устройстве (см. loadProfile).
    const prof = {
        profileName: savedProfileName,
        defaultWarehouse: lsGet('defaultWarehouse', ''),
        myTaskKeywords: lsGet('myTaskKeywords', ''),
        notifyOnlyMine: lsGet('notifyOnlyMine', ''),
        notifyAllWarehouses: lsGet('notifyAllWarehouses', ''),
        theme: lsGet('theme', 'dark'),
        markMyTasks: lsGet('markMyTasks', ''),
        merryMilkman: lsGet('merryMilkman', ''),
    };

    return fetch('/api/profile', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ profile: prof })
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
    const avatarUrl = lsGet('avatarUrl', '');
    if (avatarUrl) {
        avatar.innerHTML = '<img src="' + avatarUrl + '" class="profile-avatar-img">';
        avatar.title = savedProfileName || '';
    } else {
        const name = savedProfileName || '?';
        avatar.textContent = name.charAt(0).toUpperCase();
        avatar.title = savedProfileName || '\u041F\u0440\u043E\u0444\u0438\u043B\u044C';
    }
    if (savedProfileName) {
        avatar.classList.add('has-name');
    } else {
        avatar.classList.remove('has-name');
    }
}

function uploadAvatar(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
        showAlert('Файл слишком большой. Максимум 2 МБ.', 'danger');
        return;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    fetch('/api/profile/avatar', { method: 'POST', body: formData })
        .then(r => r.json())
        .then(data => {
            if (data.avatarUrl) {
                lsSet('avatarUrl', data.avatarUrl);
                updateProfileAvatar();
                const preview = document.getElementById('profileAvatarPreview');
                preview.innerHTML = '<img src="' + data.avatarUrl + '" class="profile-avatar-img">';
                document.getElementById('removeAvatarBtn').style.display = '';
            }
        })
        .catch(() => showAlert('Ошибка загрузки аватара', 'danger'));
}

function removeAvatar() {
    fetch('/api/profile/avatar', { method: 'DELETE' })
        .then(r => r.json())
        .then(() => {
            lsSet('avatarUrl', '');
            updateProfileAvatar();
            const preview = document.getElementById('profileAvatarPreview');
            const name = savedProfileName || '?';
            preview.textContent = name.charAt(0).toUpperCase();
            document.getElementById('removeAvatarBtn').style.display = 'none';
        })
        .catch(() => showAlert('Ошибка удаления аватара', 'danger'));
}

// ============ NOTIFICATIONS ============
var knownNotifIds = {};
var notifIdsInitialized = false;

function checkNewNotifications(list) {
    if (!Array.isArray(list)) return;
    if (!notifIdsInitialized) {
        list.forEach(function(n) { knownNotifIds[n.id] = true; });
        notifIdsInitialized = true;
        return;
    }
    list.forEach(function(n) {
        if (!knownNotifIds[n.id]) {
            var icon = n.type === 'warehouse_arrival' ? 'success' : n.type === 'warehouse_writeoff' ? 'error' : n.type === 'task_deadline' ? 'clock' : n.type === 'new_task' ? 'message' : 'message';
            var title = n.type === 'warehouse_arrival' ? 'Приход товара' : n.type === 'warehouse_writeoff' ? 'Списание товара' : n.type === 'task_deadline' ? 'Дедлайн задачи' : n.type === 'new_task' ? 'Новая задача' : 'Уведомление';
            NotificationCenter.show({ icon: icon, title: title, subtitle: n.title || n.description || '', actions: ['OK'], duration: 8000 });
            knownNotifIds[n.id] = true;
        }
    });
}

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
            checkNewNotifications(list);
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
    knownNotifIds = {};
    notifIdsInitialized = false;
    const storage = document.getElementById('storageSelect')?.value || '';
    cacheClearPrefix('/api/notifications');

    document.getElementById('notifDropdown')?.classList.remove('show');
    fetch('/api/notifications/dismiss-all', {method: 'POST'})
        .then(checkAuth)
        .then(() => {
            NotificationCenter.show({ icon: 'success', title: 'Уведомления очищены', actions: ['OK'], duration: 4000 });
            loadNotifications(storage);
        })
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
            cacheClearPrefix('/api/notifications');
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

// ============ PERMISSIONS ============
function requestPermissions() {
    if (document.body.classList.contains('login-page')) return;

    // Notifications
    if ('Notification' in window) {
        if (Notification.permission === 'default') {
            NotificationCenter.show({
                icon: 'message', title: 'Уведомления',
                subtitle: 'Для получения уведомлений о новых задачах разрешите показ уведомлений',
                actions: ['OK'], duration: 4000
            });
            Notification.requestPermission();
        } else if (Notification.permission === 'denied') {
            NotificationCenter.show({
                icon: 'warning', title: 'Уведомления',
                subtitle: 'Уведомления отключены. Включите их в настройках браузера.',
                actions: ['OK'], duration: 5000
            });
        }
    }

    // Geolocation
    if ('geolocation' in navigator && 'permissions' in navigator) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (result) {
            if (result.state === 'prompt') {
                NotificationCenter.show({
                    icon: 'message', title: 'Геолокация',
                    subtitle: 'Для автоматической фиксации местоположения при закрытии задач разрешите геолокацию',
                    actions: ['OK'], duration: 4000
                });
                navigator.geolocation.getCurrentPosition(function () {}, function () {}, { timeout: 3000 });
            } else if (result.state === 'denied') {
                NotificationCenter.show({
                    icon: 'warning', title: 'Геолокация',
                    subtitle: 'Геолокация отключена. Включите её в настройках браузера.',
                    actions: ['OK'], duration: 5000
                });
            }
        }).catch(function () {});
    }
}

// ============ STARTUP ============
// Заставка «приёмка смены»: пока грузится приложение, Mr.Check подшучивает,
// прогресс бодро бежит до 92%, «зависает» (секундочку...), затем добегает и
// шлёпает печать «ПРОВЕРЕНО» с искрами. В «молочном режиме» (merryMilkman)
// строки и искры — молочные.
var STARTUP_TIPS = [
    'Считаю пломбы…',
    'Договариваюсь с 1С…',
    'Проверяю, не убежало ли молоко…',
    'Натираю склад до блеска…',
    'Ищу свободные заявки…',
    'Сверяюсь с холодильником…',
    'Расставляю приоритеты…',
    'Почти готово. Ну, почти…'
];
var STARTUP_MERRY_TIPS = [
    'Молочный режим: ВКЛ 🥛',
    'Надоил на 300%…'
];

function startupReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
}

// Искры от печати; в молочном режиме их больше и часть — эмодзи молока.
function startupSparks(merry) {
    var ov = document.getElementById('startupOverlay');
    if (!ov) return;
    // Сыплем из печати (центр «героя»), иначе — из центра оверлея.
    var host = document.querySelector('.startup-hero') || ov;
    var total = merry ? 26 : 10;
    for (var i = 0; i < total; i++) {
        var spark = document.createElement('span');
        var isMilk = merry && i % 4 === 0;
        spark.className = 'startup-spark' + (isMilk ? ' startup-spark-milk' : '');
        if (isMilk) spark.textContent = '🥛';
        spark.style.setProperty('--dx', (Math.random() - 0.5) * 340 + 'px');
        spark.style.setProperty('--dy', (Math.random() * -260 - 60) + 'px');
        spark.style.setProperty('--r', Math.random() * 720 + 'deg');
        host.appendChild(spark);
        (function (el) { setTimeout(function () { el.remove(); }, 1400); })(spark);
    }
}

function runStartup() {
    const ov = document.getElementById('startupOverlay');
    if (!ov) return;

    try {
        if (sessionStorage.getItem('startupDone')) {
            ov.style.display = 'none';
            return;
        }
    } catch (e) {}

    const finish = (immediate) => {
        try { sessionStorage.setItem('startupDone', '1'); } catch (e) {}
        ov.classList.add('hide');
        if (immediate) { ov.style.display = 'none'; return; }
        setTimeout(() => { ov.style.display = 'none'; }, 600);
    };

    // Пользователь просил меньше движения — не мучаем его анимацией.
    if (startupReducedMotion()) { finish(true); return; }

    const statusEl = document.getElementById('startupStatus');
    const fillEl = document.getElementById('startupBarFill');
    const pctEl = document.getElementById('startupPct');

    let merry = false;
    try { merry = lsGet('merryMilkman', '') === 'true'; } catch (e) {}
    const tips = (merry ? STARTUP_MERRY_TIPS : []).concat(STARTUP_TIPS);

    const setTip = text => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.remove('startup-tip-in');
        void statusEl.offsetWidth; // перезапуск анимации появления
        statusEl.classList.add('startup-tip-in');
    };
    setTip(tips[0]);

    let tipIdx = 0;
    const tipTimer = setInterval(() => {
        tipIdx++;
        if (tipIdx >= tips.length) { clearInterval(tipTimer); return; }
        setTip(tips[tipIdx]);
    }, 330);

    // Прогресс: 0→92% за STALL_FROM мс, пауза-интрига, потом финиш.
    const DURATION = 1500, STALL_FROM = 780, STALL_TO = 1080;
    const t0 = Date.now();
    let finished = false;

    const paint = () => {
        const elapsed = Date.now() - t0;
        let pct;
        if (elapsed <= STALL_FROM) pct = (elapsed / STALL_FROM) * 92;
        else if (elapsed <= STALL_TO) pct = 92;
        else pct = 92 + ((elapsed - STALL_TO) / Math.max(1, DURATION - STALL_TO)) * 8;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        if (fillEl) fillEl.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (pct < 100 || finished) return;
        finished = true;
        clearInterval(barTimer);
        clearInterval(tipTimer);
        setTip('Смена принята. Работаем!');
        ov.classList.add('stamped');
        startupSparks(merry);
        setTimeout(finish, 220);
    };

    const barTimer = setInterval(paint, 40);
    paint();
}

// ============ INIT ============
refreshOnReconnect = function() {
    if (typeof loadMyTasks === 'function') loadMyTasks();
    if (typeof loadFreeTasks === 'function') loadFreeTasks();
    if (typeof loadClosedTasks === 'function') loadClosedTasks();
    loadNotifications('', true);
    loadProfile().then(function() { applyMerryMilkman(); });
};

document.addEventListener('DOMContentLoaded', () => {
    if (document.body.classList.contains('login-page')) return;

    runStartup();
    requestPermissions();
    initPushNotifications();
    applyTheme(currentTheme);
    updateProfileAvatar();

    loadProfile().then(function() { applyMerryMilkman(); });

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

    window.addEventListener('online', () => {
        fetch('/api/ping', {cache: 'no-store'}).then(r => { if (r.ok) setServerOnline(); }).catch(() => {});
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
