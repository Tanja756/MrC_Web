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
    setServerOnline();
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
    setServerOffline();
    if (e && (!e.message || !e.message.includes('Session expired'))) {
        var msg = e && e.message ? e.message : 'Неизвестная ошибка';
        NotificationCenter.show({ icon: 'error', title: 'Ошибка сети', subtitle: msg.length > 120 ? msg.slice(0, 120) + '...' : msg, actions: ['OK'], duration: 6000 });
    }
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

// ============ SERVER CONNECTIVITY ============
let isServerOnline = true;
let _pingTimer = null;
let _offlineBanner = null;

function ensureOfflineBanner() {
  if (_offlineBanner) return;
  _offlineBanner = document.createElement('div');
  _offlineBanner.id = 'offlineBanner';
  _offlineBanner.className = 'offline-banner';
  _offlineBanner.style.display = 'none';
  _offlineBanner.innerHTML = '<i class="bi bi-wifi-off me-1"></i>Нет соединения с сервером. Показываются кешированные данные.';
  document.body.insertBefore(_offlineBanner, document.body.firstChild);
}

function setServerOnline() {
  if (isServerOnline) return;
  isServerOnline = true;
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  if (_offlineBanner) _offlineBanner.style.display = 'none';
  cacheClearPrefix('/api/tasks/');
  cacheClearPrefix('/api/notifications');
  cacheDel('/api/profile');
  if (typeof refreshOnReconnect === 'function') refreshOnReconnect();
  NotificationCenter.show({ icon: 'success', title: 'Соединение восстановлено', actions: ['OK'], duration: 4000 });
}

function setServerOffline() {
  if (!isServerOnline) return;
  isServerOnline = false;
  ensureOfflineBanner();
  _offlineBanner.style.display = '';
  if (!_pingTimer) {
    _pingTimer = setInterval(() => {
      fetch('/api/ping', {cache: 'no-store'})
        .then(r => { if (r.ok) setServerOnline(); })
        .catch(() => {});
    }, 30000);
  }
}

// ============ REFRESH ON RECONNECT (overridden by page scripts) ============
let refreshOnReconnect = function() {};

const currentStorage = () => document.getElementById('storageSelect')?.value || '';

// Modal stack for nested modal support
let _modalStack = [];

function showModalStacked(elementOrId, showFn) {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return;
    const openEl = document.querySelector('.modal.show');
    if (openEl && openEl !== el) {
        const inst = bootstrap.Modal.getInstance(openEl);
        if (inst) {
            _modalStack.push(inst);
            inst.hide();
        }
    }
    const doShow = () => { if (showFn) showFn(); };
    if (openEl) {
        openEl.addEventListener('hidden.bs.modal', () => doShow(), { once: true });
    } else {
        doShow();
    }
    const onHidden = () => {
        el.removeEventListener('hidden.bs.modal', onHidden);
        if (_modalStack.length > 0) {
            const prev = _modalStack.pop();
            if (prev) prev.show();
        }
    };
    el.addEventListener('hidden.bs.modal', onHidden);
}

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
    showModalStacked('alertModal', () => {
        if (!_alertModalInstance) {
            _alertModalInstance = new bootstrap.Modal(modalEl, {});
        }
        _alertModalInstance.show();
    });
}

// ============ NOTIFICATION CENTER ============
window.NotificationCenter = (function() {
    var items = [];
    var itemsToKill = [];
    var killTimeout = null;
    var block = 'notification';

    function show(opts) {
        opts = opts || {};
        var id = 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        var duration = opts.duration != null ? opts.duration : 8000;

        var note = new NotificationItem(id, opts);
        note.el.style.transform = 'translateY(' + (100 * items.length) + '%)';
        items.push(note);

        if (duration > 0) {
            setTimeout(function() { kill(id); }, duration);
        }
        return id;
    }

    function kill(id) {
        var idx = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;
        var note = items[idx];
        if (note.el.classList.contains(block + '--out')) return;

        note.el.classList.add(block + '--out');
        itemsToKill.push(note);

        clearTimeout(killTimeout);
        killTimeout = setTimeout(function() {
            for (var k = 0; k < itemsToKill.length; k++) {
                var n = itemsToKill[k];
                if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
                var li = items.indexOf(n);
                if (li !== -1) items.splice(li, 1);
            }
            itemsToKill = [];
            shiftItems();
        }, 300);
    }

    function shiftItems() {
        for (var i = 0; i < items.length; i++) {
            items[i].el.style.transform = 'translateY(' + (100 * i) + '%)';
        }
    }

    function NotificationItem(id, opts) {
        this.id = id;
        this.el = null;
        initItem(this, opts);
    }

    function initItem(self, opts) {
        var note = document.createElement('div');
        note.className = block;
        note.id = self.id;
        document.body.appendChild(note);

        var box = document.createElement('div');
        box.className = block + '__box';
        note.appendChild(box);

        var content = document.createElement('div');
        content.className = block + '__content';
        box.appendChild(content);

        var iconDiv = document.createElement('div');
        iconDiv.className = block + '__icon';
        content.appendChild(iconDiv);

        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', block + '__icon-svg');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', opts.icon || 'message');
        svg.setAttribute('width', '32px');
        svg.setAttribute('height', '32px');
        iconDiv.appendChild(svg);

        var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + (opts.icon || 'message'));
        svg.appendChild(use);

        var textDiv = document.createElement('div');
        textDiv.className = block + '__text';
        content.appendChild(textDiv);

        var titleEl = document.createElement('div');
        titleEl.className = block + '__text-title';
        titleEl.textContent = opts.title || '';
        textDiv.appendChild(titleEl);

        if (opts.subtitle) {
            var subEl = document.createElement('div');
            subEl.className = block + '__text-subtitle';
            subEl.textContent = opts.subtitle;
            textDiv.appendChild(subEl);
        }

        var btns = document.createElement('div');
        btns.className = block + '__btns';
        box.appendChild(btns);

        var actions = opts.actions || ['OK'];
        for (var a = 0; a < actions.length; a++) (function(action) {
            var btn = document.createElement('button');
            btn.className = block + '__btn';
            btn.type = 'button';

            var btnText = document.createElement('span');
            btnText.className = block + '__btn-text';
            btnText.textContent = action;

            btn.appendChild(btnText);
            btns.appendChild(btn);

            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                kill(self.id);
            });
        })(actions[a]);

        note.addEventListener('click', function() { kill(self.id); });

        self.el = note;
    }

    return { show: show };
})();

function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 5000;
    var iconMap = { info: 'message', warning: 'warning', success: 'success', danger: 'error' };
    var titleMap = { info: 'Информация', warning: 'Предупреждение', success: 'Готово', danger: 'Ошибка' };
    NotificationCenter.show({
        icon: iconMap[type] || 'message',
        title: titleMap[type] || 'Информация',
        subtitle: message,
        actions: ['OK'],
        duration: duration
    });
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

        showModalStacked('confirmModal', () => modal.show());
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
