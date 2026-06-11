// ============ UTILITY ============

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
    fetch('/api/warehouse/storages')
        .then(checkAuth).then(r => r.json())
        .then(data => {
            ws.innerHTML = '<option value="">Не выбран</option>' +
                data.map(s => `<option value="${s.guid}" ${s.guid === saved ? 'selected' : ''}>${s.name}</option>`).join('');
        });

    modal.show();
}

function saveProfile() {
    savedProfileName = document.getElementById('profileName').value.trim();
    lsSet('profileName', savedProfileName);
    const warehouseGuid = document.getElementById('settingsWarehouse').value;
    lsSet('defaultWarehouse', warehouseGuid);
    updateProfileAvatar();
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

// ============ TASKS ============
let taskSearchTimeout;

function loadTasks(search, types) {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    const qs = params.toString() ? '?' + params.toString() : '';
    const fetches = [];
    const labels = types || ['my', 'free', 'closed'];
    if (labels.includes('my')) fetches.push(fetch('/api/tasks/my' + qs).then(checkAuth).then(r => r.json()));
    if (labels.includes('free')) fetches.push(fetch('/api/tasks/free' + qs).then(checkAuth).then(r => r.json()));
    if (labels.includes('closed')) fetches.push(fetch('/api/tasks/closed' + qs).then(checkAuth).then(r => r.json()));
    if (fetches.length === 0) return;
    Promise.all(fetches).then(results => {
        let i = 0;
        if (labels.includes('my')) { tasksMy = (results[i] || {}).tasks || []; i++; }
        if (labels.includes('free')) { tasksFree = (results[i] || {}).tasks || []; i++; }
        if (labels.includes('closed')) { tasksClosed = (results[i] || {}).tasks || []; }
        filterTasks();
    });
}

function loadClosedTasks() {
    loadTasks('', ['closed']);
}

function onTaskSearch() {
    const q = document.getElementById('taskSearch').value.trim();
    filterTasks();
    clearTimeout(taskSearchTimeout);
    taskSearchTimeout = setTimeout(() => loadTasks(q || undefined), 400);
}

function filterTasks() {
    const query = document.getElementById('taskSearch').value.toLowerCase().trim();
    const sort = document.getElementById('taskSort').value;
    lsSet('taskSort', sort);
    renderTasks('tasksMyList', tasksMy, query, sort, 'my');
    renderTasks('tasksFreeList', tasksFree, query, sort, 'free');
    renderTasks('tasksClosedList', tasksClosed, query, sort, 'closed');
}

function resetFilters() {
    document.getElementById('taskSearch').value = '';
    document.getElementById('taskSort').value = 'date';
    lsSet('taskSort', 'date');
    clearTimeout(taskSearchTimeout);
    loadTasks();
}

function sortTasks(tasks, sort, reverse) {
    const s = [...tasks];
    const r = reverse ? -1 : 1;
    switch (sort) {
        case 'priority':
            s.sort((a, b) => r * ((b.priority || 0) - (a.priority || 0)));
            break;
        case 'deadline': {
            s.sort((a, b) => {
                const da = parseDate(a.period), db = parseDate(b.period);
                if (!da && !db) return 0;
                if (!da) return 1;
                if (!db) return -1;
                return r * (da - db);
            });
            break;
        }
        default: {
            s.sort((a, b) => {
                const da = parseDate(a.date), db = parseDate(b.date);
                if (!da && !db) return 0;
                if (!da) return 1;
                if (!db) return -1;
                return r * (db - da);
            });
        }
    }
    return s;
}

function getUrgency(task) {
    const d = parseDate(task.period);
    if (!d) return { level: 0, label: '' };
    const now = new Date();
    const diffMs = d - now;
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffMs < 0) return { level: 3, label: 'Просрочено' };
    if (diffHours < 2) return { level: 2, label: `< ${Math.round(diffHours)} ч` };
    if (diffHours < 4) return { level: 1, label: `< ${Math.round(diffHours)} ч` };
    return { level: 0, label: '' };
}

function urgencyClass(level) {
    if (level === 3) return 'urgency-overdue';
    if (level === 2) return 'urgency-overdue';
    if (level === 1) return 'urgency-warning';
    return 'urgency-normal';
}

function isPinned(guid) { return pinnedTasks.includes(guid); }

function togglePin(guid) {
    const idx = pinnedTasks.indexOf(guid);
    if (idx >= 0) pinnedTasks.splice(idx, 1);
    else pinnedTasks.push(guid);
    lsSet('pinnedTasks', JSON.stringify(pinnedTasks));
    filterTasks();
}

function renderTasks(containerId, tasks, query, sort, mode) {
    const container = document.getElementById(containerId);
    const filtered = tasks.filter(t => {
        const searchStr = [
            t.number, t.name, t.status, t.name_department, t.user,
            clientName(t.guid_client)
        ].filter(Boolean).join(' ').toLowerCase();
        return searchStr.includes(query);
    });

    const reverse = (mode === 'closed');
    const pinned = sortTasks(filtered.filter(t => isPinned(t.guid)), sort, reverse);
    const unpinned = sortTasks(filtered.filter(t => !isPinned(t.guid)), sort, reverse);
    const sorted = [...pinned, ...unpinned];

    // Show only closed tasks with locations
    const showLocation = (mode === 'closed');

    document.getElementById('taskCount').textContent = sorted.length;

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>Нет заявок</p></div>';
        return;
    }

    container.innerHTML = sorted.map(t => {
        const urgency = mode === 'closed' ? { level: 0, label: '' } : getUrgency(t);
        const uc = urgencyClass(urgency.level);
        const pinIcon = isPinned(t.guid) ? 'pinned bi-pin-fill' : 'bi-pin';
        const pinHtml = mode === 'closed' ? '' : `<i class="bi ${pinIcon} pin-icon" onclick="togglePin('${t.guid}')"></i>`;
        const hasLoc = !!taskLocations[t.guid];
        const hasAttach = t.hasAttachments;
        const waitMs = parseDate(t.date) ? Date.now() - parseDate(t.date).getTime() : null;
        const waitHours = waitMs ? waitMs / (1000 * 60 * 60) : null;
        const remainMs = parseDate(t.period) ? parseDate(t.period).getTime() - Date.now() : null;
        const remainHours = remainMs ? remainMs / (1000 * 60 * 60) : null;

        const multiCheck = multiSelectMode && mode === 'free'
            ? `<input type="checkbox" class="form-check-input multi-check" ${selectedGuids.has(t.guid) ? 'checked' : ''} onchange="toggleSelect('${t.guid}')">`
            : '';

        let actionHtml = '';
        if (mode === 'my' && t.status !== 'Closed') {
            actionHtml = `<button class="btn btn-outline-secondary btn-action me-1" onclick="openTaskDetail('${t.guid}','${mode}')"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action me-1" onclick="openDocForm('${t.guid}')"><i class="bi bi-file-earmark-text"></i><span class="btn-label"> Документы</span></button><button class="btn btn-success btn-action" onclick="openTaskDetail('${t.guid}','user')"><i class="bi bi-check-lg"></i><span class="btn-label"> Завершить</span></button>`;
        } else if (mode === 'free' && !multiSelectMode) {
            actionHtml = `<button class="btn btn-outline-secondary btn-action me-1" onclick="openTaskDetail('${t.guid}','${mode}')"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-primary btn-action" onclick="takeTask('${t.guid}')"><i class="bi bi-hand-index-thumb"></i><span class="btn-label"> Взять</span></button>`;
        } else if (mode === 'closed') {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button>`;
        }

        const statusHtml = t.status ? `<span class="fw-semibold">${t.status}</span>` : '';

        return `<div class="card mb-2 task-card ${uc}">
            <div class="card-body py-2">
                <div class="d-flex align-items-center flex-nowrap mb-1">
                    ${multiCheck}
                    <span class="task-name flex-grow-1 me-1">${t.name || ''}</span>
                    ${pinHtml}
                    ${hasAttach ? '<i class="bi bi-paperclip meta-icon text-muted" title="Есть вложения"></i>' : ''}
                    ${showLocation ? (hasLoc ? '<i class="bi bi-geo-alt-fill meta-icon text-success" title="Геолокация сохранена"></i>' : '<i class="bi bi-geo-alt meta-icon text-danger" title="Нет геолокации"></i>') : ''}
                </div>
                <div class="task-meta mb-1">
                    <div>${statusHtml}${t.name_department ? ', ' + t.name_department : ''}</div>
                    <div><i class="bi bi-calendar3 me-1"></i>${formatDate(t.date)}<span class="meta-sep">, </span><i class="bi bi-clock me-1"></i>${formatDate(t.period)}</div>
                    <div><i class="bi bi-hourglass-split me-1"></i>${formatHours(waitHours)}<span class="meta-sep">, </span><i class="bi bi-hourglass-bottom me-1"></i>${formatHours(remainHours)}</div>
                </div>
                <div class="d-flex flex-wrap gap-1">
                    ${urgency.label ? `<span class="urgency-badge ${urgency.level >= 2 ? 'overdue' : 'warning'} me-1">${urgency.label}</span>` : ''}
                    ${actionHtml}
                </div>
            </div>
        </div>`;
    }).join('');
}

// ============ TASK DETAIL ============
function openTaskDetail(guid, mode) {
    const modal = new bootstrap.Modal(document.getElementById('taskDetailModal'));
    const lists = {user: tasksMy, my: tasksMy, free: tasksFree, closed: tasksClosed};
    const localTask = (lists[mode] || []).find(t => t.guid === guid);
    const task = localTask || null;
    if (!task) return;

    if (task && task.description !== undefined) {
        showTaskDetail(task, mode, guid);
        modal.show();
        return;
    }

    fetch('/api/tasks/' + guid).then(checkAuth).then(r => {
        if (!r.ok) return null;
        return r.json();
    }).then(task => {
        if (!task) {
            const allTasks = [...tasksMy, ...tasksFree, ...tasksClosed];
            task = allTasks.find(t => t.guid === guid);
        }
        if (!task) return;
        showTaskDetail(task, mode, guid);
        modal.show();
    });
}

function showTaskDetail(task, mode, guid) {
    document.getElementById('taskDetailTitle').innerHTML = `<i class="bi bi-info-circle me-2"></i>${task.name || ''}`;

        let body = `
            <div class="row g-3">
                <div class="col-12">
                    <div class="p-3 bg-light rounded-3">
                        <small class="text-muted d-block mb-1">Описание</small>
                        <p class="mb-0 task-description">${task.description || '—'}</p>
                    </div>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Статус</small>
                    <span class="fw-semibold">${task.status || '—'}</span>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Дата создания</small>
                    <span class="fw-semibold">${formatDate(task.date)}</span>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Срок</small>
                    <span class="fw-semibold">${formatDate(task.period)}</span>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Приоритет</small>
                    <span class="fw-semibold">${task.priority != null ? task.priority : '—'}</span>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Отдел</small>
                    <span class="fw-semibold">${task.name_department || '—'}</span>
                </div>
                <div class="col-6 col-md-4">
                    <small class="text-muted d-block">Клиент</small>
                    <span class="fw-semibold">${clientName(task.guid_client)}</span>
                </div>
            </div>`;

        let footer = '';

        if (mode === 'user') {
            body += `
                <hr class="my-3">
                <div class="mb-3">
                    <label class="form-label fw-semibold">Комментарий к закрытию</label>
                    <textarea class="form-control" id="closeComment" rows="3" placeholder="Введите комментарий..."></textarea>
                </div>
                <div class="mb-2">
                    <label class="form-label fw-semibold">Вложения</label>
                    <div class="d-flex gap-2">
                        <button class="btn btn-outline-secondary btn-sm" onclick="attachFile('pdf')"><i class="bi bi-filetype-pdf me-1"></i>PDF</button>
                        <button class="btn btn-outline-secondary btn-sm" onclick="attachFile('any')"><i class="bi bi-paperclip me-1"></i>Файл</button>
                    </div>
                    <div id="attachmentsList" class="mt-2"></div>
                </div>`;
            footer = `
                <button class="btn btn-outline-secondary" onclick="bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();openDocForm('${guid}')"><i class="bi bi-file-earmark-text me-1"></i>Документы</button>
                <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                <button class="btn btn-success" onclick="closeTask('${guid}','${task.guid_client || ''}')"><i class="bi bi-check-lg me-1"></i>Завершить заявку</button>`;
        } else if (mode === 'my') {
            footer = `
                <button class="btn btn-outline-secondary" onclick="bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();openDocForm('${guid}')"><i class="bi bi-file-earmark-text me-1"></i>Документы</button>
                <button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
        } else if (mode === 'free') {
            footer = `
                <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                <button class="btn btn-primary" onclick="takeTask('${guid}')"><i class="bi bi-hand-index-thumb me-1"></i>Взять заявку</button>`;
        } else if (mode === 'closed') {
            body += `<hr class="my-3"><div><small class="text-muted d-block mb-1">Комментарий при закрытии</small>${formatComments(task.comments)}</div>`;
            if (task.hasAttachments) {
                body += `<hr class="my-3"><div><small class="text-muted d-block mb-1">Вложения</small><div id="closedAttachments"><button class="btn btn-outline-secondary btn-sm" onclick="loadClosedAttachments('${guid}')"><i class="bi bi-download me-1"></i>Загрузить вложения</button></div></div>`;
            }
            footer = `<button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
        }

    document.getElementById('taskDetailBody').innerHTML = body;
    document.getElementById('taskDetailFooter').innerHTML = footer;
}

// ============ ATTACHMENTS ============
function attachFile(type) {
    const input = document.createElement('input');
    input.type = 'file';
    if (type === 'pdf') input.accept = '.pdf';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const base64 = await fileToBase64(file);
        pendingAttachments.push({
            data: base64.split(',')[1],
            extension: file.name.split('.').pop()
        });
        document.getElementById('attachmentsList').innerHTML = pendingAttachments.map(a =>
            `<span class="badge bg-light text-dark me-1">📎 .${a.extension} (${(a.data.length * 0.75 / 1024).toFixed(0)} KB)</span>`
        ).join('');
    };
    input.click();
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function loadClosedAttachments(guid) {
    const container = document.getElementById('closedAttachments');
    container.innerHTML = '<div class="spinner-border spinner-border-sm me-2" role="status"></div>Загрузка...';

    fetch('/api/tasks/' + guid + '/attachments')
        .then(checkAuth).then(r => r.json())
        .then(data => {
            const list = data.attachments || [];
            if (!list.length) {
                container.innerHTML = '<span class="text-muted">Нет вложений</span>';
                return;
            }
            container.innerHTML = list.map(a => {
                const dataUri = 'data:' + a.filetype + ';base64,' + a.content;
                return `<div class="mb-1 d-flex gap-2 align-items-center flex-wrap">
                    <span class="small text-truncate" style="max-width:300px"><i class="bi bi-paperclip me-1"></i>${a.filename}</span>
                    <a href="${dataUri}" download="${a.filename}" class="btn btn-outline-secondary btn-sm"><i class="bi bi-download me-1"></i>Скачать</a>
                    <a href="${dataUri}" target="_blank" class="btn btn-outline-secondary btn-sm"><i class="bi bi-eye me-1"></i>Просмотр</a>
                </div>`;
            }).join('');
        })
        .catch(() => {
            container.innerHTML = '<span class="text-danger">Ошибка загрузки вложений</span>';
        });
}

// ============ CLOSE TASK ============
function closeTask(guid, guidDoc) {
    const comment = document.getElementById('closeComment').value.trim();
    const allTasks = [...tasksMy, ...tasksFree, ...tasksClosed];
    const task = allTasks.find(t => t.guid === guid);
    const hasExistingAttachments = task && task.hasAttachments;

    if (!comment && pendingAttachments.length === 0 && !hasExistingAttachments) {
        alert('Добавьте комментарий или вложение');
        return;
    }

    const btn = document.querySelector('#taskDetailFooter .btn-success');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Закрытие...';

    const doClose = (lat, lng) => {
        fetch('/api/tasks/close', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                guid, guidDoc, comment,
                latitude: lat, longitude: lng,
                attachments: pendingAttachments,
            })
        }).then(checkAuth).then(r => r.json()).then(data => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            if (data.success) {
                if (lat || lng) {
                    taskLocations[guid] = { lat, lng, ts: Date.now() };
                    lsSet('taskLocations', JSON.stringify(taskLocations));
                }
                alert('Заявка закрыта! После проверки менеджером статус будет обновлён.');
                pendingAttachments = [];
                bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                loadTasks();
            } else {
                const msg = data.error || data.detail?._error || data.detail?._raw || 'Ошибка при закрытии заявки';
                alert('Ошибка: ' + msg);
            }
        }).catch(() => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            alert('Ошибка сети');
        });
    };

    if (!navigator.geolocation) { doClose(0, 0); return; }
    navigator.geolocation.getCurrentPosition(
        pos => doClose(pos.coords.latitude, pos.coords.longitude),
        () => doClose(0, 0),
        { timeout: 5000 }
    );
}

// ============ TAKE TASK ============
function takeTask(guid) {
    const allTasks = [...tasksMy, ...tasksFree, ...tasksClosed];
    const task = allTasks.find(t => t.guid === guid);
    if (!task) return;

    document.getElementById('confirmTakeName').textContent = task.name || '—';
    document.getElementById('confirmTakeNumber').textContent = '#' + (cleanNumber(task.number) || task.guid.slice(0,8));
    document.getElementById('confirmTakeDeadline').textContent = 'Срок: ' + formatDate(task.period);
    document.getElementById('confirmTakePriority').textContent = 'Приоритет: ' + (task.priority ?? '—');

    const modal = new bootstrap.Modal(document.getElementById('confirmTakeModal'));
    const btn = document.getElementById('confirmTakeBtn');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('click', () => {
        modal.hide();
        fetch('/api/tasks/take', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({guid})
        }).then(checkAuth).then(r => r.json()).then(data => {
            if (data.status === 'Выполнить' || data.status === 'OK') {
                loadTasks();
            } else {
                alert(data.error || 'Не удалось взять заявку');
            }
        }).catch(() => alert('Ошибка сети'));
    });
    modal.show();
}

// ============ MULTI-SELECT ============
function toggleSelect(guid) {
    if (selectedGuids.has(guid)) selectedGuids.delete(guid);
    else selectedGuids.add(guid);
    document.getElementById('bulkActions').classList.toggle('d-none', selectedGuids.size === 0);
    document.getElementById('bulkCount').textContent = `Выбрано: ${selectedGuids.size}`;
    filterTasks();
}

function cancelMultiSelect() {
    multiSelectMode = false;
    selectedGuids.clear();
    document.getElementById('bulkActions').classList.add('d-none');
    filterTasks();
}

function bulkTakeTasks() {
    if (selectedGuids.size === 0) return;
    if (!confirm(`Взять ${selectedGuids.size} заявок?`)) return;

    const promises = [];
    selectedGuids.forEach(guid => {
        promises.push(
            fetch('/api/tasks/take', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guid})
            }).then(checkAuth).then(r => r.json())
        );
    });

    Promise.allSettled(promises).then(results => {
        const ok = results.filter(r =>
            r.status === 'fulfilled' &&
            (r.value.status === 'Выполнить' || r.value.status === 'OK')
        ).length;
        alert(`Взято: ${ok} из ${selectedGuids.size}`);
        cancelMultiSelect();
        loadTasks();
    });
}

// ============ WAREHOUSE ============
function loadStorages() {
    fetch('/api/warehouse/storages')
    .then(checkAuth).then(r => r.json())
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
    fetch(`/api/warehouse/balances?storage=${guid}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            allBalances = data;
            filterBalances();
        });
}

function filterBalances() {
    const query = document.getElementById('balanceSearch').value.toLowerCase().trim();
    let filtered = allBalances;

    if (currentBalanceFilter === 'equipment')
        filtered = filtered.filter(b => b.series_name);
    else if (currentBalanceFilter === 'zip')
        filtered = filtered.filter(b => !b.series_name);

    if (query) {
        filtered = filtered.filter(b =>
            (b.product_name || '').toLowerCase().includes(query) ||
            (b.series_name || '').toLowerCase().includes(query) ||
            (b.inventory_number || '').toLowerCase().includes(query)
        );
    }

    const container = document.getElementById('balancesList');
    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-box-seam"></i><p>Нет остатков</p></div>';
        return;
    }

    // Mobile: stacked cards
    const mobileHtml = filtered.map(b => `
        <div class="balance-mobile-card d-flex py-2 px-2 border-bottom">
            <div class="flex-grow-1 min-w-0 pe-2 overflow-hidden">
                <div class="fw-semibold text-truncate">${b.product_name || '—'}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.series_name ? 'Сер.: ' + b.series_name : ''}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.inventory_number ? 'Инв.: ' + b.inventory_number : ''}</div>
            </div>
            <div class="fw-bold fs-5 text-end flex-shrink-0 align-self-center">${b.balance ?? 0}</div>
        </div>
    `).join('');

    // Desktop: table
    const desktopHtml = `<div class="table-responsive"><table class="table table-hover balance-table">
        <thead><tr><th>Товар</th><th>Серия</th><th>Инв. номер</th><th class="text-end">Остаток</th></tr></thead>
        <tbody>${filtered.map(b => `<tr>
            <td>${b.product_name || '—'}</td>
            <td>${b.series_name || '—'}</td>
            <td>${b.inventory_number || '—'}</td>
            <td class="text-end fw-bold">${b.balance ?? 0}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;

    container.innerHTML = `<div class="d-md-none">${mobileHtml}</div><div class="d-none d-md-block">${desktopHtml}</div>`;
}

function filterBalanceType(type) {
    currentBalanceFilter = type;
    ['all','equipment','zip'].forEach(t => {
        document.getElementById('bf-'+t)?.classList.toggle('active', t === type);
    });
    filterBalances();
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

    fetch(`/api/salary?start_date=${startDate}&end_date=${endDate}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            const items = data.Data || data.data || [];
            const total = data.total_amount != null ? data.total_amount : (data.totalAmount || 0);
            const container = document.getElementById('salaryList');
            document.getElementById('salaryTotal').textContent = total > 0 ? `Итого: ${total.toLocaleString('ru')} руб.` : '';

            if (items.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-cash-stack"></i><p>Нет данных за этот месяц</p></div>';
                return;
            }
            container.innerHTML = `<div class="table-responsive"><table class="table table-hover">
                <tbody>${items.map((item, i) => {
                    const val = item.value || 0;
                    const bg = i % 2 === 0 ? '' : 'bg-light';
                    return `<tr class="${bg}"><td>${item.title || '—'}</td><td class="text-end fw-semibold">${val.toLocaleString('ru')} руб.</td></tr>`;
                }).join('')}
                <tr class="salary-total"><td><strong>Итого</strong></td><td class="text-end"><strong>${total.toLocaleString('ru')} руб.</strong></td></tr>
                </tbody>
            </table></div>`;
        }).catch(() => {
            document.getElementById('salaryList').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>Ошибка загрузки</p></div>';
        });
}

function changeMonth(delta) {
    currentDate.setMonth(currentDate.getMonth() + delta);
    loadSalary();
}

// ============ PPR ============
function loadPprDepartments() {
    const year = document.getElementById('pprYear').value || new Date().getFullYear();
    const quarter = document.getElementById('pprQuarter').value;
    fetch(`/api/ppr/departments?year=${year}&quarter=${quarter}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            const sel = document.getElementById('pprDepartment');
            sel.innerHTML = '<option value="">Все отделы</option>' +
                (data.departments || []).map(d => `<option>${d}</option>`).join('');
        });
}

function loadPpr() {
    const year = document.getElementById('pprYear').value || new Date().getFullYear();
    const quarter = document.getElementById('pprQuarter').value;
    const department = document.getElementById('pprDepartment').value;

    fetch(`/api/ppr/list?year=${year}&quarter=${quarter}&department=${encodeURIComponent(department)}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            const tasks = data.tasks || [];
            const container = document.getElementById('pprList');
            if (tasks.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-kanban"></i><p>Нет задач ППР</p></div>';
                return;
            }
            // Mobile: cards
            const mobileHtml = tasks.map(t => `
                <div class="ppr-card d-flex align-items-center py-2 px-2 border-bottom gap-2">
                    <div class="flex-grow-1 min-w-0">
                        <div class="fw-semibold text-truncate">#${t.number || t.guid?.slice(0,8)} ${t.name || ''}</div>
                        <div class="small text-muted">${t.name_department || '—'} · <span class="badge bg-info">${t.status || ''}</span> · ${formatDate(t.date)}</div>
                    </div>
                    <div class="flex-shrink-0 d-flex gap-1">
                        <button class="btn btn-outline-secondary btn-sm" onclick="openPprDetail('${t.guid}')" title="Подробнее"><i class="bi bi-info-circle"></i></button>
                        ${t.status !== 'Closed' ? `<button class="btn btn-success btn-sm" onclick="openPprClose('${t.guid}')" title="Закрыть"><i class="bi bi-check-lg"></i></button>` : ''}
                    </div>
                </div>
            `).join('');

            // Desktop: table
            const desktopHtml = `<div class="table-responsive"><table class="table table-hover">
                <thead><tr><th>Номер</th><th>Название</th><th>Отдел</th><th>Статус</th><th>Дата</th><th></th></tr></thead>
                <tbody>${tasks.map(t => `<tr>
                    <td><strong>#${t.number || t.guid?.slice(0,8)}</strong></td>
                    <td>${t.name || ''}</td>
                    <td>${t.name_department || '—'}</td>
                    <td><span class="badge bg-info">${t.status || ''}</span></td>
                    <td>${formatDate(t.date)}</td>
                    <td class="text-end">
                        <button class="btn btn-outline-secondary btn-sm me-1" onclick="openPprDetail('${t.guid}')" title="Подробнее"><i class="bi bi-info-circle"></i></button>
                        ${t.status !== 'Closed' ? `<button class="btn btn-success btn-sm" onclick="openPprClose('${t.guid}')" title="Закрыть"><i class="bi bi-check-lg"></i></button>` : ''}
                    </td>
                </tr>`).join('')}</tbody>
            </table></div>`;

            container.innerHTML = `<div class="d-md-none">${mobileHtml}</div><div class="d-none d-md-block">${desktopHtml}</div>`;
        });
}

function openPprDetail(guid) {
    const year = document.getElementById('pprYear').value;
    const quarter = document.getElementById('pprQuarter').value;
    fetch(`/api/ppr/list?year=${year}&quarter=${quarter}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            const task = (data.tasks || []).find(t => t.guid === guid);
            if (!task) return;
            const modal = new bootstrap.Modal(document.getElementById('pprDetailModal'));
            document.getElementById('pprDetailTitle').innerHTML = `<i class="bi bi-kanban me-2"></i>ППР #${task.number || task.guid.slice(0,8)}`;
            document.getElementById('pprDetailBody').innerHTML = `
                <div class="row g-3">
                    <div class="col-md-6"><div class="p-3 bg-light rounded-3"><small class="text-muted d-block mb-1">Название</small><p class="mb-0 fw-semibold">${task.name || '—'}</p></div></div>
                    <div class="col-md-6"><div class="p-3 bg-light rounded-3"><small class="text-muted d-block mb-1">Отдел</small><p class="mb-0">${task.name_department || '—'}</p></div></div>
                    <div class="col-12"><div class="p-3 bg-light rounded-3"><small class="text-muted d-block mb-1">Описание</small><p class="mb-0 task-description">${task.description || '—'}</p></div></div>
                    <div class="col-md-4"><small class="text-muted d-block">Статус</small><span class="fw-semibold">${task.status || '—'}</span></div>
                    <div class="col-md-4"><small class="text-muted d-block">Дата</small><span class="fw-semibold">${formatDate(task.date)}</span></div>
                    <div class="col-md-4"><small class="text-muted d-block">Комментарий</small><span class="fw-semibold">${task.closeComment || '—'}</span></div>
                </div>`;
            document.getElementById('pprDetailFooter').innerHTML = `<button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
            modal.show();
        });
}

function pprAttachFile(type) {
    const input = document.createElement('input');
    input.type = 'file';
    if (type === 'pdf') input.accept = '.pdf';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const base64 = await fileToBase64(file);
        pprPendingAttachments.push({
            data: base64.split(',')[1],
            extension: file.name.split('.').pop()
        });
        document.getElementById('pprAttachmentsList').innerHTML = pprPendingAttachments.map(a =>
            `<span class="badge bg-light text-dark me-1">📎 .${a.extension} (${(a.data.length * 0.75 / 1024).toFixed(0)} KB)</span>`
        ).join('');
    };
    input.click();
}

function openPprClose(guid) {
    pprPendingAttachments = [];
    const modal = new bootstrap.Modal(document.getElementById('pprDetailModal'));
    document.getElementById('pprDetailTitle').innerHTML = '<i class="bi bi-check-circle me-2"></i>Закрыть задачу ППР';
    document.getElementById('pprDetailBody').innerHTML = `
        <div class="mb-3">
            <label class="form-label fw-semibold">Комментарий</label>
            <textarea class="form-control" id="pprCloseComment" rows="3" placeholder="Введите комментарий..."></textarea>
        </div>
        <div class="mb-2">
            <label class="form-label fw-semibold">Вложения</label>
            <div class="d-flex gap-2">
                <button class="btn btn-outline-secondary btn-sm" onclick="pprAttachFile('pdf')"><i class="bi bi-filetype-pdf me-1"></i>PDF</button>
                <button class="btn btn-outline-secondary btn-sm" onclick="pprAttachFile('any')"><i class="bi bi-paperclip me-1"></i>Файл</button>
            </div>
            <div id="pprAttachmentsList" class="mt-2"></div>
        </div>`;
    document.getElementById('pprDetailFooter').innerHTML = `
        <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
        <button class="btn btn-success" onclick="doPprClose('${guid}')"><i class="bi bi-check-lg me-1"></i>Закрыть</button>`;
    modal.show();
}

function doPprClose(guid) {
    const comment = document.getElementById('pprCloseComment')?.value.trim() || '';
    if (!comment && pprPendingAttachments.length === 0) {
        alert('Добавьте комментарий или вложение');
        return;
    }

    const btn = document.querySelector('#pprDetailFooter .btn-success');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Закрытие...';

    const doRequest = (lat, lng) => {
        fetch('/api/ppr/close', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({guid, comment, latitude: lat, longitude: lng, attachments: pprPendingAttachments})
        }).then(checkAuth).then(r => r.json()).then(data => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            if (data.success) {
                pprPendingAttachments = [];
                bootstrap.Modal.getInstance(document.getElementById('pprDetailModal'))?.hide();
                loadPpr();
            } else {
                alert('Ошибка при закрытии задачи ППР');
            }
        }).catch(() => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            alert('Ошибка сети');
        });
    };
    if (!navigator.geolocation) { doRequest(0, 0); return; }
    navigator.geolocation.getCurrentPosition(
        pos => doRequest(pos.coords.latitude, pos.coords.longitude),
        () => doRequest(0, 0),
        { timeout: 5000 }
    );
}

// ============ CLIENT DIRECTORY ============
function loadClients() {
    fetch('/api/tasks/documents')
        .then(checkAuth).then(r => r.json())
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
    const items = ov.querySelectorAll('.startup-item');
    const times = [1200, 1800, 2400, 3000];
    times.forEach((t, i) => {
        setTimeout(() => items[i]?.classList.add('done'), t);
    });
    setTimeout(() => {
        ov.classList.add('hide');
        sessionStorage.setItem('startupDone', '1');
        setTimeout(() => ov.style.display = 'none', 600);
    }, 4000);
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    runStartup();
    // Restore sort
    const savedSort = lsGet('taskSort', '');
    if (savedSort) document.getElementById('taskSort').value = savedSort;

    // Restore theme
    applyTheme(currentTheme);

    // Restore profile avatar
    updateProfileAvatar();

    // First login — prompt to set up profile
    const defaultWarehouse = lsGet('defaultWarehouse', '');
    if (!savedProfileName || !defaultWarehouse) {
        openSettings(true);
    }

    loadClients();
    loadTasks('', ['my', 'free']);
    loadPprDepartments();

    setInterval(() => loadTasks('', ['my', 'free']), 60000);

    // Right-click on free tasks for multi-select
    document.getElementById('tasksFreeList')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        multiSelectMode = !multiSelectMode;
        if (!multiSelectMode) cancelMultiSelect();
        else { selectedGuids.clear(); filterTasks(); }
    });

    // Load storages + balances when warehouse tab is first shown
    document.getElementById('warehouse-tab')?.addEventListener('shown.bs.tab', () => {
        const sel = document.getElementById('storageSelect');
        if (sel && sel.options.length <= 1) loadStorages();
    });

    // Load salary when salary tab is first shown
    document.getElementById('salary-tab')?.addEventListener('shown.bs.tab', () => {
        const list = document.getElementById('salaryList');
        if (!list || list.children.length) return;
        loadSalary();
    });

    // Load closed tasks when closed pill is first activated
    document.getElementById('closed-pill')?.addEventListener('shown.bs.tab', () => {
            if (!tasksClosed.length) loadClosedTasks();
    });

    // Reset loading state if modal is dismissed manually
    document.getElementById('docFormModal').addEventListener('hidden.bs.modal', () => {
        const loading = document.getElementById('docFormLoading');
        const footer = document.getElementById('docFormFooter');
        if (!loading.classList.contains('d-none')) {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
        }
    });
});

function downloadDocuments(guid) {
    fetch('/api/tasks/documents', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({guid, profile_name: savedProfileName})
    }).then(checkAuth).then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error(t) });
        return r.blob();
    }).then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'documents-' + guid.slice(0,8) + '.zip';
        a.click();
        URL.revokeObjectURL(a.href);
    }).catch(e => alert('Ошибка: ' + e.message));
}

// ============ DOCUMENT FORM ============
let docAllProducts = [];
let docSelectedItems = [];

function loadDocStorages(sel) {
    fetch('/api/warehouse/storages')
        .then(checkAuth).then(r => r.json())
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
    fetch(`/api/warehouse/balances?storage=${guid}`)
        .then(checkAuth).then(r => r.json())
        .then(data => {
            docAllProducts = (data || []).filter(p => p.series_name);
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

    const fields = {
        shop: document.getElementById('docShop').value.trim(),
        sap: document.getElementById('docSap').value.trim(),
        addr: document.getElementById('docAddr').value.trim(),
        desc: document.getElementById('docDesc').value.trim(),
        code: document.getElementById('docCode').value.trim(),
        zd: document.getElementById('docZd').value.trim(),
    };

    if (docSelectedItems.length > 0) {
        fields.items = docSelectedItems.map(item => ({
            name: item.name,
            series: item.series,
        }));
    }

    const includeAct = document.getElementById('docIncludeAct').checked;
    const includeFn = document.getElementById('docIncludeFn').checked;
    const includeM15 = document.getElementById('docIncludeM15').checked;

    // Show loading overlay, disable buttons
    const loading = document.getElementById('docFormLoading');
    const footer = document.getElementById('docFormFooter');
    const cancelBtn = document.getElementById('docFormCancelBtn');
    const submitBtn = document.getElementById('docFormSubmitBtn');
    const status = document.getElementById('docFormStatus');

    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);
    status.textContent = 'Запрос на генерацию...';

    fetch('/api/tasks/documents', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            guid,
            profile_name: savedProfileName,
            include_act: includeAct,
            include_fn: includeFn,
            include_m15: includeM15,
            fields: fields,
        })
    }).then(checkAuth).then(r => {
        if (!r.ok) return r.text().then(t => { throw new Error(t) });
        status.textContent = 'Загрузка файла...';
        return r.blob();
    }).then(blob => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        bootstrap.Modal.getInstance(document.getElementById('docFormModal'))?.hide();

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'documents-' + guid.slice(0,8) + '.zip';
        a.click();
        URL.revokeObjectURL(a.href);
    }).catch(e => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        // Show error inside modal body
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
