// ============ SHOPS BULK UPLOAD ============
// Массовая загрузка магазинов в справочник (только НОВЫЕ записи).
// Существующие по паре (shop_number, sap_code) магазины не обновляются.
let shopsRows = [];
let shopsFileName = '';
let shopsRowIdCounter = 0;

function initShopsUploadTab() {
    const dz = document.getElementById('shopsDropzone');
    const input = document.getElementById('shopsFile');
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
        if (file) handleShopsFile(file);
    });
    input.addEventListener('change', () => {
        if (input.files[0]) handleShopsFile(input.files[0]);
    });
}

function handleShopsFile(file) {
    if (!file.name.endsWith('.xlsx')) {
        showShopsError('Выберите файл формата .xlsx');
        return;
    }
    shopsFileName = file.name;
    document.querySelector('#shopsDropzone .upload-dropzone-text').textContent = file.name;
    document.getElementById('shopsResult').innerHTML = '';
    document.getElementById('shopsActions').classList.add('d-none');

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });

            if (json.length === 0) {
                showShopsError('Файл не содержит данных');
                return;
            }

            shopsRows = [];
            // Файл вида mag_list_no_index.xlsx — БЕЗ шапки, первая строка уже данные.
            // Колонки: A — SAP-код, B — номер магазина, C — адрес.
            for (let i = 0; i < json.length; i++) {
                const row = json[i];
                if (!row) continue;
                const sap = shopsCellToStr(row[0]).toUpperCase();
                const num = shopsCellToNumber(row[1]);
                const addr = shopsCellToStr(row[2]);
                if (!sap && !num && !addr) continue;
                shopsRows.push({
                    _uid: ++shopsRowIdCounter,
                    sap_code: sap,
                    shop_number: num,
                    address: addr,
                });
            }

            if (shopsRows.length === 0) {
                showShopsError('В файле нет распознанных строк (нужны колонки: SAP, номер магазина, адрес)');
                return;
            }

            renderShopsPreview();
        } catch (err) {
            showShopsError('Ошибка чтения файла: ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

function shopsCellToStr(v) {
    if (v == null) return '';
    return String(v).trim().replace(/^'/, '');
}

function shopsCellToNumber(v) {
    if (v == null) return '';
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
        return String(v);
    }
    const s = String(v).trim().replace(/^'/, '');
    const n = Number(s);
    if (s !== '' && Number.isFinite(n) && Number.isInteger(n)) return String(n);
    return s;
}

function showShopsError(msg) {
    document.getElementById('shopsPreview').innerHTML = '';
    document.getElementById('shopsActions').classList.add('d-none');
    document.getElementById('shopsResult').innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${shopsEsc(msg)}</div>`;
}

function renderShopsPreview() {
    const container = document.getElementById('shopsPreview');
    const actions = document.getElementById('shopsActions');
    const stats = document.getElementById('shopsStats');
    const result = document.getElementById('shopsResult');
    result.innerHTML = '';

    const filtered = [...shopsRows];

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="bi bi-file-earmark-excel"></i><p>Нет данных для отображения</p></div>';
        actions.classList.add('d-none');
        return;
    }

    const invalid = filtered.filter(r => !r.sap_code || !r.shop_number || !r.address).length;

    container.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover upload-table">
        <thead><tr>
            <th style="width:36px"><input type="checkbox" id="shopsSelectAll" onchange="toggleAllShopsRows(this.checked)"></th>
            <th>№</th>
            <th>Номер магазина</th>
            <th>SAP</th>
            <th>Адрес</th>
            <th style="width:50px"></th>
        </tr></thead>
        <tbody>${filtered.map((r, i) => {
            const ok = r.sap_code && r.shop_number && r.address;
            return `
            <tr>
                <td><input type="checkbox" class="shops-row-cb" value="${r._uid}"></td>
                <td>${i + 1}</td>
                <td>${shopsEsc(r.shop_number)} ${ok ? '' : '<span class="badge bg-danger">неполный</span>'}</td>
                <td>${shopsEsc(r.sap_code)}</td>
                <td class="text-truncate" style="max-width:340px">${shopsEsc(r.address)}</td>
                <td><button class="btn btn-outline-danger btn-sm" onclick="deleteShopsRow(${r._uid})" title="Удалить"><i class="bi bi-trash"></i></button></td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;

    stats.textContent = `${filtered.length} ${shopsPluralize(filtered.length, 'строка', 'строки', 'строк')} готово к загрузке` + (invalid ? ` · ${invalid} ${shopsPluralize(invalid, 'неполная', 'неполные', 'неполных')} (будут пропущены)` : '');
    actions.classList.remove('d-none');
}

function submitShopsBatch() {
    const btn = document.getElementById('shopsSubmitBtn');
    const result = document.getElementById('shopsResult');
    if (shopsRows.length === 0) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Загрузка...';

    fetch('/api/references/shops/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: shopsRows }),
    }).then(checkAuth).then(r => r.json()).then(data => {
        if (data.error) {
            result.innerHTML = `<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>${shopsEsc(data.error)}</div>`;
            return;
        }
        const ins = data.inserted || 0;
        const exist = data.skipped_existing || 0;
        const inv = data.skipped_invalid || 0;
        let msg = `<i class="bi bi-check-circle me-1"></i>Добавлено: ${ins} ${shopsPluralize(ins, 'магазин', 'магазина', 'магазинов')}`;
        if (exist) msg += `; уже есть: ${exist}`;
        if (inv) msg += `; пропущено неполных: ${inv}`;
        result.innerHTML = `<div class="alert alert-success py-2 mb-0">${msg}</div>`;
    }).catch(() => {
        result.innerHTML = '<div class="alert alert-danger py-2 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Ошибка соединения</div>';
    }).finally(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-database-up me-1"></i>Загрузить в БД';
    });
}

function toggleAllShopsRows(checked) {
    document.querySelectorAll('.shops-row-cb').forEach(cb => cb.checked = checked);
}

function deleteShopsRow(uid) {
    shopsRows = shopsRows.filter(r => r._uid !== uid);
    renderShopsPreview();
}

function deleteSelectedShopsRows() {
    const cbs = document.querySelectorAll('.shops-row-cb:checked');
    if (cbs.length === 0) return;
    const ids = new Set([...cbs].map(cb => +cb.value));
    shopsRows = shopsRows.filter(r => !ids.has(r._uid));
    renderShopsPreview();
}

function shopsEsc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function shopsPluralize(n, one, few, many) {
    n = Math.abs(n) % 100;
    if (n >= 5 && n <= 20) return many;
    n %= 10;
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
}