// ============ WAREHOUSE STATE ============
let allBalances = [];
let currentBalanceFilter = 'all';
let balanceSortField = 'date_arrival';
let balanceSortDir = 'desc';

// ============ STORAGES / BALANCES ============
function loadStorages() {
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
    .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            const sel = document.getElementById('storageSelect');
            sel.innerHTML = '<option value="">\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434...</option>' +
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
        document.getElementById('balancesList').innerHTML = '<div class="empty-state"><i class="bi bi-shop"></i><p>\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434</p></div>';
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
            (b.broken && '\u0440\u0435\u043C\u043E\u043D\u0442'.includes(query))
        );
    }

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
        container.innerHTML = '<div class="empty-state"><i class="bi bi-box-seam"></i><p>\u041D\u0435\u0442 \u043E\u0441\u0442\u0430\u0442\u043A\u043E\u0432</p></div>';
        return;
    }

    const sortIcon = field => {
        if (field !== balanceSortField) return '';
        return balanceSortDir === 'asc'
            ? ' <i class="bi bi-sort-up"></i>'
            : ' <i class="bi bi-sort-down"></i>';
    };

    const mobileHtml = filtered.map(b => `
        <div class="balance-mobile-card d-flex py-2 px-2 border-bottom${b.broken ? ' broken-item' : ''}">
            <div class="flex-grow-1 min-w-0 pe-2 overflow-hidden">
                <div class="fw-semibold text-truncate">${esc(b.product_name) || '\u2014'}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.series_name ? '\u0421\u0435\u0440.: ' + esc(b.series_name) : ''}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.inventory_number ? '\u0418\u043D\u0432.: ' + esc(b.inventory_number) : ''}</div>
                <div class="text-muted" style="font-size:0.7rem;line-height:1.3">${b.date_arrival ? '\u041F\u043E\u0441\u0442\u0443\u043F\u043B.: ' + esc(b.date_arrival) : ''}</div>
                ${b.series_name ? `
                <label class="broken-toggle" onclick="event.stopPropagation()">
                    <input type="checkbox" ${b.broken ? 'checked' : ''} onchange="toggleBroken(this, '${esc(b.product_name)}', '${esc(b.series_name)}', '${esc(b.inventory_number || '')}', ${b.broken ? 'false' : 'true'})">
                    <span class="broken-label">\u041D\u0430 \u0440\u0435\u043C\u043E\u043D\u0442</span>
                </label>` : ''}
            </div>
            <div class="fw-bold fs-5 text-end flex-shrink-0 align-self-center">${b.balance ?? 0}</div>
        </div>
    `).join('');

    const desktopHtml = `<div class="table-responsive"><table class="table table-hover balance-table">
        <thead><tr>
            <th class="sortable" onclick="sortBalances('product_name')">\u0422\u043E\u0432\u0430\u0440${sortIcon('product_name')}</th>
            <th class="sortable" onclick="sortBalances('series_name')">\u0421\u0435\u0440\u0438\u044F${sortIcon('series_name')}</th>
            <th class="sortable" onclick="sortBalances('inventory_number')">\u0418\u043D\u0432. \u043D\u043E\u043C\u0435\u0440${sortIcon('inventory_number')}</th>
            <th class="sortable" onclick="sortBalances('date_arrival')">\u041F\u043E\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435${sortIcon('date_arrival')}</th>
            <th class="text-end sortable" onclick="sortBalances('balance')">\u041E\u0441\u0442\u0430\u0442\u043E\u043A${sortIcon('balance')}</th>
            <th class="text-center" style="width:90px">\u0420\u0435\u043C\u043E\u043D\u0442</th>
        </tr></thead>
        <tbody>${filtered.map(b => `<tr class="${b.broken ? 'broken-item' : ''}">
            <td>${esc(b.product_name) || '\u2014'}</td>
            <td>${esc(b.series_name) || '\u2014'}</td>
            <td>${esc(b.inventory_number) || '\u2014'}</td>
            <td style="font-size:0.75rem">${b.date_arrival || '\u2014'}</td>
            <td class="text-end fw-bold">${b.balance ?? 0}</td>
            <td class="text-center">
                ${b.series_name ? `
                <label class="broken-toggle" onclick="event.stopPropagation()">
                    <input type="checkbox" ${b.broken ? 'checked' : ''} onchange="toggleBroken(this, '${esc(b.product_name)}', '${esc(b.series_name)}', '${esc(b.inventory_number || '')}', ${b.broken ? 'false' : 'true'})">
                </label>` : '\u2014'}
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
    if (!sel.value) { showAlert('\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434', 'warning'); return; }
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
        if (!r.ok) throw new Error('\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430');
        return r.blob();
    }).then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${storageName.replace(/[^a-zA-Z\u0430-\u044F\u0410-\u042F0-9\s]/g, '_')}_${date.replace(/\./g, '')}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }).catch(err => {
        showAlert('\u041E\u0448\u0438\u0431\u043A\u0430 \u044D\u043A\u0441\u043F\u043E\u0440\u0442\u0430: ' + err.message, 'danger');
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
    });
}

// ============ SALARY ============
let currentDate = new Date();

function loadSalary() {
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(year, currentDate.getMonth() + 1, 0).getDate();
    const startDate = `${year}-${month}-01`;
    const endDate = `${year}-${month}-${String(lastDay).padStart(2,'0')}`;

    const monthNames = ['\u042F\u043D\u0432\u0430\u0440\u044C','\u0424\u0435\u0432\u0440\u0430\u043B\u044C','\u041C\u0430\u0440\u0442','\u0410\u043F\u0440\u0435\u043B\u044C','\u041C\u0430\u0439','\u0418\u044E\u043D\u044C',
                        '\u0418\u044E\u043B\u044C','\u0410\u0432\u0433\u0443\u0441\u0442','\u0421\u0435\u043D\u0442\u044F\u0431\u0440\u044C','\u041E\u043A\u0442\u044F\u0431\u0440\u044C','\u041D\u043E\u044F\u0431\u0440\u044C','\u0414\u0435\u043A\u0430\u0431\u0440\u044C'];
    document.getElementById('salaryMonth').textContent = `${monthNames[currentDate.getMonth()]} ${year}`;

    fetchDeduped(`/api/salary?start_date=${startDate}&end_date=${endDate}`, undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => ({})) : r)
        .then(data => {
            const items = data.Data || data.data || [];
            const total = data.total_amount != null ? data.total_amount : (data.totalAmount || 0);
            const container = document.getElementById('salaryList');

            if (items.length === 0) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-cash-stack"></i><p>\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445 \u0437\u0430 \u044D\u0442\u043E\u0442 \u043C\u0435\u0441\u044F\u0446</p></div>';
                return;
            }

            container.innerHTML = `<div class="salary-cards">${items.map(item => {
                const val = Math.round(item.value || 0);
                const icon = val > 0 ? 'bi-arrow-up-circle text-success' : 'bi-dash-circle text-muted';
                return `<div class="salary-card">
                    <div class="salary-card-icon"><i class="bi ${icon}"></i></div>
                    <div class="salary-card-body">
                        <div class="salary-card-title">${item.title || '\u2014'}</div>
                        <div class="salary-card-value ${val > 0 ? 'text-success' : 'text-muted'}">${val.toLocaleString('ru')} <span class="salary-currency">\u20BD</span></div>
                    </div>
                </div>`;
            }).join('')}</div>
            <div class="salary-total-bar"><span>\u0418\u0442\u043E\u0433\u043E</span><span class="salary-total-amount">${Math.round(total).toLocaleString('ru')} \u20BD</span></div>`;
        }).catch(() => {
            document.getElementById('salaryList').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438</p></div>';
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
                    btn.innerHTML = '<i class="bi bi-check-lg"></i> \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E';
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
