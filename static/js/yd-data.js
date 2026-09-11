// ============================================================
// yd-data.js — локальные данные офлайн-моста (Фаза 2.3)
// ------------------------------------------------------------
// Хранит дампы сервера (/{username}/*.json.gz) в IndexedDB и
// при недоступности офисного сервера отдаёт их страницам для
// рендера. Обновление — дельтой по hashes.json (как воркер
// синхронизации). Если «Синхронизация данных» выключена —
// мост сообщает об этом в баннере и блокирует исходящие
// действия (outbox, Фаза 2.4).
// Имена дампов ровно те, что пишет сервер.
// ============================================================

const YDData = (function () {
    'use strict';

    const DUMP_NAMES = {
        my: 'tasks_user.json.gz',
        free: 'tasks_free.json.gz',
        closed: 'tasks_closed.json.gz',
        warehouse: 'warehouse.json.gz',
        references: 'references.json.gz',
        ppr: 'ppr_list.json.gz',
        fn_schedule: 'fn_schedule.json.gz',
        task_m15: 'task_m15.json.gz'
    };
    const HASHES_TTL = 5 * 60 * 1000;   // hashes.json перекачиваем не чаще
    const SYNC_TIMEOUT = 12000;         // потолок одной сетевой операции офлайн-режима

    let _hashes = null;
    let _hashesAt = 0;
    let _mem = {};         // запасное хранилище (нет IndexedDB / тесты)
    let _dbPromise = null;

    function lsGet(key, def) { try { return localStorage.getItem(key) ?? def; } catch (e) { return def; } }

    // Мост включён: настройка «Синхронизация данных» + токен уже на устройстве
    function isBridgeEnabled() {
        return typeof YD !== 'undefined' &&
            lsGet('yandexSyncData', 'true') === 'true' &&
            YD.isConfigured();
    }

    // Разрешено ли ставить исходящие действия в {username}/Action/ (Фаза 2.4)
    function canSyncOutbox() {
        return isBridgeEnabled();
    }

    // ============ ХРАНИЛИЩЕ (IndexedDB, fallback — память) ============
    function idb() {
        if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no indexedDB'));
        if (!_dbPromise) {
            _dbPromise = new Promise(function (resolve, reject) {
                const req = indexedDB.open('mrc-yd', 2);
                req.onupgradeneeded = function () {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('dumps')) {
                        db.createObjectStore('dumps', { keyPath: 'name' });
                    }
                    if (!db.objectStoreNames.contains('outbox')) {
                        // стор офлайн-очереди действий (Фаза 2.4, yd-outbox.js)
                        db.createObjectStore('outbox', { keyPath: 'id' });
                    }
                };
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { reject(req.error); };
            }).catch(function (e) { _dbPromise = null; throw e; });
        }
        return _dbPromise;
    }

    function storeGet(name) {
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const rq = db.transaction('dumps', 'readonly').objectStore('dumps').get(name);
                rq.onsuccess = function () { resolve(rq.result || null); };
                rq.onerror = function () { reject(rq.error); };
            });
        }).catch(function () { return _mem[name] || null; });
    }

    function storePut(rec) {
        _mem[rec.name] = rec;
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const tx = db.transaction('dumps', 'readwrite');
                tx.objectStore('dumps').put(rec);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () { return true; }); // память уже обновлена
    }

    function loadLocal(names) {
        return Promise.all(names.map(storeGet)).then(function (recs) {
            const out = {};
            recs.filter(Boolean).forEach(function (rec) { out[rec.name] = rec; });
            return out;
        });
    }

    // ==================== ДЕЛЬТА ПО hashes.json ====================
    function withTimeout(p, ms, tag) {
        return Promise.race([
            p,
            new Promise(function (_, rej) { setTimeout(function () { rej(new Error(tag + ': timeout')); }, ms); })
        ]);
    }

    function getHashes() {
        if (_hashes && Date.now() - _hashesAt < HASHES_TTL) return Promise.resolve(_hashes);
        return withTimeout(YD.downloadJson('hashes.json'), SYNC_TIMEOUT, 'hashes').then(function (h) {
            _hashes = (h && typeof h === 'object') ? h : {};
            _hashesAt = Date.now();
            return _hashes;
        });
    }

    // Скачивает только изменённые дампы (сравнение с hashes.json сервера).
    // Возвращает {имя: {name, data, hash, modified, fetchedAt}}.
    function syncDumps(names) {
        if (!isBridgeEnabled()) return Promise.reject(new Error('Офлайн-мост отключён'));
        names = names.slice();
        return getHashes().then(function (hashes) {
            return Promise.all(names.map(function (name) {
                return storeGet(name).then(function (stored) {
                    // дельта: хеш совпал — сетевой загрузки нет
                    if (stored && stored.hash && hashes[name] && stored.hash === hashes[name]) return stored;
                    return withTimeout(YD.downloadJson(name), SYNC_TIMEOUT, name).then(function (data) {
                        const rec = { name: name, data: data, hash: hashes[name] || '', modified: '', fetchedAt: Date.now() };
                        return storePut(rec).then(function () { return rec; });
                    }).catch(function () { return stored; }); // не скачался — берём что есть
                });
            }));
        }).then(function (recs) {
            // modified-времена дампов — для индикатора свежести
            return YD.getDumpFreshness().then(function (fresh) {
                return Promise.all(recs.filter(Boolean).map(function (rec) {
                    if (!fresh[rec.name]) return rec;
                    rec.modified = fresh[rec.name];
                    return storePut(rec).then(function () { return rec; });
                }));
            }).catch(function () { return recs; });
        }).then(function (recs) {
            const out = {};
            recs.filter(Boolean).forEach(function (rec) { out[rec.name] = rec; });
            return out;
        });
    }

    // ============ ИНДИКАТОР СВЕЖЕСТИ (баннер офлайна) ============
    function fmtFresh(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    // Обновляет текст офлайн-баннера: откуда данные и насколько они свежие.
    function updateOfflineBanner(names) {
        const banner = document.getElementById('offlineBanner');
        if (!banner) return Promise.resolve({});
        names = names || [DUMP_NAMES.my, DUMP_NAMES.free, DUMP_NAMES.closed];
        if (typeof isServerOnline !== 'undefined' && isServerOnline) return Promise.resolve({});
        return loadLocal(names).then(function (out) {
            let latest = '';
            names.forEach(function (n) {
                const r = out[n];
                if (r && r.modified && (!latest || r.modified > latest)) latest = r.modified;
            });
            if (!isBridgeEnabled()) {
                banner.innerHTML = '<i class="bi bi-wifi-off me-1"></i>Нет соединения с сервером. Офлайн-режим через Яндекс.Диск отключён настройкой «Синхронизация данных».';
            } else if (latest) {
                banner.innerHTML = '<i class="bi bi-cloud-check me-1"></i>Нет соединения с сервером. Показаны данные из Яндекс.Диска, актуальны на ' + fmtFresh(latest) + '.';
            } else {
                banner.innerHTML = '<i class="bi bi-wifi-off me-1"></i>Нет соединения с сервером. Показываются кешированные данные.';
            }
            return out;
        });
    }

    return {
        DUMP_NAMES: DUMP_NAMES,
        isBridgeEnabled: isBridgeEnabled,
        canSyncOutbox: canSyncOutbox,
        syncDumps: syncDumps,
        loadLocal: loadLocal,
        updateOfflineBanner: updateOfflineBanner
    };
})();
