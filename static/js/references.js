let shopModalInstance = null;
let fiasDebounceTimer = null;
let fiasHideTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    shopModalInstance = new bootstrap.Modal(document.getElementById('shopFormModal'));
    document.getElementById('shopFormModal').addEventListener('hidden.bs.modal', hideFiasSuggestions);
    loadShops();
});

function loadShops() {
    const tbody = document.getElementById('shopsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></td></tr>';
    Promise.all([
        fetch('/api/references/shops').then(r => r.json()),
        fetch('/api/references/shops/user-status').then(r => r.json()).catch(() => ({}))
    ])
        .then(([shops, userStatus]) => {
            if (!shops.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Нет магазинов</td></tr>';
                return;
            }
            const inWorkSaps = [];
            tbody.innerHTML = shops.map((s, i) => {
                const checked = !!userStatus[s.sap_code];
                if (checked) inWorkSaps.push(s.sap_code);
                return `
                <tr data-sap="${escHtml(s.sap_code)}">
                    <td>${i + 1}</td>
                    <td>${escHtml(s.shop_number)}</td>
                    <td>${escHtml(s.sap_code)}</td>
                    <td class="shop-address">${escHtml(s.address)}</td>
                    <td><input type="checkbox" class="form-check-input" ${checked ? 'checked' : ''} onchange="toggleInWork('${escHtml(s.sap_code)}', this.checked)"></td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary me-1" onclick="openShopModal(${s.id})" title="Редактировать"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteShop(${s.id})" title="Удалить"><i class="bi bi-trash"></i></button>
                    </td>
                </tr>
            `}).join('');
            lsSet('inWorkSaps', JSON.stringify(inWorkSaps));
        })
        .catch(() => {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">Ошибка загрузки</td></tr>';
        });
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

function filterShops() {
    const q = document.getElementById('shopFilter').value.trim().toLowerCase();
    document.querySelectorAll('#shopsTableBody tr').forEach(tr => {
        if (!q) { tr.style.display = ''; return; }
        const addr = (tr.querySelector('.shop-address')?.textContent || '').toLowerCase();
        tr.style.display = addr.includes(q) ? '' : 'none';
    });
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
        const cells = document.querySelector(`#shopsTableBody tr:has(button[onclick*="${id}"])`)?.cells;
        if (cells) {
            document.getElementById('shopNumber').value = cells[1].textContent;
            document.getElementById('sapCode').value = cells[2].textContent;
            document.getElementById('shopAddress').value = cells[3].textContent;
            document.getElementById('shopId').value = id;
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
            list.innerHTML = items.map(s =>
                `<button class="dropdown-item" type="button" onclick="selectFiasSuggestion('${escHtml(s.value)}')">${escHtml(s.value)}</button>`
            ).join('');
            list.style.display = 'block';
        })
        .catch(() => {});
}

function selectFiasSuggestion(value) {
    document.getElementById('shopAddress').value = value;
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
    const id = document.getElementById('shopId').value;
    const data = {
        shop_number: document.getElementById('shopNumber').value.trim(),
        sap_code: document.getElementById('sapCode').value.trim(),
        address: document.getElementById('shopAddress').value.trim(),
    };
    if (!data.shop_number || !data.sap_code || !data.address) {
        showAlert('Заполните все поля');
        return;
    }
    const url = id ? `/api/references/shops/${id}` : '/api/references/shops';
    const method = id ? 'PUT' : 'POST';
    fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
        .then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Ошибка сохранения'); });
            return r.json();
        })
        .then(() => {
            shopModalInstance.hide();
            loadShops();
        })
        .catch(err => showAlert(err.message));
}

function deleteShop(id) {
    if (!confirm('Удалить магазин?')) return;
    fetch(`/api/references/shops/${id}`, { method: 'DELETE' })
        .then(r => {
            if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Ошибка удаления'); });
            loadShops();
        })
        .catch(err => showAlert(err.message));
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
