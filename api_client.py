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

    def _get(self, endpoint: str, params: dict = None):
        url = f"{self.base_url}/{endpoint}"
        try:
            r = self.session.get(url, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException:
            logger.warning(f"_get failed: {url}")
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
        return self._get("products") or []

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

    def get_ppr_list(self, year: int, quarter: int, department: str = None):
        params = {"year": year, "quarter": quarter}
        if department:
            params["name_department"] = department
        return self._get("ppr_list", params)

    def ppr_close(self, guid: str, comment: str,
                  latitude: float, longitude: float,
                  attachments: list = None):
        if attachments is None:
            attachments = []
        return self._post("ppr_close", {
            "guid": guid,
            "comment": comment,
            "latitude": latitude,
            "longitude": longitude,
            "attachments": attachments,
        })

    def ppr_add(self, **kwargs):
        return self._post("ppr_add", kwargs)

    def get_ppr_departments(self, year: int, quarter: int):
        return self._get("ppr_departments", {
            "year": year, "quarter": quarter
        })
