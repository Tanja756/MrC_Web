const inflight = new Map();
const reqCache = new Map();

// localStorage cache helpers (persistent across page reloads)
const _LC_PREFIX = 'fc:';
function _lsHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return (h >>> 0).toString(36);
}
function _lsKey(raw) { return _LC_PREFIX + _lsHash(raw); }
function _lsCGet(key) {
  try { const v = localStorage.getItem(_lsKey(key)); return v ? JSON.parse(v) : null; } catch { return null; }
}
function _lsCSet(key, data, ts) {
  try { localStorage.setItem(_lsKey(key), JSON.stringify({data, ts, _k: key})); } catch {}
}
function _lsCDel(key) {
  try { localStorage.removeItem(_lsKey(key)); } catch {}
}
function _lsCClearPrefix(prefix) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_LC_PREFIX)) {
        try {
          const v = JSON.parse(localStorage.getItem(k));
          if (v && v._k && v._k.startsWith(prefix)) localStorage.removeItem(k);
        } catch { localStorage.removeItem(k); }
      }
    }
  } catch {}
}

function fetchDeduped(url, options, ttl) {
  const key = url + (options ? JSON.stringify(options) : '');
  if (inflight.has(key)) return inflight.get(key);

  if (ttl) {
    const mem = reqCache.get(key);
    if (mem && Date.now() - mem.ts < ttl) return Promise.resolve(mem.data);
    reqCache.delete(key);

    const ls = _lsCGet(key);
    if (ls && Date.now() - ls.ts < ttl) {
      reqCache.set(key, {data: ls.data, ts: ls.ts});
      return Promise.resolve(ls.data);
    }
    _lsCDel(key);
  }

  const p = fetch(url, options).then(r => {
    inflight.delete(key);
    if (r.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.includes('json') && ttl) {
      return r.clone().json().then(data => {
        const ts = Date.now();
        reqCache.set(key, {data, ts});
        _lsCSet(key, data, ts);
        return data;
      });
    }
    return r;
  }).catch(e => {
    inflight.delete(key);
    throw e;
  });
  inflight.set(key, p);
  return p;
}

function cacheDel(key) {
  reqCache.delete(key);
  _lsCDel(key);
}

function cacheClearPrefix(prefix) {
  for (const k of reqCache.keys()) { if (k.startsWith(prefix)) reqCache.delete(k); }
  _lsCClearPrefix(prefix);
}

const currentStorage = () => document.getElementById('storageSelect')?.value || '';

let _alertModalInstance = null;
function showAlert(message, type) {
    type = type || 'info';
    const modalEl = document.getElementById('alertModal');
    const header = document.getElementById('alertModalHeader');
    const title = document.getElementById('alertModalTitle');
    const body = document.getElementById('alertModalBody');

    header.className = 'modal-header';
    if (type === 'danger') {
        header.classList.add('bg-danger', 'text-white');
        title.innerHTML = '<i class="bi bi-x-circle me-2"></i>Ошибка';
    } else if (type === 'success') {
        header.classList.add('bg-success', 'text-white');
        title.innerHTML = '<i class="bi bi-check-circle me-2"></i>Успех';
    } else if (type === 'warning') {
        header.classList.add('bg-warning');
        title.innerHTML = '<i class="bi bi-exclamation-triangle me-2"></i>Предупреждение';
    } else {
        title.innerHTML = '<i class="bi bi-info-circle me-2"></i>Сообщение';
    }

    body.textContent = message;
    if (!_alertModalInstance) {
        _alertModalInstance = new bootstrap.Modal(modalEl, {});
    }
    _alertModalInstance.show();
}

function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 5000;
    var container = document.getElementById('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast-item toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () { toast.classList.add('toast-show'); }, 10);
    setTimeout(function () {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
        setTimeout(function () { toast.remove(); }, 300);
    }, duration);
}

function showConfirm(message) {
    return new Promise(resolve => {
        const modalEl = document.getElementById('confirmModal');
        const body = document.getElementById('confirmModalBody');
        const yesBtn = document.getElementById('confirmModalYes');
        const noBtn = document.getElementById('confirmModalNo');

        body.textContent = message;

        const modal = new bootstrap.Modal(modalEl);

        const cleanup = () => {
            modal.hide();
            modalEl.removeEventListener('hidden.bs.modal', onHide);
            yesBtn.removeEventListener('click', onYes);
            noBtn.removeEventListener('click', onNo);
        };

        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };
        const onHide = () => { cleanup(); resolve(false); };

        modalEl.addEventListener('hidden.bs.modal', onHide);
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);

        modal.show();
    });
}

function toggleFilter(el) {
    el.closest('.filter-bar').classList.toggle('show');
}

function toggleDocSection(header) {
    const section = header.closest('.doc-section');
    const allSections = section.parentElement.querySelectorAll('.doc-section');
    const wasHidden = header.nextElementSibling.classList.contains('d-none');

    allSections.forEach(s => {
        if (s === section) return;
        const body = s.querySelector('.doc-section-body');
        if (!body.classList.contains('d-none')) {
            body.classList.add('d-none');
            const icon = s.querySelector('.doc-section-header .bi');
            if (icon) icon.className = 'bi bi-chevron-down ms-auto';
        }
    });

    header.nextElementSibling.classList.toggle('d-none');
    const icon = header.querySelector('.bi');
    icon.className = 'bi bi-chevron-' + (wasHidden ? 'up' : 'down') + ' ms-auto';
}

function parseDate(str) {
    if (!str) return null;
    const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]);

    const m2 = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) return new Date(+m2[3], +m2[2]-1, +m2[1]);

    const m3 = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3], +m3[4], +m3[5], +m3[6]);

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
}

function formatDate(str) {
    const d = parseDate(str);
    if (!d) return '\u2014';
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = String(d.getFullYear()).slice(-2);
    const hh = String(d.getHours()).padStart(2,'0');
    const mi = String(d.getMinutes()).padStart(2,'0');
    return `${dd}.${mm}.${yy} ${hh}:${mi}`;
}

function formatDateShort(str) {
    const d = parseDate(str);
    if (!d) return '\u2014';
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
}

function formatHours(hours) {
    if (hours == null || isNaN(hours)) return '\u2014';
    if (hours < 0) return '0 \u0447';
    if (hours < 1) return `${Math.round(hours * 60)} \u043C\u0438\u043D`;
    if (hours < 24) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        return m > 0 ? `${h} \u0447 ${m} \u043C\u0438\u043D` : `${h} \u0447`;
    }
    const days = Math.floor(hours / 24);
    const remain = hours - days * 24;
    const h = Math.floor(remain);
    const m = Math.round((remain - h) * 60);
    let result = `${days} \u0434\u043D`;
    if (h > 0) result += ` ${h} \u0447`;
    if (m > 0) result += ` ${m} \u043C\u0438\u043D`;
    return result;
}

function formatComments(comments) {
    if (!comments || !comments.length) return '<p class="mb-0 text-muted">\u2014</p>';
    return comments.map(c =>
        `<div class="mb-2 p-2 bg-light rounded-3"><small class="text-muted d-block">${c.author || ''} \u2014 ${formatDate(c.date) || ''}</small><p class="mb-0">${c.content || ''}</p></div>`
    ).join('');
}

function lsGet(key, def) {
    try { return localStorage.getItem(key) ?? def; } catch { return def; }
}
function lsGetJSON(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch {}
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u043E';
    if (mins < 60) return `${mins} \u043C\u0438\u043D \u043D\u0430\u0437\u0430\u0434`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} \u0447 \u043D\u0430\u0437\u0430\u0434`;
    const days = Math.floor(hours / 24);
    if (days === 1) return '\u0432\u0447\u0435\u0440\u0430';
    return `${days} \u0434 \u043D\u0430\u0437\u0430\u0434`;
}

function checkAuth(r) {
    if (r.status === 401) {
        window.location.href = '/login';
        throw new Error('Session expired');
    }
    return r;
}

function cleanNumber(num) {
    if (!num) return '';
    return num.replace(/^0+/, '') || '0';
}

function clientName(guid) {
    return clientsMap[guid] || guid || '\u2014';
}

function getFilenameFromHeaders(headers, fallback) {
    const cd = headers.get('Content-Disposition');
    if (cd) {
        const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (m) return decodeURIComponent(m[1]);
    }
    return fallback;
}

function downloadMultiple(fetches, onProgress) {
    return Promise.all(fetches.map((p, i) =>
        p.then(({blob, filename}) => {
            if (onProgress) onProgress(i + 1, fetches.length);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        })
    ));
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const uint8Array = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        uint8Array[i] = rawData.charCodeAt(i);
    }
    return uint8Array;
}

function isWorkingHours() {
    const h = new Date().getHours();
    return h >= 7 && h < 23;
}

let taskPriorityMap = {};

function fetchPriorities() {
    fetch('/api/priorities', {cache: 'no-cache'})
        .then(r => r.json())
        .then(data => {
            if (Array.isArray(data)) {
                taskPriorityMap = {};
                data.forEach(p => { if (p.value != null) taskPriorityMap[p.value] = p.name; });
            }
        })
        .catch(() => {});
}
