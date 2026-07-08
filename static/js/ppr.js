// ============ PPR ============
function getPprStatusClass(t) {
    if (!t || t.status === 'Closed' || t.status === 'Завершена') return 'ppr-closed';
    const deadline = t.period || t.date;
    if (!deadline) return '';
    const d = parsePprDate(deadline);
    if (!d) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const taskDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (taskDate < today) return 'ppr-overdue';
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    if (taskDate >= weekStart && taskDate <= weekEnd) return 'ppr-current';
    return '';
}

function pprStatusBadge(t) {
    const status = t.status;
    if (status === 'Closed' || status === 'Завершена') return '<span class="badge ppr-badge-closed">Завершена</span>';
    if (status === 'Принять в работу' || status === 'open') {
        let extra = '';
        const cls = getPprStatusClass(t);
        if (cls === 'ppr-overdue') extra = ' <span class="badge bg-danger">Просрочено</span>';
        else if (cls === 'ppr-current') extra = ' <span class="badge bg-warning text-dark">Текущая</span>';
        return `<span class="badge ppr-badge-open">Открыта</span>${extra}`;
    }
    return `<span class="badge bg-secondary">${status || ''}</span>`;
}

function parsePprDate(str) {
    if (!str) return null;
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return parseDate(str);
}

function fmtPprDate(str) {
    if (!str) return '—';
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return formatDateShort(str);
}

function savePprYear() {
    const el = document.getElementById('pprYear');
    if (el) lsSet('pprYear', el.value);
}
function savePprQuarter() {
    const el = document.getElementById('pprQuarter');
    if (el) lsSet('pprQuarter', el.value);
}

function restorePprFilters() {
    const y = lsGet('pprYear', '');
    if (y) {
        const el = document.getElementById('pprYear');
        if (el) el.value = y;
    }
    const q = lsGet('pprQuarter', '');
    if (q) {
        const el = document.getElementById('pprQuarter');
        if (el) el.value = q;
    }
}

function loadPprDepartments() {
    const year = document.getElementById('pprYear').value || new Date().getFullYear();
    const quarter = document.getElementById('pprQuarter').value;
    fetchDeduped(`/api/ppr/departments?year=${year}&quarter=${quarter}`, undefined, 30000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const sel = document.getElementById('pprDepartment');
            const saved = lsGet('pprDepartment', '');
            sel.innerHTML = '<option value="">Все регионы</option>' +
                (data.departments || []).map(d => `<option>${d}</option>`).join('');
            if (saved && [...sel.options].some(o => o.value === saved)) {
                sel.value = saved;
                loadPpr();
            }
        });
}

function savePprDepartment() {
    const sel = document.getElementById('pprDepartment');
    if (sel) lsSet('pprDepartment', sel.value);
}

function loadPpr() {
    const year = document.getElementById('pprYear').value || new Date().getFullYear();
    const quarter = document.getElementById('pprQuarter').value;
    const department = document.getElementById('pprDepartment').value;

    fetchDeduped(`/api/ppr/list?year=${year}&quarter=${quarter}&department=${encodeURIComponent(department)}`, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const tasks = (data.tasks || []).sort((a, b) => {
                const aClosed = a.status === 'Closed' || a.status === 'Завершена' ? 1 : 0;
                const bClosed = b.status === 'Closed' || b.status === 'Завершена' ? 1 : 0;
                return aClosed - bClosed;
            });
            const container = document.getElementById('pprList');
            if (tasks.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-kanban"></i><p>Нет задач ППР</p></div>';
                return;
            }
            // Mobile: cards
            const mobileHtml = tasks.map(t => {
                const cls = getPprStatusClass(t);
                return `<div class="ppr-card ${cls}">
                    <div class="ppr-card-left">
                        <div class="ppr-card-number">#${t.number || t.guid?.slice(0,8)}</div>
                        <div class="ppr-card-name">${escHtml(t.name || '')}</div>
                        <div class="ppr-card-meta">
                            <span>${escHtml(t.name_department || '—')}</span>
                            <span class="ppr-card-date">${fmtPprDate(t.period || t.date)}</span>
                        </div>
                    </div>
                    <div class="ppr-card-right">
                        ${pprStatusBadge(t)}
                        <div class="ppr-card-actions">
                            <button class="btn btn-outline-secondary btn-sm" onclick="openPprDetail('${t.guid}')" title="Подробнее"><i class="bi bi-info-circle"></i></button>
                            ${t.status !== 'Closed' && t.status !== 'Завершена' ? `<button class="btn btn-success btn-sm" onclick="openPprClose('${t.guid}')" title="Закрыть"><i class="bi bi-check-lg"></i></button>` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('');

            // Desktop: table
            const desktopHtml = `<div class="table-responsive"><table class="table table-hover ppr-table">
                <thead><tr><th>Номер</th><th>Название</th><th>Регион</th><th>Статус</th><th>Срок</th><th></th></tr></thead>
                <tbody>${tasks.map(t => {
                    const cls = getPprStatusClass(t);
                    return `<tr class="${cls}">
                    <td><strong>#${t.number || t.guid?.slice(0,8)}</strong></td>
                    <td>${escHtml(t.name || '')}</td>
                    <td>${escHtml(t.name_department || '—')}</td>
                    <td>${pprStatusBadge(t)}</td>
                    <td>${fmtPprDate(t.period || t.date)}</td>
                    <td class="text-end">
                        <button class="btn btn-outline-secondary btn-sm me-1" onclick="openPprDetail('${t.guid}')" title="Подробнее"><i class="bi bi-info-circle"></i></button>
                        ${t.status !== 'Closed' && t.status !== 'Завершена' ? `<button class="btn btn-success btn-sm" onclick="openPprClose('${t.guid}')" title="Закрыть"><i class="bi bi-check-lg"></i></button>` : ''}
                    </td>
                </tr>`;
                }).join('')}</tbody>
            </table></div>`;

            container.innerHTML = `<div class="d-md-none">${mobileHtml}</div><div class="d-none d-md-block">${desktopHtml}</div>`;
        });
}

function openPprDetail(guid) {
    const modalEl = document.getElementById('pprDetailModal');
    if (modalEl.classList.contains('show')) return;
    const year = document.getElementById('pprYear').value;
    const quarter = document.getElementById('pprQuarter').value;
    fetchDeduped(`/api/ppr/list?year=${year}&quarter=${quarter}`, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
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
                    <div class="col-md-4"><small class="text-muted d-block">Срок</small><span class="fw-semibold">${formatDate(task.period || task.date)}</span></div>
                    <div class="col-md-4"><small class="text-muted d-block">Комментарий</small><span class="fw-semibold">${task.closeComment || '—'}</span></div>
                </div>`;
            document.getElementById('pprDetailFooter').innerHTML = `<button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>`;
            modal.show();
        });
}

function pprAttachFile(type) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (type === 'pdf') input.accept = '.pdf';
    input.onchange = async (e) => {
        const files = e.target.files;
        if (!files || !files.length) return;
        for (const file of files) {
            const base64 = await fileToBase64(file);
            pprPendingAttachments.push({
                data: base64.split(',')[1],
                extension: file.name.split('.').pop(),
                filename: file.name
            });
        }
        renderPprPendingAttachments();
    };
    input.click();
}

function renderPprPendingAttachments() {
    document.getElementById('pprAttachmentsList').innerHTML = pprPendingAttachments.map((a, i) =>
        `<span class="badge bg-light text-dark me-1 d-inline-flex align-items-center gap-1">📎 ${a.filename || ('.' + a.extension)} (${(a.data.length * 0.75 / 1024).toFixed(0)} KB) <i class="bi bi-x-circle-fill text-danger" style="cursor:pointer;font-size:0.7rem" onclick="removePprPendingAttachment(${i})"></i></span>`
    ).join('');
}

function removePprPendingAttachment(idx) {
    pprPendingAttachments.splice(idx, 1);
    renderPprPendingAttachments();
}

function openPprClose(guid) {
    const modalEl = document.getElementById('pprDetailModal');
    if (modalEl.classList.contains('show')) return;
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
        showAlert('Добавьте комментарий или вложение', 'warning');
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
                const year = document.getElementById('pprYear').value || new Date().getFullYear();
                const quarter = document.getElementById('pprQuarter').value;
                const department = document.getElementById('pprDepartment').value;
                ['departments', 'list'].forEach(p => { reqCache.delete('/api/ppr/' + p); });
                loadPpr();
            } else {
                showAlert('Ошибка при закрытии задачи ППР', 'danger');
            }
        }).catch(() => {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            showAlert('Ошибка сети', 'danger');
        });
    };
    if (!navigator.geolocation) { doRequest(0, 0); return; }
    navigator.geolocation.getCurrentPosition(
        pos => doRequest(pos.coords.latitude, pos.coords.longitude),
        () => doRequest(0, 0),
        { timeout: 5000 }
    );
}

// ============ UPLOAD PPR ============
let uploadRows = [];
let uploadFileName = '';
let uploadRowIdCounter = 0;

function initUploadTab() {
    if (!document.getElementById('uploadQuarter')) return;
    const q = document.getElementById('uploadQuarter');
    const now = new Date();
    const year = now.getFullYear();
    const curQ = Math.floor(now.getMonth() / 3) + 1;
    q.innerHTML = '';
    for (let i = 1; i <= 4; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${i} квартал ${year}`;
        if (i === curQ) opt.selected = true;
        q.appendChild(opt);
    }

    const dz = document.getElementById('uploadDropzone');
    const input = document.getElementById('uploadFile');

    dz.addEventListener('click', () => input.click());

    dz.addEventListener('dragover', (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleUploadFile(file);
    });
    input.addEventListener('change', () => {
        if (input.files[0]) handleUploadFile(input.files[0]);
    });

    document.getElementById('uploadRegion').addEventListener('change', renderUploadPreview);
    document.getElementById('uploadSort').addEventListener('change', renderUploadPreview);
}

function handleUploadFile(file) {
    if (!file.name.endsWith('.xlsx')) {
        showUploadError('Выберите файл формата .xlsx');
        return;
    }
    uploadFileName = file.name;
    document.querySelector('.upload-dropzone-text').textContent = file.name;
    document.getElementById('uploadResult').innerHTML = '';
    document.getElementById('uploadActions').classList.add('d-none');

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });

            if (json.length < 2) {
                showUploadError('Файл не содержит данных');
                return;
            }

            uploadRows = [];
            for (let i = 1; i < json.length; i++) {
                const row = json[i];
                if (!row || !row[0]) continue;
                const periodRaw = String(row[4] || '');
                const periodEnd = parseWeekEnd(periodRaw);
                const quarter = parseInt(document.getElementById('uploadQuarter').value);
                const year = new Date().getFullYear();

                const hasExecDate = row[6] != null && row[6] !== '';
                uploadRows.push({
                    _uid: ++uploadRowIdCounter,
                    number: String(row[0]).trim(),
                    name: `${String(row[1] || '').trim()} (${String(row[2] || '').trim()}) — ${String(row[3] || '').trim()}`,
                    name_department: String(row[5] || '').trim(),
                    date: getQuarterStart(quarter, year),
                    period: periodEnd,
                    user_name: String(row[8] || '').trim(),
                    status: hasExecDate ? 'Завершена' : 'open',
                });
            }

            populateRegionFilter();
            renderUploadPreview();
        } catch (err) {
            showUploadError('Ошибка чтения файла: ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function parseWeekEnd(str) {
    const m = str.match(/\((\d{2})\.(\d{2})-(\d{2})\.(\d{2})\)/);
    if (!m) return '';
    const day = m[3], mon = m[4];
    const year = new Date().getFullYear();
    return `${year}-${mon}-${day}`;
}

function getQuarterStart(quarter, year) {
    return `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
}

function populateRegionFilter() {
    const sel = document.getElementById('uploadRegion');
    const current = sel.value;
    const regions = [...new Set(uploadRows.map(r => r.name_department).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">Все регионы</option>' +
        regions.map(r => `<option value="${r.replace(/"/g,'&quot;')}">${r}</option>`).join('');
    if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

function getFilteredRows() {
    const region = document.getElementById('uploadRegion').value;
    const sort = document.getElementById('uploadSort').value;
    let rows = region ? uploadRows.filter(r => r.name_department === region) : [...uploadRows];

    rows.sort((a, b) => {
        const cmp = sort === 'region-date'
            ? (a.name_department || '').localeCompare(b.name_department || '') || (a.period || '').localeCompare(b.period || '')
            : (a.period || '').localeCompare(b.period || '') || (a.name_department || '').localeCompare(b.name_department || '');
        return cmp;
    });

    return rows;
}

function fmtDate(iso) {
    if (!iso) return '—';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '—';
    return `${m[3]}.${m[2]}.${m[1]}`;
}

function renderUploadPreview() {
    const container = document.getElementById('uploadPreview');
    const actions = document.getElementById('uploadActions');
    const stats = document.getElementById('uploadStats');
    const result = document.getElementById('uploadResult');
    result.innerHTML = '';

    const filtered = getFilteredRows();

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-file-earmark-excel"></i><p>Нет данных для отображения</p></div>';
        actions.classList.add('d-none');
        return;
    }

    const errors = [];
    filtered.forEach((r, i) => {
        const issues = [];
        if (!r.number) issues.push('нет номера заявки');
        if (!r.name_department) issues.push('нет региона');
        if (issues.length) errors.push({ idx: i + 1, number: r.number, issues: issues.join(', ') });
    });

    container.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover upload-table">
        <thead><tr>
            <th style="width:36px"><input type="checkbox" id="uploadSelectAll" onchange="toggleAllUploadRows(this.checked)"></th>
            <th>#</th>
            <th>Заявка</th>
            <th>Наименование</th>
            <th>Регион</th>
            <th>Срок</th>
            <th>Статус</th>
            <th style="width:50px"></th>
        </tr></thead>
        <tbody>${filtered.map((r, i) => {
            const err = errors.some(e => e.idx === i + 1);
            const closed = r.status === 'Завершена';
            return `<tr class="${err ? 'table-danger' : ''} ${closed ? 'upload-closed' : ''}">
                <td><input type="checkbox" class="upload-row-cb" value="${r._uid}"></td>
                <td>${i + 1}</td>
                <td class="text-nowrap">${r.number || '<span class="text-danger">—</span>'}</td>
                <td>${escHtml(r.name)}</td>
                <td>${r.name_department || '<span class="text-danger">—</span>'}</td>
                <td class="text-nowrap">${fmtDate(r.period)}</td>
                <td>${closed ? '<span class="badge ppr-badge-closed">Завершена</span>' : '<span class="badge ppr-badge-open">Открыта</span>'}</td>
                <td><button class="btn btn-outline-danger btn-sm" onclick="deleteUploadRow(${r._uid})" title="Удалить"><i class="bi bi-trash"></i></button></td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;

    if (errors.length) {
        result.innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${errors.length} ${pluralize(errors.length, 'строка', 'строки', 'строк')} с ошибками: ${errors.map(e => `${e.idx} (${e.number || '?'}: ${e.issues})`).join('; ')}</div>`;
    }

    const validCount = filtered.length - errors.length;
    stats.textContent = `✅ ${validCount} ${pluralize(validCount, 'строка', 'строки', 'строк')} готово к загрузке`;
    actions.classList.remove('d-none');
    document.getElementById('uploadSubmitBtn').disabled = validCount === 0;
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function pluralize(n, one, few, many) {
    n = Math.abs(n) % 100;
    if (n >= 5 && n <= 20) return many;
    n %= 10;
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
}

function showUploadError(msg) {
    document.getElementById('uploadPreview').innerHTML = '';
    document.getElementById('uploadActions').classList.add('d-none');
    document.getElementById('uploadResult').innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${escHtml(msg)}</div>`;
}

function deleteUploadRow(uid) {
    uploadRows = uploadRows.filter(r => r._uid !== uid);
    populateRegionFilter();
    renderUploadPreview();
}

function deleteSelectedUploadRows() {
    const cbs = document.querySelectorAll('.upload-row-cb:checked');
    if (cbs.length === 0) return;
    const ids = new Set([...cbs].map(cb => +cb.value));
    uploadRows = uploadRows.filter(r => !ids.has(r._uid));
    populateRegionFilter();
    renderUploadPreview();
}

function toggleAllUploadRows(checked) {
    document.querySelectorAll('.upload-row-cb').forEach(cb => cb.checked = checked);
}

function submitPprBatch() {
    const btn = document.getElementById('uploadSubmitBtn');
    const result = document.getElementById('uploadResult');
    const quarter = parseInt(document.getElementById('uploadQuarter').value);
    const year = new Date().getFullYear();
    const filtered = getFilteredRows();
    const tasks = filtered.filter(r => r.number && r.name_department).map(r => ({
        number: r.number,
        name: r.name,
        name_department: r.name_department,
        user_name: r.user_name || '',
        date: getQuarterStart(quarter, year),
        period: r.period,
        status: r.status || 'open',
    }));

    if (tasks.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Создание...';

    fetch('/api/ppr/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks }),
    }).then(checkAuth).then(r => r.json()).then(data => {
        if (data.status === 'ok') {
            const count = data.count || tasks.length;
            result.innerHTML = `<div class="alert alert-success py-2 mb-0"><i class="bi bi-check-circle me-1"></i>Создано ${count} ${pluralize(count, 'запись', 'записи', 'записей')}</div>`;
        } else {
            result.innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${data.error || 'Ошибка при создании'}</div>`;
        }
    }).catch(() => {
        result.innerHTML = '<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Ошибка соединения</div>';
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-send me-1"></i>Создать записи';
    });
}

document.getElementById('upload-tab')?.addEventListener('shown.bs.tab', () => initUploadTab());
