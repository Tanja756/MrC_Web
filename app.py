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
from datetime import datetime, timedelta
from functools import wraps
from dotenv import load_dotenv
from flask import (Flask, render_template, request, redirect,
                   url_for, session, jsonify, flash, send_file, Response)

from config import config
from api_client import OneSApiClient
from db import (
    create_notification, get_active_notifications, dismiss_notification, dismiss_all_notifications,
    get_snapshot, save_snapshot, get_snapshot_updated_at,
    get_announcements,
    get_task_snapshot, save_task_snapshot, notification_exists,
    save_subscription, get_subscriptions, get_all_subscriptions,
    get_all_task_snapshot_users,
    delete_subscription, delete_user_subscriptions,
    save_user_credentials, get_user_credentials, get_all_users_with_credentials,
    set_task_taken, set_task_closed, get_tasks_tracking,
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
env = os.environ.get('FLASK_ENV', 'development')
app.config.from_object(config.get(env, config['development']))
app.config['ENV'] = env
app.jinja_env.auto_reload = True

SERVER_HOST = os.environ.get('SERVER_HOST', '127.0.0.1')
SERVER_PORT = os.environ.get('SERVER_PORT', '5000')
SERVER_DB = os.environ.get('SERVER_DB', 'my_db')

VAPID_PUBLIC_KEY = os.environ.get('VAPID_PUBLIC_KEY', '')
VAPID_PRIVATE_KEY = os.environ.get('VAPID_PRIVATE_KEY', '')
VAPID_CLAIM_EMAIL = os.environ.get('VAPID_CLAIM_EMAIL', 'admin@example.com')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


@app.context_processor
def inject_now():
    return {'now': datetime.now}


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
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def api_login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('authenticated'):
            return jsonify({'error': 'Session expired'}), 401
        return f(*args, **kwargs)
    return decorated


@app.route('/')
def index():
    if session.get('authenticated'):
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        csrf_token = secrets.token_hex(32)
        session['csrf_token'] = csrf_token
        session.permanent = True

    if request.method == 'POST':
        token = session.get('csrf_token')
        form_token = request.form.get('csrf_token')
        if not token or not form_token or not secrets.compare_digest(token, form_token):
            flash('Session expired, please try again', 'warning')
            csrf_token = secrets.token_hex(32)
            session['csrf_token'] = csrf_token
            return render_template('login.html')

        host = SERVER_HOST
        port = SERVER_PORT
        db_name = SERVER_DB
        if not host or not port or not db_name:
            flash('Server, port and database must be configured', 'danger')
            return render_template('login.html')

        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()

        try:
            client = OneSApiClient(
                host=host, port=port, db_name=db_name,
                username=username, password=password,
            )
            data = client.login()
        except Exception as e:
            flash(f"Connection failed: {e}", 'danger')
            return render_template('login.html')

        session['authenticated'] = True
        session['server_host'] = host
        session['server_port'] = port
        session['db_name'] = db_name
        session['username'] = username
        session['password'] = password
        session['priorities'] = data.get('priorities', [])
        session['divisions'] = data.get('divisions', [])
        session['last_login'] = datetime.now().isoformat()

        # Сохраняем credentials в БД для фоновой проверки уведомлений
        try:
            save_user_credentials(username, password)
        except Exception as e:
            logger.warning(f"Failed to save credentials for {username}: {e}")

        return redirect(url_for('dashboard'))

    return render_template('login.html')


@app.route('/logout')
def logout():
    username = session.get('username', '')
    if username:
        delete_user_subscriptions(username)
    session.clear()
    return redirect(url_for('login'))


@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html')


# --- TASKS ---

TASK_FIELDS = {
    'guid', 'number', 'name', 'description', 'status', 'name_department',
    'user', 'guid_client', 'hasAttachments', 'date', 'period', 'priority',
    'comments',
}


def _project_tasks(tasks):
    return [{k: v for k, v in t.items() if k in TASK_FIELDS} for t in tasks]


def _attach_tracking(tasks, username):
    if not tasks or not username:
        return
    guids = [t.get('guid') for t in tasks if t.get('guid')]
    tracking = get_tasks_tracking(guids, username)
    for t in tasks:
        g = t.get('guid')
        if g in tracking:
            t['taken_at'] = tracking[g].get('taken_at')
            t['closed_at'] = tracking[g].get('closed_at')
        else:
            if not t.get('taken_at'):
                t['taken_at'] = t.get('date')
            if not t.get('closed_at'):
                t['closed_at'] = t.get('period')


def _parse_1c_date(s):
    """Парсит дату формата dd.MM.yyyy HH:mm:ss или dd.MM.yyyy в datetime."""
    if not s:
        return None
    try:
        return datetime.strptime(s, '%d.%m.%Y %H:%M:%S')
    except ValueError:
        try:
            return datetime.strptime(s, '%d.%m.%Y')
        except ValueError:
            return None


def _filter_tasks(tasks, search=None, sort=None, dir='desc'):
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
        tasks.sort(key=lambda t: _parse_1c_date(t.get('period')) or (datetime.max if not reverse else datetime.min), reverse=reverse)
    elif sort == 'closed_at':
        def _ck(t):
            v = t.get('closed_at')
            if v:
                try:
                    return datetime.strptime(v, '%Y-%m-%d %H:%M:%S')
                except ValueError:
                    pass
            return datetime.min if not reverse else datetime.max
        tasks.sort(key=_ck, reverse=reverse)
    else:
        tasks.sort(key=lambda t: _parse_1c_date(t.get('date')) or (datetime.min if reverse else datetime.max), reverse=reverse)
    tasks.sort(key=lambda t: 0 if 'Подтвердить' in (t.get('status') or '') or 'подтвердить' in (t.get('status') or '') else 1)
    return tasks


def _paginate(tasks, limit, offset):
    total = len(tasks)
    if limit and limit > 0:
        tasks = tasks[offset:offset + limit]
    elif offset:
        tasks = tasks[offset:]
    return tasks, total


@app.route('/api/tasks/my')
@api_login_required
def api_tasks_my():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": [], "total": 0})
    search = request.args.get('search')
    sort = request.args.get('sort')
    dir = request.args.get('dir', 'desc')
    limit = request.args.get('limit', 30, type=int)
    offset = request.args.get('offset', 0, type=int)
    username = session.get('username', '')
    data = client.get_tasks_user(limit=5000, offset=0)
    tasks = _project_tasks(data.get('tasks', []))
    _attach_tracking(tasks, username)
    tasks = _filter_tasks(tasks, search, sort, dir)
    tasks, total = _paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@app.route('/api/tasks/free')
@api_login_required
def api_tasks_free():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": [], "total": 0})
    search = request.args.get('search')
    sort = request.args.get('sort')
    dir = request.args.get('dir', 'desc')
    limit = request.args.get('limit', 30, type=int)
    offset = request.args.get('offset', 0, type=int)
    # Получаем все заявки с сервера (5000), поиск и сортировка — локально
    data = client.get_tasks_unallocated(limit=5000, offset=0)
    tasks = _project_tasks(data.get('tasks', []))
    tasks = _filter_tasks(tasks, search, sort, dir)
    tasks, total = _paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@app.route('/api/tasks/closed')
@api_login_required
def api_tasks_closed():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": [], "total": 0})
    search = request.args.get('search')
    sort = request.args.get('sort')
    dir = request.args.get('dir', 'desc')
    limit = request.args.get('limit', 30, type=int)
    offset = request.args.get('offset', 0, type=int)
    username = session.get('username', '')
    data = client.get_closed_tasks_user(limit=5000, offset=0)
    tasks = _project_tasks(data.get('tasks', []))
    _attach_tracking(tasks, username)
    tasks = _filter_tasks(tasks, search, sort, dir)
    tasks, total = _paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@app.route('/api/tasks/<guid>')
@api_login_required
def api_task_detail(guid):
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            for t in data['tasks']:
                if t.get('guid') == guid:
                    return jsonify(t)
    return jsonify({'error': 'Task not found'}), 404


@app.route('/api/tasks/take', methods=['POST'])
@api_login_required
def api_task_take():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    guid = request.json.get('guid')
    if not guid:
        return jsonify({'error': 'GUID required'}), 400
    result = client.task_take(guid)
    if result and result.get('status') in ('Выполнить', 'OK'):
        set_task_taken(session.get('username', ''), guid)
    return jsonify(result or {'error': 'Failed to take task'})


@app.route('/api/tasks/take-bulk', methods=['POST'])
@api_login_required
def api_task_take_bulk():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    guids = request.json.get('guids', [])
    if not guids or not isinstance(guids, list):
        return jsonify({'error': 'Array of GUIDs required'}), 400
    username = session.get('username', '')
    results = []
    for guid in guids:
        result = client.task_take(guid)
        ok = bool(result and (result.get('status') in ('Выполнить', 'OK')))
        if ok:
            set_task_taken(username, guid)
        results.append({'guid': guid, 'ok': ok, 'error': None if ok else (result.get('error') or 'Failed')})
    return jsonify({'results': results, 'total': len(results), 'taken': sum(1 for r in results if r['ok'])})


@app.route('/api/tasks/close', methods=['POST'])
@api_login_required
def api_task_close():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400

    data = request.json
    guid = data.get('guid')
    guid_doc = data.get('guidDoc', '')
    comment = data.get('comment', '')
    latitude = data.get('latitude', 0.0)
    longitude = data.get('longitude', 0.0)

    attachments = data.get('attachments', [])

    result = client.task_close(guid, guid_doc, comment, latitude, longitude, attachments)
    if result and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error'], 'detail': result}), 400
    set_task_closed(session.get('username', ''), guid)
    return jsonify({'success': True})


@app.route('/api/tasks/<guid>/attachments')
@api_login_required
def api_task_attachments(guid):
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = client.get_task_attachments(guid)
    if data is None:
        return jsonify({'attachments': []})
    return jsonify(data)


@app.route('/api/tasks/documents')
@api_login_required
def api_tasks_documents():
    # Returns document clients for the current filter
    client = get_api_client()
    data = client.get_clients() if client else []
    return jsonify(data)


# --- WAREHOUSE ---

@app.route('/api/warehouse/storages')
@api_login_required
def api_storages():
    client = get_api_client()
    data = client.get_storages() if client else []
    return jsonify(data)


@app.route('/api/warehouse/balances')
@api_login_required
def api_balances():
    client = get_api_client()
    storage_guid = request.args.get('storage')
    if not storage_guid or not client:
        return jsonify([])
    data = client.get_balances(storage_guid)
    _check_balance_changes(session.get('username', ''), storage_guid, data)
    for item in data:
        item['date_arrival'] = _short_date(item.get('date_arrival'))
        item['date_writeoff'] = _short_date(item.get('date_writeoff'))
    return jsonify(data)


def _check_balance_changes(username, storage_guid, new_data):
    if not username:
        return
    if not new_data:
        return
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

    def _fmt_line(diff, name, series, inv):
        parts = [f'- {diff} шт\t{name}']
        if series:
            parts.append(f'    SN: {series}')
        return '\n'.join(parts)

    def _fmt_line_add(diff, name, series, inv):
        parts = [f'+ {diff} шт\t{name}']
        if series:
            parts.append(f'    SN: {series}')
        return '\n'.join(parts)

    if added:
        lines = '\n'.join(_fmt_line_add(d, n, s, i) for d, n, s, i in added)
        create_notification(username, 'warehouse_arrival',
            'Поступление на склад', lines, storage_guid)
        send_push_notification(username, 'Поступление на склад', lines)

    if removed:
        lines = '\n'.join(_fmt_line(d, n, s, i) for d, n, s, i in removed)
        create_notification(username, 'warehouse_writeoff',
            'Списание со склада', lines, storage_guid)
        send_push_notification(username, 'Списание со склада', lines)

    save_snapshot(username, storage_guid, new_data)


@app.route('/api/warehouse/movements')
@api_login_required
def api_movements():
    client = get_api_client()
    storage_guid = request.args.get('storage')
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if not all([storage_guid, start_date, end_date, client]):
        return jsonify([])
    data = client.get_movements(storage_guid, start_date, end_date)
    for item in data:
        item['date_arrival'] = _short_date(item.get('date_arrival'))
        item['date_writeoff'] = _short_date(item.get('date_writeoff'))
    return jsonify(data)


def _short_date(val):
    if not val:
        return val
    s = val[:10] if len(val) > 10 else val
    try:
        d = datetime.strptime(s, '%Y-%m-%d')
        return d.strftime('%d.%m.%Y')
    except ValueError:
        return s

def _warehouse_pdf_html(storage_name, date_str, balances):
    rows = ''.join(
        f'<tr><td class="num">{i+1}</td>'
        f'<td>{b.get("name", "—")}</td>'
        f'<td>{b.get("series", "—")}</td>'
        f'<td>{b.get("inv", "—")}</td>'
        f'<td>{_short_date(b.get("date_arrival")) or "—"}</td>'
        f'<td>{_short_date(b.get("date_writeoff")) if b.get("date_writeoff") is not None else "В наличии"}</td>'
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


def plural(n):
    n = abs(n) % 100
    if n >= 5 and n <= 20: return 'позиций'
    n %= 10
    if n == 1: return 'позиция'
    if n >= 2 and n <= 4: return 'позиции'
    return 'позиций'


@app.route('/api/warehouse/export-pdf', methods=['POST'])
@api_login_required
def api_warehouse_export_pdf():
    data = request.get_json()
    storage_name = data.get('storage_name', 'Склад')
    date_str = data.get('date', datetime.now().strftime('%d.%m.%Y'))
    balances = data.get('balances', [])

    html = _warehouse_pdf_html(storage_name, date_str, balances)

    tag = uuid.uuid4().hex[:12]
    tmp_html = os.path.join(tempfile.gettempdir(), f'wh-{tag}.html')
    tmp_pdf = os.path.join(tempfile.gettempdir(), f'wh-{tag}.pdf')

    try:
        with open(tmp_html, 'w', encoding='utf-8') as f:
            f.write(html)

        lo_dir = os.path.join(tempfile.gettempdir(), f'lo-wh-{tag}')
        os.makedirs(lo_dir, exist_ok=True)
        env = os.environ.copy()
        env['HOME'] = lo_dir

        result = subprocess.run(
            ['libreoffice', '--headless', '--norestore',
             f'-env:UserInstallation=file:///{lo_dir}',
             '--convert-to', 'pdf', '--outdir', tempfile.gettempdir(), tmp_html],
            capture_output=True, text=True, timeout=60, env=env
        )

        expected = os.path.join(tempfile.gettempdir(), f'wh-{tag}.pdf')
        generated = os.path.join(tempfile.gettempdir(), f'wh-{tag}.html.pdf')
        if os.path.exists(generated):
            os.rename(generated, expected)
        if not os.path.exists(expected) or os.path.getsize(expected) < 100:
            raise RuntimeError(result.stderr or 'PDF not generated')

        safe_name = re.sub(r'[^\w\s-]', '', storage_name).strip().replace(' ', '_')
        filename = f'{safe_name}_{date_str.replace(".", "")}.pdf'

        response = send_file(expected, mimetype='application/pdf',
                             as_attachment=True, download_name=filename)

        @response.call_on_close
        def cleanup():
            for p in [tmp_html, expected, lo_dir]:
                try:
                    if os.path.isfile(p): os.unlink(p)
                    elif os.path.isdir(p): os.rmdir(p)
                except Exception:
                    pass
        return response
    except Exception as e:
        for p in [tmp_html, tmp_pdf]:
            try:
                if os.path.exists(p): os.unlink(p)
            except Exception:
                pass
        return jsonify({'error': str(e)}), 500


# --- NOTIFICATIONS ---

@app.route('/api/notifications')
@api_login_required
def api_notifications():
    username = session.get('username', '')
    if not username:
        return jsonify([])

    # Refresh balance check if storage provided and snapshot is older than 1 hour
    storage_guid = request.args.get('storage')
    if storage_guid:
        try:
            _refresh_balance_if_stale(username, storage_guid)
        except Exception:
            pass

    # Check tasks (deadlines + new free) if requested, at most once per 10 min
    if request.args.get('check_tasks'):
        try:
            _check_tasks(username)
        except Exception:
            pass

    notifs = get_active_notifications(username)
    if not notifs:
        _copy_seed_notifications(username)
        notifs = get_active_notifications(username)
    return jsonify(notifs)


def _refresh_balance_if_stale(username, storage_guid):
    updated_at = get_snapshot_updated_at(username, storage_guid)
    if updated_at:
        try:
            from datetime import datetime
            dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
            if (datetime.now() - dt).total_seconds() < 3600:
                return
        except (ValueError, TypeError):
            pass

    client = get_api_client()
    if not client:
        return
    data = client.get_balances(storage_guid)
    if data is not None:
        _check_balance_changes(username, storage_guid, data)


def _check_tasks(username):
    if not username:
        return

    old_data, updated_at = get_task_snapshot(username)
    if updated_at:
        try:
            from datetime import datetime
            dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
            if (datetime.now() - dt).total_seconds() < 600:
                return
        except (ValueError, TypeError):
            pass

    client = get_api_client()
    if not client:
        return

    now = datetime.now()

    # Fetch user's tasks (in progress)
    user_data = client.get_tasks_user(limit=200)
    user_tasks = _project_tasks(user_data.get('tasks', []))

    # Fetch free tasks
    free_data = client.get_tasks_unallocated(limit=200)
    free_tasks = _project_tasks(free_data.get('tasks', []))

    all_tasks = user_tasks + free_tasks

    # Check deadlines for all tasks (in progress + free)
    for task in all_tasks:
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
                    send_push_notification(username, 'Срок заявки истёк',
                        desc.replace('\n', ' — '))
            elif diff < 7200:
                desc = f'{task_label}\nОсталось менее 2 часов'
                if not notification_exists(username, 'task_deadline', desc, None):
                    create_notification(username, 'task_deadline', 'Срок заявки истекает', desc)
                    send_push_notification(username, 'Срок заявки истекает',
                        desc.replace('\n', ' — '))
        except Exception:
            continue

    # Check for new free tasks
    current_free_guids = {t.get('guid', '') for t in free_tasks if t.get('guid')}

    if old_data is None:
        # Первый запуск после очистки кеша — просто сохраняем снимок, без уведомлений
        save_task_snapshot(username, list(current_free_guids))
        logger.info(f"Initial task snapshot saved for '{username}' (cache was empty)")
    else:
        old_free_guids = set(old_data)
        new_guids = current_free_guids - old_free_guids

        for task in free_tasks:
            if task.get('guid') in new_guids:
                title = 'Новая свободная заявка'
                desc = f'Заявка {task.get("number", "")} "{task.get("name", "")}"'
                if not notification_exists(username, 'new_task', desc, 60):
                    create_notification(username, 'new_task', title, desc)
                    send_push_notification(username, title, desc)

        save_task_snapshot(username, list(current_free_guids))


def _copy_seed_notifications(username):
    seeds = get_active_notifications('__seed__')
    for s in seeds:
        create_notification(username, s['type'], s['title'], s['description'], None)
        send_push_notification(username, s['title'], s['description'])


# --- PUSH NOTIFICATIONS ---

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


@app.route('/sw.js')
def service_worker():
    return Response(
        open('static/sw.js', 'rb').read(),
        mimetype='application/javascript',
    )


@app.route('/api/push/vapid-public-key')
@api_login_required
def api_vapid_public_key():
    return jsonify({'publicKey': VAPID_PUBLIC_KEY})


@app.route('/api/push/subscribe', methods=['POST'])
@api_login_required
def api_push_subscribe():
    username = session.get('username', '')
    data = request.get_json(force=True)
    endpoint = data.get('endpoint', '')
    keys = data.get('keys', {})
    auth = keys.get('auth', '')
    p256dh = keys.get('p256dh', '')
    if not endpoint or not auth or not p256dh:
        return jsonify({'error': 'missing fields'}), 400
    save_subscription(username, endpoint, auth, p256dh)
    return jsonify({'ok': True})


@app.route('/api/push/unsubscribe', methods=['POST'])
@api_login_required
def api_push_unsubscribe():
    data = request.get_json(force=True)
    endpoint = data.get('endpoint', '')
    if endpoint:
        delete_subscription(endpoint)
    return jsonify({'ok': True})


@app.route('/api/notifications/<int:notif_id>/dismiss', methods=['POST'])
@api_login_required
def api_notification_dismiss(notif_id):
    username = session.get('username', '')
    dismiss_notification(notif_id, username)
    return jsonify({'ok': True})

@app.route('/api/notifications/dismiss-all', methods=['POST'])
@api_login_required
def api_notifications_dismiss_all():
    username = session.get('username', '')
    dismiss_all_notifications(username)
    return jsonify({'ok': True})


# --- ANNOUNCEMENTS ---

@app.route('/api/announcements')
@api_login_required
def api_announcements():
    return jsonify(get_announcements())


# --- SALARY ---

@app.route('/api/salary')
@api_login_required
def api_salary():
    client = get_api_client()
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if not all([start_date, end_date, client]):
        return jsonify({"data": [], "totalAmount": 0.0})
    data = client.get_salary(start_date, end_date)
    return jsonify(data)


# --- REPORTS / PPR ---

@app.route('/api/ppr/list')
@api_login_required
def api_ppr_list():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": []})
    year = request.args.get('year', datetime.now().year, type=int)
    quarter = request.args.get('quarter', 1, type=int)
    department = request.args.get('department')
    data = client.get_ppr_list(year, quarter, department)
    return jsonify(data or {"tasks": []})


@app.route('/api/ppr/departments')
@api_login_required
def api_ppr_departments():
    client = get_api_client()
    if not client:
        return jsonify({"departments": []})
    year = request.args.get('year', datetime.now().year, type=int)
    quarter = request.args.get('quarter', 1, type=int)
    data = client.get_ppr_departments(year, quarter)
    return jsonify(data or {"departments": []})


@app.route('/api/ppr/close', methods=['POST'])
@api_login_required
def api_ppr_close():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = request.json
    result = client.ppr_close(**data)
    if result and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True})


@app.route('/api/ppr/add', methods=['POST'])
@api_login_required
def api_ppr_add():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    result = client.ppr_add(**request.json)
    return jsonify(result or {})


@app.route('/api/profile')
@api_login_required
def api_profile_get():
    client = get_api_client()
    username = session.get('username', '')
    if not client or not username:
        return jsonify({"profile": {}})
    data = client.get_profile(username)
    return jsonify(data)


@app.route('/api/profile', methods=['POST'])
@api_login_required
def api_profile_post():
    client = get_api_client()
    username = session.get('username', '')
    if not client or not username:
        return jsonify({'error': 'No connection'}), 400
    profile = request.json.get('profile', {})
    result = client.save_profile(username, profile)
    return jsonify(result or {})


@app.route('/api/profile/clear-cache', methods=['POST'])
@api_login_required
def api_profile_clear_cache():
    username = session.get('username', '')
    if not username:
        return jsonify({'error': 'Not authenticated'}), 401
    try:
        from db import clear_user_cache
        clear_user_cache(username)
        logger.info(f"User '{username}' cleared their cache")
        return jsonify({'success': True, 'message': 'Кеш очищен'})
    except Exception as e:
        logger.error(f"Failed to clear cache for '{username}': {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/tasks/documents', methods=['POST'])
def api_task_documents():
    from docgen import generate_documents
    guid = request.json.get('guid')
    if not guid:
        return jsonify({'error': 'GUID required'}), 400

    profile_name = request.json.get('profile_name', '')
    include_act = request.json.get('include_act', True)
    include_fn = request.json.get('include_fn', True)
    include_m15 = request.json.get('include_m15', True)
    fields = request.json.get('fields') or None

    login = request.json.get('login') or ''
    password = request.json.get('password') or ''

    if login and password:
        client = OneSApiClient(
            host=SERVER_HOST,
            port=SERVER_PORT,
            db_name=SERVER_DB,
            username=login,
            password=password,
        )
    else:
        client = get_api_client()
        if not client:
            return jsonify({'error': 'Authentication required'}), 401

    all_tasks = []
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            all_tasks.extend(data['tasks'])

    task = next((t for t in all_tasks if t.get('guid') == guid), None)
    if not task:
        return jsonify({'error': 'Task not found'}), 404

    from docgen import extract_task_data
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')

    try:
        pdfs = generate_documents(task, profile_name=profile_name,
                                  include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15,
                                  field_overrides=fields)
    except Exception as e:
        logger.error(f"Document generation error: {e}")
        return jsonify({'error': str(e)}), 500

    import zipfile
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in pdfs:
            zf.write(path, os.path.basename(path))
            os.unlink(path)
    buf.seek(0)

    return buf.getvalue(), 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': f'attachment; filename="{ts}_{sap}_doc.zip"',
    }


def _make_doc_endpoint(include_act, include_fn, include_m15, suffix):
    guid = request.json.get('guid')
    if not guid:
        return jsonify({'error': 'GUID required'}), 400
    login = request.json.get('login') or ''
    password = request.json.get('password') or ''
    fields = request.json.get('fields') or None
    profile_name = request.json.get('profile_name', '')
    if login and password:
        client = OneSApiClient(
            host=SERVER_HOST, port=SERVER_PORT, db_name=SERVER_DB,
            username=login, password=password,
        )
    else:
        client = get_api_client()
        if not client:
            return jsonify({'error': 'Authentication required'}), 401
    all_tasks = []
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            all_tasks.extend(data['tasks'])
    task = next((t for t in all_tasks if t.get('guid') == guid), None)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    from docgen import extract_task_data
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    from docgen import generate_documents
    try:
        pdfs = generate_documents(task, include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15, field_overrides=fields,
                                  profile_name=profile_name)
    except Exception as e:
        logger.error(f"Document generation error: {e}")
        return jsonify({'error': str(e)}), 500
    pdf_path = pdfs[0]
    with open(pdf_path, 'rb') as f:
        data = f.read()
    os.unlink(pdf_path)
    return data, 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': f'attachment; filename="{ts}_{sap}_{suffix}.pdf"',
    }


@app.route('/api/tasks/documents/act', methods=['POST'])
def api_task_documents_act():
    return _make_doc_endpoint(True, False, False, 'AVR')


@app.route('/api/tasks/documents/fn', methods=['POST'])
def api_task_documents_fn():
    return _make_doc_endpoint(False, True, False, 'FN')


@app.route('/api/tasks/documents/m15', methods=['POST'])
def api_task_documents_m15():
    return _make_doc_endpoint(False, False, True, 'm15')


@app.route('/api/shop/by-sap')
@api_login_required
def api_shop_by_sap():
    sap = request.args.get('sap', '').strip().upper()
    if not sap:
        return jsonify({})
    from db import find_shop_by_sap
    row = find_shop_by_sap(sap)
    if row:
        return jsonify({'shop': row[0], 'sap': row[1], 'addr': row[2]})
    return jsonify({})


# ============= ФОНОВЫЙ ПРОЦЕСС ПРОВЕРКИ УВЕДОМЛЕНИЙ =============

BACKGROUND_CHECK_INTERVAL = 300  # 5 минут

_background_timer = None
_background_stop = threading.Event()


def _background_check_loop():
    """Фоновый цикл проверки задач и отправки push-уведомлений для всех пользователей."""
    while not _background_stop.is_set():
        try:
            _background_check_all_users()
        except Exception as e:
            logger.error(f"Background check error: {e}", exc_info=True)
        _background_stop.wait(BACKGROUND_CHECK_INTERVAL)


def _background_check_all_users():
    """Проверяет дедлайны и новые задачи для всех пользователей, у которых есть push-подписки."""
    subs = get_all_subscriptions()
    if not subs:
        return

    # Группируем подписки по пользователям
    users = {}
    for sub in subs:
        username = sub['username']
        if username not in users:
            users[username] = []
        users[username].append(sub)

    for username, user_subs in users.items():
        _background_check_user(username)

    # Также проверяем всех, кто есть в таблице task_snapshots (чтобы не пропустить пользователей без push)
    all_snapshot_users = get_all_task_snapshot_users()
    for username in all_snapshot_users:
        if username not in users:
            _background_check_user(username)


def _background_check_user(username):
    """Проверяет задачи для конкретного пользователя в фоне."""
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

    # Используем временного клиента с логином/паролем
    # ВАЖНО: для фоновой проверки нужно хранить пароли
    # Используем сохранённые credentials из сессий или env-переменные
    client = _get_background_api_client(username)
    if not client:
        return

    now = datetime.now()

    try:
        user_data = client.get_tasks_user(limit=200)
        user_tasks = _project_tasks(user_data.get('tasks', []))
    except Exception as e:
        logger.warning(f"Background: failed to fetch user tasks for {username}: {e}")
        user_tasks = []

    try:
        free_data = client.get_tasks_unallocated(limit=200)
        free_tasks = _project_tasks(free_data.get('tasks', []))
    except Exception as e:
        logger.warning(f"Background: failed to fetch free tasks for {username}: {e}")
        free_tasks = []

    all_tasks = user_tasks + free_tasks

    for task in all_tasks:
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

    current_free_guids = {t.get('guid', '') for t in free_tasks if t.get('guid')}

    if old_data is None:
        save_task_snapshot(username, list(current_free_guids))
        logger.info(f"Background: initial task snapshot saved for '{username}' (cache was empty)")
    else:
        old_free_guids = set(old_data)
        new_guids = current_free_guids - old_free_guids

        for task in free_tasks:
            if task.get('guid') in new_guids:
                title = 'Новая свободная заявка'
                desc = f'Заявка {task.get("number", "")} "{task.get("name", "")}"'
                if not notification_exists(username, 'new_task', desc, 60):
                    create_notification(username, 'new_task', title, desc)
                    send_push_notification(username, title, desc)

        save_task_snapshot(username, list(current_free_guids))

    # Фоновая проверка складов (не чаще раза в час на склад)
    _background_check_balances(client, username)


def _background_check_balances(client, username):
    """Проверяет изменения остатков на складах для пользователя в фоне."""
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
            # Проверяем, не обновляли ли этот склад недавно
            updated_at = get_snapshot_updated_at(username, storage_guid)
            if updated_at:
                try:
                    dt = datetime.strptime(updated_at, '%Y-%m-%d %H:%M:%S')
                    if (datetime.now() - dt).total_seconds() < 3600:
                        continue  # Обновляли менее часа назад — пропускаем
                except (ValueError, TypeError):
                    pass
            data = client.get_balances(storage_guid)
            if data is not None:
                _check_balance_changes(username, storage_guid, data)
                logger.info(f"Background: balance checked for '{username}' storage '{storage_guid}'")
    except Exception as e:
        logger.warning(f"Background: failed to check balances for {username}: {e}")


def _get_background_api_client(username):
    """Создаёт API-клиент для фоновой проверки.
    Использует credentials, сохранённые в БД при логине пользователя."""
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


def start_background_worker():
    """Запускает фоновый поток проверки уведомлений."""
    global _background_timer
    if _background_timer is not None:
        return
    _background_stop.clear()
    thread = threading.Thread(target=_background_check_loop, daemon=True)
    thread.start()
    logger.info("Background push notification worker started (interval=%ds)", BACKGROUND_CHECK_INTERVAL)


def stop_background_worker():
    """Останавливает фоновый поток."""
    _background_stop.set()


if __name__ == '__main__':
    start_background_worker()
    debug = env == 'development'
    app.run(host='0.0.0.0', port=5000, debug=debug)