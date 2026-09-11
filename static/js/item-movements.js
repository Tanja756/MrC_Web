// ============ ITEM MOVEMENTS (Движение) ============
let _bindTasksCache = [];
let _pendingReturns = [];

function _todayStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}

function loadItemMovements() {
    const q = document.getElementById('movementSearch').value.trim();
    const storage = document.getElementById('storageSelect')?.value || '';
    const container = document.getElementById('movementHistory');
    if (!q) {
        container.innerHTML = '<div class="text-muted small text-center py-4">Введите серийный или инвентарный номер</div>';
        return;
    }
    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></div>';
    Promise.all([
        fetch(`/api/warehouse/item-movements?series=${encodeURIComponent(q)}&storage=${encodeURIComponent(storage)}`).then(r => r.json().catch(() => [])),
        fetch(`/api/warehouse/item-movements?inventory=${encodeURIComponent(q)}&storage=${encodeURIComponent(storage)}`).then(r => r.json().catch(() => []))
    ]).then(([bySeries, byInventory]) => {
        const seen = new Set();
        const events = bySeries.concat(byInventory).filter(e => {
            if (seen.has(e.id)) return false;
            seen.add(e.id);
            return true;
        });
        renderItemHistory(events);
    }).catch(() => {
        container.innerHTML = '<div class="text-muted small text-center py-4">Ошибка загрузки</div>';
    });
}

function renderItemHistory(events) {
    const container = document.getElementById('movementHistory');
    if (!events.length) {
        container.innerHTML = '<div class="text-muted small text-center py-4">История не найдена</div>';
        return;
    }
    const first = events[0];
    const labels = {
        arrival: { icon: 'bi bi-box-arrow-in-down', cls: 'text-success', txt: e => `Поступление на склад ${e.storage_name || ''}` },
        writeoff: { icon: 'bi bi-box-arrow-up', cls: 'text-danger', txt: e => `Списание со склада ${e.storage_name || ''}` },
        transfer: { icon: 'bi bi-arrow-left-right', cls: 'text-primary', txt: e => `Перемещение ${e.comment || ''}` },
        m15: { icon: 'bi bi-clipboard-check', cls: 'text-info', txt: e => `Выдано по М15${e.task_label ? `, заявка ${e.task_label}` : ''}` },
        return: { icon: 'bi bi-arrow-return-left', cls: 'text-warning', txt: e => e.status === 'manual'
                ? `Возврат на склад ${e.storage_name || ''} (перемещено вручную)`
                : `Возврат на склад ${e.storage_name || ''}${e.task_label ? `, заявка ${e.task_label}` : ''}` }
    };
    const timeline = [...events].sort((a, b) => (a.display_date || '').localeCompare(b.display_date || ''));
    container.innerHTML = `
        <div class="card shadow-sm">
            <div class="card-body">
                <h6 class="mb-1">${esc(first.product_name || '—')}</h6>
                <div class="text-muted small mb-3">
                    ${first.series_name ? `<span class="me-3">Серийный: <strong>${esc(first.series_name)}</strong></span>` : ''}
                    ${first.inventory_number ? `<span>Инв. №: <strong>${esc(first.inventory_number)}</strong></span>` : ''}
                </div>
                <div class="list-group">
                    ${timeline.map(e => {
                        const def = labels[e.event_type] || { icon: 'bi bi-circle', cls: '', txt: () => e.event_type };
                        return `<div class="list-group-item d-flex align-items-center gap-2 py-2">
                            <i class="${def.icon} ${def.cls}"></i>
                            <div class="flex-grow-1 small">${esc(def.txt(e))}</div>
                            <div class="text-muted small text-nowrap">${esc(e.display_date)}</div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        </div>`;
}

function openReturnBind() {
    const storage = document.getElementById('storageSelect')?.value || '';
    if (!storage) {
        showAlert('Выберите склад', 'warning');
        return;
    }
    const modal = new bootstrap.Modal(document.getElementById('returnBindModal'));
    modal.show();
    fetch(`/api/warehouse/returns-pending?storage=${encodeURIComponent(storage)}&days=7`)
        .then(r => r.json())
        .then(data => {
            if (data && data.error) throw new Error(data.error);
            _pendingReturns = data || [];
            return fetch('/api/tasks/my').then(r => r.json().catch(() => ({ tasks: [] })));
        })
        .then(res => {
            _bindTasksCache = res.tasks || [];
            renderReturnBind();
        })
        .catch(err => {
            document.getElementById('returnBindBody').innerHTML = `<div class="text-danger small">${esc(err.message)}</div>`;
        });
}

function renderReturnBind() {
    const body = document.getElementById('returnBindBody');
    const items = _pendingReturns || [];
    if (!items.length) {
        body.innerHTML = '<div class="text-muted text-center py-4">Нет поступивших товаров за выбранный период</div>';
        return;
    }
    const tasksOptions = _bindTasksCache.map(t =>
        `<option value="${esc(t.guid)}" data-date="${esc(t.date || '')}" data-name="${esc(t.name || '')}">${esc((t.number || '') + ' — ' + (t.name || ''))}</option>`
    ).join('');
    const rows = items.map((it, i) => {
        if (it.has_transfer) {
            return `<tr>
                <td>${esc(it.product_name)}<br><small class="text-muted">SN: ${esc(it.series_name || '—')}</small></td>
                <td>${esc(it.arrival_date)}</td>
                <td class="text-muted small">Перемещено</td>
            </tr>`;
        }
        if (it.bound) {
            return `<tr>
                <td>${esc(it.product_name)}<br><small class="text-muted">SN: ${esc(it.series_name || '—')}</small></td>
                <td>${esc(it.arrival_date)}</td>
                <td class="text-muted small">Уже привязано</td>
            </tr>`;
        }
        return `<tr data-editable="1" data-idx="${i}">
            <td>
                ${esc(it.product_name)}<br>
                <small class="text-muted">SN: ${esc(it.series_name || '—')}</small>
                <input type="hidden" id="name_${i}" value="${esc(it.product_name || '')}">
                <input type="hidden" id="series_${i}" value="${esc(it.series_name || '')}">
                <input type="hidden" id="inventory_${i}" value="${esc(it.inventory_number || '')}">
            </td>
            <td class="small text-muted">${esc(it.arrival_date)}</td>
            <td>
                <div class="form-check form-check-inline">
                    <input class="form-check-input" type="radio" name="mode_${i}" id="manual_${i}" value="manual" checked onchange="onBindModeChange(${i})">
                    <label class="form-check-label small" for="manual_${i}">Перемещено вручную</label>
                </div>
                <div class="form-check form-check-inline">
                    <input class="form-check-input" type="radio" name="mode_${i}" id="taskmode_${i}" value="task" onchange="onBindModeChange(${i})">
                    <label class="form-check-label small" for="taskmode_${i}">Привязать к заявке</label>
                </div>
                <div class="input-group input-group-sm mt-1">
                    <select class="form-select" id="task_${i}" disabled>
                        <option value="">— выберите заявку —</option>
                        ${tasksOptions}
                    </select>
                </div>
                <input type="date" id="date_${i}" class="form-control form-control-sm mt-1" value="${_todayStr()}" title="Дата поступления">
            </td>
        </tr>`;
    }).join('');
    body.innerHTML = `
        <div class="table-responsive">
            <table class="table table-sm table-borderless mb-0">
                <thead><tr><th>Товар</th><th style="width:110px">Поступил</th><th>Привязка</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="text-muted small mt-2">Дата поступления проставляется из заявки; при «Перемещено вручную» — сегодня.</div>`;
}

function onBindModeChange(idx) {
    const manual = document.getElementById(`manual_${idx}`).checked;
    const taskSel = document.getElementById(`task_${idx}`);
    taskSel.disabled = manual;
    if (manual) {
        document.getElementById(`date_${idx}`).value = _todayStr();
    } else {
        onBindTaskChange(idx);
    }
}

function onBindTaskChange(idx) {
    const sel = document.getElementById(`task_${idx}`);
    const opt = sel.selectedOptions[0];
    const d = opt ? opt.dataset.date : '';
    const dateIn = document.getElementById(`date_${idx}`);
    if (d) dateIn.value = d.slice(0, 10);
}

function saveReturnBind() {
    const storage = document.getElementById('storageSelect')?.value || '';
    const items = [];
    document.querySelectorAll('#returnBindBody tr[data-editable="1"]').forEach(tr => {
        const idx = tr.dataset.idx;
        const manual = document.getElementById(`manual_${idx}`).checked;
        const taskSel = document.getElementById(`task_${idx}`);
        const taskGuid = manual ? '' : taskSel.value;
        if (!manual && !taskGuid) return;
        items.push({
            product_name: document.getElementById(`name_${idx}`).value,
            series_name: document.getElementById(`series_${idx}`).value,
            inventory_number: document.getElementById(`inventory_${idx}`).value,
            mode: manual ? 'manual' : 'task',
            task_guid: taskGuid,
            task_name: manual ? '' : (taskSel.selectedOptions[0]?.dataset?.name || ''),
            arrival_date: document.getElementById(`date_${idx}`).value || _todayStr(),
        });
    });
    if (!items.length) {
        showAlert('Нечего сохранять: выберите заявку или режим', 'warning');
        return;
    }
    const btn = document.getElementById('returnBindSave');
    btn.disabled = true;
    fetch('/api/warehouse/returns/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storage, items })
    })
    .then(r => r.json())
    .then(res => {
        if (res.ok) {
            showAlert(`Привязано: ${res.bound}`, 'success');
            bootstrap.Modal.getInstance(document.getElementById('returnBindModal')).hide();
            refreshBalances();
        } else {
            showAlert(res.error || 'Ошибка сохранения', 'danger');
        }
    })
    .catch(err => showAlert('Ошибка: ' + err.message, 'danger'))
    .finally(() => { btn.disabled = false; });
}
