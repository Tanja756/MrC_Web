// ============ FN SCHEDULE UPLOAD ============
let fnRows = [];
let fnFileName = '';
let fnRowIdCounter = 0;

function initFnUploadTab() {
    const dz = document.getElementById('fnDropzone');
    const input = document.getElementById('fnFile');
    if (!dz) return;

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
        if (file) handleFnFile(file);
    });
    input.addEventListener('change', () => {
        if (input.files[0]) handleFnFile(input.files[0]);
    });

    document.getElementById('fnFilterEngineer').addEventListener('change', renderFnPreview);
    document.getElementById('fnFilterMonth').addEventListener('change', renderFnPreview);
}

function handleFnFile(file) {
    if (!file.name.endsWith('.xlsx')) {
        showFnError('Выберите файл формата .xlsx');
        return;
    }
    fnFileName = file.name;
    document.querySelector('#fnDropzone .upload-dropzone-text').textContent = file.name;
    document.getElementById('fnResult').innerHTML = '';
    document.getElementById('fnActions').classList.add('d-none');

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });

            if (json.length < 2) {
                showFnError('Файл не содержит данных');
                return;
            }

            fnRows = [];
            for (let i = 1; i < json.length; i++) {
                const row = json[i];
                if (!row || !row[4]) continue;
                const rowObj = parseFnRow(row);
                if (rowObj) {
                    rowObj._uid = ++fnRowIdCounter;
                    fnRows.push(rowObj);
                }
            }

            const saps = [...new Set(fnRows.map(r => r.sap_code).filter(Boolean))];
            if (saps.length) {
                fetch('/api/shop/by-sap-list', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ saps }),
                }).then(checkAuth).then(r => r.json()).then(map => {
                    for (const row of fnRows) {
                        const entry = map[row.sap_code];
                        if (entry && entry.addr) {
                            row.address = entry.addr;
                        }
                    }
                    populateFnFilters();
                    renderFnPreview();
                }).catch(() => {
                    populateFnFilters();
                    renderFnPreview();
                });
            } else {
                populateFnFilters();
                renderFnPreview();
            }
        } catch (err) {
            showFnError('Ошибка чтения файла: ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function excelSerialToDateStr(num) {
    const d = new Date((num - 25569) * 86400 * 1000);
    if (isNaN(d.getTime())) return String(num);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function cellToStr(v) {
    if (v == null) return '';
    return String(v).trim().replace(/^'/, '');
}

function cellToDate(v) {
    if (v == null) return '';
    if (typeof v === 'number') return excelSerialToDateStr(v);
    const s = String(v).trim().replace(/\s+\d{2}:\d{2}:\d{2}$/, '');
    return s;
}

function cellToMonth(v) {
    const raw = cellToDate(v);
    const m = raw.match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    return raw;
}

function cleanAddress(s) {
    return s.replace(/^[^a-zA-Zа-яА-ЯёЁ]+/, '');
}

function parseFnRow(row) {
    const factoryName = cellToStr(row[4]);
    const fm = factoryName.match(/(\d+)-/);
    const shopNumber = fm ? fm[1] : '';

    return {
        shop_number: shopNumber,
        sap_code: cellToStr(row[3]),
        address: cleanAddress(cellToStr(row[11])),
        cashreg_number: cellToStr(row[15]),
        engineer: cellToStr(row[5]),
        month: cellToMonth(row[23]),
        fn_expiry: cellToDate(row[14]),
        kkt_serial: cellToStr(row[16]),
        be_name: cellToStr(row[0]),
        cluster_name: cellToStr(row[1]),
        gp_name: cellToStr(row[2]),
        factory_name: factoryName,
        ssi_ts5: cellToStr(row[6]),
        replace_from: cellToDate(row[7]),
        replace_to: cellToDate(row[8]),
        replace_date: cellToDate(row[9]),
        status: cellToStr(row[10]),
        fn_id: cellToStr(row[12]),
        fn_prev_id: cellToStr(row[13]),
        kkt_model: cellToStr(row[17]),
        fn_model: cellToStr(row[18]),
        rnm_after_activation: cellToStr(row[19]),
        kkt_reg_status: cellToStr(row[20]),
        fp_received_date: cellToDate(row[21]),
        fn_activation_plus410: cellToDate(row[22]),
        registry: cellToStr(row[24]),
        invoice: cellToStr(row[25]),
        payment: cellToStr(row[26]),
        comment: cellToStr(row[27]),
        card_sent: cellToStr(row[28]),
    };
}

function showFnError(msg) {
    document.getElementById('fnPreview').innerHTML = '';
    document.getElementById('fnActions').classList.add('d-none');
    document.getElementById('fnResult').innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${escHtml(msg)}</div>`;
}

function populateFnFilters() {
    const engineers = [...new Set(fnRows.map(r => r.engineer).filter(Boolean))].sort();
    const months = [...new Set(fnRows.map(r => r.month).filter(Boolean))].sort();

    const engSel = document.getElementById('fnFilterEngineer');
    const curEng = engSel.value;
    engSel.innerHTML = '<option value="">Все инженеры</option>' +
        engineers.map(e => `<option value="${escAttr(e)}">${escHtml(e)}</option>`).join('');
    if (curEng && [...engSel.options].some(o => o.value === curEng)) engSel.value = curEng;

    const monSel = document.getElementById('fnFilterMonth');
    const curMon = monSel.value;
    monSel.innerHTML = '<option value="">Все месяцы</option>' +
        months.map(m => `<option value="${escAttr(m)}">${escHtml(m)}</option>`).join('');
    if (curMon && [...monSel.options].some(o => o.value === curMon)) monSel.value = curMon;
}

function getFilteredFnRows() {
    const engineer = document.getElementById('fnFilterEngineer').value;
    const month = document.getElementById('fnFilterMonth').value;
    let rows = [...fnRows];
    if (engineer) rows = rows.filter(r => r.engineer === engineer);
    if (month) rows = rows.filter(r => r.month === month);
    return rows;
}

function formatFnDate(str) {
    if (!str) return '—';
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    return str;
}

function renderFnPreview() {
    const container = document.getElementById('fnPreview');
    const actions = document.getElementById('fnActions');
    const stats = document.getElementById('fnStats');
    const result = document.getElementById('fnResult');
    result.innerHTML = '';

    const filtered = getFilteredFnRows();
    filtered.sort((a, b) => {
        if (!a.fn_expiry && !b.fn_expiry) return 0;
        if (!a.fn_expiry) return 1;
        if (!b.fn_expiry) return -1;
        return a.fn_expiry.localeCompare(b.fn_expiry);
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-file-earmark-excel"></i><p>Нет данных для отображения</p></div>';
        actions.classList.add('d-none');
        return;
    }

    container.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover upload-table">
        <thead><tr>
            <th style="width:36px"><input type="checkbox" id="fnSelectAll" onchange="toggleAllFnRows(this.checked)"></th>
            <th>№</th>
            <th>Магазин</th>
            <th>SAP</th>
            <th>Адрес</th>
            <th>Номер кассы</th>
            <th>Статус</th>
            <th>Дата оконч. ФН</th>
            <th style="width:50px"></th>
        </tr></thead>
        <tbody>${filtered.map((r, i) => `
            <tr>
                <td><input type="checkbox" class="fn-row-cb" value="${r._uid}"></td>
                <td>${i + 1}</td>
                <td>${escHtml(r.shop_number)}</td>
                <td>${escHtml(r.sap_code)}</td>
                <td class="text-truncate" style="max-width:300px">${escHtml(r.address)}</td>
                <td>${escHtml(r.cashreg_number)}</td>
                <td class="fn-status-${r.status === 'Выполнена' ? 'done' : r.status === 'Снят с учета' ? 'removed' : 'other'}">${escHtml(r.status)}</td>
                <td class="text-nowrap">${formatFnDate(r.fn_expiry)}</td>
                <td><button class="btn btn-outline-danger btn-sm" onclick="deleteFnRow(${r._uid})" title="Удалить"><i class="bi bi-trash"></i></button></td>
            </tr>`
        ).join('')}</tbody>
    </table></div>`;

    stats.textContent = `✅ ${filtered.length} ${pluralize(filtered.length, 'строка', 'строки', 'строк')} готово к загрузке`;
    actions.classList.remove('d-none');
}

function escAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function toggleAllFnRows(checked) {
    document.querySelectorAll('.fn-row-cb').forEach(cb => cb.checked = checked);
}

function deleteFnRow(uid) {
    fnRows = fnRows.filter(r => r._uid !== uid);
    populateFnFilters();
    renderFnPreview();
}

function deleteSelectedFnRows() {
    const cbs = document.querySelectorAll('.fn-row-cb:checked');
    if (cbs.length === 0) return;
    const ids = new Set([...cbs].map(cb => +cb.value));
    fnRows = fnRows.filter(r => !ids.has(r._uid));
    populateFnFilters();
    renderFnPreview();
}

function markFnByKeywords() {
    const keywordsStr = lsGet('myTaskKeywords', '');
    if (!keywordsStr) {
        showAlert('Ключевые слова не заданы в настройках', 'warning');
        return;
    }
    const keywords = keywordsStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) {
        showAlert('Ключевые слова не заданы', 'warning');
        return;
    }

    const filtered = getFilteredFnRows();
    document.querySelectorAll('.fn-row-cb').forEach(cb => {
        const uid = +cb.value;
        const row = fnRows.find(r => r._uid === uid);
        if (row && row.sap_code && keywords.some(k => row.sap_code.toLowerCase().includes(k))) {
            cb.checked = true;
        }
    });
}

function submitFnBatch() {
    const btn = document.getElementById('fnSubmitBtn');
    const result = document.getElementById('fnResult');
    const filtered = getFilteredFnRows();

    if (filtered.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Загрузка...';

    fetch('/api/fn/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: filtered }),
    }).then(checkAuth).then(r => r.json()).then(data => {
        const count = data.count || filtered.length;
        result.innerHTML = `<div class="alert alert-success py-2 mb-0"><i class="bi bi-check-circle me-1"></i>Загружено ${count} ${pluralize(count, 'запись', 'записи', 'записей')}</div>`;
    }).catch(() => {
        result.innerHTML = '<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Ошибка соединения</div>';
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-database-up me-1"></i>Загрузить в БД';
    });
}

function normalizeFnAddresses() {
    const cbs = document.querySelectorAll('.fn-row-cb:checked');
    if (cbs.length === 0) {
        showAlert('Выберите строки для нормализации адресов', 'warning');
        return;
    }
    const ids = new Set([...cbs].map(cb => +cb.value));
    const rows = fnRows.filter(r => ids.has(r._uid));
    const btn = document.querySelector('[onclick="normalizeFnAddresses()"]');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Нормализация...';

    fetch('/api/fn/normalize-addresses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
    }).then(checkAuth).then(r => r.json()).then(data => {
        const results = data.results || [];
        for (const res of results) {
            const row = fnRows.find(r => r._uid === res._uid);
            if (row && res.address) row.address = res.address;
        }
        renderFnPreview();
        const done = results.length;
        document.getElementById('fnResult').innerHTML =
            `<div class="alert alert-success py-2 mb-0"><i class="bi bi-check-circle me-1"></i>Нормализовано ${done} ${pluralize(done, 'адрес', 'адреса', 'адресов')}</div>`;
    }).catch(() => {
        document.getElementById('fnResult').innerHTML =
            '<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Ошибка при нормализации адресов</div>';
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
    });
}
