// ============ MOVEMENT FEED (Движения: приход/расход по складу) ============
// Источник данных — локальная таблица item_movements: наименование и серийный
// номер хранятся текстом, поэтому товары, исчезнувшие из справочника 1С,
// остаются в ленте. Уведомления прихода/расхода создаются из тех же событий.
let _movementDirection = 'all';
let _movementDebounceTimer = null;
let _movementFeedRows = []; // последние отрисованные строки (для PDF-экспорта)

function _movementDefaultDates() {
    // период по умолчанию — последние 30 дней
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { from: fmt(from), to: fmt(to) };
}

function initMovementFeed() {
    const sel = document.getElementById('movementStorage');
    if (!sel) return;
    const defaults = _movementDefaultDates();
    const fromInput = document.getElementById('movementDateFrom');
    const toInput = document.getElementById('movementDateTo');
    if (fromInput && !fromInput.value) fromInput.value = defaults.from;
    if (toInput && !toInput.value) toInput.value = defaults.to;
    if (sel.dataset.loaded === '1') { loadMovementFeed(); return; }
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            const list = Array.isArray(data) ? data : [];
            sel.innerHTML = '<option value="">Все склады</option>' +
                list.map(s => `<option value="${s.guid}">${esc(s.name)}</option>`).join('');
            sel.dataset.loaded = '1';
            const saved = lsGet('defaultWarehouse', '');
            if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
            loadMovementFeed();
        })
        .catch(() => loadMovementFeed());
}

function setMovementDirection(dir) {
    _movementDirection = dir;
    ['all', 'in', 'out'].forEach(d => {
        const btn = document.getElementById(`mf-${d}`);
        if (btn) btn.classList.toggle('active', d === dir);
    });
    loadMovementFeed();
}

function clearMovementDates() {
    document.getElementById('movementDateFrom').value = '';
    document.getElementById('movementDateTo').value = '';
    loadMovementFeed();
}

function onMovementQueryInput() {
    clearTimeout(_movementDebounceTimer);
    _movementDebounceTimer = setTimeout(() => loadMovementFeed(), 300);
}

function loadMovementFeed(force) {
    const container = document.getElementById('movementFeed');
    if (!container) return;
    const storage = document.getElementById('movementStorage')?.value || '';
    const q = (document.getElementById('movementQuery')?.value || '').trim();
    const start = document.getElementById('movementDateFrom')?.value || '';
    const end = document.getElementById('movementDateTo')?.value || '';
    const params = new URLSearchParams();
    if (storage) params.set('storage', storage);
    if (q) params.set('q', q);
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    params.set('direction', _movementDirection);
    params.set('limit', '500');
    if (force) cacheClearPrefix('/api/warehouse/movement-feed');
    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></div>';
    fetchDeduped(`/api/warehouse/movement-feed?${params.toString()}`, undefined, force ? 0 : 15000)
        .then(r => {
            // fetchDeduped при ttl>0 возвращает уже распарсенный JSON, при ttl=0 — Response
            if (r && typeof r.json === 'function') {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }
            return r;
        })
        .then(data => renderMovementFeed(data))
        .catch(() => {
            container.innerHTML = '<div class="text-muted small text-center py-4">Ошибка загрузки ленты</div>';
        });
}

function renderMovementFeed(data) {
    const container = document.getElementById('movementFeed');
    const items = (data && data.items) || [];
    _movementFeedRows = items;
    const inCount = (data && data.in_count) || 0;
    const outCount = (data && data.out_count) || 0;
    if (!items.length) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-arrow-left-right"></i><p>Нет движений за выбранный период</p></div>';
        return;
    }
    // группировка по датам (items уже отсортированы date DESC)
    const groups = [];
    let cur = null;
    items.forEach(e => {
        const key = e.event_date || '';
        if (!cur || cur.key !== key) {
            cur = { key, rows: [] };
            groups.push(cur);
        }
        cur.rows.push(e);
    });
    const summary = `
        <div class="d-flex gap-3 flex-wrap small mb-2">
            <span class="text-success"><i class="bi bi-box-arrow-in-down me-1"></i>Приход: <strong>${inCount}</strong></span>
            <span class="text-danger"><i class="bi bi-box-arrow-up me-1"></i>Расход: <strong>${outCount}</strong></span>
            <span class="text-muted">Показано: <strong>${items.length}</strong></span>
        </div>`;
    const groupsHtml = groups.map(g => `
        <div class="mb-2">
            <div class="fw-semibold text-muted small mt-2 mb-1"><i class="bi bi-calendar3 me-1"></i>${esc(g.key ? _mfRuDate(g.key) : '—')}</div>
            <div class="list-group list-group-flush">
                ${g.rows.map(e => _movementRowHtml(e)).join('')}
            </div>
        </div>`).join('');
    container.innerHTML = `<div class="card shadow-sm"><div class="card-body">${summary}${groupsHtml}</div></div>`;
}

function _mfRuDate(iso) {
    if (!iso || iso.length < 10) return iso || '';
    return iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);
}

function _movementRowHtml(e) {
    const isIn = e.event_type === 'arrival';
    const sign = isIn ? '+' : '−';
    const badge = isIn ? 'bg-success' : 'bg-danger';
    const details = [];
    if (e.series_name) details.push(`SN: ${esc(e.series_name)}`);
    if (e.inventory_number) details.push(`Инв.: ${esc(e.inventory_number)}`);
    if (e.comment) details.push(esc(e.comment));
    if (e.storage_name) details.push(`<i class="bi bi-shop me-1"></i>${esc(e.storage_name)}`);
    if (e.task_label) details.push(`<i class="bi bi-clipboard-check me-1"></i>${esc(e.task_label)}`);
    return `<div class="d-flex align-items-start gap-2 py-1 border-bottom">
        <span class="badge ${badge} rounded-pill flex-shrink-0 mt-1" style="min-width:1.6rem">${sign}</span>
        <div class="flex-grow-1 min-0">
            <div class="fw-semibold small">${esc(e.product_name) || '—'}</div>
            <div class="text-muted" style="font-size:0.72rem;line-height:1.4">${details.join(' · ')}</div>
        </div>
        <div class="text-muted small text-nowrap">${esc(e.display_date || '')}</div>
    </div>`;
}

function exportMovementPdf() {
    if (!_movementFeedRows.length) {
        showAlert('Нет данных для экспорта', 'warning');
        return;
    }
    const sel = document.getElementById('movementStorage');
    const storageName = (sel && sel.value) ? sel.options[sel.selectedIndex].text : 'Все склады';
    const from = document.getElementById('movementDateFrom')?.value || '';
    const to = document.getElementById('movementDateTo')?.value || '';
    let period = 'всё время';
    if (from && to) period = `с ${_mfRuDate(from)} по ${_mfRuDate(to)}`;
    else if (from) period = `с ${_mfRuDate(from)}`;
    else if (to) period = `по ${_mfRuDate(to)}`;
    const dirLabel = { in: 'Приход', out: 'Расход' }[_movementDirection];
    if (dirLabel) period += `, ${dirLabel.toLowerCase()}`;
    const q = (document.getElementById('movementQuery')?.value || '').trim();
    if (q) period += `, поиск: «${q}»`;

    const btn = document.querySelector('[onclick="exportMovementPdf()"]');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
    fetch('/api/warehouse/movement-feed/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            storage_name: storageName,
            period,
            rows: _movementFeedRows.map(e => ({
                event_type: e.event_type,
                display_date: e.display_date || '',
                product_name: e.product_name || '',
                series_name: e.series_name || '',
                inventory_number: e.inventory_number || '',
                storage_name: e.storage_name || '',
                comment: e.comment || ''
            }))
        })
    }).then(r => {
        if (!r.ok) throw new Error('Ошибка сервера');
        return r.blob();
    }).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safe = storageName.replace(/[^a-zA-Zа-яА-Я0-9\s]/g, '_');
        a.download = `${safe}_движение_${new Date().toLocaleDateString('ru-RU').replace(/\./g, '')}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(err => {
        showAlert('Ошибка экспорта: ' + err.message, 'danger');
    }).finally(() => {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    });
}

// Автозагрузка ленты при переключении на вкладку «Движения»
document.querySelector('#warehouseTabs [data-bs-target="#wh-movements"]')
    ?.addEventListener('shown.bs.tab', () => initMovementFeed());
