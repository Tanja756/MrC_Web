import re
from datetime import datetime
from flask import Blueprint, request, jsonify, session
from .helpers import api_login_required, get_api_client
from db import get_db_connection, get_tasks_tracking

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


def _local_closed_by_task(t, username):
    name = t.get('name', '') or ''
    m = re.search(r'[А-ЯЁ]{2}-\d{6}(?=[:;| ]|$)', name)
    if not m:
        return None
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""SELECT closed_at FROM task_tracking
                 WHERE username = ? AND task_name LIKE ?
                 ORDER BY closed_at DESC LIMIT 1""",
              (username, f"%{m.group()}%"))
    row = c.fetchone()
    conn.close()
    return row[0] if row and row[0] else None


@route_bp.route('/sheet', methods=['POST'])
@api_login_required
def api_route_sheet():
    body = request.get_json(silent=True) or {}
    month = body.get('month', '')
    if not month or len(month) != 7:
        return jsonify({'error': 'month required (YYYY-MM)'}), 400
    sort_dir = body.get('sort', 'desc')

    username = session.get('username', '')
    client = get_api_client()
    if not client:
        return jsonify({'error': 'no api client'}), 400

    # ── Tasks: from 1C closed tasks, dates from local DB (priority) / 1C closed_at / 1C date ──
    closed_data = client.get_closed_tasks_user(limit=1000)
    closed_tasks = closed_data.get('tasks', []) if isinstance(closed_data, dict) else closed_data or []

    guids = [t.get('guid') for t in closed_tasks if t.get('guid')]
    tracking = get_tasks_tracking(guids, username) if guids else {}

    entries = []
    for t in closed_tasks:
        guid = t.get('guid')
        if not guid:
            continue
        local = tracking.get(guid, {})
        closed_at = local.get('closed_at') or _local_closed_by_task(t, username) or t.get('closed_at') or t.get('date')
        if not closed_at:
            continue
        dt = _parse_dt(closed_at)
        if dt.strftime('%Y-%m') != month:
            continue
        number = t.get('number', '') or ''
        name = t.get('name', '') or ''
        content = name or guid[:18]
        entries.append({
            'type': 'task',
            'dt': dt,
            'date': dt.strftime('%d.%m.%Y'),
            'time': dt.strftime('%H:%M'),
            'content': content,
        })

    # ── Transfers: group by day into trips ──
    from routes.warehouse import _stock_transfers_history_cache
    cached = _stock_transfers_history_cache.get("data")
    if cached is None:
        cached = client.get_stock_transfers_history()
    if cached:
        day_transfers = {}
        for doc in cached:
            doc_date = doc.get('date', '') or ''
            if not doc_date:
                continue
            dt = _parse_dt(doc_date)
            if dt.strftime('%Y-%m') != month:
                continue
            day_key = dt.strftime('%Y-%m-%d')
            if day_key not in day_transfers:
                day_transfers[day_key] = {'dts': [], 'count': 0}
            day_transfers[day_key]['dts'].append(dt)
            day_transfers[day_key]['count'] += 1

        for day_key, info in day_transfers.items():
            first_dt = min(info['dts'])
            entries.append({
                'type': 'trip',
                'dt': first_dt,
                'date': first_dt.strftime('%d.%m.%Y'),
                'time': first_dt.strftime('%H:%M'),
                'content': f"Поездка ({info['count']} перемещений)",
            })

    if not entries:
        return jsonify({'rows': [], 'count': 0})

    entries.sort(key=lambda e: e['dt'], reverse=(sort_dir == 'desc'))

    # ── Group by date, wrap with Дом ──
    rows = []
    current_day = None
    day_entries = []
    for e in entries:
        day = e['date']
        if day != current_day:
            if current_day is not None and day_entries:
                rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': current_day, 'content': 'Дом', 'type': 'home'})
            day_entries = []
            current_day = day
            rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': day, 'content': 'Дом', 'type': 'home'})
        rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': day, 'content': e['content'], 'type': e['type']})
        day_entries.append(e)

    if current_day is not None and day_entries:
        rows.append({'num': len(rows) + 1, 'login_1c': username, 'date': current_day, 'content': 'Дом', 'type': 'home'})

    return jsonify({'rows': rows, 'count': len(rows)})
