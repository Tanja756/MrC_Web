// ============ TASKS ============
let taskSearchTimeout;

let pendingAttachments = [];
let tasksMy = [], tasksFree = [], tasksClosed = [];
let multiSelectMode = false;
const selectedGuids = new Set();
let knownTaskGuids = {};
let taskGuidsInitialized = false;
let deadlinesNotified = false;

function checkNewTaskNotifications(tasks) {
    if (!taskGuidsInitialized) {
        tasks.forEach(function(t) { knownTaskGuids[t.guid] = true; });
        taskGuidsInitialized = true;
        return;
    }
    var newOnes = [];
    tasks.forEach(function(t) {
        if (!knownTaskGuids[t.guid]) newOnes.push(t);
        knownTaskGuids[t.guid] = true;
    });
    if (newOnes.length === 0) return;
    if (newOnes.length === 1) {
        var t = newOnes[0];
        NotificationCenter.show({ icon: 'message', title: 'Новая задача', subtitle: t.name || ('Задача #' + (t.number || '')), actions: ['OK'], duration: 9000 });
    } else {
        NotificationCenter.show({ icon: 'message', title: 'Новые задачи', subtitle: newOnes.length + ' новых задач в разделе «В работе»', actions: ['OK'], duration: 9000 });
    }
}

function checkDeadlineNotifications(tasks) {
    if (deadlinesNotified) return;
    var soon = tasks.filter(function(t) { return getUrgency(t).level >= 2; });
    if (soon.length === 0) return;
    if (soon.length === 1) {
        var t = soon[0];
        NotificationCenter.show({ icon: 'clock', title: 'Скоро дедлайн', subtitle: t.name || ('Задача #' + (t.number || '')), actions: ['OK'], duration: 10000 });
    } else {
        NotificationCenter.show({ icon: 'clock', title: 'Скоро дедлайн', subtitle: soon.length + ' задач с приближающимся сроком', actions: ['OK'], duration: 10000 });
    }
    deadlinesNotified = true;
}

/**** guids tracking ****/
let currentTab = localStorage.getItem('taskTab') || 'my';
if (!['my', 'free', 'closed'].includes(currentTab)) currentTab = 'my';
let tabPrefs = {
    my: { sort: lsGet('taskSort_my', 'deadline'), dir: lsGet('taskSortDir_my', 'asc') },
    free: { sort: lsGet('taskSort_free', 'deadline'), dir: lsGet('taskSortDir_free', 'asc') },
    closed: { sort: lsGet('taskSort_closed', 'closed_at'), dir: lsGet('taskSortDir_closed', 'desc') },
};

function saveTabPrefs(tab) {
    if (!tab) tab = currentTab;
    lsSet('taskSort_' + tab, tabPrefs[tab].sort);
    lsSet('taskSortDir_' + tab, tabPrefs[tab].dir);
}

function loadTabIntoUI(tab) {
    const prefs = tabPrefs[tab];
    document.getElementById('taskSort').value = prefs.sort;
    document.querySelectorAll('#sortDirGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.dir === prefs.dir));
}

function switchTab(tab) {
    saveTabPrefs(currentTab);
    currentTab = tab;
    localStorage.setItem('taskTab', tab);
    loadTabIntoUI(tab);
    if (tab === 'closed') {
        loadClosedTasks('', tabPrefs.closed.sort);
    } else {
        filterTasks();
    }
}

function setSortDir(dir) {
    tabPrefs[currentTab].dir = dir;
    saveTabPrefs();
    document.querySelectorAll('#sortDirGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.dir === dir));
    filterTasks();
}

function loadTasks(search, types) {
    const fetches = [];
    const labels = types || ['my', 'free'];
    const ttl = document.hidden ? 0 : 15000;
    for (const label of labels) {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        params.set('sort', tabPrefs[label].sort);
        params.set('dir', tabPrefs[label].dir);
        const qs = params.toString() ? '?' + params.toString() : '';
        fetches.push(fetchDeduped('/api/tasks/' + label + qs, undefined, ttl).then(r => { if (r instanceof Response) return r.json().catch(() => ({})); return r; }));
    }
    if (fetches.length === 0) return;
    Promise.all(fetches).then(results => {
        let i = 0;
        if (labels.includes('my')) { const d = results[i] || {}; if (Array.isArray(d.tasks)) { checkNewTaskNotifications(d.tasks); checkDeadlineNotifications(d.tasks); tasksMy = d.tasks; } i++; }
        if (labels.includes('free')) { const d = results[i] || {}; if (Array.isArray(d.tasks)) tasksFree = d.tasks; i++; }
        filterTasks();
    });
}

function autoRefreshTasks() {
    const el = document.getElementById('taskCount');
    refreshCurrentTab()
        .then(() => { if (el) el.style.color = '#1a7a1a'; })
        .catch(() => { if (el) el.style.color = '#8b0000'; })
        .finally(() => { if (el) setTimeout(() => el.style.color = '', 2000); });
}

if (document.getElementById('tasksMyList')) {
    setInterval(() => {
        if (isWorkingHours()) autoRefreshTasks();
    }, 600000);
}

function onRefreshClick() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.remove('refreshed');
    btn.classList.add('refreshing');
    Promise.all([
        refreshCurrentTab(),
        new Promise(r => setTimeout(r, 300)),
    ]).then(() => {
        btn.classList.remove('refreshing');
        btn.classList.add('refreshed');
        setTimeout(() => btn.classList.remove('refreshed'), 1500);
    }).catch(() => btn.classList.remove('refreshing'));
}

function refreshCurrentTab(search) {
    const s = search !== undefined ? search : document.getElementById('taskSearch').value.trim();
    if (currentTab === 'closed') {
        return loadClosedTasks(s || '', tabPrefs.closed.sort);
    }
    const params = new URLSearchParams();
    if (s) params.set('search', s);
    params.set('sort', tabPrefs[currentTab].sort);
    params.set('dir', tabPrefs[currentTab].dir);
    const qs = params.toString() ? '?' + params.toString() : '';
    return fetchDeduped('/api/tasks/' + currentTab + qs, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            if (Array.isArray(data.tasks)) {
                if (currentTab === 'my') { checkNewTaskNotifications(data.tasks); checkDeadlineNotifications(data.tasks); tasksMy = data.tasks; }
                else tasksFree = data.tasks;
            }
            filterTasks();
        });
}

function loadClosedTasks(search, sort) {
    if (search === undefined) search = document.getElementById('taskSearch').value.trim();
    if (sort === undefined) sort = tabPrefs.closed.sort;

    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('sort', sort);
    params.set('dir', tabPrefs.closed.dir);
    const qs = '?' + params.toString();

    return fetchDeduped('/api/tasks/closed' + qs, undefined, 15000).then(r => r instanceof Response ? r.json().catch(() => null) : r).then(data => {
        if (data && Array.isArray(data.tasks)) tasksClosed = data.tasks;
        filterTasks();
    });
}

function onTaskSearch() {
    const q = document.getElementById('taskSearch').value.trim();
    filterTasks();
    clearTimeout(taskSearchTimeout);
    taskSearchTimeout = setTimeout(() => {
        refreshCurrentTab(q || undefined);
    }, 400);
}

function filterTasks() {
    const query = document.getElementById('taskSearch').value.toLowerCase().trim();
    tabPrefs[currentTab].sort = document.getElementById('taskSort').value;
    saveTabPrefs();

    renderTasks('tasksMyList', tasksMy, query, 'my');
    renderTasks('tasksFreeList', tasksFree, query, 'free');
    renderTasks('tasksClosedList', tasksClosed, query, 'closed');
}

function resetFilters() {
    document.getElementById('taskSearch').value = '';
    for (const t of ['my', 'free', 'closed']) {
        tabPrefs[t].sort = t === 'closed' ? 'closed_at' : 'deadline';
        tabPrefs[t].dir = t === 'closed' ? 'desc' : 'asc';
        saveTabPrefs(t);
    }
    document.getElementById('taskSort').value = tabPrefs[currentTab].sort;
    document.querySelectorAll('#sortDirGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.dir === 'asc'));
    clearTimeout(taskSearchTimeout);
    refreshCurrentTab();
}

function sortTasks(tasks, sort, dir) {
    const s = [...tasks];
    const r = dir === 'asc' ? 1 : -1;
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
        case 'closed_at': {
            s.sort((a, b) => {
                const da = parseDate(a.closed_at) || parseDate(a.period);
                const db = parseDate(b.closed_at) || parseDate(b.period);
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
    if (level === 2) return 'urgency-imminent';
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

function renderTasks(containerId, tasks, query, mode) {
    const container = document.getElementById(containerId);
    const defaultSort = mode === 'closed' ? 'closed_at' : 'deadline';
    const sort = tabPrefs[mode]?.sort || defaultSort;
    const dir = tabPrefs[mode]?.dir || (mode === 'closed' ? 'desc' : 'asc');
    const filtered = tasks.filter(t => {
        const searchStr = [
            t.number, t.name, t.status, t.name_department, t.user,
            clientName(t.guid_client)
        ].filter(Boolean).join(' ').toLowerCase();
        return searchStr.includes(query);
    });

    let sorted;
    if (mode === 'closed') {
        if (sort === 'deadline') {
            const confirming = sortTasks(filtered.filter(t => t.status && (t.status.includes('Подтвердить') || t.status.includes('подтвердить'))), 'deadline', dir);
            const rest = sortTasks(filtered.filter(t => !t.status || (!t.status.includes('Подтвердить') && !t.status.includes('подтвердить'))), 'deadline', dir);
            sorted = [...confirming, ...rest];
        } else {
            sorted = sortTasks(filtered, sort, dir);
        }
    } else {
        const pinned = sortTasks(filtered.filter(t => isPinned(t.guid)), sort, dir);
        const unpinned = sortTasks(filtered.filter(t => !isPinned(t.guid)), sort, dir);
        sorted = [...pinned, ...unpinned];
    }

    // Show only closed tasks with locations
    const showLocation = (mode === 'closed');

    if (mode === currentTab) {
        document.getElementById('taskCount').textContent = sorted.length;
    }

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-inbox"></i><p>Нет заявок</p></div>';
        return;
    }

    container.innerHTML = sorted.map(t => {
        const urgency = mode === 'closed' ? { level: 0, label: '' } : getUrgency(t);
        const markMine = lsGet('markMyTasks', '') === 'true';
        const keywords = lsGet('myTaskKeywords', '').split(',').map(s => s.trim()).filter(Boolean);
        let inWorkSaps = [];
        try { inWorkSaps = JSON.parse(lsGet('inWorkSaps', '[]')); } catch(e) {}
        const allKeys = [...keywords, ...inWorkSaps];
        const isMine = mode === 'free' && markMine && allKeys.length > 0 && allKeys.some(k => (t.name && t.name.toLowerCase().includes(k.toLowerCase())) || (t.number && t.number.toLowerCase().includes(k.toLowerCase())));
        const uc = isMine ? 'urgency-mine' : (t.is_new && mode === 'free' ? 'urgency-new' : urgencyClass(urgency.level));
        const pinIcon = isPinned(t.guid) ? 'pinned bi-pin-fill' : 'bi-pin';
        const pinHtml = mode === 'closed' ? '' : `<i class="bi ${pinIcon} pin-icon" onclick="togglePin('${t.guid}')"></i>`;
        const hasLoc = !!taskLocations[t.guid];
        const hasAttach = t.hasAttachments;
        const waitMs = parseDate(t.date) ? Date.now() - parseDate(t.date).getTime() : null;
        const waitHours = waitMs ? waitMs / (1000 * 60 * 60) : null;
        const remainMs = parseDate(t.period) ? parseDate(t.period).getTime() - Date.now() : null;
        const remainHours = remainMs ? remainMs / (1000 * 60 * 60) : null;

        const isOverdue = remainMs !== null && remainMs < 0;
        const isDueSoon = remainMs !== null && remainMs > 0 && remainMs < 4 * 60 * 60 * 1000;
        const deadlineClass = isOverdue ? 'urgent' : isDueSoon ? 'warning' : '';

        // Priority dot
        let priorityClass = 'low';
        const p = parseInt(t.priority, 10);
        if (p >= 8) priorityClass = 'high';
        else if (p >= 5) priorityClass = 'medium';

        // Status badge class
        const isClosed = t.status === 'Closed' || t.status === 'closed';
        const isConfirming = t.status && (t.status.includes('Подтвердить') || t.status.includes('подтвердить'));
        const statusClass = isConfirming ? 'confirming' : (isClosed ? 'closed' : 'open');

        const multiCheck = multiSelectMode && mode === 'free'
            ? `<input type="checkbox" class="form-check-input multi-check" ${selectedGuids.has(t.guid) ? 'checked' : ''} onchange="toggleSelect('${t.guid}')">`
            : '';

        const typeName = taskPriorityMap[t.priority] || '';
        const typeBadge = typeName ? `<span class="task-type-badge ms-auto">${esc(typeName)}</span>` : '';
        const hkCode = (t.name || '').match(/[А-ЯЁ]{2}-\d{6}(?=[:;| ]|$)/);
        const hk = hkCode ? esc(hkCode[0]) : '';
        let actionHtml = '';
        if (mode === 'my' && !isClosed) {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action" onclick="openDocForm('${t.guid}')" title="Документы"><i class="bi bi-file-earmark-text"></i><span class="btn-label"> Документы</span></button><button class="btn btn-outline-secondary btn-action" onclick="viewM15Equipment('${t.guid}','${hk}')" title="Просмотреть сохранённое оборудование"><i class="bi bi-clipboard-data"></i></button><button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','user')" title="Завершить"><i class="bi bi-check-lg"></i><span class="btn-label"> Завершить</span></button>`;
        } else if (mode === 'free' && !multiSelectMode) {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action" onclick="openDocForm('${t.guid}')" title="Документы"><i class="bi bi-file-earmark-text"></i><span class="btn-label"> Документы</span></button><button class="btn btn-outline-secondary btn-action" onclick="viewM15Equipment('${t.guid}','${hk}')" title="Просмотреть сохранённое оборудование"><i class="bi bi-clipboard-data"></i></button><button class="btn btn-outline-secondary btn-action" onclick="takeTask('${t.guid}')" title="Взять"><i class="bi bi-hand-index-thumb"></i><span class="btn-label"> Взять</span></button>`;
        } else if (mode === 'closed') {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action" onclick="viewM15Equipment('${t.guid}','${hk}')" title="Просмотреть сохранённое оборудование"><i class="bi bi-clipboard-data"></i></button>`;
        }

        // Deadline label
        let deadlineLabel = formatDate(t.period);
        if (isOverdue && urgency.label) deadlineLabel = urgency.label;

        return `<div class="card mb-2 task-card ${uc}">
            <div class="card-body">
                <div class="task-header">
                    ${multiCheck}
                    <span class="task-priority ${priorityClass}"></span>
                    ${t.status ? `<span class="task-status ${statusClass}">${t.status}</span>` : ''}
                    ${isOverdue && mode !== 'closed' ? '<span class="badge bg-danger ms-1">Просрочено</span>' : ''}
                    ${t.name_department ? `<span class="task-dept">${t.name_department}</span>` : ''}
                    <div class="task-header-end">
                        ${hasAttach ? '<i class="bi bi-paperclip meta-icon text-muted" title="Есть вложения"></i>' : ''}
                        ${showLocation ? (hasLoc ? '<i class="bi bi-geo-alt-fill meta-icon text-success" title="Геолокация сохранена"></i>' : '<i class="bi bi-geo-alt meta-icon text-danger" title="Нет геолокации"></i>') : ''}
                        ${pinHtml}
                    </div>
                </div>
                <div class="task-name">${t.name || ''}</div>
                <div class="task-meta-row">
                    ${t.user ? `<span class="task-meta-item"><i class="bi bi-person"></i>${t.user}</span>` : ''}
                    ${t.guid_client && clientName(t.guid_client) ? `<span class="task-meta-item"><i class="bi bi-building"></i>${clientName(t.guid_client)}</span>` : ''}
                    ${t.date ? `<span class="task-meta-item"><i class="bi bi-calendar3"></i>${formatDate(t.date)}</span>` : ''}
                    ${t.taken_at && mode === 'my' ? `<span class="task-meta-item"><i class="bi bi-play-fill"></i>${formatDate(t.taken_at)}</span>` : ''}
                    ${(t.closed_at)
                        ? `<span class="task-meta-item"><i class="bi bi-check-circle"></i>${formatDate(t.closed_at)}</span>`
                        : (mode === 'closed' ? `<span class="task-meta-item text-muted"><i class="bi bi-check-circle"></i>${formatDate(t.period)} <small>(срок)</small></span>` : '')}
                    <span class="task-meta-item ${deadlineClass}"><i class="bi bi-alarm"></i>${deadlineLabel}</span>
                </div>
                <div class="task-actions">
                    ${actionHtml}${typeBadge}
                </div>
            </div>
        </div>`;
    }).join('');
}

// ============ TASK DETAIL ============
function openTaskDetail(guid, mode) {
    const modalEl = document.getElementById('taskDetailModal');
    if (modalEl.classList.contains('show')) return;
    const modal = new bootstrap.Modal(modalEl);
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

let _taskCtx = null;

function showTaskDetail(task, mode, guid) {
    _taskCtx = { task, mode, guid };
    document.getElementById('taskDetailTitle').innerHTML = `<i class="bi bi-info-circle me-2"></i>${task.name || ''}`;

        let body = `
            <div class="row g-3">
                <div class="col-12">
                    <div class="p-3 bg-light rounded-3">
                        <small class="text-muted d-block mb-1">Описание</small>
                        <p class="mb-0 task-description">${task.description || '—'}</p>
                        <span id="taskDetailSapCountDesc" class="d-none badge bg-success text-dark mt-2"></span>
                    </div>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Статус</small>
                    <span class="fw-semibold">${task.status || '—'}</span>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Дата создания</small>
                    <span class="fw-semibold">${formatDate(task.date)}</span>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Срок</small>
                    <span class="fw-semibold">${formatDate(task.period)}</span>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Приоритет</small>
                    <span class="fw-semibold">${task.priority != null ? task.priority : '—'}</span>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Отдел</small>
                    <span class="fw-semibold">${task.name_department || '—'}</span>
                </div>
                <div class="col-6 col-md-4 d-none d-md-block">
                    <small class="text-muted d-block">Клиент</small>
                    <span class="fw-semibold">${clientName(task.guid_client)}</span>
                </div>
            </div>`;

        let footer = '';

        if (mode === 'user') {
            if (_taskCtx && _taskCtx.guid !== guid) pendingAttachments = [];
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
                </div>
                `;
            footer = `
                <button class="btn btn-danger me-auto" onclick="showRejectForm()" title="Отклонить заявку"><i class="bi bi-x-circle"></i></button>
                <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                <button class="btn btn-success" onclick="closeTask('${guid}','${task.guid_client || ''}')"><i class="bi bi-check-lg me-1"></i>Завершить заявку</button>`;
        } else if (mode === 'my') {
            if (task.hasAttachments) {
                body += `<hr class="my-3"><div><small class="text-muted d-block mb-1">Вложения</small><div id="closedAttachments"><button class="btn btn-outline-secondary btn-sm" onclick="loadClosedAttachments('${guid}')"><i class="bi bi-download me-1"></i>Загрузить вложения</button></div></div>`;
            }
            footer = `
                <button class="btn btn-outline-secondary me-auto" onclick="showRedirectForm('${guid}','${mode}')" title="Вернуть в свободные"><i class="bi bi-arrow-return-left"></i></button>
                <button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
        } else if (mode === 'free') {
            footer = `
                <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                <button class="btn btn-primary" onclick="takeTask('${guid}')"><i class="bi bi-hand-index-thumb me-1"></i>Взять заявку</button>`;
        } else if (mode === 'closed') {
            body += `
                <hr class="my-3">
                <div class="row g-3">
                    <div class="col-6 col-md-4">
                        <small class="text-muted d-block">Дата закрытия</small>
                        <span class="fw-semibold" id="closedAtDisplay" data-value="${task.closed_at || ''}">
                            ${task.closed_at ? formatDate(task.closed_at) : (formatDate(task.period) + ' <small class="text-muted">(срок)</small>')}
                            <i class="bi bi-pencil ms-1 edit-icon" onclick="editClosedAt('${guid}')" title="Изменить дату закрытия"></i>
                        </span>
                    </div>
                </div>`;
            body += `<hr class="my-3"><div><small class="text-muted d-block mb-1">Комментарий при закрытии</small>${formatComments(task.comments)}</div>`;
            if (task.hasAttachments) {
                body += `<hr class="my-3"><div><small class="text-muted d-block mb-1">Вложения</small><div id="closedAttachments"><button class="btn btn-outline-secondary btn-sm" onclick="loadClosedAttachments('${guid}')"><i class="bi bi-download me-1"></i>Загрузить вложения</button></div></div>`;
            }
            const showRedirect = task.status && (task.status.includes('Подтвердить') || task.status.includes('подтвердить'));
            footer = `${showRedirect ? `<button class="btn btn-outline-secondary me-auto" onclick="showRedirectForm('${guid}','${mode}')" title="Вернуть в свободные"><i class="bi bi-arrow-return-left"></i></button>` : ''}<button class="btn btn-outline-secondary" onclick="openDocForm('${guid}')"><i class="bi bi-file-earmark-text me-1"></i>Документы</button><button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
        }

    document.getElementById('taskDetailBody').innerHTML = body;
    document.getElementById('taskDetailFooter').innerHTML = footer;

    (function() {
        const el = document.getElementById('taskDetailSapCount');
        const elDesc = document.getElementById('taskDetailSapCountDesc');
        const text = (task.name || '') + '\n' + (task.description || '');
        const m = text.match(/SAP-(\w{4})/i);
        const sap = m ? m[1].toUpperCase() : '';
        if (!sap) {
            el.classList.add('d-none');
            if (elDesc) elDesc.classList.add('d-none');
            return;
        }
        const pattern = new RegExp('SAP-' + sap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        const count = [...tasksMy, ...tasksFree].filter(t => t.guid !== guid && pattern.test((t.name || '') + '\n' + (t.description || ''))).length;
        if (count > 0) {
            let word;
            if (count % 10 === 1 && count % 100 !== 11) word = 'заявка';
            else if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20)) word = 'заявки';
            else word = 'заявок';
            const text = 'Ещё ' + count + ' активн' + (count % 10 === 1 && count % 100 !== 11 ? 'ая ' : 'ых ') + word;
            el.textContent = text;
            el.classList.remove('d-none');
            if (elDesc) {
                elDesc.textContent = text;
                elDesc.classList.remove('d-none');
            }
        } else {
            el.classList.add('d-none');
            if (elDesc) elDesc.classList.add('d-none');
        }
    })();

    if (mode === 'user' && guid) {
        fetch('/api/tasks/' + guid + '/m15-items')
            .then(checkAuth)
            .then(r => r.json())
            .then(items => {
                if (items && items.length > 0) {
                    const el = document.getElementById('closeComment');
                    if (el) el.value = items.map(i => i.name + ' ' + i.series).join('\n');
                }
            })
            .catch(() => {});
    }

    fetchAndAppendFnData(task);
    fetchAndAppendShopContacts(task);

    if (mode === 'user') {
        const modalEl = document.getElementById('taskDetailModal');
        modalEl.addEventListener('shown.bs.modal', function handler() {
            const el = document.getElementById('closeComment');
            if (el) el.focus();
            modalEl.removeEventListener('shown.bs.modal', handler);
        });
    }
}

function fetchAndAppendFnData(task) {
    if (task.priority != 300) return;
    const text = (task.name || '') + '\n' + (task.description || '');
    const m = text.match(/(\d+)-Пятерочка/);
    if (!m) return;
    const shopNumber = m[1];
    fetch('/api/fn/shop/' + encodeURIComponent(shopNumber))
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            const rows = data.rows || [];
            if (rows.length === 0) return;
            const bodyEl = document.getElementById('taskDetailBody');
            if (!bodyEl) return;
            let fnHtml = '<hr class="my-3"><div class="p-3 bg-light rounded-3"><small class="text-muted d-block mb-2"><i class="bi bi-cpu me-1"></i>Замена ФН</small>';
            rows.forEach(r => {
                fnHtml += '<div class="row g-2 small">';
                fnHtml += '<div class="col-6"><strong>Касса:</strong> ' + esc(r.cashreg_number || '—') + '</div>';
                fnHtml += '<div class="col-6"><strong>Зав.№ ККТ:</strong> ' + esc(r.kkt_serial || '—') + '</div>';
                fnHtml += '<div class="col-6"><strong>Модель ККТ:</strong> ' + esc(r.kkt_model || '—') + '</div>';
                fnHtml += '<div class="col-6"><strong>Дата оконч. ФН:</strong> ' + formatDateShort(r.fn_expiry) + '</div>';
                fnHtml += '</div>';
            });
            fnHtml += '</div>';
            bodyEl.insertAdjacentHTML('beforeend', fnHtml);
        })
        .catch(() => {});
}

function fetchAndAppendShopContacts(task) {
    const text = (task.name || '') + '\n' + (task.description || '');
    const m = text.match(/SAP-(\w{4})/i);
    const sap = m ? m[1].toUpperCase() : '';
    if (!sap) return;
    fetch(`/api/shop/by-sap?sap=${encodeURIComponent(sap)}`)
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            if (!data || !data.sap) return;
            const roles = [
                { label: 'ДМ', name: data.dm_name, phone: data.dm_phone },
                { label: 'АДМ1', name: data.adm1_name, phone: data.adm1_phone },
                { label: 'АДМ2', name: data.adm2_name, phone: data.adm2_phone },
            ];
            const parts = roles
                .filter(r => r.phone)
                .map(r => r.label + ': ' + r.phone + (r.name ? ' (' + r.name + ')' : ''));
            if (!parts.length) return;
            const bodyEl = document.getElementById('taskDetailBody');
            if (!bodyEl) return;
            const contactHtml = '<div class="mt-2 p-2 bg-info bg-opacity-10 rounded-3 small"><strong>Контакты:</strong> ' + esc(parts.join(' ')) + '</div>';
            const descEl = bodyEl.querySelector('.task-description');
            if (descEl) {
                descEl.insertAdjacentHTML('afterend', contactHtml);
            } else {
                bodyEl.insertAdjacentHTML('afterbegin', contactHtml);
            }
        })
        .catch(() => {});
}

// ============ EDIT CLOSED AT ============
function editClosedAt(guid) {
    const display = document.getElementById('closedAtDisplay');
    if (!display) return;
    const raw = display.dataset.value || '';
    const inputId = 'closedAtInput';
    let value = '';
    const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
    if (parts) {
        value = `${parts[1]}-${parts[2]}-${parts[3]} ${String(parts[4]).padStart(2,'0')}:${parts[5]}`;
    } else {
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const mi = String(now.getMinutes()).padStart(2, '0');
        value = `${y}-${mo}-${d} ${h}:${mi}`;
    }
    display.innerHTML = `
        <div class="d-flex align-items-center gap-1 flex-nowrap">
            <input type="text" id="${inputId}" class="form-control form-control-sm" placeholder="ДД.ММ.ГГГГ ЧЧ:ММ" style="max-width:200px">
            <button class="btn btn-sm btn-outline-success" onclick="saveClosedAt('${guid}')" title="Сохранить"><i class="bi bi-check-lg"></i></button>
            <button class="btn btn-sm btn-outline-secondary" onclick="cancelEditClosedAt()" title="Отмена"><i class="bi bi-x-lg"></i></button>
        </div>`;
    flatpickr('#' + inputId, {
        enableTime: true,
        locale: 'ru',
        dateFormat: 'Y-m-d H:i',
        defaultDate: value,
        time_24hr: true,
        allowInput: true,
        position: 'auto'
    });
}

function saveClosedAt(guid) {
    const input = document.getElementById('closedAtInput');
    if (!input) return;
    const val = input.value;
    if (!val) return;
    const closedAt = val + ':00';
    const display = document.getElementById('closedAtDisplay');
    const originalHtml = display.innerHTML;
    display.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    fetch(`/api/tasks/${guid}/update-closed-at`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({closed_at: closedAt})
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const d = parseDate(closedAt);
            const dd = d ? `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(-2)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : '—';
            display.innerHTML = `${dd} <i class="bi bi-pencil ms-1 edit-icon" onclick="editClosedAt('${guid}')" title="Изменить дату закрытия"></i>`;
            display.dataset.value = closedAt;
        } else {
            display.innerHTML = originalHtml;
            showAlert(data.error || 'Ошибка сохранения', 'danger');
        }
    })
    .catch(() => {
        display.innerHTML = originalHtml;
        showAlert('Ошибка сети', 'danger');
    });
}

function cancelEditClosedAt() {
    const input = document.getElementById('closedAtInput');
    if (input && input._flatpickr) input._flatpickr.destroy();
    const display = document.getElementById('closedAtDisplay');
    if (!display) return;
    const raw = display.dataset.value || '';
    const d = parseDate(raw);
    const text = d ? `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getFullYear()).slice(-2)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}` : '—';
    const guid = (_taskCtx && _taskCtx.guid) || '';
    display.innerHTML = `${text} <i class="bi bi-pencil ms-1 edit-icon" onclick="editClosedAt('${guid}')" title="Изменить дату закрытия"></i>`;
}

// ============ REJECT FORM ============
function showRejectForm() {
    const ctx = _taskCtx;
    if (!ctx) return;
    document.getElementById('taskDetailTitle').innerHTML = `<i class="bi bi-x-circle me-2"></i>Отмена заявки`;
    document.getElementById('taskDetailBody').innerHTML = `
        <div class="mb-3">
            <label class="form-label fw-semibold">Причина отмены</label>
            <textarea class="form-control" id="rejectComment" rows="3" placeholder="Укажите причину отмены..."></textarea>
        </div>`;
    document.getElementById('taskDetailFooter').innerHTML = `
        <button class="btn btn-secondary" onclick="showTaskDetail(_taskCtx.task, _taskCtx.mode, _taskCtx.guid)"><i class="bi bi-arrow-left me-1"></i>Назад</button>
        <button class="btn btn-danger" onclick="rejectTask('${ctx.guid}')"><i class="bi bi-x-circle me-1"></i>Отклонить</button>`;
}

// ============ ATTACHMENTS ============
function attachFile(type) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (type === 'pdf') input.accept = '.pdf';
    input.onchange = async (e) => {
        const files = e.target.files;
        if (!files || !files.length) return;
        for (const file of files) {
            const base64 = await fileToBase64(file);
            pendingAttachments.push({
                data: base64.split(',')[1],
                extension: file.name.split('.').pop(),
                filename: file.name
            });
        }
        renderPendingAttachments();
    };
    input.click();
}

function renderPendingAttachments() {
    document.getElementById('attachmentsList').innerHTML = pendingAttachments.map((a, i) =>
        `<span class="badge bg-light text-dark me-1 d-inline-flex align-items-center gap-1">📎 ${a.filename || ('.' + a.extension)} (${(a.data.length * 0.75 / 1024).toFixed(0)} KB) <i class="bi bi-x-circle-fill text-danger" style="cursor:pointer;font-size:0.7rem" onclick="removePendingAttachment(${i})"></i></span>`
    ).join('');
}

function removePendingAttachment(idx) {
    pendingAttachments.splice(idx, 1);
    renderPendingAttachments();
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
        showAlert('Добавьте комментарий или вложение', 'warning');
        return;
    }

    const btn = document.querySelector('#taskDetailFooter .btn-success');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Закрытие...';

    const doClose = (lat, lng) => {
        try {
            const attachments = pendingAttachments;
            pendingAttachments = [];
            const taskName = task ? (task.number ? `Заявка ${task.number} — ${task.name || ''}` : (task.name || '')) : '';
            const body = JSON.stringify({
                guid, guidDoc, comment,
                latitude: lat, longitude: lng,
                attachments: attachments,
                taskName: taskName,
            });
            fetch('/api/tasks/close', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: body,
            }).then(checkAuth).then(r => {
                if (!r.ok) {
                    return r.text().then(text => {
                        let detail;
                        try { detail = JSON.parse(text); } catch(e) { detail = {}; }
                        const msg = detail.error || detail.detail?._error || detail.detail?._raw || text || 'HTTP ' + r.status;
                        throw new Error(msg);
                    });
                }
                return r.json();
            }).then(data => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                if (data.success) {
                    if (lat || lng) {
                        taskLocations[guid] = { lat, lng, ts: Date.now() };
                        lsSet('taskLocations', JSON.stringify(taskLocations));
                    }
                    bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                    setTimeout(() => {
                        showAlert('Заявка закрыта! После проверки менеджером статус будет обновлён.', 'success');
                        NotificationCenter.show({ icon: 'success', title: 'Заявка закрыта', subtitle: 'После проверки менеджером статус будет обновлён', actions: ['OK'], duration: 6000 });
                    }, 300);
                    tasksMy = tasksMy.filter(t => t.guid !== guid);
                    cacheDel('/api/tasks/my');
                    cacheClearPrefix('/api/tasks/closed');
                    filterTasks();
                } else {
                    const msg = data.error || data.detail?._error || data.detail?._raw || 'Ошибка при закрытии заявки';
                    showAlert('Ошибка: ' + msg, 'danger');
                }
            }).catch(err => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                const msg = err && err.message;
                if (msg && msg !== 'Failed to fetch') {
                    showAlert('Ошибка: ' + msg, 'danger');
                } else {
                    // Network error — request may have reached 1C
                    bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                    tasksMy = tasksMy.filter(t => t.guid !== guid);
                    cacheDel('/api/tasks/my');
                    cacheClearPrefix('/api/tasks/closed');
                    filterTasks();
                    setTimeout(() => {
                        showAlert('Заявка отправлена, проверьте статус после обновления.', 'warning');
                    }, 300);
                }
            });
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            showAlert('Ошибка при подготовке данных: ' + e.message, 'danger');
        }
    };

    doClose(0, 0);
}

// ============ TAKE TASK ============
function takeTask(guid) {
    const modalEl = document.getElementById('confirmTakeModal');
    if (modalEl.classList.contains('show')) return;
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
                NotificationCenter.show({ icon: 'success', title: 'Заявка взята', subtitle: 'Заявка #' + (cleanNumber(task.number) || task.guid.slice(0,8)) + ' теперь в работе', actions: ['OK'], duration: 6000 });
                cacheClearPrefix('/api/tasks/');
                loadTasks();
            } else {
                showAlert(data.error || 'Не удалось взять заявку', 'danger');
            }
        }).catch(() => showAlert('Ошибка сети', 'danger'));
    });
    modal.show();
}

// ============ REJECT TASK ============
function rejectTask(guid) {
    const comment = document.getElementById('rejectComment').value.trim();
    if (!comment) {
        showAlert('Укажите причину отмены', 'warning');
        return;
    }
    showConfirm('Отменить заявку?')
        .then(ok => {
            if (!ok) return;
            const btn = document.querySelector('#taskDetailFooter .btn-danger');
            const origHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Отмена...';
            fetch('/api/tasks/reject', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guid, comment})
            }).then(checkAuth).then(r => r.json()).then(data => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                if (data.success) {
                    bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                    setTimeout(() => {
                        showAlert('Заявка отменена', 'success');
                    }, 300);
                    cacheClearPrefix('/api/tasks/');
                    loadTasks();
                } else {
                    const msg = data.error || data.detail?._error || 'Ошибка при отмене';
                    showAlert('Ошибка: ' + msg, 'danger');
                }
            }).catch(() => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                showAlert('Ошибка сети', 'danger');
            });
        });
}

// ============ REDIRECT (RETURN TO FREE) ============
function openTaskRedirect(guid, mode) {
    const modalEl = document.getElementById('taskDetailModal');
    if (modalEl.classList.contains('show')) {
        showRedirectForm(guid, mode);
        return;
    }
    const lists = {user: tasksMy, my: tasksMy, free: tasksFree, closed: tasksClosed};
    const task = (lists[mode] || []).find(t => t.guid === guid);
    if (!task) return;
    _taskCtx = { task, mode, guid };
    showRedirectForm(guid, mode);
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
}

function showRedirectForm(guid, mode) {
    const ctx = _taskCtx;
    if (!ctx && !guid) return;
    const g = guid || ctx.guid;
    const m = mode || ctx.mode;
    document.getElementById('taskDetailTitle').innerHTML = `<i class="bi bi-arrow-return-left me-2"></i>Возврат заявки`;
    document.getElementById('taskDetailBody').innerHTML = `
        <div class="mb-3">
            <label class="form-label fw-semibold">Причина возврата</label>
            <textarea class="form-control" id="redirectComment" rows="3" placeholder="Укажите причину возврата..."></textarea>
        </div>`;
    document.getElementById('taskDetailFooter').innerHTML = `
        <button class="btn btn-secondary" onclick="showTaskDetail(_taskCtx.task, '${m}', '${g}')"><i class="bi bi-arrow-left me-1"></i>Назад</button>
        <button class="btn btn-warning" onclick="redirectTask('${g}')"><i class="bi bi-arrow-return-left me-1"></i>Вернуть в свободные</button>`;
}

function redirectTask(guid) {
    const comment = document.getElementById('redirectComment').value.trim();
    if (!comment) {
        showAlert('Укажите причину возврата', 'warning');
        return;
    }
    showConfirm('Вернуть заявку в свободные?')
        .then(ok => {
            if (!ok) return;
            const btn = document.querySelector('#taskDetailFooter .btn-warning');
            const origHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Возврат...';
            fetch('/api/tasks/redirect', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guid, comment})
            }).then(checkAuth).then(r => r.json()).then(data => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                if (data.success) {
                    bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                    setTimeout(() => {
                        showAlert('Заявка возвращена в свободные', 'success');
                    }, 300);
                    cacheClearPrefix('/api/tasks/');
                    loadTasks();
                } else {
                    const msg = data.error || data.detail?._error || 'Ошибка при возврате';
                    showAlert('Ошибка: ' + msg, 'danger');
                }
            }).catch(() => {
                btn.disabled = false;
                btn.innerHTML = origHtml;
                showAlert('Ошибка сети', 'danger');
            });
        });
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
    showConfirm(`Взять ${selectedGuids.size} заявок?`)
        .then(ok => {
            if (!ok) return;

            const guids = Array.from(selectedGuids);
            fetch('/api/tasks/take-bulk', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guids})
            }).then(checkAuth).then(r => r.json()).then(data => {
                const taken = data.taken || 0;
                showAlert(`Взято: ${taken} из ${guids.length}`, 'success');
                cancelMultiSelect();
                cacheClearPrefix('/api/tasks/');
                loadTasks();
            }).catch(() => showAlert('Ошибка сети', 'danger'));
        });
}

// ============ CLIENTS (also used from tasks page) ============
function loadClients() {
    fetchDeduped('/api/tasks/documents', undefined, 300000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            (data || []).forEach(c => { if (c.guid) clientsMap[c.guid] = c.name || c.guid; });
        });
}

// ============ DOCUMENT FORM (tasks page) ============
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
            const includeAll = document.getElementById('docIncludeAllGoods')?.checked;
            docAllProducts = (data || []).filter(p => !p.broken && (includeAll || !!p.series_name));
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
        container.innerHTML = '<div class="text-muted small text-center py-3">Нет товаров</div>';
        return;
    }

    filtered.sort((a, b) => {
        const parseDate = s => { if (!s || s === '\u2014') return 0; const [d, m, y] = s.split('.'); return new Date(y, m - 1, d); };
        const cmp = parseDate(b.date_arrival) - parseDate(a.date_arrival);
        if (cmp !== 0) return cmp;
        return (a.product_name || '').localeCompare(b.product_name || '', 'ru');
    });

    const maxReached = docSelectedItems.length >= 20;
    container.innerHTML = filtered.map(p => {
            const key = p.product_name + '|' + p.series_name;
            const checked = docSelectedItems.some(s => s.key === key);
            const disabled = !checked && maxReached;
            return `<div class="form-check doc-product-item ${checked ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-key="${key.replace(/"/g,'&quot;')}">
                <input class="form-check-input" type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                <label class="form-check-label small">${(p.product_name || '—').replace(/</g,'&lt;')} ${p.series_name ? `<span class="text-muted">[${(p.series_name || '—').replace(/</g,'&lt;')}]</span>` : '<span class="text-muted small">(без серийного номера)</span>'}</label>
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
        if (docSelectedItems.length >= 20) { renderDocProducts(); return; }
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
            ${i+1}. ${item.name}${item.series ? ' [' + item.series + ']' : ''}
            <i class="bi bi-x" style="cursor:pointer" onclick="removeDocItem(${i})"></i>
        </span>`
    ).join('');
}

function removeDocItem(idx) {
    docSelectedItems.splice(idx, 1);
    renderDocProducts();
    renderDocSelected();
}

// ============ M15 EQUIPMENT MODAL ============
function showM15EquipmentModal(text) {
    document.getElementById('m15EquipmentText').value = text || '';
    const shareBtn = document.getElementById('m15ShareBtn');
    if (navigator.share) {
        shareBtn.classList.remove('d-none');
    } else {
        shareBtn.classList.add('d-none');
    }
    showModalStacked('m15EquipmentModal', () => {
        const modal = new bootstrap.Modal(document.getElementById('m15EquipmentModal'));
        modal.show();
    });
}

function copyM15Equipment() {
    const textarea = document.getElementById('m15EquipmentText');
    navigator.clipboard.writeText(textarea.value).then(() => {
        const btn = document.getElementById('m15CopyBtn');
        btn.innerHTML = '<i class="bi bi-check me-1"></i>Скопировано';
        setTimeout(() => {
            btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Копировать';
        }, 2000);
    }).catch(() => {
        textarea.select();
        document.execCommand('copy');
    });
}

function shareM15Equipment() {
    const textarea = document.getElementById('m15EquipmentText');
    navigator.share({ text: textarea.value }).catch(() => {});
}

function viewM15Equipment(guid, hk) {
    let url = '/api/tasks/' + guid + '/m15-text';
    if (hk) url += '?hk=' + encodeURIComponent(hk);
    fetch(url)
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            if (data.text) {
                const code = data.code || '';
                const text = code ? `Код заявки: ${code}\n${data.text}` : data.text;
                showM15EquipmentModal(text);
            } else {
                showAlert('Нет сохранённого оборудования для этой заявки', 'info');
            }
        })
        .catch(() => showAlert('Ошибка загрузки данных', 'danger'));
}

function openDocForm(guid) {
    const modalEl = document.getElementById('docFormModal');
    if (modalEl.classList.contains('show')) return;
    const fillForm = (task) => {
        document.querySelectorAll('#docFormModal .modal-body .alert').forEach(el => el.remove());
        const text = (task.name || '') + '\n' + (task.description || '');

        function rx(p) {
            const m = text.match(p);
            return m ? m[1].trim() : '';
        }

        document.getElementById('docFormGuid').value = guid;
        document.getElementById('docDate').value = new Date().toISOString().slice(0,10);
        document.getElementById('docShop').value = rx(/(\d+)-Пятерочка/);
        const sap = rx(/SAP-(\w{4})/).toUpperCase();
        document.getElementById('docSap').value = sap;
        document.getElementById('docCode').value = rx(/Код заявки:\s*(\S+)/);
        document.getElementById('docZd').value = rx(/Номер:\s*(\S+)/);

        if (!document.getElementById('docCode').value) {
            const m = text.match(/(?:ЗНО|ИНЦ)-\d{9}/);
            if (m) document.getElementById('docCode').value = m[0];
        }
        if (!document.getElementById('docZd').value) {
            const m = text.match(/[A-Za-zА-Яа-я]{2}-\d{6}/);
            if (m) document.getElementById('docZd').value = m[0];
        }

        let addr = rx(/Адрес:\s*(.*)$/m);
        if (!addr && sap) {
            const m = text.match(new RegExp('SAP-' + sap + '\\s+(.*?)(?:\\s*\\||$)'));
            if (m) {
                addr = m[1].trim().replace(/\s*(Контрагент:|Срок:).*$/, '').trim();
            }
        }
        document.getElementById('docAddr').value = addr;
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
        if (!desc) desc = (task.description || '').replace(/Объект обслуживания:.*?(?:\n|$)/g, '').replace(/Адрес:.*?(?:\n|$)/g, '').replace(/Код заявки:.*?(?:\n|$)/g, '').replace(/Номер:.*?(?:\n|$)/g, '').trim();
        document.getElementById('docDesc').value = desc;

        document.getElementById('docIncludeAct').checked = true;
        document.getElementById('docIncludeFn').checked = false;
        document.getElementById('docIncludeM15').checked = false;
        document.getElementById('docIncludeAllGoods').checked = false;

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

        showModalStacked('docFormModal', () => {
            const modal = new bootstrap.Modal(document.getElementById('docFormModal'));
            modal.show();
        });
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
    const docDate = document.getElementById('docDate').value;
    if (shop) fields.shop = shop;
    if (sap) fields.sap = sap;
    if (addr) fields.addr = addr;
    fields.desc = desc;
    fields.code = code;
    fields.zd = zd;
    if (docDate) Object.assign(fields, {doc_date: docDate});
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
                if (!r.ok) return r.json().then(t => { throw new Error(t.error || 'Ошибка генерации') });
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
        if (docSelectedItems.length > 0) {
            const shop = document.getElementById('docShop').value;
            const sap = document.getElementById('docSap').value;
            const code = document.getElementById('docCode').value;
            const items = docSelectedItems.filter(i => i.series).map(i => i.name + ' (' + i.series + ')').join('\n');
            const header = `Перемещение оборудования на/с магазин(а) ${shop} - ${sap} - ${code}:`;
            setTimeout(() => showM15EquipmentModal(header + '\n' + items), 300);
        }
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

function generateDocFormAndUpload() {
    const guid = document.getElementById('docFormGuid').value;
    if (!guid) return;

    const fields = {};
    const shop = document.getElementById('docShop').value.trim();
    const sap = document.getElementById('docSap').value.trim();
    const addr = document.getElementById('docAddr').value.trim();
    const desc = document.getElementById('docDesc').value.trim();
    const code = document.getElementById('docCode').value.trim();
    const zd = document.getElementById('docZd').value.trim();
    const docDate = document.getElementById('docDate').value;
    if (shop) fields.shop = shop;
    if (sap) fields.sap = sap;
    if (addr) fields.addr = addr;
    fields.desc = desc;
    fields.code = code;
    fields.zd = zd;
    if (docDate) Object.assign(fields, {doc_date: docDate});
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
    status.textContent = 'Генерация и загрузка на Я.Диск...';

    fetch('/api/tasks/documents/upload-to-yandex', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            guid,
            profile_name: savedProfileName,
            fields: Object.keys(fields).length > 0 ? fields : undefined,
            include_act: includeAct,
            include_fn: includeFn,
            include_m15: includeM15,
        })
    }).then(checkAuth).then(r => r.json()).then(data => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        if (data.success) {
            bootstrap.Modal.getInstance(document.getElementById('docFormModal'))?.hide();
            showAlert('Документы сформированы и загружены на Я.Диск', 'success');
        } else {
            showAlert(data.error || 'Ошибка при загрузке на Я.Диск', 'danger');
        }
    }).catch(e => {
        loading.classList.add('d-none');
        footer.querySelectorAll('button').forEach(b => b.disabled = false);
        showAlert('Ошибка сети: ' + e.message, 'danger');
    });
}

// ============ SWIPE TABS ============
function initSwipeTabs() {
    const el = document.querySelector('.tab-content');
    if (!el) return;
    let startX = 0, startY = 0;
    el.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
        const pills = document.querySelectorAll('#taskTabs .nav-link');
        const active = document.querySelector('#taskTabs .nav-link.active');
        const idx = Array.from(pills).indexOf(active);
        if (idx === -1) return;
        const next = dx < 0 ? idx + 1 : idx - 1;
        if (next >= 0 && next < pills.length) pills[next].click();
    }, { passive: true });
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
