let shopModalInstance = null;
let fiasDebounceTimer = null;
let fiasHideTimer = null;
let shopContacts = {};
let fiasItems = [];
// Полный список магазинов (как пришёл с сервера) — для сортировки/фильтрации
// на клиенте без повторного запроса. Изначально отсортирован по номеру магазина.
let shopsData = [];
let shopSortField = 'shop_number';
let shopSortDir = 'asc';
// rowid выбранных (мультиселект) магазинов для массового удаления.
const selectedShopIds = new Set();

document.addEventListener('DOMContentLoaded', () => {
    shopModalInstance = new bootstrap.Modal(document.getElementById('shopFormModal'));
    document.getElementById('shopFormModal').addEventListener('hidden.bs.modal', hideFiasSuggestions);
    document.getElementById('fiasSuggestions').addEventListener('click', e => {
        const btn = e.target.closest('[data-fias-index]');
        if (btn) selectFiasSuggestion(parseInt(btn.dataset.fiasIndex, 10));
    });
    loadShops();
});

function loadShops() {
    const tbody = document.getElementById('shopsTableBody');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></td></tr>';
    Promise.all([
        fetch('/api/references/shops').then(checkAuth).then(r => r.json()),
        fetch('/api/references/shops/user-status').then(r => r.json()).catch(() => ({}))
    ])
        .then(([shops, userStatus]) => {
            shopsData = Array.isArray(shops) ? shops : [];
            shopContacts = {};
            // Синхронизируем список SAP «в работе» для текущего пользователя
            // (его читают другие разделы приложения из localStorage).
            const inWorkSaps = shopsData.filter(s => !!userStatus[s.sap_code]).map(s => s.sap_code);
            lsSet('inWorkSaps', JSON.stringify(inWorkSaps));
            populateShopRegionFilter();
            renderShopsTable();
        })
        .catch(() => {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Ошибка загрузки</td></tr>';
        });
}

// Наполняет выпадающий список регионов из уникальных значений загруженных магазинов,
// сохраняя текущий выбор (как селекты подразделений/типов в задачах).
function populateShopRegionFilter() {
    const sel = document.getElementById('shopRegionFilter');
    if (!sel) return;
    const current = sel.value;
    const regions = [...new Set(shopsData.map(s => (s.region || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    sel.innerHTML = '<option value="">Все регионы</option>' +
        regions.map(r => `<option value="${escHtml(r)}">${escHtml(r)}</option>`).join('');
    if (regions.includes(current)) sel.value = current;
    // Те же значения подсказываем в поле «Регион» формы магазина (автодополнение).
    const dl = document.getElementById('shopRegionOptions');
    if (dl) dl.innerHTML = regions.map(r => `<option value="${escHtml(r)}"></option>`).join('');
}

// Рендерит таблицу: применяет сортировку и фильтры (регион + текстовый поиск).
function renderShopsTable() {
    const tbody = document.getElementById('shopsTableBody');
    const rows = getFilteredSortedShops();

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">${shopsData.length ? 'Ничего не найдено' : 'Нет магазинов'}</td></tr>`;
        updateShopsSelectionUI();
        return;
    }

    const inWorkSaps = JSON.parse(lsGet('inWorkSaps', '[]'));
    tbody.innerHTML = rows.map((s, i) => {
        const checked = inWorkSaps.includes(s.sap_code);
        shopContacts[s.id] = s;
        const sel = selectedShopIds.has(String(s.id));
        return `
        <tr data-sap="${escHtml(s.sap_code)}" data-shop-number="${escHtml(s.shop_number)}" class="${sel ? 'row-selected' : ''}">
            <td><input type="checkbox" class="form-check-input shop-row-cb" value="${s.id}" ${sel ? 'checked' : ''} onchange="onShopRowSelect(this)"></td>
            <td>${i + 1}</td>
            <td>${escHtml(s.shop_number)}</td>
            <td>${escHtml(s.sap_code)}</td>
            <td class="shop-address">${escHtml(s.address)}</td>
            <td class="shop-region">${s.region ? escHtml(s.region) : '—'}</td>
            <td><input type="checkbox" class="form-check-input" ${checked ? 'checked' : ''} onchange="toggleInWork(${jsAttr(s.sap_code)}, this.checked)"></td>
            <td>
                <button class="btn btn-sm btn-outline-primary me-1" onclick="openShopModal(${s.id})" title="Редактировать"><i class="bi bi-pencil"></i></button>
                <button class="btn btn-sm btn-outline-danger" onclick="deleteShop(${s.id})" title="Удалить"><i class="bi bi-trash"></i></button>
            </td>
        </tr>
    `}).join('');
    updateSortIcons();
    updateShopsSelectionUI();
}

// Фильтр (регион + поиск) + сортировка по выбранной колонке.
function getFilteredSortedShops() {
    const q = (document.getElementById('shopFilter').value || '').trim().toLowerCase();
    const region = document.getElementById('shopRegionFilter')?.value || '';
    let rows = shopsData;
    if (region) rows = rows.filter(s => (s.region || '') === region);
    if (q) {
        rows = rows.filter(s =>
            (s.shop_number || '').toLowerCase().includes(q) ||
            (s.sap_code || '').toLowerCase().includes(q) ||
            (s.address || '').toLowerCase().includes(q) ||
            (s.region || '').toLowerCase().includes(q)
        );
    }
    const dir = shopSortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = String(a[shopSortField] ?? ''), vb = String(b[shopSortField] ?? '');
        // Номер магазина — числовая сортировка, если оба числовые.
        if (shopSortField === 'shop_number' && /^\d+$/.test(va) && /^\d+$/.test(vb)) {
            return (Number(va) - Number(vb)) * dir;
        }
        return va.localeCompare(vb, 'ru') * dir;
    });
}

function sortShops(field) {
    if (shopSortField === field) {
        shopSortDir = shopSortDir === 'asc' ? 'desc' : 'asc';
    } else {
        shopSortField = field;
        shopSortDir = 'asc';
    }
    renderShopsTable();
}

// Обновляет стрелки направления сортировки в заголовках.
function updateSortIcons() {
    document.querySelectorAll('#shopsTable th.sortable').forEach(th => {
        const field = th.getAttribute('onclick')?.match(/sortShops\('([^']+)'\)/)?.[1];
        const icon = th.querySelector('.sort-icon');
        if (!icon) return;
        if (field === shopSortField) {
            th.setAttribute('data-dir', shopSortDir);
            icon.innerHTML = `<i class="bi ${shopSortDir === 'asc' ? 'bi-sort-up' : 'bi-sort-down'}"></i>`;
        } else {
            th.removeAttribute('data-dir');
            icon.innerHTML = '<i class="bi bi-arrow-down-up"></i>';
        }
    });
}

function filterShops() {
    renderShopsTable();
}

function clearShopFilter() {
    document.getElementById('shopFilter').value = '';
    const rf = document.getElementById('shopRegionFilter');
    if (rf) rf.value = '';
    renderShopsTable();
}

function toggleInWork(sapCode, checked) {
    fetch('/api/references/shops/user-status', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sap_code: sapCode, in_work: checked})
    }).catch(() => {});
    const saps = JSON.parse(lsGet('inWorkSaps', '[]'));
    if (checked) {
        if (!saps.includes(sapCode)) saps.push(sapCode);
    } else {
        const idx = saps.indexOf(sapCode);
        if (idx !== -1) saps.splice(idx, 1);
    }
    lsSet('inWorkSaps', JSON.stringify(saps));
}

function onShopRowSelect(cb) {
    const id = String(cb.value);
    if (cb.checked) selectedShopIds.add(id);
    else selectedShopIds.delete(id);
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('row-selected', cb.checked);
    updateShopsSelectionUI();
}

// «Выделить всё» — отмечает/снимает только видимые (после фильтра) строки.
function toggleAllShops(checked) {
    document.querySelectorAll('#shopsTableBody .shop-row-cb').forEach(cb => {
        cb.checked = checked;
        const id = String(cb.value);
        if (checked) selectedShopIds.add(id);
        else selectedShopIds.delete(id);
        const tr = cb.closest('tr');
        if (tr) tr.classList.toggle('row-selected', checked);
    });
    updateShopsSelectionUI();
}

// Показывает/скрывает кнопку «Удалить выбранные» и синхронизирует счётчик
// и состояние чекбокса «выделить всё».
function updateShopsSelectionUI() {
    const btn = document.getElementById('shopsDeleteSelectedBtn');
    const count = document.getElementById('shopsSelectedCount');
    if (count) count.textContent = selectedShopIds.size;
    if (btn) btn.classList.toggle('d-none', selectedShopIds.size === 0);
    const all = document.getElementById('shopsSelectAll');
    if (all) {
        const cbs = document.querySelectorAll('#shopsTableBody .shop-row-cb');
        all.checked = cbs.length > 0 && selectedShopIds.size === cbs.length;
    }
}

function deleteSelectedShops() {
    if (!selectedShopIds.size) return;
    const n = selectedShopIds.size;
    if (!confirm(`Удалить выбранные магазины (${n})? Действие необратимо.`)) return;
    const ids = [...selectedShopIds];
    fetch('/api/references/shops/bulk-delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ ids })
    })
        .then(checkAuth)
        .then(r => r.json().then(e => ({ ok: r.ok, body: e })))
        .then(({ ok, body }) => {
            if (!ok) throw new Error(body.error || 'Ошибка удаления');
            selectedShopIds.clear();
            loadShops();
        })
        .catch(err => showAlert(err.message));
}

function openShopModal(id) {
    hideFiasSuggestions();
    document.getElementById('shopForm').reset();
    document.getElementById('shopId').value = '';
    document.getElementById('shopFormModalLabel').textContent = 'Добавить магазин';
    document.getElementById('shopFormSaveBtn').textContent = 'Сохранить';
    if (id) {
        document.getElementById('shopFormModalLabel').textContent = 'Редактировать магазин';
        document.getElementById('shopFormSaveBtn').textContent = 'Сохранить изменения';
        const c = shopContacts[id];
        if (c) {
            document.getElementById('shopNumber').value = c.shop_number;
            document.getElementById('sapCode').value = c.sap_code;
            document.getElementById('shopAddress').value = c.address;
            document.getElementById('shopId').value = id;
            document.getElementById('shopRegion').value = c.region || '';
            document.getElementById('dmName').value = c.dm_name || '';
            document.getElementById('dmPhone').value = c.dm_phone || '';
            document.getElementById('adm1Name').value = c.adm1_name || '';
            document.getElementById('adm1Phone').value = c.adm1_phone || '';
            document.getElementById('adm2Name').value = c.adm2_name || '';
            document.getElementById('adm2Phone').value = c.adm2_phone || '';
        }
    }
    shopModalInstance.show();
}

function onAddressInput() {
    clearTimeout(fiasDebounceTimer);
    const q = document.getElementById('shopAddress').value.trim();
    if (q.length < 3) {
        hideFiasSuggestions();
        return;
    }
    fiasDebounceTimer = setTimeout(() => fetchFiasSuggestions(q), 300);
}

function fetchFiasSuggestions(q) {
    fetch('/api/fias/suggest?q=' + encodeURIComponent(q))
        .then(r => r.json())
        .then(data => {
            const list = document.getElementById('fiasSuggestions');
            const items = data.suggestions || [];
            if (!items.length) {
                list.innerHTML = '<div class="dropdown-item text-muted small disabled">Нет подсказок</div>';
                list.style.display = 'block';
                return;
            }
            list.innerHTML = items.map((s, i) =>
                `<button class="dropdown-item" type="button" data-fias-index="${i}">${escHtml(s.value)}</button>`
            ).join('');
            fiasItems = items;
            list.style.display = 'block';
        })
        .catch(() => {});
}

function selectFiasSuggestion(idx) {
    const item = fiasItems[idx];
    if (item) document.getElementById('shopAddress').value = item.value;
    hideFiasSuggestions();
}

function hideFiasSuggestions() {
    const list = document.getElementById('fiasSuggestions');
    if (!list) return;
    list.style.display = 'none';
    list.innerHTML = '';
}

function onAddressBlur() {
    fiasHideTimer = setTimeout(hideFiasSuggestions, 200);
}

function onAddressFocus() {
    clearTimeout(fiasHideTimer);
    const list = document.getElementById('fiasSuggestions');
    if (list && list.children.length) {
        list.style.display = 'block';
    }
}

function saveShop() {
    const saveBtn = document.getElementById('shopFormSaveBtn');
    if (saveBtn.disabled) return; // защита от двойного клика
    const id = document.getElementById('shopId').value;
    const data = {
        shop_number: document.getElementById('shopNumber').value.trim(),
        sap_code: document.getElementById('sapCode').value.trim(),
        address: document.getElementById('shopAddress').value.trim(),
        dm_name: document.getElementById('dmName').value.trim(),
        dm_phone: document.getElementById('dmPhone').value.trim(),
        adm1_name: document.getElementById('adm1Name').value.trim(),
        adm1_phone: document.getElementById('adm1Phone').value.trim(),
        adm2_name: document.getElementById('adm2Name').value.trim(),
        adm2_phone: document.getElementById('adm2Phone').value.trim(),
        region: document.getElementById('shopRegion').value.trim(),
    };
    if (!data.shop_number || !data.sap_code || !data.address) {
        showAlert('Заполните номер магазина, SAP-код и адрес');
        return;
    }
    const url = id ? `/api/references/shops/${id}` : '/api/references/shops';
    const method = id ? 'PUT' : 'POST';
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Сохранение...';
    saveShopRetry(url, method, data, 2);
}

function saveShopRetry(url, method, data, attemptsLeft) {
    const saveBtn = document.getElementById('shopFormSaveBtn');
    fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
        .then(checkAuth)
        .then(r => {
            if (!r.ok) {
                return r.json().catch(() => ({})).then(e => {
                    // 503 — база занята: тихо повторяем пару раз, потом показываем ошибку
                    if (r.status === 503 && attemptsLeft > 0) {
                        setTimeout(() => saveShopRetry(url, method, data, attemptsLeft - 1), 1500);
                        return null;
                    }
                    throw new Error(e.error || 'Ошибка сохранения');
                });
            }
            return r.json();
        })
        .then(res => {
            if (res === null) return; // пошёл автоматический повтор
            shopModalInstance.hide();
            loadShops();
        })
        .catch(err => showAlert(err.message))
        .finally(() => {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Сохранить';
        });
}

function deleteShop(id) {
    if (!confirm('Удалить магазин?')) return;
    fetch(`/api/references/shops/${id}`, { method: 'DELETE' })
        .then(checkAuth)
        .then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Ошибка удаления'); });
            selectedShopIds.delete(String(id));
            loadShops();
        })
        .catch(err => showAlert(err.message));
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    // кавычки экранируем дополнительно — escHtml используется и в HTML-атрибутах
    return d.innerHTML.replace(/"/g, '&quot;');
}
