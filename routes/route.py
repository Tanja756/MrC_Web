from datetime import datetime
from flask import Blueprint, request, jsonify, session
from .helpers import api_login_required, get_api_client
from db import get_db_connection

route_bp = Blueprint('route', __name__, url_prefix='/api/route')


def _parse_dt(s):
    if not s:
        return datetime.min
    for fmt in ('%d.%m.%Y %H:%M:%S', '%d.%m.%Y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return datetime.min


def _task_name_by_guid(client, username):
    names = {}
    for method in ('get_closed_tasks_user', 'get_tasks_user', 'get_tasks_unallocated'):
        data = getattr(client, method)(limit=500)
        for t in (data.get('tasks') if isinstance(data, dict) else data or []):
            g = t.get('guid')
            if g and g not in names:
                number = t.get('number', '') or ''
                name = t.get('name', '') or ''
                label = f"Заявка {number} — {name}" if number else name
                names[g] = label
    return names


@route_bp.route('/sheet', methods=['POST'])
@api_login_required
def api_route_sheet():
    body = request.get_json(silent=True) or {}
    month = body.get('month', '')
    if not month or len(month) != 7:
        return jsonify({'error': 'month required (YYYY-MM)'}), 400

    username = session.get('username', '')

    # ── Tasks: closed in month ──
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT guid, closed_at, task_name FROM task_tracking
        WHERE username = ? AND closed_at LIKE ?
    """, (username, f"{month}-%"))
    task_rows = c.fetchall()
    conn.close()

    # fallback name map from 1C for entries with empty task_name
    client = get_api_client()
    guid_to_fetch = [r[0] for r in task_rows if not r[2]]
    name_map = {}
    if guid_to_fetch and client:
        name_map = _task_name_by_guid(client, username)

    entries = []
    for guid, closed_at, task_name in task_rows:
        dt = _parse_dt(closed_at)
        label = task_name or name_map.get(guid, guid[:18])
        entries.append({
            'type': 'task',
            'dt': dt,
            'date': dt.strftime('%d.%m.%Y'),
            'time': dt.strftime('%H:%M'),
            'content': label,
        })

    # ── Transfers: from stock transfers history cache ──
    from routes.warehouse import _stock_transfers_history_cache
    cached = _stock_transfers_history_cache.get("data")
    if cached is None and client:
        cached = client.get_stock_transfers_history()
    if cached:
        for doc in cached:
            doc_date = doc.get('date', '') or ''
            if not doc_date:
                continue
            dt = _parse_dt(doc_date)
            if dt.strftime('%Y-%m') != month:
                continue
            src = doc.get('warehouse_source_name', '') or ''
            dst = doc.get('warehouse_dest_name', '') or ''
            if src or dst:
                content = f"Перемещение: {src} → {dst}"
            else:
                content = "Перемещение"
            entries.append({
                'type': 'transfer',
                'dt': dt,
                'date': dt.strftime('%d.%m.%Y'),
                'time': dt.strftime('%H:%M'),
                'content': content,
            })

    if not entries:
        return jsonify({'rows': [], 'count': 0})

    entries.sort(key=lambda e: e['dt'])

    # ── Group by date, wrap with Дом ──
    rows = []
    current_day = None
    day_entries = []
    for e in entries:
        day = e['date']
        if day != current_day:
            if current_day is not None and day_entries:
                rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': current_day, 'content': 'Дом'})
            day_entries = []
            current_day = day
            rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': day, 'content': 'Дом'})
        rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': day, 'content': e['content']})
        day_entries.append(e)

    if current_day is not None and day_entries:
        rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': current_day, 'content': 'Дом'})

    return jsonify({'rows': rows, 'count': len(rows)})
