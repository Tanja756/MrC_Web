let currentRouteDate = new Date();
let routeSortDirection = 'desc';

const routeMonthNames = ['\u042F\u043D\u0432\u0430\u0440\u044C','\u0424\u0435\u0432\u0440\u0430\u043B\u044C','\u041C\u0430\u0440\u0442','\u0410\u043F\u0440\u0435\u043B\u044C','\u041C\u0430\u0439','\u0418\u044E\u043D\u044C',
                         '\u0418\u044E\u043B\u044C','\u0410\u0432\u0433\u0443\u0441\u0442','\u0421\u0435\u043D\u0442\u044F\u0431\u0440\u044C','\u041E\u043A\u0442\u044F\u0431\u0440\u044C','\u041D\u043E\u044F\u0431\u0440\u044C','\u0414\u0435\u043A\u0430\u0431\u0440\u044C'];

function changeRouteMonth(delta) {
    currentRouteDate.setMonth(currentRouteDate.getMonth() + delta);
    loadRouteSheet();
}

function toggleRouteSort() {
    routeSortDirection = routeSortDirection === 'desc' ? 'asc' : 'desc';
    const btn = document.getElementById('routeSortBtn');
    const label = document.getElementById('routeSortLabel');
    const icon = btn.querySelector('i');
    if (routeSortDirection === 'desc') {
        icon.className = 'bi bi-sort-down-alt';
        label.textContent = '\u041D\u043E\u0432\u044B\u0435 \u0441\u0432\u0435\u0440\u0445\u0443';
        btn.title = '\u041D\u043E\u0432\u044B\u0435 \u0441\u0432\u0435\u0440\u0445\u0443';
    } else {
        icon.className = 'bi bi-sort-up-alt';
        label.textContent = '\u041D\u043E\u0432\u044B\u0435 \u0441\u043D\u0438\u0437\u0443';
        btn.title = '\u041D\u043E\u0432\u044B\u0435 \u0441\u043D\u0438\u0437\u0443';
    }
    loadRouteSheet();
}

function updateRouteMonthLabel() {
    const year = currentRouteDate.getFullYear();
    document.getElementById('routeMonthLabel').textContent =
        `${routeMonthNames[currentRouteDate.getMonth()]} ${year}`;
}

function exportRoutePdf() {
    const year = currentRouteDate.getFullYear();
    const month = String(currentRouteDate.getMonth() + 1).padStart(2, '0');
    const monthStr = `${year}-${month}`;

    const tbody = document.querySelector('#routeTable tbody');
    const rows = [];
    for (const tr of tbody.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 4) continue;
        rows.push({
            num: tds[0].textContent.trim(),
            login_1c: tds[1].textContent.trim(),
            date: tds[2].textContent.trim(),
            content: tds[3].textContent.trim(),
            type: tr.classList.contains('table-secondary') ? 'home'
                : tr.classList.contains('table-info') ? 'trip'
                : 'task',
        });
    }

    if (!rows.length) { alert('Нет данных для экспорта'); return; }

    const btn = document.querySelector('[onclick="exportRoutePdf()"]');
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    fetch('/api/route/export-pdf', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({rows, month: monthStr}),
    })
    .then(r => {
        if (!r.ok) throw new Error('Ошибка сервера');
        return r.blob();
    })
    .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `route_${monthStr}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    })
    .catch(err => {
        alert('Ошибка экспорта: ' + err.message);
    })
    .finally(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
    });
}

function rebuildRouteCache() {
    const year = currentRouteDate.getFullYear();
    const month = String(currentRouteDate.getMonth() + 1).padStart(2, '0');
    const monthStr = `${year}-${month}`;
    const btn = document.querySelector('[onclick="rebuildRouteCache()"]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>...';
    fetch('/api/route/rebuild-cache', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({month: monthStr}),
    })
    .then(r => r.json())
    .then(data => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Перестроить';
        loadRouteSheet();
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Перестроить';
        alert('Ошибка: ' + err.message);
    });
}

function loadRouteSheet() {
    updateRouteMonthLabel();
    const year = currentRouteDate.getFullYear();
    const month = String(currentRouteDate.getMonth() + 1).padStart(2, '0');
    const monthStr = `${year}-${month}`;

    const container = document.getElementById('routeTableContainer');
    const empty = document.getElementById('routeEmpty');
    const tbody = document.querySelector('#routeTable tbody');

    container.style.display = 'none';
    empty.style.display = 'none';
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted small py-3">\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...</td></tr>';

    fetch('/api/route/sheet', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({month: monthStr, sort: routeSortDirection}),
    })
    .then(r => r.json())
    .then(data => {
        tbody.innerHTML = '';
        if (!data.rows || data.rows.length === 0) {
            empty.style.display = '';
            return;
        }
        for (const row of data.rows) {
            const tr = document.createElement('tr');
            if (row.type === 'home') {
                tr.className = 'table-secondary';
                tr.innerHTML = `
                    <td class="text-center fw-semibold">${row.num}</td>
                    <td class="fw-semibold">${row.login_1c}</td>
                    <td class="fw-semibold">${row.date}</td>
                    <td class="fw-semibold"><i class="bi bi-house-door me-1"></i>${row.content}</td>
                `;
            } else if (row.type === 'trip') {
                tr.className = 'table-info';
                tr.innerHTML = `
                    <td class="text-center fw-semibold">${row.num}</td>
                    <td class="fw-semibold">${row.login_1c}</td>
                    <td class="fw-semibold">${row.date}</td>
                    <td class="fw-semibold"><i class="bi bi-truck me-1"></i>${row.content}</td>
                `;
            } else {
                tr.innerHTML = `
                    <td class="text-center">${row.num}</td>
                    <td>${row.login_1c}</td>
                    <td>${row.date}</td>
                    <td>${row.content}</td>
                `;
            }
            tbody.appendChild(tr);
        }
        container.style.display = '';
    })
    .catch(err => {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger small py-3">\u041E\u0448\u0438\u0431\u043A\u0430: ${err.message}</td></tr>`;
    });
}
