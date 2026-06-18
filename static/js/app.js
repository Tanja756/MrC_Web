// ============ UTILITY ============

// Request deduplication + in-memory cache (avoids redundant fetches on slow networks)
const inflight = new Map();
const reqCache = new Map();
function fetchDeduped(url, options, ttl) {
  const key = url + (options ? JSON.stringify(options) : '');
  if (inflight.has(key)) return inflight.get(key);
  if (ttl && reqCache.has(key)) {
    const cached = reqCache.get(key);
    if (Date.now() - cached.ts < ttl) return Promise.resolve(cached.data);
    reqCache.delete(key);
  }
  const p = fetch(url, options).then(r => {
    inflight.delete(key);
    if (r.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.includes('json') && ttl) {
      return r.clone().json().then(data => {
        reqCache.set(key, { data, ts: Date.now() });
        return data;
      });
    }
    return r;
  }).catch(e => {
    inflight.delete(key);
    throw e;
  });
  inflight.set(key, p);
  return p;
}

const currentStorage = () => document.getElementById('storageSelect')?.value || '';

// Android back button — close modals instead of navigating away
document.addEventListener('shown.bs.modal', () => {
    if (!document.querySelectorAll('.modal.show').length) {
        history.pushState(null, '');
    }
});
window.addEventListener('popstate', () => {
    const modal = document.querySelector('.modal.show');
    if (modal) bootstrap.Modal.getInstance(modal)?.hide();
});

// ============ SWIPE GESTURES (MOBILE) ============

const TAB_ORDER = ['tasks-tab', 'warehouse-tab', 'salary-tab', 'reports-tab'];
const TASK_PILL_SELECTOR = '#taskTabs .nav-link';

let touchStartX = 0, touchDeltaX = 0;
let isSwiping = false;

document.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    touchStartX = t.clientX;
    touchDeltaX = 0;
    isSwiping = true;
}, {passive: true});

document.addEventListener('touchmove', e => {
    if (!isSwiping) return;
    const t = e.changedTouches[0];
    touchDeltaX = t.clientX - touchStartX;
}, {passive: true});

document.addEventListener('touchend', e => {
    if (!isSwiping) return;
    isSwiping = false;
    if (Math.abs(touchDeltaX) < 80) return;
    if (document.querySelector('.modal.show')) return;

    const activeMain = document.querySelector('#mainTabs .nav-link.active');
    if (!activeMain) return;

    if (activeMain.id === 'tasks-tab') {
        const pills = document.querySelectorAll(TASK_PILL_SELECTOR);
        const activePill = document.querySelector(TASK_PILL_SELECTOR + '.active');
        const idx = Array.from(pills).indexOf(activePill);
        if (idx === -1) return;
        const next = touchDeltaX < 0 ? pills[idx + 1] : pills[idx - 1];
        if (next) bootstrap.Tab.getOrCreateInstance(next).show();
        return;
    }

    const idx = TAB_ORDER.indexOf(activeMain.id);
    if (idx === -1) return;
    const next = touchDeltaX < 0 ? TAB_ORDER[idx + 1] : TAB_ORDER[idx - 1];
    if (next) bootstrap.Tab.getOrCreateInstance(document.getElementById(next)).show();
}, {passive: true});

// ============ CUSTOM ALERT / CONFIRM ============

function showAlert(message, type) {
    type = type || 'info';
    const modalEl = document.getElementById('alertModal');
    const header = document.getElementById('alertModalHeader');
    const title = document.getElementById('alertModalTitle');
    const body = document.getElementById('alertModalBody');

    header.className = 'modal-header';
    if (type === 'danger') {
        header.classList.add('bg-danger', 'text-white');
        title.innerHTML = '<i class="bi bi-x-circle me-2"></i>Ошибка';
    } else if (type === 'success') {
        header.classList.add('bg-success', 'text-white');
        title.innerHTML = '<i class="bi bi-check-circle me-2"></i>Успех';
    } else if (type === 'warning') {
        header.classList.add('bg-warning');
        title.innerHTML = '<i class="bi bi-exclamation-triangle me-2"></i>Предупреждение';
    } else {
        title.innerHTML = '<i class="bi bi-info-circle me-2"></i>Сообщение';
    }

    body.textContent = message;
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
}

function showConfirm(message) {
    return new Promise(resolve => {
        const modalEl = document.getElementById('confirmModal');
        const body = document.getElementById('confirmModalBody');
        const yesBtn = document.getElementById('confirmModalYes');
        const noBtn = document.getElementById('confirmModalNo');

        body.textContent = message;

        const modal = new bootstrap.Modal(modalEl);

        const cleanup = () => {
            modal.hide();
            modalEl.removeEventListener('hidden.bs.modal', onHide);
            yesBtn.removeEventListener('click', onYes);
            noBtn.removeEventListener('click', onNo);
        };

        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };
        const onHide = () => { cleanup(); resolve(false); };

        modalEl.addEventListener('hidden.bs.modal', onHide);
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);

        modal.show();
    });
}

function toggleFilter(el) {
    el.closest('.filter-bar').classList.toggle('show');
}

function toggleDocSection(header) {
    const body = header.nextElementSibling;
    const isHidden = body.classList.toggle('d-none');
    const icon = header.querySelector('.bi');
    icon.className = 'bi bi-chevron-' + (isHidden ? 'down' : 'up') + ' ms-auto';
}

// Parse 1C date format: "dd.MM.yyyy HH:mm:ss"
function parseDate(str) {
    if (!str) return null;
    const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]);

    const m2 = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) return new Date(+m2[3], +m2[2]-1, +m2[1]);

    const m3 = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3], +m3[4], +m3[5], +m3[6]);

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function formatDate(str) {
    const d = parseDate(str);
    if (!d) return '—';
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${dd}.${mm}.${yy} ${hh}:${mi}`;
}

function formatDateShort(str) {
    const d = parseDate(str);
    if (!d) return '—';
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
}

function formatHours(hours) {
    if (hours == null || isNaN(hours)) return '—';
    if (hours < 0) return '0 ч';
    if (hours < 1) return `${Math.round(hours * 60)} мин`;
    if (hours < 24) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
    }
    const days = Math.floor(hours / 24);
    const remain = hours - days * 24;
    const h = Math.floor(remain);
    const m = Math.round((remain - h) * 60);
    let result = `${days} дн`;
    if (h > 0) result += ` ${h} ч`;
    if (m > 0) result += ` ${m} мин`;
    return result;
}

function formatComments(comments) {
    if (!comments || !comments.length) return '<p class="mb-0 text-muted">—</p>';
    return comments.map(c =>
        `<div class="mb-2 p-2 bg-light rounded-3"><small class="text-muted d-block">${c.author || ''} — ${formatDate(c.date) || ''}</small><p class="mb-0">${c.content || ''}</p></div>`
    ).join('');
}

// ============ STATE ============
function lsGet(key, def) {
    try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function lsGetJSON(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch {}
}

let pinnedTasks = lsGetJSON('pinnedTasks', []);
let tasksMy = [], tasksFree = [], tasksClosed = [];
let allBalances = [];
let currentDate = new Date();
let currentBalanceFilter = 'all';
let balanceSortField = 'date_arrival';
let balanceSortDir = 'desc';
let multiSelectMode = false;
let selectedGuids = new Set();
let pendingAttachments = [];
let pprPendingAttachments = [];
let taskLocations = lsGetJSON('taskLocations', {});
let clientsMap = {};  // guid → name

// Profile
let savedProfileName = lsGet('profileName', '');

// Theme
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
    if (label) label.textContent = theme === 'light' ? 'Светлая' : 'Тёмная';

    updateProfileAvatar();
}

function toggleTheme() {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
}

function openSettings(firstLogin) {
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    const titleEl = document.querySelector('#settingsModal .modal-title');
    if (firstLogin) {
        titleEl.innerHTML = '<i class="bi bi-person-check me-2"></i>Добро пожаловать! Заполните настройки';
    } else {
        titleEl.innerHTML = '<i class="bi bi-gear me-2"></i>Настройки';
    }
    document.getElementById('profileName').value = savedProfileName;
    document.getElementById('settingsModal').querySelector('.theme-toggle').classList.toggle('active', currentTheme === 'light');
    document.getElementById('settingsModal').querySelector('.theme-toggle').setAttribute('aria-checked', currentTheme === 'light');

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
            // Update form fields if settings modal is open
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
    updateProfileAvatar();

    fetch('/api/profile', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            profile: {
                profileName: savedProfileName,
                defaultWarehouse: warehouseGuid,
                theme: currentTheme,
            }
        })
    }).catch(() => {});
}

function clearUserCache() {
    showConfirm('Вы уверены, что хотите очистить кеш? Это удалит уведомления, снимки складов, push-подписки и сохранённый пароль. Потребуется повторный вход.')
        .then(ok => {
            if (!ok) return;

            const btn = document.querySelector('button[onclick="clearUserCache()"]');
            if (btn) btn.disabled = true;

            fetch('/api/profile/clear-cache', {method: 'POST'})
                .then(checkAuth).then(r => r.json())
                .then(data => {
                    if (data.success) {
                        showAlert('Кеш очищен. Вы будете перенаправлены на страницу входа.', 'success');
                        window.location.href = '/logout';
                    } else {
                        showAlert('Ошибка: ' + (data.error || 'Неизвестная ошибка'), 'danger');
                    }
                })
                .catch(err => {
                    showAlert('Ошибка при очистке кеша: ' + err.message, 'danger');
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
        avatar.title = 'Профиль';
    }
}

function cleanNumber(num) {
    if (!num) return '';
    return num.replace(/^0+/, '') || '0';
}

function clientName(guid) {
    return clientsMap[guid] || guid || '—';
}

function checkAuth(r) {
    if (r.status === 401) {
        window.location.href = '/login';
        throw new Error('Session expired');
    }
    return r;
}
