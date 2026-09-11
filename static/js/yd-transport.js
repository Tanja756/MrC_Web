// ============================================================
// yd-transport.js — транспорт офлайн-моста «PWA ↔ Яндекс.Диск»
// ------------------------------------------------------------
// Сервер (в офисном интернете) выкладывает дампы в /{username}/
// и обрабатывает команды из /{username}/Action/. Клиент при
// недоступности сервера работает с Диском напрямую (CORS открыт,
// cloud-api отвечает Access-Control-Allow-Origin: origin).
// Токен выдаёт наш сервер: GET /api/yandex/token (только при
// онлайне и включённой настройке «Синхронизация данных»).
// Модель доступа: полный токен с сервера (решение по Фазе 2).
// ============================================================

const YD = (function () {
    'use strict';

    const DISK_API = 'https://cloud-api.yandex.net/v1/disk/resources';
    const TOKEN_TTL_MS = 24 * 3600 * 1000; // фоновое обновление токена раз в сутки

    let _token = null;
    let _basePath = '';
    let _fetchedAt = 0;

    function lsGet(key, def) { try { return localStorage.getItem(key) ?? def; } catch (e) { return def; } }
    function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
    function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

    function isConfigured() {
        return !!(lsGet('ydToken', '') && lsGet('ydBasePath', ''));
    }

    function clearCredentials() {
        _token = null; _basePath = ''; _fetchedAt = 0;
        lsDel('ydToken'); lsDel('ydBasePath'); lsDel('ydTokenAt');
    }

    // Запросить свежий access-токен у нашего сервера (нужен онлайн).
    // 403 = «Синхронизация данных» выключена — забываем сохранённый токен.
    function refreshTokenFromServer() {
        return fetch('/api/yandex/token', { cache: 'no-store' })
            .then(function (r) {
                if (r.status === 403) { clearCredentials(); return null; }
                if (!r.ok) return null;
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.accessToken) return false;
                _token = data.accessToken;
                _basePath = (data.basePath || '').replace(/^\/+|\/+$/g, '');
                _fetchedAt = Date.now();
                lsSet('ydToken', _token);
                lsSet('ydBasePath', _basePath);
                lsSet('ydTokenAt', String(_fetchedAt));
                return true;
            })
            .catch(function () { return false; });
    }

    function basePath() {
        if (!_basePath) _basePath = (lsGet('ydBasePath', '') || '').replace(/^\/+|\/+$/g, '');
        return _basePath;
    }

    function _fullPath(relPath) {
        const rel = String(relPath || '').replace(/^\/+|\/+$/g, '');
        return basePath() + (rel ? '/' + rel : '');
    }

    // Токен: память → localStorage; при устаревании — обновление с сервера.
    function ensureToken() {
        if (!_token) {
            _token = lsGet('ydToken', '') || null;
            _basePath = (lsGet('ydBasePath', '') || '').replace(/^\/+|\/+$/g, '');
            _fetchedAt = parseInt(lsGet('ydTokenAt', '0'), 10) || 0;
        }
        if (!isConfigured()) {
            return Promise.reject(new Error('Офлайн-мост не настроен: нет токена Яндекс.Диска (нужен хотя бы один запуск приложения при рабочем интернете)'));
        }
        if (Date.now() - _fetchedAt > TOKEN_TTL_MS && typeof isServerOnline !== 'undefined' && isServerOnline) {
            return refreshTokenFromServer().then(function (ok) {
                if (!ok) throw new Error('Не удалось обновить токен Яндекс.Диска');
                return _token;
            });
        }
        return Promise.resolve(_token);
    }

    function _apiOnce(method, url, params) {
        let full = url;
        if (params) {
            const qs = new URLSearchParams(params).toString();
            if (qs) full += (full.indexOf('?') >= 0 ? '&' : '?') + qs;
        }
        return fetch(full, { method: method, headers: { 'Authorization': 'OAuth ' + _token } });
    }

    // Вызов cloud-api с одним автоповтором при 401 (перевыпуск токена с сервера)
    function _api(method, url, params) {
        return ensureToken().then(function () {
            return _apiOnce(method, url, params);
        }).then(function (r) {
            if (r.status !== 401) return r;
            return refreshTokenFromServer().then(function (ok) {
                if (!ok) throw new Error('Токен Яндекс.Диска недействителен, обновить не удалось');
                return _apiOnce(method, url, params);
            });
        });
    }

    // --- gzip (дампы на Диске всегда .gz — как их пишет сервер) ---
    function gzipBytes(str) {
        if (typeof CompressionStream === 'undefined') {
            return Promise.reject(new Error('Браузер не поддерживает сжатие (CompressionStream)'));
        }
        try {
            const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
            return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
        } catch (e) { return Promise.reject(e); }
    }

    function gunzipText(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error('Браузер не поддерживает распаковку (DecompressionStream)'));
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
    }

    // ==================== ПАПКИ И ФАЙЛЫ ====================
    // Все пути относительные: 'tasks_user.json.gz', 'Action/...', 'Docs/...'

    function _list(relPath) {
        const p = _fullPath(relPath);
        return _api('GET', DISK_API, { path: p, limit: 200 }).then(function (r) {
            if (r.status === 404) return [];
            if (!r.ok) throw new Error('Yandex.Disk: list ' + p + ' \u2192 ' + r.status);
            return r.json().then(function (j) {
                const items = (j._embedded && j._embedded.items) || [];
                return items.map(function (i) {
                    return { name: i.name, type: i.type, path: i.path, size: i.size || 0, modified: i.modified || '' };
                });
            });
        });
    }

    // Скачать дамп; 404 → null. Возвращает распарсенный JSON.
    function _downloadJson(relPath) {
        const p = _fullPath(relPath);
        return _api('GET', DISK_API + '/download', { path: p }).then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('Yandex.Disk: download ' + p + ' \u2192 ' + r.status);
            return r.json().then(function (j) {
                return fetch(j.href, { cache: 'no-store' }).then(function (resp) {
                    if (!resp.ok) throw new Error('Yandex.Disk: storage download ' + resp.status);
                    if (/\.gz$/i.test(p)) {
                        return resp.arrayBuffer().then(function (buf) { return gunzipText(new Uint8Array(buf)); });
                    }
                    return resp.text();
                });
            });
        }).then(function (text) {
            return text == null ? null : JSON.parse(text);
        });
    }

    // Загрузить JSON: имя '.json' — как есть (для Action-файлов),
    // '.json.gz' — с gzip-сжатием (для дампов, как пишет сервер).
    function _uploadJson(relPath, data) {
        const p = _fullPath(relPath);
        const asGz = /\.gz$/i.test(p);
        const body = JSON.stringify(data);
        return _api('GET', DISK_API + '/upload', { path: p, overwrite: 'true' }).then(function (r) {
            if (!r.ok) throw new Error('Yandex.Disk: upload href ' + p + ' \u2192 ' + r.status);
            return r.json().then(function (j) {
                if (asGz) {
                    return gzipBytes(body).then(function (bytes) {
                        return fetch(j.href, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/x-gzip' } });
                    });
                }
                return fetch(j.href, { method: 'PUT', body: body, headers: { 'Content-Type': 'application/json' } });
            });
        }).then(function (resp) {
            if (!resp.ok) throw new Error('Yandex.Disk: upload ' + p + ' \u2192 ' + resp.status);
            return true;
        });
    }

    function _deleteFile(relPath) {
        const p = _fullPath(relPath);
        return _api('DELETE', DISK_API, { path: p }).then(function (r) {
            if (r.status === 404 || r.status === 200 || r.status === 202 || r.status === 204) return true;
            throw new Error('Yandex.Disk: delete ' + p + ' \u2192 ' + r.status);
        });
    }

    function _moveFile(relFrom, relTo) {
        return _api('POST', DISK_API + '/move', { from: _fullPath(relFrom), path: _fullPath(relTo) }).then(function (r) {
            if (r.status === 200 || r.status === 201 || r.status === 202 || r.status === 204 || r.status === 409) return true;
            throw new Error('Yandex.Disk: move ' + relFrom + ' \u2192 ' + r.status);
        });
    }

    // ==================== ACTION (исходящие команды мосту) ====================

    // Поставить команду в очередь: {basePath}/Action/{action}_{ts}_{rnd}.json.
    // Префикс action обязан быть один из понимаемых сервером:
    // take_task_ / close_task_ / reject_task_ / redirect_task_ / generate_docs_
    function _submitAction(action, payload) {
        const name = action + '_' + Date.now() + '_' + Math.floor(Math.random() * 1000000) + '.json';
        const body = Object.assign({ action: action, created_at: new Date().toISOString() }, payload || {});
        return _uploadJson('Action/' + name, body).then(function () { return name; });
    }

    // Снимок папки Action: имя файла (без расширений) → 'pending'|'processing'|'error'.
    // Жизненный цикл на сервере: .json → .processing → (удалён = success | .error = сбой 1С).
    function _getActionStatuses() {
        return _list('Action').then(function (items) {
            const st = {};
            items.forEach(function (it) {
                let n = it.name, status = 'pending';
                if (/\.error$/i.test(n)) { status = 'error'; n = n.slice(0, -6); }
                else if (/\.processing$/i.test(n)) { status = 'processing'; n = n.slice(0, -11); }
                if (/\.json$/i.test(n)) n = n.slice(0, -5);
                if (n) st[n] = status;
            });
            return st;
        });
    }

    // Свежесть дампов для индикатора «данные актуальны на …»:
    // имя файла → ISO-время изменения на Диске.
    function _getDumpFreshness() {
        return _list('').then(function (items) {
            const fresh = {};
            items.forEach(function (it) {
                if (it.type === 'file' && /\.json(\.gz)?$/i.test(it.name)) {
                    fresh[it.name] = it.modified;
                }
            });
            return fresh;
        });
    }


    return {
        refreshTokenFromServer: refreshTokenFromServer,
        isConfigured: isConfigured,
        clearCredentials: clearCredentials,
        basePath: basePath,
        list: _list, downloadJson: _downloadJson, uploadJson: _uploadJson,
        deleteFile: _deleteFile, moveFile: _moveFile,
        submitAction: _submitAction, getActionStatuses: _getActionStatuses,
        getDumpFreshness: _getDumpFreshness,
        _gzipBytes: gzipBytes, _gunzipText: gunzipText, _api: _api, DISK_API: DISK_API
    };
})();
