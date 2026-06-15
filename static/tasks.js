// ============ TASKS ============
let taskSearchTimeout;

let currentTab = 'my';
let tabPrefs = {
    my: { sort: lsGet('taskSort_my', 'deadline'), dir: lsGet('taskSortDir_my', 'asc') },
    free: { sort: lsGet('taskSort_free', 'deadline'), dir: lsGet('taskSortDir_free', 'asc') },
    closed: { sort: lsGet('taskSort_closed', 'deadline'), dir: lsGet('taskSortDir_closed', 'desc') },
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
    loadTabIntoUI(tab);
    if (tab === 'closed') {
        loadClosedTasks('', tabPrefs.closed.sort, 1);
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
    const sort = document.getElementById('taskSort').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('sort', sort);
    params.set('dir', tabPrefs[currentTab].dir);
    const qs = params.toString() ? '?' + params.toString() : '';
    const fetches = [];
    const labels = types || ['my', 'free'];
    const ttl = document.hidden ? 0 : 15000;
    if (labels.includes('my')) fetches.push(fetchDeduped('/api/tasks/my' + qs, undefined, ttl).then(r => { if (r instanceof Response) return r.json().catch(() => ({})); return r; }));
    if (labels.includes('free')) fetches.push(fetchDeduped('/api/tasks/free' + qs, undefined, ttl).then(r => { if (r instanceof Response) return r.json().catch(() => ({})); return r; }));
    if (fetches.length === 0) return;
    Promise.all(fetches).then(results => {
        let i = 0;
        if (labels.includes('my')) { tasksMy = (results[i] || {}).tasks || []; i++; }
        if (labels.includes('free')) { tasksFree = (results[i] || {}).tasks || []; i++; }
        filterTasks();
    });
}

let tasksClosedPage = 1;
let tasksClosedTotal = 0;
let tasksClosedSort = 'date';
let tasksClosedDir = 'desc';

function loadClosedTasks(search, sort, page) {
    if (search === undefined) search = document.getElementById('taskSearch').value.trim();
    if (sort === undefined) sort = tabPrefs.closed.sort;
    if (page === undefined) page = 1;

    tasksClosedSort = sort;
    tasksClosedDir = tabPrefs.closed.dir;
    tasksClosedPage = page;

    const params = new URLSearchParams();
    if (search) params.set('search', search);
    params.set('sort', sort);
    params.set('dir', tabPrefs.closed.dir);
    params.set('limit', '30');
    if (page > 1) params.set('offset', (page - 1) * 30);
    const qs = '?' + params.toString();

    console.log('[loadClosedTasks] fetching', qs);
    fetchDeduped('/api/tasks/closed' + qs, undefined, 15000).then(r => r instanceof Response ? r.json().catch(() => ({})) : r).then(data => {
        tasksClosed = data.tasks || [];
        tasksClosedTotal = data.total || 0;
        console.log('[loadClosedTasks] received', tasksClosed.length, 'items, total=', tasksClosedTotal);
        filterTasks();
    });
}

function renderClosedPagination() {
    const nav = document.getElementById('closedPagination');
    if (!nav) { console.warn('[pagin] nav not found'); return; }
    const total = tasksClosedTotal;
    const page = tasksClosedPage;
    const pages = Math.ceil(total / 30);
    console.log('[pagin] total=' + total + ' page=' + page + ' pages=' + pages);
    if (pages <= 1) { nav.classList.add('d-none'); return; }
    nav.classList.remove('d-none');
    document.getElementById('pageInfo').textContent = page + ' / ' + pages;
    document.getElementById('prevPage').disabled = page <= 1;
    document.getElementById('nextPage').disabled = page >= pages;
}

function changeClosedPage(delta) {
    const page = tasksClosedPage + delta;
    if (page < 1) return;
    const pages = Math.ceil(tasksClosedTotal / 30);
    if (page > pages) return;
    loadClosedTasks(undefined, undefined, page);
}

function onTaskSearch() {
    const q = document.getElementById('taskSearch').value.trim();
    filterTasks();
    clearTimeout(taskSearchTimeout);
    taskSearchTimeout = setTimeout(() => {
        loadTasks(q || undefined);
        loadClosedTasks(q || '', tabPrefs.closed.sort, 1);
    }, 400);
}

function filterTasks() {
    const query = document.getElementById('taskSearch').value.toLowerCase().trim();
    tabPrefs[currentTab].sort = document.getElementById('taskSort').value;
    saveTabPrefs();

    const closedDir = tabPrefs.closed.dir;
    if (tabPrefs.closed.sort !== tasksClosedSort || closedDir !== tasksClosedDir) {
        loadClosedTasks(undefined, tabPrefs.closed.sort, 1);
    }

    renderTasks('tasksMyList', tasksMy, query, 'my');
    renderTasks('tasksFreeList', tasksFree, query, 'free');
    renderTasks('tasksClosedList', tasksClosed, query, 'closed');
    renderClosedPagination();
}

function resetFilters() {
    document.getElementById('taskSearch').value = '';
    for (const t of ['my', 'free', 'closed']) {
        tabPrefs[t].sort = 'deadline';
        tabPrefs[t].dir = t === 'closed' ? 'desc' : 'asc';
        saveTabPrefs(t);
    }
    document.getElementById('taskSort').value = 'deadline';
    document.querySelectorAll('#sortDirGroup .btn').forEach(b => b.classList.toggle('active', b.dataset.dir === 'asc'));
    clearTimeout(taskSearchTimeout);
    loadTasks();
    loadClosedTasks('', 'deadline', 1);
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

function renderTasks(containerId, tasks, query, mode) {
    const container = document.getElementById(containerId);
    const sort = tabPrefs[mode]?.sort || 'date';
    const dir = tabPrefs[mode]?.dir || 'desc';
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
            const confirming = filtered.filter(t => t.status && (t.status.includes('Подтвердить') || t.status.includes('подтвердить')));
            const rest = filtered.filter(t => !t.status || (!t.status.includes('Подтвердить') && !t.status.includes('подтвердить')));
            sorted = [...confirming, ...rest];
        } else {
            sorted = filtered;
        }
    } else {
        const pinned = sortTasks(filtered.filter(t => isPinned(t.guid)), sort, dir);
        const unpinned = sortTasks(filtered.filter(t => !isPinned(t.guid)), sort, dir);
        sorted = [...pinned, ...unpinned];
    }

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

        let actionHtml = '';
        if (mode === 'my' && !isClosed) {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action" onclick="openDocForm('${t.guid}')" title="Документы"><i class="bi bi-file-earmark-text"></i><span class="btn-label"> Документы</span></button><button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','user')" title="Завершить"><i class="bi bi-check-lg"></i><span class="btn-label"> Завершить</span></button>`;
        } else if (mode === 'free' && !multiSelectMode) {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button><button class="btn btn-outline-secondary btn-action" onclick="takeTask('${t.guid}')" title="Взять"><i class="bi bi-hand-index-thumb"></i><span class="btn-label"> Взять</span></button>`;
        } else if (mode === 'closed') {
            actionHtml = `<button class="btn btn-outline-secondary btn-action" onclick="openTaskDetail('${t.guid}','${mode}')" title="Описание"><i class="bi bi-info-circle"></i><span class="btn-label"> Описание</span></button>`;
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
                    <span class="task-meta-item ${deadlineClass}"><i class="bi bi-alarm"></i>${deadlineLabel}</span>
                </div>
                <div class="task-actions">
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
                <div class="col-12 d-none d-md-block">
                    <div class="p-3 bg-light rounded-3">
                        <small class="text-muted d-block mb-1">Описание</small>
                        <p class="mb-0 task-description">${task.description || '—'}</p>
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
                <button class="btn btn-secondary" data-bs-dismiss="modal">Отмена</button>
                <button class="btn btn-success" onclick="closeTask('${guid}','${task.guid_client || ''}')"><i class="bi bi-check-lg me-1"></i>Завершить заявку</button>`;
        } else if (mode === 'my') {
            footer = `
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
        showAlert('Добавьте комментарий или вложение', 'warning');
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
                showAlert('Заявка закрыта! После проверки менеджером статус будет обновлён.', 'success');
                pendingAttachments = [];
                bootstrap.Modal.getInstance(document.getElementById('taskDetailModal'))?.hide();
                tasksMy = tasksMy.filter(t => t.guid !== guid);
                reqCache.delete('/api/tasks/my');
                filterTasks();
            } else {
                const msg = data.error || data.detail?._error || data.detail?._raw || 'Ошибка при закрытии заявки';
                showAlert('Ошибка: ' + msg, 'danger');
            }
        }).catch(() => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            showAlert('Ошибка сети', 'danger');
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
                ['my', 'free', 'closed'].forEach(t => { reqCache.delete('/api/tasks/' + t); });
                loadTasks();
            } else {
                showAlert(data.error || 'Не удалось взять заявку', 'danger');
            }
        }).catch(() => showAlert('Ошибка сети', 'danger'));
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
                ['my', 'free', 'closed'].forEach(t => {
                  reqCache.delete('/api/tasks/' + t);
                });
                loadTasks();
            }).catch(() => showAlert('Ошибка сети', 'danger'));
        });
}
