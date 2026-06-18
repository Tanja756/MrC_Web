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

// ============ WAREHOUSE ============
function loadStorages() {
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
    .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            const sel = document.getElementById('storageSelect');
            sel.innerHTML = '<option value="">Выберите склад...</option>' +
                data.map(s => `<option value="${s.guid}">${s.name}</option>`).join('');
            const saved = lsGet('defaultWarehouse', '');
            if (saved && [...sel.options].some(o => o.value === saved)) {
                sel.value = saved;
                loadBalances();
            }
        });
}

function loadBalances() {
    const guid = document.getElementById('storageSelect').value;
    if (!guid) {
        document.getElementById('balancesList').innerHTML = '<div class="empty-state"><i class="bi bi-shop"></i><p>Выберите склад</p></div>';
        return;
    }
    fetchDeduped(`/api/warehouse/balances?storage=${guid}`, undefined, 30000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            allBalances = data;
            filterBalances();
            loadNotifications(guid);
            loadAnnouncements();
        });
}

function refreshBalances() {
    const guid = document.getElementById('storageSelect').value;
    if (guid) {
        for (const key of reqCache.keys()) {
            if (key.startsWith('/api/warehouse/balances')) reqCache.delete(key);
        }
    }
    loadBalances();
}

function sortBalances(field) {
    if (balanceSortField === field) {
        balanceSortDir = balanceSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        balanceSortField = field;
        balanceSortDir = 'asc';
    }
    filterBalances();
}

function filterBalances() {
    const query = document.getElementById('balanceSearch').value.toLowerCase().trim();
    let filtered = allBalances;

    if (currentBalanceFilter === 'equipment')
        filtered = filtered.filter(b => b.series_name && !b.broken);
    else if (currentBalanceFilter === 'zip')
        filtered = filtered.filter(b => !b.series_name && !b.broken);
    else if (currentBalanceFilter === 'repair')
        filtered = filtered.filter(b => b.broken);

    if (query) {
        filtered = filtered.filter(b =>
            (b.product_name || '').toLowerCase().includes(query) ||
            (b.series_name || '').toLowerCase().includes(query) ||
            (b.inventory_number || '').toLowerCase().includes(query) ||
            (b.date_arrival || '').toLowerCase().includes(query) ||
            (b.broken && 'ремонт'.includes(query))
        );
    }

    // Sort broken items to the bottom
    filtered = [...filtered].sort((a, b) => {
        if (a.broken !== b.broken) return a.broken ? 1 : -1;
        if (balanceSortField) {
            const compare = (field, dir) => {
                let va = a[field], vb = b[field];
                if (va == null) va = '';
                if (vb == null) vb = '';
                if (field === 'balance') {
                    return (Number(va) || 0) - (Number(vb) || 0);
                }
                return String(va).localeCompare(String(vb), 'ru');
            };
            let cmp = compare(balanceSortField, balanceSortDir);
            if (cmp === 0) cmp = compare('product_name', 'asc');
            return balanceSortDir === 'asc' ? cmp : -cmp;
        }
        return 0;
    });

    const container = document.getElementById('balancesList');
    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-box-seam"></i><p>Нет остатков</p></div>';
        return;
    }

    const sortIcon = field => {
        if (field !== balanceSortField) return '';
        return balanceSortDir === 'asc'
            ? ' <i class="bi bi-sort-up"></i>'
            : ' <i class="bi bi-sort-down"></i>';
    };

    // Mobile: stacked cards
    const mobileHtml = filtered.map(b => `
        <div class="balance-mobile-card d-flex py-2 px-2 border-bottom${b.broken ? ' broken-item' : ''}">
            <div class="flex-grow-1 min-w-0 pe-2 overflow-hidden">
                <div class="fw-semibold text-truncate">${esc(b.product_name) || '—'}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.series_name ? 'Сер.: ' + esc(b.series_name) : ''}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.inventory_number ? 'Инв.: ' + esc(b.inventory_number) : ''}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.date_arrival ? 'Поступл.: ' + esc(b.date_arrival) : ''}</div>
                <label class="broken-toggle" onclick="event.stopPropagation()">
                    <input type="checkbox" ${b.broken ? 'checked' : ''} onchange="toggleBroken(this, '${esc(b.product_name)}', '${esc(b.series_name || '')}', '${esc(b.inventory_number || '')}', ${b.broken ? 'false' : 'true'})">
                    <span class="broken-label">На ремонт</span>
                </label>
            </div>
            <div class="fw-bold fs-5 text-end flex-shrink-0 align-self-center">${b.balance ?? 0}</div>
        </div>
    `).join('');

    // Desktop: table
    const desktopHtml = `<div class="table-responsive"><table class="table table-hover balance-table">
        <thead><tr>
            <th class="sortable" onclick="sortBalances('product_name')">Товар${sortIcon('product_name')}</th>
            <th class="sortable" onclick="sortBalances('series_name')">Серия${sortIcon('series_name')}</th>
            <th class="sortable" onclick="sortBalances('inventory_number')">Инв. номер${sortIcon('inventory_number')}</th>
            <th class="sortable" onclick="sortBalances('date_arrival')">Поступление${sortIcon('date_arrival')}</th>
            <th class="text-end sortable" onclick="sortBalances('balance')">Остаток${sortIcon('balance')}</th>
            <th class="text-center" style="width:90px">Ремонт</th>
        </tr></thead>
        <tbody>${filtered.map(b => `<tr class="${b.broken ? 'broken-item' : ''}">
            <td>${esc(b.product_name) || '—'}</td>
            <td>${esc(b.series_name) || '—'}</td>
            <td>${esc(b.inventory_number) || '—'}</td>
            <td style="font-size:0.75rem">${b.date_arrival || '—'}</td>
            <td class="text-end fw-bold">${b.balance ?? 0}</td>
            <td class="text-center">
                <label class="broken-toggle" onclick="event.stopPropagation()">
                    <input type="checkbox" ${b.broken ? 'checked' : ''} onchange="toggleBroken(this, '${esc(b.product_name)}', '${esc(b.series_name || '')}', '${esc(b.inventory_number || '')}', ${b.broken ? 'false' : 'true'})">
                </label>
            </td>
        </tr>`).join('')}</tbody>
    </table></div>`;

    container.innerHTML = `<div class="d-md-none">${mobileHtml}</div><div class="d-none d-md-block">${desktopHtml}</div>`;
}

function filterBalanceType(type) {
    currentBalanceFilter = type;
    ['all','equipment','zip','repair'].forEach(t => {
        document.getElementById('bf-'+t)?.classList.toggle('active', t === type);
    });
    filterBalances();
}

function toggleBroken(checkbox, product_name, series_name, inventory_number, broken) {
    const storage_guid = document.getElementById('storageSelect').value;
    if (!storage_guid) return;
    fetch('/api/warehouse/balances/toggle-broken', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storage_guid, product_name, series_name, inventory_number, broken})
    }).then(checkAuth).then(() => {
        for (const key of reqCache.keys()) {
            if (key.startsWith('/api/warehouse/balances')) reqCache.delete(key);
        }
        loadBalances();
    }).catch(() => {});
}

function exportWarehousePdf() {
    const sel = document.getElementById('storageSelect');
    if (!sel.value) { showAlert('Выберите склад', 'warning'); return; }
    const storageName = sel.options[sel.selectedIndex].text;

    let balances = allBalances;
    if (currentBalanceFilter === 'equipment') balances = balances.filter(b => b.series_name && !b.broken);
    else if (currentBalanceFilter === 'zip') balances = balances.filter(b => !b.series_name && !b.broken);
    else if (currentBalanceFilter === 'repair') balances = balances.filter(b => b.broken);

    const query = document.getElementById('balanceSearch').value.toLowerCase().trim();
    if (query) {
        balances = balances.filter(b =>
            (b.product_name || '').toLowerCase().includes(query) ||
            (b.series_name || '').toLowerCase().includes(query) ||
            (b.inventory_number || '').toLowerCase().includes(query) ||
            (b.date_arrival || '').toLowerCase().includes(query)
        );
    }

    const btn = document.querySelector('[onclick="exportWarehousePdf()"]');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    const date = new Date().toLocaleDateString('ru-RU');
    fetch('/api/warehouse/export-pdf', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            storage_name: storageName,
            date,
            balances: balances.map(b => ({
                name: b.product_name || '',
                series: b.series_name || '',
                inv: b.inventory_number || '',
                balance: b.balance ?? 0,
                date_arrival: b.date_arrival || null,
                date_writeoff: b.date_writeoff ?? null
            }))
        })
    }).then(r => {
        if (!r.ok) throw new Error('Ошибка сервера');
        return r.blob();
    }).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${storageName.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '_')}_${date.replace(/\./g, '')}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(err => {
        showAlert('Ошибка экспорта: ' + err.message, 'danger');
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
    });
}

// ============ SALARY ============
function loadSalary() {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(year, currentDate.getMonth() + 1, 0).getDate();
    const startDate = `${year}-${month}-01`;
    const endDate = `${year}-${month}-${String(lastDay).padStart(2,'0')}`;

    const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                        'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    document.getElementById('salaryMonth').textContent = `${monthNames[currentDate.getMonth()]} ${year}`;

    fetchDeduped(`/api/salary?start_date=${startDate}&end_date=${endDate}`, undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const items = data.Data || data.data || [];
            const total = data.total_amount != null ? data.total_amount : (data.totalAmount || 0);
            const container = document.getElementById('salaryList');

            if (items.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-cash-stack"></i><p>Нет данных за этот месяц</p></div>';
                return;
            }

            container.innerHTML = `<div class="salary-cards">${items.map(item => {
                const val = Math.round(item.value || 0);
                const icon = val > 0 ? 'bi-arrow-up-circle text-success' : 'bi-dash-circle text-muted';
                return `<div class="salary-card">
                    <div class="salary-card-icon"><i class="bi ${icon}"></i></div>
                    <div class="salary-card-body">
                        <div class="salary-card-title">${item.title || '—'}</div>
                        <div class="salary-card-value ${val > 0 ? 'text-success' : 'text-muted'}">${val.toLocaleString('ru')} <span class="salary-currency">₽</span></div>
                    </div>
                </div>`;
            }).join('')}</div>
            <div class="salary-total-bar"><span>Итого</span><span class="salary-total-amount">${Math.round(total).toLocaleString('ru')} ₽</span></div>`;
        }).catch(() => {
            document.getElementById('salaryList').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>Ошибка загрузки</p></div>';
        });
}

function sendTestPush() {
    fetch('/api/push/test', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.ok) {
                const btn = document.querySelector('#salary .btn-outline-primary');
                if (btn) {
                    const orig = btn.innerHTML;
                    btn.innerHTML = '<i class="bi bi-check-lg"></i> Отправлено';
                    btn.classList.remove('btn-outline-primary');
                    btn.classList.add('btn-success');
                    setTimeout(() => {
                        btn.innerHTML = orig;
                        btn.classList.remove('btn-success');
                        btn.classList.add('btn-outline-primary');
                    }, 2000);
                }
            }
        })
        .catch(e => console.warn('Push test failed', e));
}

function changeMonth(delta) {
    currentDate.setMonth(currentDate.getMonth() + delta);
    loadSalary();
}

// ============ CLIENT DIRECTORY ============
function loadClients() {
    fetchDeduped('/api/tasks/documents', undefined, 300000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            (data || []).forEach(c => { if (c.guid) clientsMap[c.guid] = c.name || c.guid; });
        });
}

// ============ STARTUP ============
function runStartup() {
    const ov = document.getElementById('startupOverlay');
    if (!ov) return;
    if (sessionStorage.getItem('startupDone')) {
        ov.style.display = 'none';
        return;
    }
    // Total startup duration: ~1.6s (letters animate in by ~0.7s, then we wait)
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
    runStartup();
    initPushNotifications();
    applyTheme(currentTheme);
    updateProfileAvatar();

    loadProfile();

    loadNotifications('', true);
    loadAnnouncements();

    setInterval(() => loadNotifications('', true), 600000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            const now = Date.now();
            for (const [key, entry] of reqCache) {
                if (now - entry.ts > 30 * 60 * 1000) reqCache.delete(key);
            }
            loadNotifications('', true);
            if (typeof loadTasks === 'function') loadTasks('', ['my', 'free']);
            if (typeof loadBalances === 'function') loadBalances();
        }
    });

    window.addEventListener('scroll', () => {
        const btn = document.getElementById('scrollTopBtn');
        if (btn) btn.classList.toggle('show', window.scrollY > 400);
    });
});
function getFilenameFromHeaders(headers, fallback) {
    const cd = headers.get('Content-Disposition');
    if (cd) {
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (m) return m[1];
    }
    return fallback;
}

function downloadMultiple(fetches, onProgress) {
    return Promise.all(fetches.map((p, i) =>
        p.then(({blob, filename}) => {
            if (onProgress) onProgress(i + 1, fetches.length);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        })
    ));
}

function downloadDocuments(guid) {
    const body = JSON.stringify({guid, profile_name: savedProfileName});
    const endpoints = ['/api/tasks/documents/act', '/api/tasks/documents/fn', '/api/tasks/documents/m15'];
    const fetches = endpoints.map(url =>
        fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body})
            .then(checkAuth)
            .then(r => {
                if (!r.ok) return null;
                const filename = getFilenameFromHeaders(r.headers);
                return r.blob().then(blob => ({blob, filename}));
            })
    );
    downloadMultiple(fetches).catch(e => showAlert('Ошибка: ' + e.message, 'danger'));
}

// ============ DOCUMENT FORM ============
let docAllProducts = [];
let docSelectedItems = [];

function loadDocStorages(sel) {
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            sel.innerHTML = '<option value="">Выберите склад...</option>' +
                data.map(s => `<option value="${s.guid}">${s.name}</option>`).join('');
            const saved = lsGet('defaultWarehouse', '');
            if (saved && [...sel.options].some(o => o.value === saved)) {
                sel.value = saved;
                loadDocProducts();
            }
        });
}

function loadDocProducts() {
    const guid = document.getElementById('docStorageSelect').value;
    const list = document.getElementById('docProductsList');
    if (!guid) {
        list.innerHTML = '<div class="text-muted small text-center py-3">Выберите склад</div>';
        docAllProducts = [];
        renderDocProducts();
        return;
    }
    fetchDeduped(`/api/warehouse/balances?storage=${guid}`, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            docAllProducts = (data || []).filter(p => p.series_name && !p.broken);
            renderDocProducts();
        });
}

function filterDocProducts() {
    renderDocProducts();
}

function renderDocProducts() {
    const query = document.getElementById('docProductSearch').value.toLowerCase().trim();
    const container = document.getElementById('docProductsList');
    const filtered = docAllProducts.filter(p =>
        (p.product_name || '').toLowerCase().includes(query) ||
        (p.series_name || '').toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-muted small text-center py-3">Нет товаров с серийными номерами</div>';
        return;
    }

    const maxReached = docSelectedItems.length >= 3;
    container.innerHTML = filtered.map(p => {
            const key = p.product_name + '|' + p.series_name;
            const checked = docSelectedItems.some(s => s.key === key);
            const disabled = !checked && maxReached;
            return `<div class="form-check doc-product-item ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-key="${key.replace(/"/g,'&quot;')}">
                <input class="form-check-input" type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                <label class="form-check-label small">${(p.product_name || '—').replace(/</g,'&lt;')} <span class="text-muted">[${(p.series_name || '—').replace(/</g,'&lt;')}]</span></label>
            </div>`;
        }).join('');
}

// Click delegation for product list
document.getElementById('docProductsList')?.addEventListener('click', (e) => {
    const div = e.target.closest('.doc-product-item');
    if (!div) return;
    const key = div.dataset.key;
    if (!key) return;
    const alreadySelected = docSelectedItems.some(s => s.key === key);

    if (alreadySelected) {
        const si = docSelectedItems.findIndex(s => s.key === key);
        if (si !== -1) docSelectedItems.splice(si, 1);
    } else {
        if (docSelectedItems.length >= 3) { renderDocProducts(); return; }
        const p = docAllProducts.find(x => (x.product_name || '') + '|' + (x.series_name || '') === key);
        if (!p) return;
        docSelectedItems.push({ key, name: p.product_name || '', series: p.series_name || '' });
    }
    renderDocProducts();
    renderDocSelected();
});

function renderDocSelected() {
    const container = document.getElementById('docSelectedProducts');
    if (docSelectedItems.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = docSelectedItems.map((item, i) =>
        `<span class="badge bg-primary d-flex align-items-center gap-1" style="font-size:0.75rem">
            ${i+1}. ${item.name} [${item.series}]
            <i class="bi bi-x" style="cursor:pointer" onclick="removeDocItem(${i})"></i>
        </span>`
    ).join('');
}

function removeDocItem(idx) {
    docSelectedItems.splice(idx, 1);
    renderDocProducts();
    renderDocSelected();
}

function openDocForm(guid) {
    const fillForm = (task) => {
        const text = (task.name || '') + '\n' + (task.description || '');

        function rx(p) {
            const m = text.match(p);
            return m ? m[1].trim() : '';
        }

        document.getElementById('docFormGuid').value = guid;
        document.getElementById('docShop').value = rx(/(\d+)-Пятерочка/);
        const sap = rx(/SAP-(\w+)/).toUpperCase();
        document.getElementById('docSap').value = sap;
        document.getElementById('docCode').value = rx(/Код заявки:\s*(\S+)/);
        document.getElementById('docZd').value = rx(/Номер:\s*(\S+)/);

        document.getElementById('docAddr').value = '';
        if (sap) {
            fetch(`/api/shop/by-sap?sap=${encodeURIComponent(sap)}`)
                .then(checkAuth).then(r => r.json())
                .then(data => {
                    if (data.addr) document.getElementById('docAddr').value = data.addr;
                    if (data.shop && !document.getElementById('docShop').value) {
                        document.getElementById('docShop').value = data.shop;
                    }
                });
        }

        let desc = rx(/Подробное\s*описание:\s*\n?(.*?)(?:\n\n|\*{3}|$)/s);
        if (!desc) desc = (task.description || '').replace(/Объект обслуживания:.*?(?:\n|$)/g, '').replace(/Адрес:.*?(?:\n|$)/g, '').trim();
        document.getElementById('docDesc').value = desc;

        document.getElementById('docIncludeAct').checked = true;
        document.getElementById('docIncludeFn').checked = false;
        document.getElementById('docIncludeM15').checked = false;

        docSelectedItems = [];
        docAllProducts = [];
        document.getElementById('docProductSearch').value = '';
        document.getElementById('docProductsList').innerHTML = '<div class="text-muted small text-center py-3">Выберите склад</div>';
        document.getElementById('docSelectedProducts').innerHTML = '';
        document.getElementById('docBasicSection').classList.remove('d-none');
        document.getElementById('docProductsSection').classList.add('d-none');
        document.querySelectorAll('#docFormModal .doc-section-header .bi').forEach(icon => {
            const header = icon.closest('.doc-section-header');
            const body = header.nextElementSibling;
            const isHidden = body.classList.contains('d-none');
            icon.className = 'bi bi-chevron-' + (isHidden ? 'down' : 'up') + ' ms-auto';
        });
        loadDocStorages(document.getElementById('docStorageSelect'));

        const modal = new bootstrap.Modal(document.getElementById('docFormModal'));
        modal.show();
    };

    const allTasks = [...tasksMy, ...tasksFree, ...tasksClosed];
    const local = allTasks.find(t => t.guid === guid);
    if (local && local.description) {
        fillForm(local);
        return;
    }

    fetch('/api/tasks/' + guid).then(checkAuth).then(r => r.ok ? r.json() : null).then(task => {
        if (task) fillForm(task);
    });
}

function generateDocForm() {
    const guid = document.getElementById('docFormGuid').value;
    if (!guid) return;

    const fields = {};
    const shop = document.getElementById('docShop').value.trim();
    const sap = document.getElementById('docSap').value.trim();
    const addr = document.getElementById('docAddr').value.trim();
    const desc = document.getElementById('docDesc').value.trim();
    const code = document.getElementById('docCode').value.trim();
    const zd = document.getElementById('docZd').value.trim();
    if (shop || sap || addr || desc || code || zd) {
        Object.assign(fields, {shop, sap, addr, desc, code, zd});
    }
    if (docSelectedItems.length > 0) {
        fields.items = docSelectedItems.map(item => ({name: item.name, series: item.series}));
    }

    const includeAct = document.getElementById('docIncludeAct').checked;
    const includeFn = document.getElementById('docIncludeFn').checked;
    const includeM15 = document.getElementById('docIncludeM15').checked;

    const loading = document.getElementById('docFormLoading');
    const footer = document.getElementById('docFormFooter');
    const status = document.getElementById('docFormStatus');

    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);
    status.textContent = 'Запрос на генерацию...';

    const endpoints = [];
    if (includeAct) endpoints.push('/api/tasks/documents/act');
    if (includeFn) endpoints.push('/api/tasks/documents/fn');
    if (includeM15) endpoints.push('/api/tasks/documents/m15');

    if (endpoints.length === 0) {
        status.textContent = 'Выберите хотя бы один тип документа';
        setTimeout(() => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
        }, 1500);
        return;
    }

    const body = JSON.stringify({
        guid,
        profile_name: savedProfileName,
        fields: Object.keys(fields).length > 0 ? fields : undefined,
    });

    status.textContent = 'Генерация документов...';

    const fetches = endpoints.map(url =>
        fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body})
            .then(checkAuth)
            .then(r => {
                if (!r.ok) return r.text().then(t => { throw new Error(t) });
                const filename = getFilenameFromHeaders(r.headers);
                return r.blob().then(blob => ({blob, filename}));
            })
    );

    downloadMultiple(fetches, (done, total) => {
        status.textContent = `Загрузка... (${done}/${total})`;
    }).then(() => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        bootstrap.Modal.getInstance(document.getElementById('docFormModal'))?.hide();
    }).catch(e => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        const body = document.querySelector('#docFormModal .modal-body');
        const errDiv = document.createElement('div');
        errDiv.className = 'alert alert-danger alert-dismissible fade show mt-2 mb-0';
        errDiv.role = 'alert';
        errDiv.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i><span></span>' +
            '<button type="button" class="btn-close" data-bs-dismiss="alert"></button>';
        errDiv.querySelector('span').textContent = e.message;
        body.prepend(errDiv);
    });
}

// ============ NOTIFICATIONS ============

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'только что';
    if (mins < 60) return `${mins} мин назад`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'вчера';
    return `${days} д назад`;
}

function renderNotifications(list, container) {
    if (!list || !list.length) {
        container.innerHTML = '<div class="text-muted small p-2">Нет уведомлений</div>';
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
            ${n.type === 'warehouse_arrival' ? `<button class="notif-broken-btn" onclick="markArrivalBroken(${n.id}, this)" title="Отметить весь товар как сломанный">🗑️</button>` : ''}
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
            container.innerHTML = '<div class="text-muted small">Ошибка загрузки</div>';
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
    if (container) container.innerHTML = '<div class="text-muted small">Очистка...</div>';
    const storage = document.getElementById('storageSelect')?.value || '';
    for (const key of reqCache.keys()) {
        if (key.startsWith('/api/notifications')) reqCache.delete(key);
    }
    fetch('/api/notifications/dismiss-all', {method: 'POST'})
        .then(checkAuth)
        .then(() => { loadNotifications(storage); })
        .catch(() => {
            if (container) container.innerHTML = '<div class="text-muted small">Ошибка</div>';
        });
}

function markArrivalBroken(notifId, btn) {
    if (!confirm('Отметить весь поступивший товар как сломанный?')) return;
    btn.disabled = true;
    const storage = document.getElementById('storageSelect')?.value || '';
    fetch(`/api/notifications/${notifId}/mark-broken`, {method: 'POST'})
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            if (data.ok) {
                dismissNotification(notifId);
                loadBalances();
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
                container.innerHTML = '<div class="text-muted small">Ошибка при очистке</div>';
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
                container.innerHTML = '<div class="text-muted small">Нет объявлений</div>';
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
            container.innerHTML = '<div class="text-muted small">Ошибка загрузки</div>';
        });
}

// ============ ANNOUNCEMENTS TOGGLE ============

function toggleAnnouncements() {
    const list = document.getElementById('announcementsList');
    const icon = document.getElementById('annToggleIcon');
    if (!list || !icon) return;
    const collapsed = list.classList.toggle('announcements-collapsed');
    icon.className = 'bi bi-chevron-' + (collapsed ? 'up' : 'down');
}

// ============ WEB PUSH ============

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const uint8Array = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        uint8Array[i] = rawData.charCodeAt(i);
    }
    return uint8Array;
}

async function initPushNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
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

// ============ PWA INSTALL ============
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
});
window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
});

// ============ STOCK TRANSFERS ============

let transferPickProducts = [];
let transferSelectedItems = [];
let transferPhotos = [];  // {data: base64, extension: string}
let currentTransferDoc = null;
let transferChangedAmounts = {};  // itemGuid -> new amount
let transferNewComment = '';

function openCreateTransfer() {
    document.getElementById('transferSource').innerHTML = '<option value="">Загрузка...</option>';
    document.getElementById('transferDest').innerHTML = '<option value="">Загрузка...</option>';

    const sel = document.getElementById('storageSelect');
    if (sel && sel.options.length > 1) {
        const opts = sel.innerHTML;
        document.getElementById('transferSource').innerHTML = opts;
        document.getElementById('transferDest').innerHTML = opts;
    } else {
        loadTransferStorages();
    }

    const pickSel = document.getElementById('transferStoragePick');
    if (pickSel) {
        pickSel.innerHTML = sel ? sel.innerHTML : '<option value="">Выберите склад...</option>';
    }

    transferSelectedItems = [];
    transferPhotos = [];
    document.getElementById('transferSelectedItems').innerHTML = '';
    document.getElementById('transferPhotoPreview').innerHTML = '';
    document.getElementById('transferComment').value = '';
    document.getElementById('transferProductSearch').value = '';
    document.getElementById('transferProductsList').innerHTML = '<div class="text-muted small text-center py-3">Выберите склад остатков</div>';
    transferPickProducts = [];

    const modal = new bootstrap.Modal(document.getElementById('createTransferModal'));
    modal.show();
}

function loadTransferStorages() {
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            const opts = '<option value="">Выберите склад...</option>' +
                data.map(s => `<option value="${s.guid}">${s.name}</option>`).join('');
            document.getElementById('transferSource').innerHTML = opts;
            document.getElementById('transferDest').innerHTML = opts;
            document.getElementById('transferStoragePick').innerHTML = opts;
        });
}

function loadTransferProducts() {
    const guid = document.getElementById('transferStoragePick').value;
    const list = document.getElementById('transferProductsList');
    if (!guid) {
        list.innerHTML = '<div class="text-muted small text-center py-3">Выберите склад остатков</div>';
        transferPickProducts = [];
        renderTransferProducts();
        return;
    }
    fetchDeduped(`/api/warehouse/balances-pick?storage=${guid}`, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            transferPickProducts = data || [];
            renderTransferProducts();
        });
}

function filterTransferProducts() {
    renderTransferProducts();
}

function renderTransferProducts() {
    const query = document.getElementById('transferProductSearch').value.toLowerCase().trim();
    const container = document.getElementById('transferProductsList');
    const filtered = transferPickProducts.filter(p => {
        const name = (p.product_name || p.product_guid || '').toLowerCase();
        const series = p.series ? (p.series.name || '').toLowerCase() : '';
        return name.includes(query) || series.includes(query);
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-muted small text-center py-3">Нет доступных товаров</div>';
        return;
    }

    container.innerHTML = filtered.map(p => {
        const key = p.product_guid + '|' + (p.series ? p.series.guid : '');
        const already = transferSelectedItems.some(s => s.key === key);
        const seriesName = p.series ? (p.series.name || p.series.inventory_number || '—') : '—';
        const name = p.product_name || p.product_guid || '—';
        return `<div class="transfer-product-item ${already ? 'selected' : ''}" data-key="${key.replace(/"/g,'&quot;')}" onclick="toggleTransferProduct(this)">
            <div class="d-flex justify-content-between align-items-center px-2 py-1 ${already ? 'bg-primary bg-opacity-10' : ''}" style="cursor:pointer">
                <div class="small">
                    <span class="fw-semibold">${esc(name)}</span>
                    ${p.series ? `<span class="text-muted ms-2">[${esc(seriesName)}]</span>` : ''}
                </div>
                <div class="text-nowrap">
                    <span class="badge bg-secondary me-2">${p.balance ?? 0}</span>
                    ${already ? '<i class="bi bi-check-lg text-primary"></i>' : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

function toggleTransferProduct(el) {
    const key = el.dataset.key;
    if (!key) return;
    const idx = transferSelectedItems.findIndex(s => s.key === key);
    if (idx !== -1) {
        transferSelectedItems.splice(idx, 1);
    } else {
        const p = transferPickProducts.find(x => {
            const k = x.product_guid + '|' + (x.series ? x.series.guid : '');
            return k === key;
        });
        if (!p) return;
        transferSelectedItems.push({
            key,
            product_guid: p.product_guid,
            product_name: p.product_name || p.product_guid,
            series_guid: p.series ? p.series.guid : null,
            characteristic_guid: p.characteristic || null,
            count: 1,
        });
    }
    renderTransferProducts();
    renderTransferSelected();
}

function renderTransferSelected() {
    const container = document.getElementById('transferSelectedItems');
    if (transferSelectedItems.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = transferSelectedItems.map((item, i) =>
        `<span class="badge bg-primary d-inline-flex align-items-center gap-1" style="font-size:0.75rem">
            ${i+1}. ${esc(item.product_name || item.product_guid.slice(0,8) + '…')}
            <input type="number" min="1" value="${item.count}" style="width:40px;font-size:0.7rem;padding:0 2px;text-align:center;border:none;border-radius:3px" onchange="transferSelectedItems[${i}].count=Math.max(1,parseInt(this.value)||1)">
            <i class="bi bi-x" style="cursor:pointer" onclick="removeTransferItem(${i})"></i>
        </span>`
    ).join('');
}

function removeTransferItem(idx) {
    transferSelectedItems.splice(idx, 1);
    renderTransferProducts();
    renderTransferSelected();
}

function onTransferPhotoSelected(input) {
    const files = input.files;
    if (!files || !files.length) return;
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64 = e.target.result.split(',')[1];
            const ext = file.name.split('.').pop() || 'jpg';
            transferPhotos.push({data: base64, extension: ext});
            renderTransferPhotos();
        };
        reader.readAsDataURL(file);
    }
    input.value = '';
}

function captureTransferPhoto() {
    const input = document.getElementById('transferPhotoInput');
    if (input) input.click();
}

function renderTransferPhotos() {
    const container = document.getElementById('transferPhotoPreview');
    if (transferPhotos.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = transferPhotos.map((photo, i) =>
        `<div class="position-relative" style="width:72px;height:72px">
            <img src="data:image/${photo.extension};base64,${photo.data}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">
            <i class="bi bi-x-circle-fill position-absolute" style="top:-6px;right:-6px;cursor:pointer;color:#dc3545;font-size:1rem" onclick="removeTransferPhoto(${i})"></i>
        </div>`
    ).join('');
}

function removeTransferPhoto(idx) {
    transferPhotos.splice(idx, 1);
    renderTransferPhotos();
}

function submitTransfer() {
    const source = document.getElementById('transferSource').value;
    const dest = document.getElementById('transferDest').value;
    if (!source || !dest) {
        showAlert('Выберите склад отправитель и получатель', 'warning');
        return;
    }
    if (source === dest) {
        showAlert('Склады отправитель и получатель должны различаться', 'warning');
        return;
    }
    if (transferSelectedItems.length === 0) {
        showAlert('Добавьте хотя бы один товар', 'warning');
        return;
    }

    const loading = document.getElementById('transferFormLoading');
    const footer = document.querySelector('#createTransferModal .modal-footer');
    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);

    const products = transferSelectedItems.map(item => ({
        guid: item.product_guid,
        series_guid: item.series_guid,
        characteristic_guid: item.characteristic_guid,
        count: item.count,
    }));

    const body = {
        source_storage: source,
        destination_storage: dest,
        products: products,
        comment: document.getElementById('transferComment').value.trim(),
        attachments: transferPhotos.map(ph => ({
            data: ph.data,
            extension: ph.extension,
        })),
    };

    fetch('/api/warehouse/stock-transfers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    })
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            if (data.success) {
                bootstrap.Modal.getInstance(document.getElementById('createTransferModal'))?.hide();
                showAlert('Перемещение создано', 'success');
                loadTransfers();
            } else {
                showAlert('Ошибка: ' + (data.error || 'Неизвестная ошибка'), 'danger');
            }
        })
        .catch(err => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            showAlert('Ошибка отправки: ' + err.message, 'danger');
        });
}

let _transfersCache = [];

function loadTransfers() {
    const container = document.getElementById('transfersList');
    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></div>';

    fetchDeduped('/api/warehouse/stock-transfers', undefined, 10000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            _transfersCache = data || [];
            if (!_transfersCache.length) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-arrow-left-right"></i><p>Нет перемещений</p></div>';
                return;
            }
            container.innerHTML = _transfersCache.map((doc, idx) => {
                const itemsCount = (doc.items || []).length;
                const totalQty = (doc.items || []).reduce((s, it) => s + (it.amount || 0), 0);
                const src = doc.warehouse_source_name || doc.warehouse_source || '—';
                const dst = doc.warehouse_dest_name || doc.warehouse_dest || '—';
                const org = doc.organization_name || '';
                return `<div class="transfer-card border rounded-3 p-3 mb-2" style="cursor:pointer" onclick="openTransferDetail(${idx})">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <div class="fw-semibold">${esc(doc.number || '—')}</div>
                            <div class="small text-muted">${formatDate(doc.date)}</div>
                            ${org ? `<div class="small text-muted">${esc(org)}</div>` : ''}
                        </div>
                        <div class="text-end small text-muted">
                            <div>${itemsCount} поз.</div>
                            <div>${totalQty} шт.</div>
                        </div>
                    </div>
                    <div class="small mt-1">
                        <i class="bi bi-arrow-right-short"></i> ${esc(src)} → ${esc(dst)}
                    </div>
                </div>`;
            }).join('');
        })
        .catch(() => {
            container.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>Ошибка загрузки</p></div>';
        });
}

function openTransferDetail(idx) {
    const doc = _transfersCache[idx];
    if (!doc) return;
    currentTransferDoc = doc;
    transferChangedAmounts = {};
    transferNewComment = '';

    const title = document.getElementById('transferDetailTitle');
    title.innerHTML = `<i class="bi bi-arrow-left-right me-2"></i>${esc(doc.number || 'Перемещение')}`;

    const src = doc.warehouse_source_name || doc.warehouse_source || '—';
    const dst = doc.warehouse_dest_name || doc.warehouse_dest || '—';

    document.getElementById('transferDetailInfo').innerHTML = `
        <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
                <div class="small text-muted">${formatDate(doc.date)}</div>
                <div class="small">${esc(doc.organization_name || '')}</div>
            </div>
            <div class="text-end small">
                <div><strong>${esc(src)}</strong> <i class="bi bi-arrow-right"></i> <strong>${esc(dst)}</strong></div>
            </div>
        </div>
    `;

    // Products
    const items = doc.items || [];
    document.getElementById('transferDetailProducts').innerHTML = `
        <label class="fw-semibold small d-block mb-1"><i class="bi bi-box-seam me-1"></i>Товары</label>
        <div class="table-responsive">
        <table class="table table-sm table-borderless mb-0">
            <thead><tr><th>Товар</th><th>Серия</th><th class="text-center" style="width:80px">Кол-во</th></tr></thead>
            <tbody>${items.map((item, i) => {
                const seriesName = item.series ? (item.series.name || item.series.inventory_number || '—') : '—';
                const inv = item.series ? (item.series.inventory_number || '') : '';
                const name = item.product_name || item.product_guid || '—';
                return `<tr>
                    <td class="small">${esc(name)}</td>
                    <td class="small text-muted">${esc(seriesName)}${inv ? ' ('+esc(inv)+')' : ''}</td>
                    <td class="text-center">
                        <input type="number" min="0" value="${item.amount ?? 0}"
                            class="form-control form-control-sm" style="width:65px;display:inline-block;text-align:center"
                            data-item-guid="${esc(item.guid)}"
                            onchange="onTransferAmountChange(this, '${esc(item.guid)}')">
                    </td>
                </tr>`;
            }).join('')}</tbody>
        </table>
        </div>
    `;

    // Comments
    const comments = doc.comments || [];
    const commentsHtml = comments.length
        ? comments.map(c =>
            `<div class="small mb-1 p-1 bg-light rounded-3">${esc(c.author || '')} — ${esc(c.date || '')}<br>${esc(c.content || '')}</div>`
          ).join('')
        : '<div class="text-muted small mb-2">Нет комментариев</div>';
    document.getElementById('transferDetailComments').innerHTML = `
        <label class="fw-semibold small d-block mb-1"><i class="bi bi-chat-dots me-1"></i>Комментарии</label>
        ${commentsHtml}
        <div class="input-group input-group-sm mt-1">
            <input type="text" class="form-control" id="transferDetailNewComment" placeholder="Добавить комментарий..."
                oninput="transferNewComment=this.value.trim()">
            <button class="btn btn-outline-secondary" onclick="document.getElementById('transferDetailNewComment').value='';transferNewComment='';this.closest('.input-group').querySelector('input').focus()" title="Очистить"><i class="bi bi-x-lg"></i></button>
        </div>
    `;

    // Photos
    const attachments = doc.attachments || [];
    document.getElementById('transferDetailPhotos').innerHTML = attachments.length
        ? `<label class="fw-semibold small d-block mb-1"><i class="bi bi-paperclip me-1"></i>Вложения</label>
           <div class="d-flex gap-2 flex-wrap">${attachments.map(a =>
               `<div style="width:72px;height:72px;border-radius:6px;overflow:hidden;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#999" title="${esc(a.filename || '')}">
                   <i class="bi bi-file-earmark-image" style="font-size:1.5rem"></i>
               </div>`
           ).join('')}</div>`
        : '';

    const modal = new bootstrap.Modal(document.getElementById('transferDetailModal'));
    modal.show();
}

function onTransferAmountChange(input, guid) {
    const val = parseInt(input.value) || 0;
    const original = ((currentTransferDoc.items || []).find(i => i.guid === guid) || {}).amount || 0;
    if (val !== original) {
        transferChangedAmounts[guid] = val;
    } else {
        delete transferChangedAmounts[guid];
    }
}

function saveTransferChanges() {
    if (!currentTransferDoc) return;
    const taskGuid = currentTransferDoc.guid;
    const promises = [];

    // Changed amounts
    for (const [guid, amount] of Object.entries(transferChangedAmounts)) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/amount', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guid, task_guid: taskGuid, amount}),
            }).then(checkAuth).then(r => r.json())
        );
    }

    // New comment
    const comment = document.getElementById('transferDetailNewComment')?.value?.trim();
    if (comment) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/comment', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({task_guid: taskGuid, comment}),
            }).then(checkAuth).then(r => r.json())
        );
    }

    if (promises.length === 0) {
        showAlert('Нет изменений для сохранения', 'info');
        return;
    }

    const loading = document.getElementById('transferDetailLoading');
    const footer = document.querySelector('#transferDetailModal .modal-footer');
    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);

    Promise.all(promises)
        .then(results => {
            const errors = results.filter(r => r && !r.success && r.error);
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            if (errors.length) {
                showAlert('Ошибки: ' + errors.map(e => e.error).join('; '), 'danger');
            } else {
                showAlert('Сохранено', 'success');
                bootstrap.Modal.getInstance(document.getElementById('transferDetailModal'))?.hide();
                loadTransfers();
            }
        })
        .catch(err => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            showAlert('Ошибка: ' + err.message, 'danger');
        });
}

document.querySelector('#warehouseTabs [data-bs-target="#wh-transfers"]')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('storageSelect');
    const opts = sel ? sel.innerHTML : '';
    if (opts && opts.includes('<option')) {
        document.getElementById('transferSource').innerHTML = opts;
        document.getElementById('transferDest').innerHTML = opts;
        document.getElementById('transferStoragePick').innerHTML = opts;
    }
    loadTransfers();
});

document.querySelector('#warehouseTabs [data-bs-target="#wh-balances"]')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('storageSelect');
    if (sel && sel.options.length <= 1) loadStorages();
});
