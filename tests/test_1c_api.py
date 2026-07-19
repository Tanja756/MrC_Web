#!/usr/bin/env python3
"""
1C API Test Suite — standalone read-only endpoint tester.

Tests all GET (read-only) endpoints of the 1C HTTP API.
Logs every request and response to a JSON file for diff after 1C updates.

Usage:
    python tests/test_1c_api.py
    python tests/test_1c_api.py --host 10.0.0.1 --port 8232 --db my_base
    python tests/test_1c_api.py --username admin --password pass
"""

import argparse
import base64
import getpass
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


# ── Coloured terminal output ───────────────────────────────────────────

def _c(code, text):
    return f"\033[{code}m{text}\033[0m"

def GREEN(text): return _c("32", text)
def RED(text): return _c("31", text)
def YELLOW(text): return _c("33", text)
def BOLD(text): return _c("1", text)


# ─── Config / CLI ──────────────────────────────────────────────────────

def _load_dotenv():
    env = Path(".env")
    if env.exists() and load_dotenv:
        load_dotenv(env)

def parse_args():
    p = argparse.ArgumentParser(description="1C API read-only endpoint tester")
    p.add_argument("--host", help="1C server host (default: SERVER_HOST from .env)")
    p.add_argument("--port", help="1C server port (default: SERVER_PORT from .env)")
    p.add_argument("--db", "--db-name", dest="db", help="1C database name (default: SERVER_DB from .env)")
    p.add_argument("--username", help="1C username (will prompt if omitted)")
    p.add_argument("--password", help="1C password (will prompt if omitted)")
    p.add_argument("--log-dir", default=".", help="Directory for the JSON log file")
    p.add_argument("--no-color", action="store_true", help="Disable coloured output")
    return p.parse_args()

def resolve_config(args):
    _load_dotenv()
    host = args.host or os.environ.get("SERVER_HOST", "127.0.0.1")
    port = args.port or os.environ.get("SERVER_PORT", "5000")
    db   = args.db   or os.environ.get("SERVER_DB",   "my_db")
    return host, port, db

def resolve_credentials(args):
    u = args.username
    p = args.password
    if not u:
        u = input("Username: ").strip()
    if not p:
        p = getpass.getpass("Password: ").strip()
    return u, p


# ─── Test HTTP client ──────────────────────────────────────────────────

class ApiTester:
    """Wraps requests.Session with 1C auth + per-request logging."""

    def __init__(self, host, port, db_name, username, password):
        self.base_url = f"http://{host}:{port}/{db_name}/hs/api/v1"
        b64 = base64.b64encode(f"{username}:{password}".encode()).decode()
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Basic {b64}",
            "Content-Type": "application/json",
        })
        self.username = username

    def get(self, endpoint, params=None):
        url = f"{self.base_url}/{endpoint}"
        t0 = time.monotonic()
        try:
            r = self.session.get(url, params=params, timeout=30)
            return self._pack(r, time.monotonic() - t0)
        except requests.exceptions.Timeout:
            return self._err("Timeout", time.monotonic() - t0, url)
        except requests.exceptions.ConnectionError:
            return self._err("ConnectionError", time.monotonic() - t0, url)
        except Exception as e:
            return self._err(str(e), time.monotonic() - t0, url)

    def _pack(self, resp, elapsed):
        out = {
            "ok": resp.ok,
            "status": resp.status_code,
            "url": resp.url,
            "elapsed": round(elapsed, 3),
            "error": None,
            "json": None,
            "text": resp.text,
        }
        try:
            out["json"] = resp.json()
        except Exception:
            pass
        if not resp.ok:
            out["error"] = f"HTTP {resp.status_code}"
        return out

    @staticmethod
    def _err(msg, elapsed, url):
        return {"ok": False, "status": 0, "url": url,
                "elapsed": round(elapsed, 3), "error": msg,
                "json": None, "text": ""}


# ─── Validation ────────────────────────────────────────────────────────

def expect(name, result, check_empty=True):
    errors = []
    if result is None:
        errors.append("no result (None)")
    elif not result.get("ok"):
        errors.append(result.get("error", "HTTP error"))
    else:
        data = result.get("json")
        if data is None:
            errors.append("response is not valid JSON")
        elif isinstance(data, dict):
            if "_error" in data:
                errors.append(f'server error: {data["_error"]}')
            elif check_empty and not data:
                pass  # empty dict might be ok
        elif isinstance(data, list):
            if check_empty and not data:
                errors.append("empty list")
    return errors


# ─── Helpers ───────────────────────────────────────────────────────────

def safe_get(d, *keys):
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k)
        elif isinstance(d, list) and isinstance(k, int) and 0 <= k < len(d):
            d = d[k]
        else:
            return None
    return d


# ═══════════════════════════════════════════════════════════════════════
#  Main
# ═══════════════════════════════════════════════════════════════════════

def main():
    args = parse_args()
    if args.no_color:
        global GREEN, RED, YELLOW, BOLD
        def identity(t): return t
        GREEN = RED = YELLOW = BOLD = identity

    host, port, db = resolve_config(args)
    user, pwd = resolve_credentials(args)

    print()
    print(BOLD(" 1C API Test Suite"))
    print(f" Target: {host}:{port}/{db}")
    print(f" User:   {user}")
    print()

    # ── Create client & quick auth check ────────────────────────────
    api = ApiTester(host, port, db, user, pwd)
    auth = api.get("login")
    if auth.get("status") != 200:
        print(f" {RED('✗')} Authentication FAILED — {auth.get('error')}")
        sys.exit(1)
    print(f" {GREEN('✓')} Authenticated — {api.base_url}")
    print()

    # ── Log file ────────────────────────────────────────────────────
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = Path(args.log_dir) / f"test_1c_api_{ts}.json"
    log_entries = []

    passed = failed = skipped = 0

    def test(name, fn, *args, _empty_ok=False, **kwargs):
        nonlocal passed, failed
        t0 = time.monotonic()
        result = fn(*args, **kwargs)
        errs = expect(name, result, check_empty=not _empty_ok)
        ok = not errs
        elapsed = result.get("elapsed", 0) if result else 0

        log_entries.append({
            "timestamp": datetime.now().isoformat(),
            "endpoint": name,
            "status": "PASS" if ok else "FAIL",
            "url": result.get("url") if result else None,
            "status_code": result.get("status") if result else None,
            "elapsed": elapsed,
            "error": result.get("error") if result else None,
            "response_size": len(result.get("text") or "") if result else 0,
            "validation_errors": errs,
        })

        if ok:
            passed += 1
            print(f"  {GREEN('✓')} {name:42s} {GREEN(str(result.get('status'))+'  '+f'{elapsed:.2f}s'):>12s}")
        else:
            failed += 1
            msg = errs[0] if errs else (result.get("error") or "FAIL")
            print(f"  {RED('✗')} {name:42s} {RED(msg):>20s}")

        return result

    def skip(name, reason):
        nonlocal skipped
        skipped += 1
        log_entries.append({
            "timestamp": datetime.now().isoformat(),
            "endpoint": name,
            "status": "SKIP",
            "url": None,
            "status_code": None,
            "elapsed": None,
            "error": reason,
            "response_size": 0,
            "validation_errors": [reason],
        })
        print(f"  {YELLOW('⚠')} {name:42s} {YELLOW(reason):>20s}")

    print(BOLD(" ── Reference data ─────────────────────────────────────"))
    r_storages = test("storages", api.get, "storages")
    r_products = test("products", api.get, "products")
    r_clients  = test("clients",  api.get, "clients")
    r_depts    = test("ppr_departments", api.get, "ppr_departments",
                      {"year": 2026, "quarter": 2})

    # Extract GUIDs for dependent tests
    ctx = {"username": user}

    if r_storages and r_storages.get("json"):
        lst = r_storages["json"]
        if isinstance(lst, list) and lst:
            ctx["storage_guid"] = safe_get(lst[0], "guid")
            ctx["storage_name"] = safe_get(lst[0], "name")

    if r_products and r_products.get("json"):
        lst = r_products["json"]
        ctx["has_products"] = isinstance(lst, list) and len(lst) > 0

    print()
    print(BOLD(" ── Task & salary lists ────────────────────────────────"))
    r_tasks_user       = test("tasks-user",       api.get, "tasks-user",
                             {"limit": 5})
    r_tasks_unalloc    = test("tasks-unallocated", api.get, "tasks-unallocated",
                             {"limit": 5})
    r_closed_tasks     = test("closed-tasks-user", api.get, "closed-tasks-user",
                             {"limit": 5})
    r_stock_transfers  = test("stock-transfers",        api.get, "stock-transfers")
    r_stock_hist       = test("stock-transfers-history", api.get, "stock-transfers-history")
    r_notifications    = test("user-notifications", api.get, "user-notifications",
                             _empty_ok=True)

    # Extract a sample task GUID
    task_guid = None
    if r_tasks_user and r_tasks_user.get("json"):
        data = r_tasks_user["json"]
        tasks = data.get("tasks") or data.get("docs") or []
        if tasks:
            task_guid = safe_get(tasks[0], "guid")
    ctx["task_guid"] = task_guid

    # Extract stock-transfer GUIDs for attachment tests
    st_guid = st_att_guid = None
    if r_stock_transfers and r_stock_transfers.get("json"):
        lst = r_stock_transfers["json"]
        if isinstance(lst, list) and lst:
            st_guid = safe_get(lst[0], "guid")
            attachments = safe_get(lst[0], "attachments") or []
            if attachments:
                st_att_guid = safe_get(attachments[0], "guid")
    ctx["st_guid"] = st_guid
    ctx["st_att_guid"] = st_att_guid

    # For history attachment
    hist_guid = hist_att_guid = hist_date = None
    if r_stock_hist and r_stock_hist.get("json"):
        lst = r_stock_hist["json"]
        if isinstance(lst, list) and lst:
            hist_guid = safe_get(lst[0], "guid")
            attachments = safe_get(lst[0], "attachments") or []
            if attachments:
                hist_att_guid = safe_get(attachments[0], "guid")
            hist_date = safe_get(lst[0], "date")
    ctx["hist_guid"] = hist_guid
    ctx["hist_att_guid"] = hist_att_guid
    ctx["hist_date"] = hist_date

    print()
    print(BOLD(" ── Detailed / parameterized endpoints ─────────────────"))

    if ctx.get("storage_guid"):
        sg = ctx["storage_guid"]
        test("balances-report", api.get, "balances-report",
             {"storage": sg})
        test("balances-pick", api.get, "balances-pick",
             {"storage": sg})
        today = datetime.now()
        start = today - timedelta(days=30)
        test("movements", api.get, "movements", {
            "storage": sg,
            "start_date": start.strftime("%Y-%m-%d"),
            "end_date":   today.strftime("%Y-%m-%d"),
        })
    else:
        skip("balances-report", "no storage GUID")
        skip("balances-pick",   "no storage GUID")
        skip("movements",       "no storage GUID")

    if ctx.get("task_guid"):
        tg = ctx["task_guid"]
        test("task",            api.get, "task",           {"guid": tg})
        test("task-is-closed",  api.get, "task-is-closed", {"guid": tg})
        test("tasks-attachment", api.get, "tasks-attachment", {"guid": tg})
    else:
        skip("task",             "no task GUID")
        skip("task-is-closed",   "no task GUID")
        skip("tasks-attachment", "no task GUID")

    today = datetime.now()
    start_year = today.replace(month=1, day=1)
    test("salary", api.get, "salary", {
        "start_date": start_year.strftime("%Y-%m-%d"),
        "end_date":   today.strftime("%Y-%m-%d"),
    }, _empty_ok=True)

    test("ppr_list", api.get, "ppr_list",
         {"year": today.year, "quarter": (today.month - 1) // 3 + 1},
         _empty_ok=True)

    test("profile", api.get, "profile", {"username": user})

    if ctx.get("st_guid") and ctx.get("st_att_guid"):
        test("stock-transfers-attachment", api.get,
             "stock-transfers-attachment", {
                 "task_guid":       ctx["st_guid"],
                 "attachment_guid": ctx["st_att_guid"],
             })
    else:
        skip("stock-transfers-attachment", "no sample transfer with attachment")

    if ctx.get("hist_guid") and ctx.get("hist_att_guid") and ctx.get("hist_date"):
        test("stock-transfers-history-attachment", api.get,
             "stock-transfers-history-attachment", {
                 "doc_guid":        ctx["hist_guid"],
                 "attachment_guid": ctx["hist_att_guid"],
                 "date":            ctx["hist_date"],
             })
    else:
        skip("stock-transfers-history-attachment", "no sample history with attachment")

    # ── Summary ──────────────────────────────────────────────────────
    print()
    print(BOLD("=" * 50))
    print(BOLD("  Summary"))
    print(BOLD("=" * 50))
    print(f"  {GREEN(f'Passed:  {passed}')}")
    if failed:
        print(f"  {RED(f'Failed:  {failed}')}")
    if skipped:
        print(f"  {YELLOW(f'Skipped: {skipped}')}")
    print(f"  Total:   {passed + failed + skipped}")
    print(f"  Log:     {log_path}")
    print()

    # ── Save log ─────────────────────────────────────────────────────
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log_entries, f, ensure_ascii=False, indent=2)

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
