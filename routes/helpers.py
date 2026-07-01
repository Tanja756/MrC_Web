import os
import re
import json
import uuid
import base64
import secrets
import subprocess
import tempfile
import logging
import threading
import time
import fcntl
from datetime import datetime, timedelta
from functools import wraps
from flask import session, request, jsonify, redirect, url_for, Response, send_file

from api_client import OneSApiClient
from yandex_disk import YandexDiskClient, sync_tasks_to_yandex, sync_warehouse_to_yandex, sync_references_to_yandex, sync_hashes_to_yandex, process_actions
from db import (
    create_notification, get_active_notifications, dismiss_notification, dismiss_all_notifications,
    get_snapshot, save_snapshot, get_snapshot_updated_at,
    get_announcements,
    get_task_snapshot, save_task_snapshot, notification_exists, get_new_task_guids,
    save_subscription, get_subscriptions, get_all_subscriptions,
    get_all_task_snapshot_users,
    delete_subscription, delete_user_subscriptions,
    save_user_credentials, get_user_credentials, get_all_users_with_credentials,
    set_task_taken, set_task_closed, get_tasks_tracking,
    get_task_user_snapshot, save_task_user_snapshot,
    count_user_notifications,
    get_balance_item_meta, set_balance_item_broken, get_notification_by_id,
    get_arrival_overrides, set_arrival_override,
    sync_products, get_products_dict,
    sync_product_instances_from_balances, sync_product_instances_from_items,
)

logger = logging.getLogger(__name__)

SERVER_HOST = os.environ.get('SERVER_HOST', '127.0.0.1')
SERVER_PORT = os.environ.get('SERVER_PORT', '5000')
SERVER_DB = os.environ.get('SERVER_DB', 'my_db')

VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_CLAIM_EMAIL = os.environ.get('VAPID_CLAIM_EMAIL', 'admin@example.com')

BACKGROUND_CHECK_INTERVAL = int(os.environ.get('BACKGROUND_CHECK_INTERVAL', '600'))
BALANCE_STALE_THRESHOLD = int(os.environ.get('BALANCE_STALE_THRESHOLD', '600'))
ACTION_CHECK_INTERVAL = int(os.environ.get('ACTION_CHECK_INTERVAL', '60'))
BACKGROUND_LOCK_PATH = "/tmp/mrcheck_background.lock"
_background_timer = None
_background_stop = threading.Event()


def get_api_client():
    if not session.get('authenticated'):
        return None
    host = session.get('server_host', SERVER_HOST)
    port = session.get('server_port', SERVER_PORT)
    db_name = session.get('db_name', SERVER_DB)
    username = session.get('username')
    password = session.get('password')
    if not username or not password:
        return None
    return OneSApiClient(
        host=host, port=port, db_name=db_name,
        username=username, password=password,
    )


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('authenticated'):
            return redirect(url_for('auth.login'))
        return f(*args, **kwargs)
    return decorated


def api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('authenticated'):
            return jsonify({'error': 'Session expired'}), 401
        return f(*args, **kwargs)
    return decorated


# --- TASK HELPERS ---

TASK_FIELDS = {
    'guid', 'number', 'name', 'description', 'status', 'name_department',
    'user', 'guid_client', 'hasAttachments', 'date', 'period', 'priority',
    'comments', 'closed_at',
}


def project_tasks(tasks):
    return [{k: v for k, v in t.items() if k in TASK_FIELDS} for t in tasks]


def attach_tracking(tasks, username):
    if not tasks or not username:
        return
    guids = [t.get('guid') for t in tasks if t.get('guid')]
    tracking = get_tasks_tracking(guids, username)
    for t in tasks:
        g = t.get('guid')
        if g in tracking:
            if tracking[g].get('taken_at'):
                t['taken_at'] = tracking[g]['taken_at']
            if tracking[g].get('closed_at'):
                t['closed_at'] = tracking[g]['closed_at']
        if not t.get('taken_at'):
            t['taken_at'] = t.get('date')
        if not t.get('closed_at'):
            t['closed_at'] = t.get('date')


def auto_close_tracked_tasks(tasks, username):
    """If a task was taken via web app (has taken_at in local tracking)
    but closed externally (no closed_at), set closed_at to now if now <= period."""
    if not tasks or not username:
        return
    now = datetime.now()
    guids = [t.get('guid') for t in tasks if t.get('guid')]
    tracking = get_tasks_tracking(guids, username)
    for t in tasks:
        g = t.get('guid')
        if not g or g not in tracking:
            continue
        tr = tracking[g]
        if tr.get('taken_at') and not tr.get('closed_at'):
            period_str = t.get('period')
            if not period_str:
                continue
            deadline = parse_1c_date(period_str)
            if deadline and now <= deadline:
                set_task_closed(username, g)
                t['closed_at'] = now.strftime('%Y-%m-%d %H:%M:%S')


def parse_1c_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s, '%d.%m.%Y %H:%M:%S')
    except ValueError:
        try:
            return datetime.strptime(s, '%d.%m.%Y')
        except ValueError:
            return None


def filter_tasks(tasks, search=None, sort=None, dir='desc'):
    if search:
        q = search.lower()
        tasks = [t for t in tasks if any(
            q in (str(t.get(f)) or '').lower()
            for f in ('number', 'name', 'status', 'name_department', 'user')
        )]
    reverse = (dir == 'desc')
    if sort == 'priority':
        tasks.sort(key=lambda t: t.get('priority') or 0, reverse=reverse)
    elif sort == 'deadline':
        tasks.sort(key=lambda t: parse_1c_date(t.get('period')) or (datetime.max if not reverse else datetime.min), reverse=reverse)
    elif sort == 'closed_at':
        def _ck(t):
            v = t.get('closed_at')
            if v:
                try:
                    return datetime.strptime(v, '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    pass
                p = parse_1c_date(v)
                if p:
                    return p
            return datetime.min if not reverse else datetime.max
        tasks.sort(key=_ck, reverse=reverse)
    else:
        tasks.sort(key=lambda t: parse_1c_date(t.get('date')) or (datetime.min if reverse else datetime.max), reverse=reverse)
    tasks.sort(key=lambda t: 0 if 'Подтвердить' in (t.get('status') or '') or 'подтвердить' in (t.get('status') or '') else 1)
    return tasks


def paginate(tasks, limit, offset):
    total = len(tasks)
    if limit and limit > 0:
        tasks = tasks[offset:offset + limit]
    elif offset:
        tasks = tasks[offset:]
    return tasks, total


# --- WAREHOUSE HELPERS ---

def get_storage_name(client, storage_guid):
    if not client or not storage_guid:
        return ''
    storages = client.get_storages()
    for s in storages:
        if s.get('guid') == storage_guid:
            return s.get('name', '')
    return ''


def short_date(val):
    if not val:
        return val
    s = val[:10] if len(val) > 10 else val
    try:
        d = datetime.strptime(s, '%Y-%m-%d')
        return d.strftime('%d.%m.%Y')
    except ValueError:
        return s


def plural(n):
    n = abs(n) % 100
    if n >= 5 and n <= 20: return 'позиций'
    n %= 10
    if n == 1: return 'позиция'
    if n >= 2 and n <= 4: return 'позиции'
    return 'позиций'


def warehouse_pdf_html(storage_name, date_str, balances):
    rows = ''.join(
        f'<tr><td class="num">{i+1}</td>'
        f'<td>{b.get("name", "—")}</td>'
        f'<td>{b.get("series", "—")}</td>'
        f'<td>{b.get("inv", "—")}</td>'
        f'<td>{short_date(b.get("date_arrival")) or "—"}</td>'
        f'<td>{short_date(b.get("date_writeoff")) if b.get("date_writeoff") is not None else "В наличии"}</td>'
        f'<td class="balance">{b.get("balance", 0)}</td></tr>'
        for i, b in enumerate(balances)
    )
    total = sum(b.get('balance', 0) for b in balances)
    return f'''<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8">
<style>
@page {{ margin: 14mm 10mm; }}
body {{ font-family: 'Liberation Sans', 'Arial', sans-serif; font-size: 9pt; color: #1a1a1a; }}
.header {{ display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid #d32f2f; }}
.header h1 {{ font-size: 13pt; margin: 0; color: #d32f2f; }}
.header .meta {{ font-size: 8pt; color: #666; text-align: right; line-height: 1.4; }}
table {{ width: 100%; border-collapse: collapse; }}
th {{ background: #f5f5f5; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.8px; padding: 5px 7px; text-align: left; border-bottom: 1px solid #ccc; color: #666; }}
td {{ padding: 4px 7px; border-bottom: 1px solid #eee; font-size: 8.5pt; }}
td.num {{ text-align: center; color: #999; width: 28px; }}
td.balance {{ text-align: right; font-weight: 700; font-size: 9pt; }}
tr:nth-child(even) td {{ background: #fafafa; }}
.footer {{ margin-top: 16px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 7.5pt; color: #999; text-align: center; }}
.total {{ text-align: right; font-weight: 700; margin-top: 6px; font-size: 9pt; }}
</style></head>
<body>
<div class="header">
    <div><h1>Остатки склада</h1><div style="font-size:8.5pt;color:#444;margin-top:3px;">{storage_name}</div></div>
    <div class="meta">Дата: {date_str}<br>Всего: {len(balances)} {plural(len(balances))}</div>
</div>
<table>
<tr><th>#</th><th>Товар</th><th>Серия</th><th>Инв. номер</th><th>Поступление</th><th>Списание</th><th style="text-align:right">Остаток</th></tr>
{rows}
</table>
<div class="total">Итого: {total} шт.</div>
<div class="footer">Сгенерировано Mr.Check</div>
</body></html>'''


def check_balance_changes(username, storage_guid, new_data, storage_name=''):
    if not username or not new_data:
        return
    sync_product_instances_from_balances(new_data, storage_guid)
    old = get_snapshot(username, storage_guid)
    if old is None:
        save_snapshot(username, storage_guid, new_data)
        return

    def key(item):
        return f"{item.get('product_name','')}|{item.get('series_name','') or ''}|{item.get('inventory_number','') or ''}"

    old_map = {key(item): item for item in old}
    new_map = {key(item): item for item in new_data}

    added = []
    removed = []

    for k, item in new_map.items():
        old_item = old_map.get(k)
        if not old_item:
            added.append((item.get('balance', 0), item.get('product_name', '?'),
                         item.get('series_name', ''), item.get('inventory_number', '')))
        else:
            diff = (item.get('balance', 0) or 0) - (old_item.get('balance', 0) or 0)
            if diff > 0:
                added.append((diff, item.get('product_name', '?'),
                             item.get('series_name', ''), item.get('inventory_number', '')))
            elif diff < 0:
                removed.append((-diff, item.get('product_name', '?'),
                               item.get('series_name', ''), item.get('inventory_number', '')))

    for k, item in old_map.items():
        if k not in new_map:
            removed.append((item.get('balance', 0) or 0, item.get('product_name', '?'),
                           item.get('series_name', ''), item.get('inventory_number', '')))

    def _fmt_line(sign, diff, name, series, inv):
        parts = [f'{sign} {diff} шт\t{name}']
        if series:
            parts.append(f'    SN: {series}')
        return '\n'.join(parts)

    def _title_arrival():
        return f'Поступление на склад {storage_name}'.strip() if storage_name else 'Поступление на склад'

    def _title_writeoff():
        return f'Списание со склада {storage_name}'.strip() if storage_name else 'Списание со склада'

    if added:
        lines = '\n'.join(_fmt_line('+', d, n, s, i) for d, n, s, i in added)
        items_data = [{'product_name': n, 'series_name': s or '', 'inventory_number': i or ''} for d, n, s, i in added]
        if not notification_exists(username, 'warehouse_arrival', lines, 60):
            create_notification(username, 'warehouse_arrival',
                _title_arrival(), lines, storage_guid, items=items_data)
            send_push_notification(username, _title_arrival(), lines)

    if removed:
        lines = '\n'.join(_fmt_line('-', d, n, s, i) for d, n, s, i in removed)
        if not notification_exists(username, 'warehouse_writeoff', lines, 60):
            create_notification(username, 'warehouse_writeoff',
                _title_writeoff(), lines, storage_guid)
            send_push_notification(username, _title_writeoff(), lines)

    save_snapshot(username, storage_guid, new_data)


def sync_and_enrich_products(items, client=None, key='product_guid'):
    """Fetch products from 1C, sync to local DB, enrich items with product_name.
    Falls back to local cache when 1C is unreachable or product is missing from API."""
    if client:
        try:
            api_products = client.get_products()
            if api_products:
                sync_products(api_products)
        except Exception:
            pass
    cached = get_products_dict()
    for item in items:
        guid = item.get(key, '')
        if not guid:
            continue
        prod = cached.get(guid, {})
        item['product_name'] = prod.get('name', '') or prod.get('article', '') or guid
    sync_product_instances_from_items(items)


def enrich_products_to_dict(client=None):
    """Fetch products from 1C, sync to local DB, return full {guid: product} dict."""
    if client:
        try:
            api_products = client.get_products()
            if api_products:
                sync_products(api_products)
        except Exception:
            pass
    return get_products_dict()


def refresh_balance_if_stale(username, storage_guid):
    updated_at = get_snapshot_updated_at(username, storage_guid)
    if updated_at:
        try:
            dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
            if (datetime.now() - dt).total_seconds() < BALANCE_STALE_THRESHOLD:
                return
        except (ValueError, TypeError):
            pass
    client = get_api_client()
    if not client:
        return
    data = client.get_balances(storage_guid)
    if data is not None:
        storage_name = get_storage_name(client, storage_guid)
        check_balance_changes(username, storage_guid, data, storage_name)


# --- NOTIFICATION HELPERS ---

def send_push_notification(username, title, body):
    if not VAPID_PUBLIC_KEY or not VAPID_PRIVATE_KEY:
        return
    subs = get_subscriptions(username)
    if not subs:
        return
    from pywebpush import webpush
    payload = json.dumps({'title': title, 'body': body})
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    'endpoint': sub['endpoint'],
                    'keys': {'auth': sub['auth'], 'p256dh': sub['p256dh']},
                },
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={'sub': f'mailto:{VAPID_CLAIM_EMAIL}'},
            )
        except Exception as e:
            err_str = str(e)
            if '410' in err_str or '404' in err_str or '401' in err_str:
                delete_subscription(sub['endpoint'])
            else:
                logger.warning(f"push failed for {username}: {err_str[:120]}")


def copy_seed_notifications(username):
    seeds = get_active_notifications('__seed__')
    if not seeds:
        return
    if count_user_notifications(username) > 0:
        return
    for s in seeds:
        create_notification(username, s['type'], s['title'], s['description'], None)
        send_push_notification(username, s['title'], s['description'])


def _task_matches_keywords(task, keywords_str):
    if not keywords_str:
        return True
    keywords = [k.strip().lower() for k in keywords_str.split(',') if k.strip()]
    if not keywords:
        return True
    text = f"{task.get('name', '')} {task.get('number', '')}".lower()
    return any(k in text for k in keywords)


def check_deadlines(tasks, username, now, notify_only_mine=False, my_task_keywords=''):
    for task in tasks:
        if task.get('priority') == 700:
            continue
        if notify_only_mine and not _task_matches_keywords(task, my_task_keywords):
            continue
        period_str = task.get('period') or task.get('date')
        if not period_str:
            continue
        try:
            m = re.match(r'(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})', period_str)
            if m:
                deadline = datetime(int(m[3]), int(m[2]), int(m[1]), int(m[4]), int(m[5]), int(m[6]))
            else:
                m2 = re.match(r'(\d{2})\.(\d{2})\.(\d{4})', period_str)
                if m2:
                    deadline = datetime(int(m2[3]), int(m2[2]), int(m2[1]), 23, 59, 59)
                else:
                    continue
            diff = (deadline - now).total_seconds()
            task_label = f'Заявка {task.get("number", "")} "{task.get("name", "")}"'
            if diff < 0:
                desc = f'{task_label}\nСрок был: {period_str}'
                if not notification_exists(username, 'task_deadline', desc, None):
                    create_notification(username, 'task_deadline', 'Срок заявки истёк', desc)
                    send_push_notification(username, 'Срок заявки истёк', desc.replace('\n', ' — '))
            elif diff < 7200:
                desc = f'{task_label}\nОсталось менее 2 часов'
                if not notification_exists(username, 'task_deadline', desc, None):
                    create_notification(username, 'task_deadline', 'Срок заявки истекает', desc)
                    send_push_notification(username, 'Срок заявки истекает', desc.replace('\n', ' — '))
        except Exception:
            continue


def check_new_free_tasks(username, free_tasks, old_data, notify_only_mine=False, my_task_keywords=''):
    current_free_guids = {t.get('guid', '') for t in free_tasks if t.get('guid')}
    if old_data is None:
        save_task_snapshot(username, list(current_free_guids))
        logger.info(f"Initial task snapshot saved for '{username}' (cache was empty)")
        return
    old_free_guids = set(old_data)
    new_guids = current_free_guids - old_free_guids
    for task in free_tasks:
        if task.get('guid') in new_guids:
            if notify_only_mine and not _task_matches_keywords(task, my_task_keywords):
                continue
            desc = f'Заявка {task.get("number", "")} "{task.get("name", "")}"'
            if not notification_exists(username, 'new_task', desc, None):
                create_notification(username, 'new_task', 'Новая свободная заявка', desc, task.get('guid'))
                send_push_notification(username, 'Новая свободная заявка', desc)
    save_task_snapshot(username, list(current_free_guids))


def _track_task_transitions(username, user_tasks, free_tasks, closed_tasks, old_free_data):
    current_user_guids = {t['guid'] for t in user_tasks if t.get('guid')}
    current_closed_guids = {t['guid'] for t in closed_tasks if t.get('guid')}

    old_free_guids = set(old_free_data) if old_free_data else set()
    old_user_data, _ = get_task_user_snapshot(username)
    old_user_guids = set(old_user_data) if old_user_data else set()

    taken_guids = (old_free_guids & current_user_guids) - old_user_guids
    if taken_guids:
        for guid in taken_guids:
            set_task_taken(username, guid)
            logger.info(f"Background: task '{guid}' taken by '{username}' (transition detected)")

    closed_guids = old_user_guids & current_closed_guids
    if closed_guids:
        tracking = get_tasks_tracking(list(closed_guids), username)
        for guid in closed_guids:
            if not tracking.get(guid, {}).get('closed_at'):
                set_task_closed(username, guid)
                logger.info(f"Background: task '{guid}' closed for '{username}' (transition detected)")

    save_task_user_snapshot(username, list(current_user_guids))


def check_tasks(username):
    if not username:
        return
    old_data, updated_at = get_task_snapshot(username)
    if updated_at:
        try:
            dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
            if (datetime.now() - dt).total_seconds() < BACKGROUND_CHECK_INTERVAL:
                return
        except (ValueError, TypeError):
            pass
    client = get_api_client()
    if not client:
        return
    now = datetime.now()
    try:
        user_data = client.get_tasks_user(limit=200)
        user_tasks = project_tasks(user_data.get('tasks', []))
    except Exception as e:
        logger.error(f"check_tasks: get_tasks_user failed — {e}")
        user_tasks = []
    try:
        free_data = client.get_tasks_unallocated(limit=200)
        free_tasks = project_tasks(free_data.get('tasks', []))
    except Exception as e:
        logger.error(f"check_tasks: get_tasks_unallocated failed — {e}")
        free_tasks = []

    try:
        from db import get_user_settings
        settings = get_user_settings(username)
        notify_only_mine = bool(settings and settings.get('notify_only_mine'))
        my_task_keywords = (settings or {}).get('my_task_keywords', '')
    except Exception:
        notify_only_mine = False
        my_task_keywords = ''

    check_deadlines(user_tasks + free_tasks, username, now, notify_only_mine, my_task_keywords)
    check_new_free_tasks(username, free_tasks, old_data, notify_only_mine, my_task_keywords)


# --- BACKGROUND WORKER ---

def get_background_api_client(username):
    host = SERVER_HOST
    port = SERVER_PORT
    db_name = SERVER_DB
    password = get_user_credentials(username)
    if not password:
        logger.warning(f"Background: no stored credentials for {username}")
        return None
    return OneSApiClient(
        host=host, port=port, db_name=db_name,
        username=username, password=password,
    )


def background_check_balances(client, username):
    if not client or not username:
        return
    try:
        storages = client.get_storages()
        if not storages:
            return
        for storage in storages:
            storage_guid = storage.get('guid')
            if not storage_guid:
                continue
            updated_at = get_snapshot_updated_at(username, storage_guid)
            if updated_at:
                try:
                    dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
                    if (datetime.now() - dt).total_seconds() < BALANCE_STALE_THRESHOLD:
                        continue
                except (ValueError, TypeError):
                    pass
            data = client.get_balances(storage_guid)
            if data is not None:
                storage_name = storage.get('name', '')
                check_balance_changes(username, storage_guid, data, storage_name)
                logger.info(f"Background: balance checked for '{username}' storage '{storage_guid}'")
    except Exception as e:
        logger.warning(f"Background: failed to check balances for {username}: {e}")


def background_check_user(username, force=False):
    if not username:
        return
    if not force:
        old_data, updated_at = get_task_snapshot(username)
        if updated_at:
            try:
                dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
                if (datetime.now() - dt).total_seconds() < BACKGROUND_CHECK_INTERVAL:
                    return
            except (ValueError, TypeError):
                pass
    else:
        old_data, _ = get_task_snapshot(username)
    client = get_background_api_client(username)
    if not client:
        return
    now = datetime.now()
    user_data = {}
    user_tasks = []
    try:
        user_data = client.get_tasks_user(limit=200) or {}
        user_tasks = user_data.get('tasks', [])
    except Exception as e:
        logger.warning(f"Background: failed to fetch user tasks for {username}: {e}")
    free_data = {}
    free_tasks = []
    try:
        free_data = client.get_tasks_unallocated(limit=200) or {}
        free_tasks = free_data.get('tasks', [])
    except Exception as e:
        logger.warning(f"Background: failed to fetch free tasks for {username}: {e}")
    closed_data = {}
    closed_tasks = []
    try:
        closed_data = client.get_closed_tasks_user(limit=200) or {}
        closed_tasks = closed_data.get('tasks', [])
    except Exception as e:
        logger.warning(f"Background: failed to fetch closed tasks for {username}: {e}")
        closed_data = {}
        closed_tasks = []
    try:
        from db import get_user_settings
        settings = get_user_settings(username)
        notify_only_mine = bool(settings and settings.get('notify_only_mine'))
        my_task_keywords = (settings or {}).get('my_task_keywords', '')
    except Exception:
        notify_only_mine = False
        my_task_keywords = ''

    check_deadlines(user_tasks + free_tasks, username, now, notify_only_mine, my_task_keywords)
    _track_task_transitions(username, user_tasks, free_tasks, closed_tasks, old_data)
    check_new_free_tasks(username, free_tasks, old_data, notify_only_mine, my_task_keywords)
    background_check_balances(client, username)

    process_actions(username, client)

    attach_tracking(user_tasks, username)
    attach_tracking(closed_tasks, username)

    yandex = YandexDiskClient()
    sync_tasks_to_yandex(username, user_data, free_data, closed_data, yandex=yandex)
    sync_references_to_yandex(username, client, yandex=yandex)

    try:
        products = client.get_products()
        if products:
            sync_products(products)
    except Exception as e:
        logger.warning("Background: failed to sync products: %s", e)

    auto_close_tracked_tasks(closed_tasks, username)

    try:
        warehouse_data = {}
        storages = client.get_storages()
        if storages:
            for storage in storages:
                guid = storage.get('guid')
                snap = get_snapshot(username, guid)
                if snap is not None:
                    warehouse_data[guid] = snap
        sync_warehouse_to_yandex(username, warehouse_data, yandex=yandex)
    except Exception as e:
        logger.warning("Background: failed to prepare warehouse data for Yandex sync: %s", e)

    sync_hashes_to_yandex(username, yandex=yandex)


def background_check_all_users():
    subs = get_all_subscriptions()
    if not subs:
        return
    users = {}
    for sub in subs:
        username = sub['username']
        if username not in users:
            users[username] = []
        users[username].append(sub)
    for username in users:
        background_check_user(username)
    all_snapshot_users = get_all_task_snapshot_users()
    for username in all_snapshot_users:
        if username not in users:
            background_check_user(username)


def _is_working_hours():
    h = datetime.now().hour
    return 7 <= h < 23

def _try_background_lock():
    """Try to acquire inter-process flock. Returns fd on success, None on failure."""
    fd = None
    try:
        fd = os.open(BACKGROUND_LOCK_PATH, os.O_RDWR | os.O_CREAT, 0o644)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (IOError, OSError):
        if fd is not None:
            os.close(fd)
        return None

def background_check_loop():
    last_action_check = 0.0
    last_full_check = 0.0
    while not _background_stop.is_set():
        if _is_working_hours():
            now = time.time()
            action_due = (now - last_action_check) >= ACTION_CHECK_INTERVAL
            full_due = (now - last_full_check) >= BACKGROUND_CHECK_INTERVAL

            if action_due or full_due:
                lock_fd = _try_background_lock()
                if not lock_fd:
                    logger.debug("Background: another worker holds the lock, skipping cycle")
                    _background_stop.wait(min(ACTION_CHECK_INTERVAL, BACKGROUND_CHECK_INTERVAL))
                    continue
                try:
                    all_users = set()
                    for sub in get_all_subscriptions():
                        all_users.add(sub['username'])
                    for uname in get_all_task_snapshot_users():
                        all_users.add(uname)

                    actions_found = set()
                    if action_due:
                        for username in sorted(all_users):
                            client = get_background_api_client(username)
                            if client and process_actions(username, client):
                                actions_found.add(username)
                        last_action_check = time.time()

                    if full_due or actions_found:
                        users_to_check = all_users if full_due else actions_found
                        for username in sorted(users_to_check):
                            force = username in actions_found
                            try:
                                background_check_user(username, force=force)
                            except Exception as e:
                                logger.warning(f"Background check failed for {username}: {e}")
                        last_full_check = time.time()
                finally:
                    os.close(lock_fd)

        sleep_interval = min(ACTION_CHECK_INTERVAL, BACKGROUND_CHECK_INTERVAL)
        _background_stop.wait(sleep_interval)


def start_background_worker():
    global _background_timer
    if _background_timer is not None:
        return
    _background_stop.clear()
    thread = threading.Thread(target=background_check_loop, daemon=True)
    thread.start()
    _background_timer = thread
    logger.info("Background push notification worker started (interval=%ds)", BACKGROUND_CHECK_INTERVAL)


def stop_background_worker():
    _background_stop.set()
