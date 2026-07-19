import os
import json
import gzip
import hashlib
import logging
import re
from datetime import datetime, timedelta

import requests

from db import get_yandex_upload_status, save_yandex_upload_status, set_task_taken, set_task_closed

logger = logging.getLogger(__name__)

DISK_API = "https://cloud-api.yandex.net/v1/disk/resources"
TOKEN_URL = "https://oauth.yandex.ru/token"


class YandexDiskClient:
    _instance = None
    _initialized = False

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if YandexDiskClient._initialized:
            return
        YandexDiskClient._initialized = True
        self._client_id = os.environ.get("YANDEX_CLIENT_ID", "")
        self._client_secret = os.environ.get("YANDEX_CLIENT_SECRET", "")
        self._refresh_token = os.environ.get("YANDEX_REFRESH_TOKEN", "")
        self._access_token = None
        self._expires_at = None

    def is_authenticated(self):
        return bool(self._refresh_token)

    def _ensure_token(self):
        if self._access_token and self._expires_at and datetime.now() < self._expires_at:
            return
        if not self._refresh_token:
            raise RuntimeError("Yandex refresh token not configured")
        self._refresh_access_token()

    def _refresh_access_token(self):
        r = requests.post(TOKEN_URL, data={
            "grant_type": "refresh_token",
            "refresh_token": self._refresh_token,
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }, timeout=15)
        data = r.json()
        if "access_token" not in data:
            logger.error("Yandex token refresh failed: %s", data.get("error_description", data.get("error", "unknown")))
            raise RuntimeError("Yandex token refresh failed")
        self._access_token = data["access_token"]
        expires_in = data.get("expires_in", 365 * 86400)
        self._expires_at = datetime.now() + timedelta(seconds=expires_in)

        new_refresh = data.get("refresh_token")
        if new_refresh and new_refresh != self._refresh_token:
            self._refresh_token = new_refresh
            self._update_env_refresh_token(new_refresh)

    def _update_env_refresh_token(self, token):
        try:
            from dotenv import set_key, find_dotenv
            dotenv_path = find_dotenv()
            if dotenv_path:
                set_key(dotenv_path, "YANDEX_REFRESH_TOKEN", token)
                os.environ["YANDEX_REFRESH_TOKEN"] = token
                logger.info("Yandex refresh token updated in .env")
        except Exception as e:
            logger.warning("Failed to update YANDEX_REFRESH_TOKEN in .env: %s", e)

    def _request(self, method, url, **kwargs):
        self._ensure_token()
        kwargs.setdefault("timeout", 15)
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"OAuth {self._access_token}"
        r = requests.request(method, url, headers=headers, **kwargs)
        if r.status_code == 401:
            self._access_token = None
            self._ensure_token()
            headers["Authorization"] = f"OAuth {self._access_token}"
            r = requests.request(method, url, headers=headers, **kwargs)
        return r

    def ensure_folder(self, path):
        path = path.strip("/")
        r = self._request("GET", DISK_API, params={"path": path})
        if r.status_code == 200:
            return
        if r.status_code == 404:
            parts = path.split("/")
            for i in range(1, len(parts) + 1):
                sub = "/".join(parts[:i])
                r2 = self._request("PUT", DISK_API, params={"path": sub})
                if r2.status_code not in (201, 202, 409):
                    r2.raise_for_status()
            return
        r.raise_for_status()

    def upload_json(self, folder_path, filename, data):
        folder_path = folder_path.strip("/")
        if not filename.endswith('.gz'):
            filename += '.gz'
        file_path = f"{folder_path}/{filename}"

        upload_r = self._request("GET", DISK_API + "/upload", params={
            "path": file_path,
            "overwrite": "true",
        })
        upload_r.raise_for_status()
        upload_url = upload_r.json()["href"]

        body = json.dumps(data, ensure_ascii=False, default=str, sort_keys=True).encode("utf-8")
        compressed = gzip.compress(body)
        put_r = requests.put(upload_url, data=compressed, timeout=30)
        put_r.raise_for_status()
        logger.info("Uploaded Yandex.Disk: %s (%d -> %d bytes)", file_path, len(body), len(compressed))

    def upload_file(self, folder_path, filename, data: bytes):
        folder_path = folder_path.strip("/")
        file_path = f"{folder_path}/{filename}"

        upload_r = self._request("GET", DISK_API + "/upload", params={
            "path": file_path,
            "overwrite": "true",
        })
        upload_r.raise_for_status()
        upload_url = upload_r.json()["href"]

        put_r = requests.put(upload_url, data=data, timeout=60)
        put_r.raise_for_status()
        logger.info("Uploaded Yandex.Disk: %s (%d bytes)", file_path, len(data))

    def list_folder(self, path):
        path = path.strip("/")
        r = self._request("GET", DISK_API, params={"path": path, "limit": 100})
        if r.status_code == 404:
            return []
        r.raise_for_status()
        items = r.json().get("_embedded", {}).get("items", [])
        return [{"name": i["name"], "type": i["type"], "path": i["path"]} for i in items]

    def download_file(self, file_path):
        file_path = file_path.strip("/")
        r = self._request("GET", DISK_API + "/download", params={"path": file_path})
        r.raise_for_status()
        href = r.json()["href"]
        resp = requests.get(href, timeout=30)
        resp.raise_for_status()
        raw = resp.content
        if file_path.endswith('.gz'):
            raw = gzip.decompress(raw)
        return raw.decode('utf-8')

    def delete_file(self, file_path):
        file_path = file_path.strip("/")
        r = self._request("DELETE", DISK_API, params={"path": file_path})
        if r.status_code not in (200, 202, 204, 404):
            r.raise_for_status()

    def move_file(self, source_path, dest_path):
        source_path = source_path.strip("/")
        dest_path = dest_path.strip("/")
        r = self._request("POST", DISK_API + "/move", params={
            "from": source_path, "path": dest_path,
        })
        if r.status_code not in (200, 201, 202, 204, 409):
            r.raise_for_status()


def compute_hash(data):
    raw = json.dumps(data, ensure_ascii=False, default=str, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def sync_tasks_to_yandex(username, user_data, free_data, closed_data, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    saved = get_yandex_upload_status(username)

    sections = [
        ("tasks_user.json", (user_data or {}).get("tasks", [])),
        ("tasks_free.json", (free_data or {}).get("tasks", [])),
        ("tasks_closed.json", (closed_data or {}).get("tasks", [])),
    ]

    try:
        yandex.ensure_folder(f"/{username}")
    except Exception as e:
        logger.error("Yandex sync: failed to ensure folder for %s: %s", username, e)
        return

    hash_kw = {}
    for filename, data in sections:
        h = compute_hash(data)
        key = filename.replace(".json", "_hash")
        if saved and saved.get(key) == h:
            continue
        try:
            yandex.upload_json(f"/{username}", filename, data)
            hash_kw[key] = h
            logger.info("Yandex sync: %s updated for %s", filename, username)
        except Exception as e:
            logger.error("Yandex sync: failed to upload %s for %s: %s", filename, username, e)

    if hash_kw:
        save_yandex_upload_status(username, **hash_kw)


def sync_warehouse_to_yandex(username, warehouse_data, yandex=None):
    if not warehouse_data:
        return

    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    h = compute_hash(warehouse_data)

    saved = get_yandex_upload_status(username)
    if saved and saved.get("warehouse_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "warehouse.json", warehouse_data)
        save_yandex_upload_status(username, warehouse_hash=h)
        logger.info("Yandex sync: warehouse updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload warehouse for %s: %s", username, e)


def sync_hashes_to_yandex(username, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    saved = get_yandex_upload_status(username)
    if not saved:
        return

    hashes = {
        "tasks_user.json.gz": saved.get("tasks_user_hash"),
        "tasks_free.json.gz": saved.get("tasks_free_hash"),
        "tasks_closed.json.gz": saved.get("tasks_closed_hash"),
        "warehouse.json.gz": saved.get("warehouse_hash"),
        "references.json.gz": saved.get("references_hash"),
        "ppr_list.json.gz": saved.get("ppr_hash"),
        "fn_schedule.json.gz": saved.get("fn_schedule_hash"),
    }
    hashes = {k: v for k, v in hashes.items() if v}

    if not hashes:
        return

    h = compute_hash(hashes)
    if saved.get("hashes_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "hashes.json", hashes)
        save_yandex_upload_status(username, hashes_hash=h)
        logger.info("Yandex sync: hashes updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload hashes for %s: %s", username, e)


def sync_fn_schedule_to_yandex(username, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return
    try:
        from db import get_db_connection
        conn = get_db_connection()
        c = conn.execute("SELECT * FROM fn_schedule ORDER BY id")
        rows = c.fetchall()
        cols = [d[0] for d in c.description]
        data = [dict(zip(cols, r)) for r in rows]
        conn.close()
    except Exception as e:
        logger.error("Failed to read fn_schedule: %s", e)
        return

    h = compute_hash(data)
    saved = get_yandex_upload_status(username)
    if saved and saved.get("fn_schedule_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "fn_schedule.json", data)
        save_yandex_upload_status(username, fn_schedule_hash=h)
        logger.info("Yandex sync: fn_schedule updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload fn_schedule for %s: %s", username, e)


def sync_ppr_to_yandex(username, client=None, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    try:
        from datetime import datetime
        from db import get_ppr_list
        year = datetime.now().year
        quarter = (datetime.now().month - 1) // 3 + 1
        tasks = get_ppr_list(year, quarter)
        data = {"tasks": tasks}
    except Exception as e:
        logger.error("Failed to fetch ppr_list from local DB: %s", e)
        return

    h = compute_hash(data)
    saved = get_yandex_upload_status(username)
    if saved and saved.get("ppr_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "ppr_list.json", data)
        save_yandex_upload_status(username, ppr_hash=h)
        logger.info("Yandex sync: ppr_list updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload ppr_list for %s: %s", username, e)


def _rename_to_error(yandex, file_path, name):
    error_path = file_path.rsplit(".", 1)[0] + ".error"
    try:
        yandex.move_file(file_path, error_path)
        logger.info("Yandex Action: renamed %s to .error", name)
    except Exception as e:
        logger.error("Yandex Action: failed to rename %s: %s", name, e)


def _handle_close_task(yandex, client, username, file_path, name, data) -> bool:
    """Process a single close_task action file. Returns True on success."""
    if data.get("action") != "close_task":
        logger.warning("Yandex Action: unknown action in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    guid = data.get("guid")
    if not guid:
        logger.error("Yandex Action: missing guid in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    guid_doc = data.get("guid_doc", "")
    comment = data.get("comment", "")
    latitude = data.get("latitude", 0.0)
    longitude = data.get("longitude", 0.0)
    attachments = data.get("attachments", [])

    # Rename immediately after successful read → .processing
    # (no longer ends with .json, so process_actions won't pick it up again)
    processing_path = file_path.rsplit(".", 1)[0] + ".processing"
    try:
        yandex.move_file(file_path, processing_path)
    except Exception as e:
        logger.error("Yandex Action: failed to rename %s: %s", name, e)
        return False

    # Guard: check with 1C if task is already closed
    status = client.task_is_closed(guid)
    if status is not None and status.get("closed"):
        logger.info("Yandex Action: task %s already closed in 1C, skipping", guid)
        try:
            yandex.delete_file(processing_path)
        except Exception as e:
            logger.error("Yandex Action: failed to delete %s: %s", name, e)
        return True

    # Fetch task details before close to store ХК-код locally
    task_name = ''
    try:
        tasks_data = client.get_tasks_user(limit=200)
        if isinstance(tasks_data, dict):
            task = next((t for t in tasks_data.get('tasks', []) if t.get('guid') == guid), None)
            if task:
                tn = (task.get('number', '') or '').strip()
                nm = (task.get('name', '') or '').strip()
                task_name = f"Заявка {tn} — {nm}" if tn else nm
    except Exception:
        pass

    try:
        result = client.task_close(guid, guid_doc, comment, latitude, longitude, attachments)
    except Exception as e:
        logger.error("Yandex Action: 1C close failed for %s (guid=%s): %s", name, guid, e)
        _rename_to_error(yandex, processing_path, name)
        return False

    if result and result.get("_error"):
        logger.error("Yandex Action: 1C returned error for %s (guid=%s): %s", name, guid, result["_error"])
        _rename_to_error(yandex, processing_path, name)
        return False

    try:
        set_task_closed(username, guid, task_name)
    except Exception as e:
        logger.warning("Yandex Action: failed to set_task_closed locally for %s: %s", guid, e)

    try:
        yandex.delete_file(processing_path)
        logger.info("Yandex Action: task %s closed from %s, file deleted", guid, name)
        return True
    except Exception as e:
        logger.error("Yandex Action: failed to delete %s after success: %s", name, e)
        return False


def _handle_take_task(yandex, client, username, file_path, name, data) -> bool:
    """Process a single take_task action file. Returns True on success."""
    if data.get("action") != "take_task":
        logger.warning("Yandex Action: unknown action in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    guid = data.get("guid")
    if not guid:
        logger.error("Yandex Action: missing guid in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    processing_path = file_path.rsplit(".", 1)[0] + ".processing"
    try:
        yandex.move_file(file_path, processing_path)
    except Exception as e:
        logger.error("Yandex Action: failed to rename %s: %s", name, e)
        return False

    try:
        result = client.task_take(guid)
    except Exception as e:
        logger.error("Yandex Action: 1C take failed for %s (guid=%s): %s", name, guid, e)
        _rename_to_error(yandex, processing_path, name)
        return False

    if result and result.get("_error"):
        logger.error("Yandex Action: 1C returned error for %s (guid=%s): %s", name, guid, result["_error"])
        _rename_to_error(yandex, processing_path, name)
        return False

    try:
        set_task_taken(username, guid)
    except Exception as e:
        logger.warning("Yandex Action: failed to set_task_taken locally for %s: %s", guid, e)

    try:
        yandex.delete_file(processing_path)
        logger.info("Yandex Action: task %s taken from %s, file deleted", guid, name)
        return True
    except Exception as e:
        logger.error("Yandex Action: failed to delete %s after success: %s", name, e)
        return False


_PDF_SUFFIX_MAP = {
    re.compile(r'-ACT-'): 'AVR',
    re.compile(r'-FN-'): 'FN',
    re.compile(r'-M15-'): 'm15',
}


def _get_pdf_type(filepath):
    basename = os.path.basename(filepath)
    for pattern, suffix in _PDF_SUFFIX_MAP.items():
        if pattern.search(basename):
            return suffix
    return 'doc'


def _handle_generate_docs(yandex, client, username, file_path, name, data) -> bool:
    from docgen import extract_task_data, generate_documents

    if data.get("action") != "generate_docs":
        logger.warning("Yandex Action: unknown action in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    guid = data.get("guid")
    if not guid:
        logger.error("Yandex Action: missing guid in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    profile_name = data.get("profile_name", "")
    include_act = data.get("include_act", True)
    include_m15 = data.get("include_m15", True)
    include_fn = data.get("include_fn", False)

    if not include_act and not include_m15 and not include_fn:
        logger.error("Yandex Action: no document types enabled in %s", name)
        _rename_to_error(yandex, file_path, name)
        return False

    processing_path = file_path.rsplit(".", 1)[0] + ".processing"
    try:
        yandex.move_file(file_path, processing_path)
    except Exception as e:
        logger.error("Yandex Action: failed to rename %s: %s", name, e)
        return False

    task = None
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        try:
            tasks_data = getattr(client, fetcher)()
            if tasks_data and 'tasks' in tasks_data:
                task = next((t for t in tasks_data['tasks'] if t.get('guid') == guid), None)
                if task:
                    break
        except Exception:
            continue

    if not task:
        logger.error("Yandex Action: task %s not found in 1C", guid)
        _rename_to_error(yandex, processing_path, name)
        return False

    parsed = extract_task_data(task)
    sap = parsed.get('sap', '')
    shop = parsed.get('shop', '')
    code = parsed.get('code', '')

    if not sap:
        logger.error("Yandex Action: could not determine SAP for task %s", guid)
        _rename_to_error(yandex, processing_path, name)
        return False

    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    date_str = datetime.now().strftime('%Y-%m-%d')
    folder = f"{username}/Docs/{date_str}/{sap}"

    try:
        pdfs = generate_documents(task, profile_name=profile_name,
                                  include_act=include_act,
                                  include_fn=include_fn,
                                  include_m15=include_m15)
    except Exception as e:
        logger.error("Yandex Action: document generation failed for %s (guid=%s): %s", name, guid, e)
        _rename_to_error(yandex, processing_path, name)
        return False

    if not pdfs:
        logger.error("Yandex Action: no documents generated for %s (guid=%s)", name, guid)
        _rename_to_error(yandex, processing_path, name)
        return False

    try:
        yandex.ensure_folder(folder)
    except Exception as e:
        logger.error("Yandex Action: failed to create folder %s: %s", folder, e)
        for p in pdfs:
            try:
                os.unlink(p)
            except Exception:
                pass
        _rename_to_error(yandex, processing_path, name)
        return False

    try:
        for pdf_path in pdfs:
            pdf_type = _get_pdf_type(pdf_path)
            filename = f"{ts}-{sap}-{shop}-{code}-{pdf_type}.pdf"
            with open(pdf_path, 'rb') as f:
                pdf_data = f.read()
            yandex.upload_file(folder, filename, pdf_data)
            os.unlink(pdf_path)
    except Exception as e:
        logger.error("Yandex Action: failed to upload documents for %s (guid=%s): %s", name, guid, e)
        for p in pdfs:
            try:
                os.unlink(p)
            except Exception:
                pass
        _rename_to_error(yandex, processing_path, name)
        return False

    try:
        yandex.delete_file(processing_path)
        logger.info("Yandex Action: documents generated for task %s (%s), uploaded to %s", guid, name, folder)
        return True
    except Exception as e:
        logger.error("Yandex Action: failed to delete %s after success: %s", name, e)
        return False


def process_actions(username, client, yandex=None) -> bool:
    """Read all .json files from {username}/Action/, dispatch to handlers.
    Returns True if at least one action was successfully handled."""
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return False

    action_folder = f"{username}/Action"

    try:
        items = yandex.list_folder(action_folder)
    except Exception as e:
        logger.debug("Yandex Action folder not available for %s: %s", username, e)
        return False

    json_files = [i for i in items if i["name"].endswith(".json")]
    if not json_files:
        return False

    logger.info("Yandex Action: found %d file(s) for %s", len(json_files), username)

    any_handled = False
    for f in json_files:
        file_path = f"{action_folder}/{f['name']}"
        try:
            content = yandex.download_file(file_path)
            data = json.loads(content)
        except Exception as e:
            logger.error("Yandex Action: failed to read %s: %s", f["name"], e)
            _rename_to_error(yandex, file_path, f["name"])
            continue

        handled = False
        if f["name"].startswith("close_task_"):
            handled = _handle_close_task(yandex, client, username, file_path, f["name"], data)
        elif f["name"].startswith("generate_docs_"):
            handled = _handle_generate_docs(yandex, client, username, file_path, f["name"], data)
        elif f["name"].startswith("take_task_"):
            handled = _handle_take_task(yandex, client, username, file_path, f["name"], data)

        if handled:
            any_handled = True

    return any_handled


def _get_item_key(item):
    if isinstance(item, dict):
        return item.get('guid') or item.get('id') or json.dumps(item, sort_keys=True)
    return str(item)


def _compare_ref_lists(label, old_list, new_list):
    if not old_list and not new_list:
        return
    if not old_list:
        sample = new_list[0]
        if isinstance(sample, dict):
            logger.warning("  [ref] %s: NEW (count=%d), first keys: %s", label, len(new_list), list(sample.keys()))
        else:
            logger.warning("  [ref] %s: NEW (count=%d), first item type=%s", label, len(new_list), type(sample).__name__)
        return
    if not new_list:
        logger.warning("  [ref] %s: DELETED (was %d items)", label, len(old_list))
        return
    logger.warning("  [ref] %s: %d -> %d items", label, len(old_list), len(new_list))

    # If items are not dicts, just log types
    if not isinstance(old_list[0], dict) or not isinstance(new_list[0], dict):
        logger.warning("  [ref] %s: old type=%s, new type=%s — skip detailed diff",
                       label, type(old_list[0]).__name__, type(new_list[0]).__name__)
        return

    old_by_guid = {}
    for item in old_list:
        g = _get_item_key(item)
        old_by_guid[g] = item

    samples = 0
    for new_item in new_list:
        if samples >= 3:
            break
        g = _get_item_key(new_item)
        old_item = old_by_guid.pop(g, None)
        if old_item is None:
            logger.warning("  [ref] %s: NEW item key=%s", label, g)
            samples += 1
        elif old_item != new_item:
            old_keys = set(old_item.keys())
            new_keys = set(new_item.keys())
            added_keys = new_keys - old_keys
            removed_keys = old_keys - new_keys
            changed_keys = {k for k in old_keys & new_keys if old_item[k] != new_item[k]}
            logger.warning(
                "  [ref] %s: CHANGED key=%s added=%s removed=%s changed=%s",
                label, g, added_keys, removed_keys, list(changed_keys)[:5]
            )
            for k in list(changed_keys)[:2]:
                oval, nval = old_item.get(k), new_item.get(k)
                logger.warning("    [ref]   %s: %r -> %r", k, oval, nval)
            samples += 1

    if old_by_guid and samples < 3:
        logger.warning("  [ref] %s: REMOVED (sample): %s", label, list(old_by_guid.keys())[:3])


REFERENCES_COOLDOWN = 3600  # не чаще 1 часа


def sync_references_to_yandex(username, client, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    saved = get_yandex_upload_status(username)

    # Проверяем, существует ли файл .json.gz на диске
    gz_path = f"{username}/references.json.gz"
    gz_exists = False
    try:
        meta_r = yandex._request("GET", DISK_API, params={"path": gz_path})
        gz_exists = meta_r.status_code == 200
    except Exception:
        pass

    if saved and saved.get("references_synced_at") and saved.get("references_hash") and gz_exists:
        try:
            last = datetime.fromisoformat(saved["references_synced_at"])
            if (datetime.now() - last).total_seconds() < REFERENCES_COOLDOWN:
                return
        except (ValueError, TypeError):
            pass

    try:
        products = client.get_products()
        clients = client.get_clients()
        storages = client.get_storages()
    except Exception as e:
        logger.error("Yandex sync: failed to fetch references for %s: %s", username, e)
        return

    # Стабилизация хэша: исключаем поля, которые 1C меняет при каждом запросе
    _NOISE_KEYS = {'for_selection'}
    if clients:
        for c in clients:
            if isinstance(c, dict):
                for k in _NOISE_KEYS & c.keys():
                    del c[k]

    data = {
        "products": products,
        "clients": clients,
        "storages": storages,
    }
    h = compute_hash(data)

    saved = get_yandex_upload_status(username)
    if saved and saved.get("references_hash") == h and gz_exists:
        return

    # Диагностика: что именно изменилось
    logger.warning("[ref] references hash changed for %s — fetching old to diff", username)
    old_data = None
    try:
        old_text = yandex.download_file(f"/{username}/references.json.gz")
        old_data = json.loads(old_text)
    except Exception as e:
        logger.warning("[ref] could not fetch old references.json for %s: %s", username, e)
    if old_data and isinstance(old_data, dict):
        sections = {"products": products, "clients": clients, "storages": storages}
        for section, new_val in sections.items():
            try:
                _compare_ref_lists(section, old_data.get(section), new_val)
            except Exception as e:
                logger.warning("[ref] diff failed for %s/%s: %s", username, section, e)
    else:
        logger.warning("[ref] old data unavailable or not a dict; new sizes: products=%d, clients=%d, storages=%d",
                       len(products) if products else 0,
                       len(clients) if clients else 0,
                       len(storages) if storages else 0)

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "references.json", data)
        save_yandex_upload_status(username, references_hash=h, references_synced_at=datetime.now().isoformat())
        logger.info("Yandex sync: references updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload references for %s: %s", username, e)
