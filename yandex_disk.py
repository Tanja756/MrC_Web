import os
import json
import hashlib
import logging
from datetime import datetime, timedelta

import requests

from db import get_yandex_upload_status, save_yandex_upload_status

logger = logging.getLogger(__name__)

DISK_API = "https://cloud-api.yandex.net/v1/disk/resources"
TOKEN_URL = "https://oauth.yandex.ru/token"


class YandexDiskClient:
    def __init__(self):
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
        file_path = f"{folder_path}/{filename}"

        delete_r = self._request("DELETE", DISK_API, params={"path": file_path})
        if delete_r.status_code not in (200, 202, 204, 404):
            delete_r.raise_for_status()

        upload_r = self._request("GET", DISK_API + "/upload", params={
            "path": file_path,
            "overwrite": "true",
        })
        upload_r.raise_for_status()
        upload_url = upload_r.json()["href"]

        body = json.dumps(data, ensure_ascii=False, default=str, sort_keys=True).encode("utf-8")
        put_r = requests.put(upload_url, data=body, timeout=30)
        put_r.raise_for_status()
        logger.info("Uploaded Yandex.Disk: %s (%d bytes)", file_path, len(body))

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
        body = requests.get(href, timeout=30)
        body.raise_for_status()
        return body.text

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

    current = {"user": user_data, "free": free_data, "closed": closed_data}
    h = compute_hash(current)

    saved = get_yandex_upload_status(username)
    if saved and saved.get("tasks_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "tasks.json", current)
        save_yandex_upload_status(username, tasks_hash=h)
        logger.info("Yandex sync: tasks updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload tasks for %s: %s", username, e)


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
        "tasks.json": saved.get("tasks_hash"),
        "warehouse.json": saved.get("warehouse_hash"),
        "references.json": saved.get("references_hash"),
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


def _rename_to_error(yandex, file_path, name):
    error_path = file_path.rsplit(".", 1)[0] + ".error"
    try:
        yandex.move_file(file_path, error_path)
        logger.info("Yandex Action: renamed %s to .error", name)
    except Exception as e:
        logger.error("Yandex Action: failed to rename %s: %s", name, e)


def process_close_task_actions(username, client, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    action_folder = f"{username}/Action"

    try:
        items = yandex.list_folder(action_folder)
    except Exception as e:
        logger.debug("Yandex Action folder not available for %s: %s", username, e)
        return

    close_files = [i for i in items if i["name"].startswith("close_task_") and i["name"].endswith(".json")]
    if not close_files:
        return

    logger.info("Yandex Action: found %d close_task file(s) for %s", len(close_files), username)

    for f in close_files:
        file_path = f"{action_folder}/{f['name']}"
        try:
            content = yandex.download_file(file_path)
            data = json.loads(content)
        except Exception as e:
            logger.error("Yandex Action: failed to read %s: %s", f["name"], e)
            _rename_to_error(yandex, file_path, f["name"])
            continue

        if data.get("action") != "close_task":
            logger.warning("Yandex Action: unknown action in %s", f["name"])
            _rename_to_error(yandex, file_path, f["name"])
            continue

        guid = data.get("guid")
        if not guid:
            logger.error("Yandex Action: missing guid in %s", f["name"])
            _rename_to_error(yandex, file_path, f["name"])
            continue

        guid_doc = data.get("guid_doc", "")
        comment = data.get("comment", "")
        latitude = data.get("latitude", 0.0)
        longitude = data.get("longitude", 0.0)
        attachments = data.get("attachments", [])

        try:
            result = client.task_close(guid, guid_doc, comment, latitude, longitude, attachments)
        except Exception as e:
            logger.error("Yandex Action: 1C close failed for %s (guid=%s): %s", f["name"], guid, e)
            continue

        if result and result.get("_error"):
            logger.error("Yandex Action: 1C returned error for %s (guid=%s): %s", f["name"], guid, result["_error"])
            _rename_to_error(yandex, file_path, f["name"])
            continue

        try:
            yandex.delete_file(file_path)
            logger.info("Yandex Action: task %s closed from %s, file deleted", guid, f["name"])
        except Exception as e:
            logger.error("Yandex Action: failed to delete %s after success: %s", f["name"], e)


def sync_references_to_yandex(username, client, yandex=None):
    if yandex is None:
        yandex = YandexDiskClient()
    if not yandex.is_authenticated():
        return

    try:
        products = client.get_products()
        clients = client.get_clients()
        storages = client.get_storages()
    except Exception as e:
        logger.error("Yandex sync: failed to fetch references for %s: %s", username, e)
        return

    data = {
        "products": products,
        "clients": clients,
        "storages": storages,
    }
    h = compute_hash(data)

    saved = get_yandex_upload_status(username)
    if saved and saved.get("references_hash") == h:
        return

    try:
        yandex.ensure_folder(f"/{username}")
        yandex.upload_json(f"/{username}", "references.json", data)
        save_yandex_upload_status(username, references_hash=h)
        logger.info("Yandex sync: references updated for %s", username)
    except Exception as e:
        logger.error("Yandex sync: failed to upload references for %s: %s", username, e)
