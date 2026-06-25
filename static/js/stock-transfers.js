// ============ STOCK TRANSFERS ============
let transferPickProducts = [];
let transferSelectedItems = [];
let transferPhotos = [];
let currentTransferDoc = null;
let transferChangedAmounts = {};
let transferNewComment = '';
let transferNewAttachments = [];
let transferDeletedAttachments = new Set();
let _transfersCache = [];

function openCreateTransfer() {
    const modalEl = document.getElementById('createTransferModal');
    if (modalEl.classList.contains('show')) return;
    document.getElementById('transferSource').innerHTML = '<option value="">\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...</option>';
    document.getElementById('transferDest').innerHTML = '<option value="">\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430...</option>';

    const sel = document.getElementById('storageSelect');
    if (sel && sel.options.length > 1) {
        const opts = sel.innerHTML;
        document.getElementById('transferSource').innerHTML = opts;
        document.getElementById('transferDest').innerHTML = opts;
    } else {
        loadTransferStorages();
    }

    const pickSel = document.getElementById('transferStoragePick');
    if (pickSel) {
        pickSel.innerHTML = sel ? sel.innerHTML : '<option value="">Выберите склад...</option>';
    }

    transferSelectedItems = [];
    transferPhotos = [];
    document.getElementById('transferSelectedItems').innerHTML = '';
    document.getElementById('transferPhotoPreview').innerHTML = '';
    document.getElementById('transferComment').value = '';
    document.getElementById('transferProductSearch').value = '';
    transferPickProducts = [];

    const sourceEl = document.getElementById('transferSource');
    if (sourceEl.value) {
        document.getElementById('transferStoragePick').value = sourceEl.value;
        loadTransferProducts();
    } else {
        document.getElementById('transferProductsList').innerHTML = '<div class="text-muted small text-center py-3">Выберите склад-отправитель</div>';
    }

    const modal = new bootstrap.Modal(document.getElementById('createTransferModal'));
    modal.show();
}

function loadTransferStorages() {
    fetchDeduped('/api/warehouse/storages', undefined, 60000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            const opts = '<option value="">\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434...</option>' +
                data.map(s => `<option value="${s.guid}">${s.name}</option>`).join('');
            document.getElementById('transferSource').innerHTML = opts;
            document.getElementById('transferDest').innerHTML = opts;
            document.getElementById('transferStoragePick').innerHTML = opts;
        });
}

function loadTransferProducts() {
    const guid = document.getElementById('transferStoragePick').value;
    const list = document.getElementById('transferProductsList');
    if (!guid) {
        list.innerHTML = '<div class="text-muted small text-center py-3">\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434-\u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C</div>';
        transferPickProducts = [];
        renderTransferProducts();
        return;
    }
    fetchDeduped(`/api/warehouse/balances-pick?storage=${guid}`, undefined, 15000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            transferPickProducts = data || [];
            renderTransferProducts();
        });
}

function filterTransferProducts() {
    renderTransferProducts();
}

function renderTransferProducts() {
    const query = document.getElementById('transferProductSearch').value.toLowerCase().trim();
    const container = document.getElementById('transferProductsList');
    const filtered = transferPickProducts.filter(p => {
        const name = (p.product_name || p.product_guid || '').toLowerCase();
        const series = p.series ? (p.series.name || '').toLowerCase() : '';
        return name.includes(query) || series.includes(query);
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="text-muted small text-center py-3">\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0445 \u0442\u043E\u0432\u0430\u0440\u043E\u0432</div>';
        return;
    }

    container.innerHTML = filtered.map(p => {
        const key = p.product_guid + '|' + (p.series ? p.series.guid : '');
        const already = transferSelectedItems.some(s => s.key === key);
        const seriesName = p.series ? (p.series.name || p.series.inventory_number || '\u2014') : '\u2014';
        const name = p.product_name || p.product_guid || '\u2014';
        return `<div class="transfer-product-item ${already ? 'selected' : ''}" data-key="${key.replace(/"/g,'&quot;')}" onclick="toggleTransferProduct(this)">
            <div class="d-flex justify-content-between align-items-center px-2 py-1 ${already ? 'bg-primary bg-opacity-10' : ''}" style="cursor:pointer">
                <div class="small">
                    <span class="fw-semibold">${esc(name)}</span>
                    ${p.series ? `<span class="text-muted ms-2">[${esc(seriesName)}]</span>` : ''}
                </div>
                <div class="text-nowrap">
                    <span class="badge bg-secondary me-2">${p.balance ?? 0}</span>
                    ${already ? '<i class="bi bi-check-lg text-primary"></i>' : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

function toggleTransferProduct(el) {
    const key = el.dataset.key;
    if (!key) return;
    const idx = transferSelectedItems.findIndex(s => s.key === key);
    if (idx !== -1) {
        transferSelectedItems.splice(idx, 1);
    } else {
        const p = transferPickProducts.find(x => {
            const k = x.product_guid + '|' + (x.series ? x.series.guid : '');
            return k === key;
        });
        if (!p) return;
        transferSelectedItems.push({
            key,
            product_guid: p.product_guid,
            product_name: p.product_name || p.product_guid,
            series_guid: p.series ? p.series.guid : null,
            characteristic_guid: p.characteristic || null,
            count: 1,
        });
    }
    renderTransferProducts();
    renderTransferSelected();
}

function renderTransferSelected() {
    const container = document.getElementById('transferSelectedItems');
    if (transferSelectedItems.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = transferSelectedItems.map((item, i) =>
        `<span class="badge bg-primary d-inline-flex align-items-center gap-1" style="font-size:0.75rem">
            ${i+1}. ${esc(item.product_name || item.product_guid.slice(0,8) + '\u2026')}
            <input type="number" min="1" value="${item.count}" style="width:40px;font-size:0.7rem;padding:0 2px;text-align:center;border:none;border-radius:3px" onchange="transferSelectedItems[${i}].count=Math.max(1,parseInt(this.value)||1)">
            <i class="bi bi-x" style="cursor:pointer" onclick="removeTransferItem(${i})"></i>
        </span>`
    ).join('');
}

function removeTransferItem(idx) {
    transferSelectedItems.splice(idx, 1);
    renderTransferProducts();
    renderTransferSelected();
}

function compressImage(file, maxDimension = 1920, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
                let w = img.width, h = img.height;
                if (w > h && w > maxDimension) {
                    h = Math.round(h * maxDimension / w);
                    w = maxDimension;
                } else if (h > maxDimension) {
                    w = Math.round(w * maxDimension / h);
                    h = maxDimension;
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function onTransferPhotoSelected(input) {
    const files = input.files;
    if (!files || !files.length) return;
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        try {
            const base64 = await compressImage(file, 1920, 0.7);
            transferPhotos.push({data: base64, extension: 'jpg', filename: file.name});
            renderTransferPhotos();
        } catch (e) {
            console.error('Image compression failed', e);
        }
    }
    input.value = '';
}

function captureTransferPhoto() {
    const input = document.getElementById('transferCameraInput');
    if (input) input.click();
}

function renderTransferPhotos() {
    const container = document.getElementById('transferPhotoPreview');
    if (transferPhotos.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = transferPhotos.map((photo, i) =>
        `<div style="text-align:center">
            <div class="position-relative d-inline-block" style="width:72px;height:72px">
                <img src="data:image/${photo.extension};base64,${photo.data}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">
                <i class="bi bi-x-circle-fill position-absolute" style="top:-6px;right:-6px;cursor:pointer;color:#dc3545;font-size:1rem" onclick="removeTransferPhoto(${i})"></i>
            </div>
            <div class="small text-muted text-truncate" style="max-width:80px">${esc(photo.filename || '')}</div>
        </div>`
    ).join('');
}

function removeTransferPhoto(idx) {
    transferPhotos.splice(idx, 1);
    renderTransferPhotos();
}

function submitTransfer() {
    const source = document.getElementById('transferSource').value;
    const dest = document.getElementById('transferDest').value;
    if (!source || !dest) {
        showAlert('\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043A\u043B\u0430\u0434 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0438 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C', 'warning');
        return;
    }
    if (source === dest) {
        showAlert('\u0421\u043A\u043B\u0430\u0434\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C \u0438 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u044C \u0434\u043E\u043B\u0436\u043D\u044B \u0440\u0430\u0437\u043B\u0438\u0447\u0430\u0442\u044C\u0441\u044F', 'warning');
        return;
    }
    if (transferSelectedItems.length === 0) {
        showAlert('\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u0438\u043D \u0442\u043E\u0432\u0430\u0440', 'warning');
        return;
    }

    const loading = document.getElementById('transferFormLoading');
    const footer = document.querySelector('#createTransferModal .modal-footer');
    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);

    const products = transferSelectedItems.map(item => ({
        guid: item.product_guid,
        series_guid: item.series_guid,
        characteristic_guid: item.characteristic_guid,
        count: item.count,
    }));

    const body = {
        source_storage: source,
        destination_storage: dest,
        products: products,
        comment: document.getElementById('transferComment').value.trim(),
        attachments: transferPhotos.map(ph => ({
            data: ph.data,
            extension: ph.extension,
            filename: ph.filename || ('photo.' + ph.extension),
        })),
    };

    fetch('/api/warehouse/stock-transfers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
    })
        .then(checkAuth)
        .then(r => r.json())
        .then(data => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            if (data.success) {
                bootstrap.Modal.getInstance(document.getElementById('createTransferModal'))?.hide();
                showAlert('\u041F\u0435\u0440\u0435\u043C\u0435\u0449\u0435\u043D\u0438\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u043E', 'success');
                loadTransfers();
            } else {
                showAlert('\u041E\u0448\u0438\u0431\u043A\u0430: ' + (data.error || '\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430'), 'danger');
            }
        })
        .catch(err => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            showAlert('\u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438: ' + err.message, 'danger');
        });
}

function loadTransfers() {
    const container = document.getElementById('transfersList');
    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-muted"></div></div>';

    fetchDeduped('/api/warehouse/stock-transfers', undefined, 10000)
        .then(r => r instanceof Response ? r.json().catch(() => []) : r)
        .then(data => {
            _transfersCache = data || [];
            if (!_transfersCache.length) {
                container.innerHTML = '<div class="empty-state"><i class="bi bi-arrow-left-right"></i><p>\u041D\u0435\u0442 \u043F\u0435\u0440\u0435\u043C\u0435\u0449\u0435\u043D\u0438\u0439</p></div>';
                return;
            }
            container.innerHTML = _transfersCache.map((doc, idx) => {
                const itemsCount = (doc.items || []).length;
                const totalQty = (doc.items || []).reduce((s, it) => s + (it.amount || 0), 0);
                const src = doc.warehouse_source_name || doc.warehouse_source || '\u2014';
                const dst = doc.warehouse_dest_name || doc.warehouse_dest || '\u2014';
                const org = doc.organization_name || '';
                const comments = doc.comments || [];
                const commentsHtml = comments.length
                    ? `<div class="small mt-1 text-muted"><i class="bi bi-chat-dots me-1"></i>${esc(typeof comments[comments.length - 1] === 'string' ? comments[comments.length - 1] : (comments[comments.length - 1].content || ''))}</div>`
                    : '';
                return `<div class="transfer-card border rounded-3 p-3 mb-2" style="cursor:pointer" onclick="openTransferDetail(${idx})">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <div class="fw-semibold">${esc(doc.number || '\u2014')}</div>
                            <div class="small text-muted">${formatDate(doc.date)}</div>
                            ${org ? `<div class="small text-muted">${esc(org)}</div>` : ''}
                        </div>
                        <div class="text-end small text-muted">
                            <div>${itemsCount} \u043F\u043E\u0437.</div>
                            <div>${totalQty} \u0448\u0442.</div>
                        </div>
                    </div>
                    <div class="small mt-1">
                        <i class="bi bi-arrow-right-short"></i> ${esc(src)} \u2192 ${esc(dst)}
                    </div>
                    ${commentsHtml}
                </div>`;
            }).join('');
        })
        .catch(() => {
            container.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-triangle"></i><p>\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438</p></div>';
        });
}

function openTransferDetail(idx) {
    const modalEl = document.getElementById('transferDetailModal');
    if (modalEl.classList.contains('show')) return;
    const doc = _transfersCache[idx];
    if (!doc) return;
    currentTransferDoc = doc;
    transferChangedAmounts = {};
    transferNewComment = '';
    transferNewAttachments = [];
    transferDeletedAttachments = new Set();

    const title = document.getElementById('transferDetailTitle');
    title.innerHTML = `<i class="bi bi-arrow-left-right me-2"></i>${esc(doc.number || '\u041F\u0435\u0440\u0435\u043C\u0435\u0449\u0435\u043D\u0438\u0435')}`;

    const src = doc.warehouse_source_name || doc.warehouse_source || '\u2014';
    const dst = doc.warehouse_dest_name || doc.warehouse_dest || '\u2014';

    document.getElementById('transferDetailInfo').innerHTML = `
        <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
                <div class="small text-muted">${formatDate(doc.date)}</div>
                <div class="small">${esc(doc.organization_name || '')}</div>
            </div>
            <div class="text-end small">
                <div><strong>${esc(src)}</strong> <i class="bi bi-arrow-right"></i> <strong>${esc(dst)}</strong></div>
            </div>
        </div>
    `;

    const items = doc.items || [];
    document.getElementById('transferDetailProducts').innerHTML = `
        <label class="fw-semibold small d-block mb-1"><i class="bi bi-box-seam me-1"></i>\u0422\u043E\u0432\u0430\u0440\u044B</label>
        <div class="table-responsive">
        <table class="table table-sm table-borderless mb-0">
            <thead><tr><th>\u0422\u043E\u0432\u0430\u0440</th><th>\u0421\u0435\u0440\u0438\u044F</th><th class="text-center" style="width:80px">\u041A\u043E\u043B-\u0432\u043E</th></tr></thead>
            <tbody>${items.map((item, i) => {
                const seriesName = item.series ? (item.series.name || item.series.inventory_number || '\u2014') : '\u2014';
                const inv = item.series ? (item.series.inventory_number || '') : '';
                const name = item.product_name || item.product_guid || '\u2014';
                return `<tr>
                    <td class="small">${esc(name)}</td>
                    <td class="small text-muted">${esc(seriesName)}${inv ? ' ('+esc(inv)+')' : ''}</td>
                    <td class="text-center">
                        <input type="number" min="0" value="${item.amount ?? 0}"
                            class="form-control form-control-sm" style="width:65px;display:inline-block;text-align:center"
                            data-item-guid="${esc(item.guid)}"
                            onchange="onTransferAmountChange(this, '${esc(item.guid)}')">
                    </td>
                </tr>`;
            }).join('')}</tbody>
        </table>
        </div>
    `;

    const comments = doc.comments || [];
    const commentsHtml = comments.length
        ? comments.map(c => {
            if (typeof c === 'string') {
                return `<div class="small mb-1 p-1 bg-light rounded-3">${esc(c)}</div>`;
            }
            return `<div class="small mb-1 p-1 bg-light rounded-3">${esc(c.author || '')} \u2014 ${esc(c.date || '')}<br>${esc(c.content || '')}</div>`;
          }).join('')
        : '<div class="text-muted small mb-2">\u041D\u0435\u0442 \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0435\u0432</div>';
    document.getElementById('transferDetailComments').innerHTML = `
        <label class="fw-semibold small d-block mb-1"><i class="bi bi-chat-dots me-1"></i>\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0438</label>
        ${commentsHtml}
        <div class="input-group input-group-sm mt-1">
            <input type="text" class="form-control" id="transferDetailNewComment" placeholder="\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439..."
                oninput="transferNewComment=this.value.trim()">
            <button class="btn btn-outline-secondary" onclick="document.getElementById('transferDetailNewComment').value='';transferNewComment='';this.closest('.input-group').querySelector('input').focus()" title="\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C"><i class="bi bi-x-lg"></i></button>
        </div>
    `;

    renderTransferDetailAttachments();

    const modal = new bootstrap.Modal(document.getElementById('transferDetailModal'));
    modal.show();
}

function onTransferAmountChange(input, guid) {
    const val = parseInt(input.value) || 0;
    const original = ((currentTransferDoc.items || []).find(i => i.guid === guid) || {}).amount || 0;
    if (val !== original) {
        transferChangedAmounts[guid] = val;
    } else {
        delete transferChangedAmounts[guid];
    }
}

function renderTransferDetailAttachments() {
    const doc = currentTransferDoc;
    if (!doc) return;
    const attachments = doc.attachments || [];
    const taskGuid = doc.guid;
    const container = document.getElementById('transferDetailPhotos');

    const existingHtml = attachments.map(a => {
        const deleted = transferDeletedAttachments.has(a.guid);
        const icon = a.filename && /\.(pdf|doc|docx|xls|xlsx|zip)$/i.test(a.filename)
            ? 'bi bi-file-earmark' : 'bi bi-file-earmark-image';
        return `<div class="position-relative" style="width:72px;height:72px${deleted ? ';opacity:0.4' : ''}">
            <div style="width:72px;height:72px;border-radius:6px;overflow:hidden;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#999;cursor:pointer"
                 title="${esc(a.filename || '')}"
                 onclick="downloadTransferAttachment('${a.guid}')">
                <i class="${icon}" style="font-size:1.5rem"></i>
            </div>
            <i class="bi ${deleted ? 'bi-arrow-counterclockwise text-success' : 'bi-x-circle-fill text-danger'} position-absolute"
               style="top:-6px;right:-6px;cursor:pointer;font-size:1rem;background:white;border-radius:50%"
               onclick="event.stopPropagation();toggleDeleteTransferAttachment('${a.guid}')"></i>
        </div>`;
    }).join('');

    const newHtml = transferNewAttachments.map((att, i) =>
        `<div style="text-align:center">
            <div class="position-relative d-inline-block" style="width:72px;height:72px">
                <img src="data:image/${att.extension};base64,${att.data}" style="width:100%;height:100%;object-fit:cover;border-radius:6px">
                <i class="bi bi-x-circle-fill position-absolute" style="top:-6px;right:-6px;cursor:pointer;color:#dc3545;font-size:1rem;background:white;border-radius:50%"
                   onclick="event.stopPropagation();removeNewTransferAttachment(${i})"></i>
            </div>
            <div class="small text-muted text-truncate" style="max-width:80px">${esc(att.filename || '')}</div>
        </div>`
    ).join('');

    const addBtn = `<div style="width:72px;height:72px;border-radius:6px;border:2px dashed #ccc;display:flex;align-items:center;justify-content:center;cursor:pointer"
                         onclick="document.getElementById('transferDetailAttachmentInput').click()">
                        <i class="bi bi-plus-lg" style="font-size:1.5rem;color:#aaa"></i>
                    </div>`;

    const total = attachments.length + transferNewAttachments.length;
    container.innerHTML = total
        ? `<label class="fw-semibold small d-block mb-1"><i class="bi bi-paperclip me-1"></i>\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u044F</label>
           <div class="d-flex gap-2 flex-wrap align-items-center">${existingHtml}${newHtml}${addBtn}</div>
           <input type="file" id="transferDetailAttachmentInput" accept="image/*" multiple style="display:none" onchange="onTransferDetailAttachmentSelected(this)">
           ${transferDeletedAttachments.size ? `<div class="small mt-1 text-danger">${transferDeletedAttachments.size} \u043A \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044E</div>` : ''}`
        : `<label class="fw-semibold small d-block mb-1"><i class="bi bi-paperclip me-1"></i>\u0412\u043B\u043E\u0436\u0435\u043D\u0438\u044F</label>
           <div class="d-flex gap-2 flex-wrap align-items-center">${addBtn}</div>
           <input type="file" id="transferDetailAttachmentInput" accept="image/*" multiple style="display:none" onchange="onTransferDetailAttachmentSelected(this)">`;
}

function downloadTransferAttachment(attachmentGuid) {
    const taskGuid = currentTransferDoc.guid;
    window.open(`/api/warehouse/stock-transfers/${taskGuid}/attachment/${attachmentGuid}`, '_blank');
}

function toggleDeleteTransferAttachment(guid) {
    if (transferDeletedAttachments.has(guid)) {
        transferDeletedAttachments.delete(guid);
    } else {
        transferDeletedAttachments.add(guid);
    }
    renderTransferDetailAttachments();
}

async function onTransferDetailAttachmentSelected(input) {
    const files = input.files;
    if (!files || !files.length) return;
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        try {
            const base64 = await compressImage(file, 1920, 0.7);
            transferNewAttachments.push({data: base64, extension: 'jpg', filename: file.name});
            renderTransferDetailAttachments();
        } catch (e) {
            console.error('Image compression failed', e);
        }
    }
    input.value = '';
}

function removeNewTransferAttachment(idx) {
    transferNewAttachments.splice(idx, 1);
    renderTransferDetailAttachments();
}

function saveTransferChanges() {
    if (!currentTransferDoc) return;
    const taskGuid = currentTransferDoc.guid;
    const promises = [];

    for (const [guid, amount] of Object.entries(transferChangedAmounts)) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/amount', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({guid, task_guid: taskGuid, amount}),
            }).then(checkAuth).then(r => r.json())
        );
    }

    const comment = document.getElementById('transferDetailNewComment')?.value?.trim();
    if (comment) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/comment', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({task_guid: taskGuid, comment}),
            }).then(checkAuth).then(r => r.json())
        );
    }

    for (const attGuid of transferDeletedAttachments) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/attachments', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({task_guid: taskGuid, attachment_guid: attGuid}),
            }).then(checkAuth).then(r => r.json())
        );
    }

    if (transferNewAttachments.length) {
        promises.push(
            fetch('/api/warehouse/stock-transfers/attachments', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    task_guid: taskGuid,
                    attachments: transferNewAttachments.map(a => ({
                        data: a.data,
                        extension: a.extension,
                        filename: a.filename || ('photo.' + a.extension),
                    })),
                }),
            }).then(checkAuth).then(r => r.json())
        );
    }

    if (promises.length === 0) {
        showAlert('\u041D\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439 \u0434\u043B\u044F \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F', 'info');
        return;
    }

    const loading = document.getElementById('transferDetailLoading');
    const footer = document.querySelector('#transferDetailModal .modal-footer');
    loading.classList.remove('d-none');
    footer.querySelectorAll('button').forEach(b => b.disabled = true);

    Promise.all(promises)
        .then(results => {
            const errors = results.filter(r => r && !r.success && r.error);
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            if (errors.length) {
                showAlert('\u041E\u0448\u0438\u0431\u043A\u0438: ' + errors.map(e => e.error).join('; '), 'danger');
            } else {
                showAlert('\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E', 'success');
                bootstrap.Modal.getInstance(document.getElementById('transferDetailModal'))?.hide();
                loadTransfers();
            }
        })
        .catch(err => {
            loading.classList.add('d-none');
            footer.querySelectorAll('button').forEach(b => b.disabled = false);
            showAlert('\u041E\u0448\u0438\u0431\u043A\u0430: ' + err.message, 'danger');
        });
}

document.getElementById('createTransferModal')?.addEventListener('change', function(e) {
    if (e.target.id === 'transferSource') {
        const pick = document.getElementById('transferStoragePick');
        if (pick) pick.value = e.target.value;
        loadTransferProducts();
    }
});

document.querySelector('#warehouseTabs [data-bs-target="#wh-transfers"]')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('storageSelect');
    const opts = sel ? sel.innerHTML : '';
    if (opts && opts.includes('<option')) {
        document.getElementById('transferSource').innerHTML = opts;
        document.getElementById('transferDest').innerHTML = opts;
        document.getElementById('transferStoragePick').innerHTML = opts;
    }
    loadTransfers();
});

document.querySelector('#warehouseTabs [data-bs-target="#wh-balances"]')?.addEventListener('shown.bs.tab', () => {
    const sel = document.getElementById('storageSelect');
    if (sel && sel.options.length <= 1) loadStorages();
});
