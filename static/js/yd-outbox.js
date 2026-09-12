// ============================================================
// yd-outbox.js — офлайн-очередь действий (Фаза 2.4)
// ------------------------------------------------------------
// Действия пользователя (взять/закрыть/отклонить/вернуть),
// совершённые без связи с сервером, ставятся в IndexedDB-очередь
// и выгружаются на Яндекс.Диск в {username}/Action/ (гейт —
// YDData.canSyncOutbox()). Офисный сервер (routes/helpers.py)
// разбирает Action-файлы, выполняет их в 1С и сразу переливает
// свежие дампы. Клиент по исчезновению файла понимает, что
// действие выполнено, уведомляет и перечитывает дампы.
// Жизненный цикл файла на сервере: .json → .processing →
// (удалён = успех | .error = сбой 1С).
// Имя файла генерируется ОДИН раз при постановке в очередь и
// хранится в записи — повторные отправки не плодят дубликаты.
// ============================================================

const YDOutbox = (function () {
    'use strict';

    const DB_NAME = 'mrc-yd';
    const DB_VERSION = 2;              // синхронно с yd-data.js
    const STORE = 'outbox';
    const TICK_INTERVAL = 90 * 1000;   // автоповтор при возврате связи

    let _dbPromise = null;
    let _mem = [];                     // запасное хранилище (нет IndexedDB / тесты)
    let _started = false;
    let _items = [];                   // кеш записей для UI
    let _ticking = false;

    // ============ ХРАНИЛИЩЕ (IndexedDB, fallback — память) ============
    function idb() {
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no indexedDB'));
        if (!_dbPromise) {
            _dbPromise = new Promise(function (resolve, reject) {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = function () {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('dumps')) db.createObjectStore('dumps', { keyPath: 'name' });
                    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
                };
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            }).catch(function (e) { _dbPromise = null; throw e; });
        }
        return _dbPromise;
    }

    function dbAll() {
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
                rq.onsuccess = function () { resolve(rq.result || []); };
                rq.onerror = function () { reject(rq.error); };
            });
        }).catch(function () { return _mem.slice(); });
    }

    function dbPut(rec) {
        const i = _mem.findIndex(function (r) { return r.id === rec.id; });
        if (i >= 0) _mem[i] = rec; else _mem.push(rec);
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(rec);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () { return true; });
    }

    function dbDel(id) {
        _mem = _mem.filter(function (r) { return r.id !== id; });
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).delete(id);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () { return true; });
    }

    // ============ СОСТОЯНИЕ ============
    function available() {
        return typeof YD !== 'undefined' && typeof YDData !== 'undefined' && YDData.canSyncOutbox();
    }

    function counts() {
        const c = { queued: 0, sent: 0, error: 0, total: _items.length };
        _items.forEach(function (r) { if (c[r.status] != null) c[r.status]++; });
        return c;
    }

    // ============ ПОСТАНОВКА В ОЧЕРЕДЬ ============
    function enqueue(action, payload, label) {
        if (!available()) {
            return Promise.reject(new Error('Офлайн-очередь недоступна: выключена «Синхронизация данных» или нет токена Яндекс.Диска'));
        }
        const id = action + '_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
        const rec = {
            id: id,
            action: action,
            file: id + '.json',
            payload: Object.assign({ action: action, created_at: new Date().toISOString() }, payload || {}),
            label: label || action,
            status: 'queued',
            createdAt: Date.now(),
            sentAt: 0,
            attempts: 0,
            lastError: ''
        };
        return dbPut(rec).then(function () {
            updateBadge();
            setTimeout(function () { tick(); }, 400);
            return rec;
        });
    }

    // ============ ОТПРАВКА ============
    function flushQueued(items) {
        let p = Promise.resolve();
        items.filter(function (r) { return r.status === 'queued'; }).forEach(function (rec) {
            p = p.then(function () {
                return YD.uploadJson('Action/' + rec.file, rec.payload).then(function () {
                    rec.status = 'sent'; rec.sentAt = Date.now(); rec.attempts++; rec.lastError = '';
                    return dbPut(rec);
                }).catch(function (e) {
                    rec.attempts++; rec.lastError = (e && e.message) || 'Ошибка отправки на Диск';
                    return dbPut(rec);
                });
            });
        });
        return p;
    }

    // ============ СТАТУСЫ (снимок папки Action) ============
    function refreshStatuses(items) {
        const sent = items.filter(function (r) { return r.status === 'sent'; });
        if (!sent.length) return Promise.resolve();
        return YD.getActionStatuses().then(function (st) {
            const jobs = [];
            sent.forEach(function (rec) {
                const s = st[rec.id];
                if (s === 'error') {
                    rec.status = 'error';
                    rec.lastError = '1С не смогла выполнить действие — проверьте заявку и повторите';
                    jobs.push(dbPut(rec).then(function () { notifyError(rec); }));
                } else if (!s) {
                    // файл исчез — сервер обработал действие успешно
                    jobs.push(dbDel(rec.id).then(function () { notifyDone(rec); refreshDumps(); }));
                }
                // 'pending'/'processing' — просто ждём следующего тика
            });
            return Promise.all(jobs);
        });
    }

    // После успеха воркер сервера форсит перелив дампов — перечитываем,
    // чтобы оптимистичные сдвиги UI заменились реальным состоянием 1С
    function refreshDumps() {
        if (typeof YDData === 'undefined') return;
        const N = YDData.DUMP_NAMES;
        YDData.syncDumps([N.my, N.free, N.closed])
            .then(function () {
                if (typeof loadTasks === 'function' && typeof isServerOnline !== 'undefined' && !isServerOnline) loadTasks();
            })
            .catch(function () {});
    }

    function tick() {
        if (_ticking || !available()) return Promise.resolve();
        _ticking = true;
        return dbAll().then(function (items) {
            _items = items;
            return flushQueued(items);
        }).then(function () {
            return dbAll().then(function (items) {
                _items = items;
                return refreshStatuses(items);
            });
        })
        .catch(function () {})
        .then(function () { _ticking = false; updateBadge(); });
    }

    function start() {
        if (_started) return;
        _started = true;
        setTimeout(tick, 2500);
        setInterval(tick, TICK_INTERVAL);
        // автоповтор при возврате связи
        window.addEventListener('online', function () { setTimeout(tick, 3000); });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') setTimeout(tick, 1500);
        });
    }

    // ============ РУЧНЫЕ ДЕЙСТВИЯ С ОШИБАМИ ============
    // Повторить после сбоя 1С: подчищаем .error и ставим файл заново
    function retry(id) {
        return dbAll().then(function (items) {
            const rec = items.find(function (r) { return r.id === id; });
            if (!rec) return false;
            return YD.deleteFile('Action/' + id + '.error').catch(function () {}).then(function () {
                rec.status = 'queued';
                rec.lastError = '';
                return dbPut(rec).then(function () { setTimeout(function () { tick(); }, 300); return true; });
            });
        });
    }

    // Убрать сбойную запись из очереди (файл .error на Диске тоже чистим)
    function dismiss(id) {
        return YD.deleteFile('Action/' + id + '.error').catch(function () {}).then(function () {
            return dbDel(id).then(function () {
                _items = _items.filter(function (r) { return r.id !== id; });
                updateBadge();
                return true;
            });
        });
    }

    // ============ УВЕДОМЛЕНИЯ ============
    function notifyDone(rec) {
        if (typeof NotificationCenter !== 'undefined') {
            NotificationCenter.show({ icon: 'success', title: rec.label || 'Офлайн-действие', subtitle: 'Выполнено: сервер обработал действие', actions: ['OK'], duration: 6000 });
        }
    }

    function notifyError(rec) {
        if (typeof NotificationCenter !== 'undefined') {
            NotificationCenter.show({ icon: 'error', title: (rec.label || 'Офлайн-действие') + ' — ошибка', subtitle: rec.lastError || 'Сервер не смог выполнить действие', actions: ['OK'], duration: 8000 });
        }
    }

    // ============ UI: бейдж + список очереди ============
    function fmtTime(ts) {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        const p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function esc(s) {
        return String(s || '').replace(/[&<>"']/g, function (ch) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
        });
    }

    function updateBadge() {
        const c = counts();
        let badge = document.getElementById('outboxBadge');
        if (!c.total) { if (badge) badge.remove(); return; }
        if (!badge) {
            badge = document.createElement('button');
            badge.id = 'outboxBadge';
            badge.type = 'button';
            badge.style.cssText = 'left:12px;bottom:76px;z-index:1030;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.35);';
            badge.addEventListener('click', showOutboxModal);
            document.body.appendChild(badge);
        }
        let cls = 'btn-warning', txt = 'В очереди: ' + c.queued;
        if (c.error) { cls = 'btn-danger'; txt = 'Ошибки: ' + c.error; }
        else if (c.sent) { cls = 'btn-primary'; txt = 'Отправлено: ' + c.sent; }
        badge.className = 'btn btn-sm position-fixed ' + cls;
        badge.innerHTML = '<i class="bi bi-cloud-arrow-up me-1"></i>' + txt;
        badge.title = 'Офлайн-очередь действий (Яндекс.Диск)';
    }

    function statusView(rec) {
        if (rec.status === 'error') return ['text-danger', 'bi-x-octagon', 'Ошибка 1С'];
        if (rec.status === 'sent') {
            if (rec.lastError) return ['text-warning', 'bi-arrow-repeat', 'Ошибка отправки — повторим автоматически'];
            // Диагностика «заявка не закрылась»: файл лежит на Диске, но воркер
            // офисного сервера его не обрабатывает дольше 15 минут
            if (rec.sentAt && Date.now() - rec.sentAt > 15 * 60 * 1000) {
                return ['text-warning', 'bi-hourglass-split', 'Отправлено, но сервер не обрабатывает дольше 15 минут — проверьте рабочий сервер (логи «Yandex Action», токен Я.Диска, «Синхронизация данных»)'];
            }
            return ['text-primary', 'bi-cloud-arrow-up', 'Отправлено — сервер обрабатывает'];
        }
        return ['text-warning', 'bi-hourglass-split', 'В очереди — отправится при появлении связи'];
    }

    function showOutboxModal() {
        if (typeof bootstrap === 'undefined') return;
        const old = document.getElementById('outboxModal');
        if (old) { bootstrap.Modal.getInstance(old)?.dispose(); old.remove(); }
        const rows = _items.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).map(function (r) {
            const sv = statusView(r);
            const controls = r.status === 'error'
                ? '<button class="btn btn-sm btn-outline-primary" data-ob-retry="' + r.id + '">Повторить</button>' +
                  '<button class="btn btn-sm btn-outline-danger" data-ob-dismiss="' + r.id + '">Убрать</button>'
                : '';
            return '<div class="d-flex align-items-start justify-content-between border-bottom py-2 gap-2">' +
                '<div class="small flex-grow-1">' +
                    '<div class="fw-semibold">' + esc(r.label) + '</div>' +
                    '<div class="text-muted"><i class="bi ' + sv[1] + ' me-1"></i><span class="' + sv[0] + '">' + sv[2] + '</span> · ' + fmtTime(r.createdAt) + '</div>' +
                    (r.status === 'error' && r.lastError ? '<div class="text-danger">' + esc(r.lastError) + '</div>' : '') +
                '</div>' +
                '<div class="d-flex gap-1 flex-shrink-0">' + controls + '</div>' +
            '</div>';
        }).join('');
        const div = document.createElement('div');
        div.id = 'outboxModal';
        div.className = 'modal fade';
        div.innerHTML = '<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">' +
            '<div class="modal-content">' +
                '<div class="modal-header"><h6 class="modal-title"><i class="bi bi-cloud-arrow-up me-2"></i>Офлайн-очередь действий</h6>' +
                '<button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
                '<div class="modal-body">' + (rows || '<div class="text-muted small">Очередь пуста</div>') + '</div>' +
                '<div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button></div>' +
            '</div></div>';
        document.body.appendChild(div);
        div.querySelectorAll('[data-ob-retry]').forEach(function (b) {
            b.addEventListener('click', function () { retry(b.getAttribute('data-ob-retry')).then(function () { showOutboxModal(); }); });
        });
        div.querySelectorAll('[data-ob-dismiss]').forEach(function (b) {
            b.addEventListener('click', function () { dismiss(b.getAttribute('data-ob-dismiss')).then(function () { showOutboxModal(); }); });
        });
        const m = new bootstrap.Modal(div);
        div.addEventListener('hidden.bs.modal', function () { m.dispose(); div.remove(); updateBadge(); });
        m.show();
    }

    return {
        available: available,
        enqueue: enqueue,
        tick: tick,
        start: start,
        retry: retry,
        dismiss: dismiss,
        show: showOutboxModal,
        getItems: function () { return _items.slice(); },
        counts: counts,
        updateBadge: updateBadge
    };
})();
