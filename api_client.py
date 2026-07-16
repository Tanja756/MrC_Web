import json
import base64
import logging
import requests
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


class OneSApiClient:
    def __init__(self, host: str, port: str, db_name: str,
                 username: str, password: str):
        self.base_url = f"http://{host}:{port}/{db_name}/hs/api/v1"
        self.auth = base64.b64encode(
            f"{username}:{password}".encode()
        ).decode()

        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Basic {self.auth}",
            "Content-Type": "application/json",
        })

    @staticmethod
    def _clean_response(data, endpoint: str):
        """Strip heavy fields from 1C responses (same as mrc_proxy did)."""
        CLEAN_DOCS_SERVICES = ("tasks-user", "tasks-unallocated", "closed-tasks-user")
        CLEAN_ATTACHMENTS = ("stock-transfers",)

        if isinstance(data, dict):
            if any(endpoint.endswith(s) for s in CLEAN_DOCS_SERVICES):
                data.pop("docs", None)
                data.pop("services", None)
                for task in data.get("tasks", []):
                    for att in task.get("attachments", []):
                        att.pop("content", None)
                return data
        if isinstance(data, list):
            if any(endpoint.endswith(s) for s in CLEAN_ATTACHMENTS):
                for item in data:
                    for att in item.get("attachments", []):
                        att.pop("content", None)
                return data
        return data

    def _get(self, endpoint: str, params: dict = None):
        url = f"{self.base_url}/{endpoint}"
        try:
            r = self.session.get(url, params=params, timeout=30)
            logger.info(f"_get {r.status_code} {url}")
            r.raise_for_status()
            data = r.json()
            return self._clean_response(data, endpoint)
        except requests.exceptions.Timeout:
            logger.error(f"_get timeout: {url}")
            return None
        except requests.exceptions.HTTPError as e:
            resp = e.response
            status = resp.status_code if resp is not None else 0
            body = resp.text[:500] if resp is not None else ''
            logger.error(f"_get HTTP {status}: {url} — {body}")
            return None
        except requests.exceptions.RequestException:
            logger.warning(f"_get failed: {url}")
            return None
        except Exception as e:
            logger.error(f"_get error: {url} — {e}")
            return None

    def _post(self, endpoint: str, data: dict):
        url = f"{self.base_url}/{endpoint}"
        try:
            r = self.session.post(url, json=data, timeout=60)
            r.raise_for_status()
            try:
                return r.json()
            except json.JSONDecodeError:
                return {}
        except requests.exceptions.Timeout:
            logger.error(f"_post timeout: {url}")
            return {"_error": "Timeout"}
        except requests.exceptions.HTTPError as e:
            resp = e.response
            body = resp.text[:1000] if resp is not None else ''
            status = resp.status_code if resp is not None else 0
            logger.error(f"_post HTTP {status}: {url} — {body}")
            try:
                detail = resp.json() if resp is not None else {}
            except Exception:
                detail = {"_raw": body}
            detail["_error"] = f"HTTP {status}"
            return detail
        except Exception as e:
            logger.error(f"_post error: {url} — {e}")
            return {"_error": str(e)}

    def login(self):
        data = self._get("login")
        if data is None:
            raise RuntimeError("Server unreachable or invalid credentials")
        return data

    def get_storages(self):
        return self._get("storages") or []

    def get_balances(self, storage_guid: str):
        return self._get("balances-report", {"storage": storage_guid}) or []

    def get_products(self):
        data = self._get("products")
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ('products', 'data', 'items', 'result'):
                val = data.get(key)
                if isinstance(val, list):
                    return val
        return data or []

    def get_tasks_user(self, search=None, limit=None, offset=None):
        params = self._build_task_params(search, limit, offset)
        return self._get("tasks-user", params) or {"docs": [], "tasks": []}

    def get_clients(self):
        return self._get("clients") or []

    def get_tasks_unallocated(self, search=None, limit=None, offset=None):
        params = self._build_task_params(search, limit, offset)
        return self._get("tasks-unallocated", params) or {"docs": [], "tasks": []}

    def _build_task_params(self, search=None, limit=None, offset=None):
        params = {}
        if search is not None:
            params['search'] = search
        if limit is not None:
            params['limit'] = limit
        if offset is not None:
            params['offset'] = offset
        return params

    def task_take(self, guid: str):
        return self._post("task-take", {"guid": guid})

    def task_close(self, guid: str, guid_doc: str, comment: str,
                   latitude: float, longitude: float,
                   attachments: list = None):
        if attachments is None:
            attachments = []
        return self._post("task-close", {
            "guid": guid,
            "guidDoc": guid_doc,
            "comment": comment,
            "latitude": latitude,
            "longitude": longitude,
            "attachments": attachments,
            "services": [],
        })

    def get_closed_tasks_user(self, search=None, limit=None, offset=None):
        params = self._build_task_params(search, limit, offset)
        return self._get("closed-tasks-user", params) or {"docs": [], "tasks": []}

    def get_task_attachments(self, guid: str):
        return self._get("tasks-attachment", {"guid": guid})

    def get_salary(self, start_date: str, end_date: str):
        return self._get("salary", {
            "start_date": start_date,
            "end_date": end_date,
        }) or {"data": [], "totalAmount": 0.0}

    def get_movements(self, storage_guid: str, start_date: str, end_date: str):
        return self._get("movements", {
            "storage": storage_guid,
            "start_date": start_date,
            "end_date": end_date,
        }) or []

    def get_task(self, guid: str, filter_by_current_user: bool = True):
        params = {"guid": guid}
        if filter_by_current_user:
            params["filter_by_current_user"] = "true"
        return self._get("task", params)

    def task_is_closed(self, guid: str):
        return self._get("task-is-closed", {"guid": guid})

    def task_reject(self, guid: str, comment: str):
        return self._post("task-reject", {"guid": guid, "comment": comment})

    def task_redirect(self, guid: str, comment: str):
        return self._post("task-redirect", {"guid": guid, "comment": comment})

    def get_stock_transfers(self):
        return self._get("stock-transfers") or []

    def create_stock_transfer(self, data: dict):
        return self._post("stock-transfers", data)

    def get_balances_pick(self, storage_guid: str):
        return self._get("balances-pick", {"storage": storage_guid}) or []

    def _patch(self, endpoint: str, data: dict):
        url = f"{self.base_url}/{endpoint}"
        try:
            r = self.session.patch(url, json=data, timeout=60)
            r.raise_for_status()
            try:
                return r.json()
            except json.JSONDecodeError:
                return {}
        except requests.exceptions.Timeout:
            logger.error(f"_patch timeout: {url}")
            return {"_error": "Timeout"}
        except requests.exceptions.HTTPError as e:
            resp = e.response
            body = resp.text[:1000] if resp is not None else ''
            status = resp.status_code if resp is not None else 0
            logger.error(f"_patch HTTP {status}: {url} — {body}")
            try:
                detail = resp.json() if resp is not None else {}
            except Exception:
                detail = {"_raw": body}
            detail["_error"] = f"HTTP {status}"
            return detail
        except Exception as e:
            logger.error(f"_patch error: {url} — {e}")
            return {"_error": str(e)}

    def add_transfer_comment(self, task_guid: str, comment: str):
        return self._patch("stock-transfers-add-comment", {
            "task_guid": task_guid,
            "comment": comment,
        })

    def change_transfer_amount(self, guid: str, task_guid: str, amount: int):
        return self._patch("stock-transfers-change-amount", {
            "guid": guid,
            "task_guid": task_guid,
            "amount": amount,
        })

    def get_stock_transfer_attachment(self, task_guid: str, attachment_guid: str):
        return self._get("stock-transfers-attachment", {
            "task_guid": task_guid,
            "attachment_guid": attachment_guid,
        })

    def add_transfer_attachments(self, task_guid: str, attachments: list):
        return self._patch("stock-transfers-add-attachments", {
            "task_guid": task_guid,
            "attachments": attachments,
        })

    def delete_transfer_attachment(self, task_guid: str, attachment_guid: str):
        return self._patch("stock-transfers-delete-attachment", {
            "task_guid": task_guid,
            "attachment_guid": attachment_guid,
        })

    def get_stock_transfers_history(self):
        return self._get("stock-transfers-history") or []

    def get_user_notifications(self):
        return self._get("user-notifications") or {"notifications": []}

    def get_stock_transfers_history_attachment(self, doc_guid: str, attachment_guid: str, date: str):
        return self._get("stock-transfers-history-attachment", {
            "doc_guid": doc_guid,
            "attachment_guid": attachment_guid,
            "date": date,
        })
