function loadRouteSheet() {
    const month = document.getElementById('routeMonth').value;
    if (!month) return;

    const container = document.getElementById('routeTableContainer');
    const empty = document.getElementById('routeEmpty');
    const tbody = document.querySelector('#routeTable tbody');

    container.style.display = 'none';
    empty.style.display = 'none';
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted small py-3">Загрузка...</td></tr>';

    fetch('/api/route/sheet', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({month: month}),
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
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger small py-3">Ошибка: ${err.message}</td></tr>`;
    });
}
