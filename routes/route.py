import os
import re
import uuid
import subprocess
import tempfile
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, session, send_file
from .helpers import api_login_required, get_api_client, route_pdf_html
from db import get_db_connection, get_tasks_tracking, get_route_cache_entries, save_route_cache_entries, delete_route_cache_entries

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


def _load_1c_entries(client, username):
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
        number = t.get('number', '') or ''
        name = t.get('name', '') or ''
        entries.append({
            'type': 'task',
            'dt': dt,
            'date': dt.strftime('%d.%m.%Y'),
            'time': dt.strftime('%H:%M'),
            'content': name or guid[:18],
        })

    # PPR from local DB
    conn = get_db_connection()
    cur = conn.execute(
        "SELECT number, name, date, period, updated_at FROM ppr_tasks WHERE status = 'Завершена'"
    )
    for row in cur.fetchall():
        number, name = row[0], row[1]
        date_str = row[2] or row[3] or row[4]
        dt = _parse_dt(date_str)
        entries.append({
            'type': 'task',
            'dt': dt,
            'date': dt.strftime('%d.%m.%Y'),
            'time': dt.strftime('%H:%M'),
            'content': f"[ППР] {number} {name}",
        })
    conn.close()

    # Trips from stock transfers history
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

    return entries


def _group_into_rows(entries, username, sort_dir):
    if not entries:
        return []
    entries.sort(key=lambda e: e['dt'], reverse=(sort_dir == 'desc'))

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

    return rows


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

    year, mon = int(month[:4]), int(month[5:7])
    month_start = datetime(year, mon, 1)
    month_end = datetime(year + 1, 1, 1) if mon == 12 else datetime(year, mon + 1, 1)
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = today - timedelta(days=7)

    entries = []

    # ── Cached entries (dates < cutoff) ──
    need_full_load = False
    if month_start < cutoff:
        cache_entries = get_route_cache_entries(username, month)
        if cache_entries:
            for e in cache_entries:
                dt = _parse_dt(f"{e['date']} {e['time']}")
                if dt >= cutoff:
                    continue
                e['dt'] = dt
                entries.append(e)
        else:
            need_full_load = True

    if need_full_load:
        all_entries = _load_1c_entries(client, username)
        pre = [e for e in all_entries if e['dt'] < cutoff and e['dt'] >= month_start and e['dt'] < month_end]
        post = [e for e in all_entries if e['dt'] >= cutoff and e['dt'] >= month_start and e['dt'] < month_end]
        if pre:
            save_route_cache_entries(username, month, pre)
        entries.extend(pre)
        entries.extend(post)
    else:
        # ── Live entries (dates >= cutoff) ──
        if cutoff < month_end:
            live_entries = _load_1c_entries(client, username)
            for e in live_entries:
                if e['dt'] >= cutoff and e['dt'] >= month_start and e['dt'] < month_end:
                    entries.append(e)

    rows = _group_into_rows(entries, username, sort_dir)
    return jsonify({'rows': rows, 'count': len(rows)})


@route_bp.route('/export-pdf', methods=['POST'])
@api_login_required
def api_route_export_pdf():
    body = request.get_json(silent=True) or {}
    rows = body.get('rows', [])
    month = body.get('month', '')

    username = session.get('username', '')
    if not month or len(month) != 7:
        return jsonify({'error': 'month required (YYYY-MM)'}), 400

    year, mon = int(month[:4]), int(month[5:7])
    month_names = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                   'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь']
    month_label = f"{month_names[mon-1]} {year}"

    html = route_pdf_html(month_label, rows, username)
    tag = uuid.uuid4().hex[:12]
    tmp_html = os.path.join(tempfile.gettempdir(), f'rt-{tag}.html')
    tmp_pdf = os.path.join(tempfile.gettempdir(), f'rt-{tag}.pdf')
    try:
        with open(tmp_html, 'w', encoding='utf-8') as f:
            f.write(html)
        lo_dir = os.path.join(tempfile.gettempdir(), f'lo-rt-{tag}')
        os.makedirs(lo_dir, exist_ok=True)
        env = os.environ.copy()
        env['HOME'] = lo_dir
        result = subprocess.run(
            ['libreoffice', '--headless', '--norestore',
             f'-env:UserInstallation=file:///{lo_dir}',
             '--convert-to', 'pdf', '--outdir', tempfile.gettempdir(), tmp_html],
            capture_output=True, text=True, timeout=60, env=env
        )
        generated = os.path.join(tempfile.gettempdir(), f'rt-{tag}.html.pdf')
        expected = tmp_pdf
        if os.path.exists(generated):
            os.rename(generated, expected)
        if not os.path.exists(expected) or os.path.getsize(expected) < 100:
            raise RuntimeError(result.stderr or 'PDF not generated')
        filename = f'route_{month}.pdf'
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


@route_bp.route('/rebuild-cache', methods=['POST'])
@api_login_required
def api_route_rebuild_cache():
    body = request.get_json(silent=True) or {}
    month = body.get('month', '')
    if not month or len(month) != 7:
        return jsonify({'error': 'month required (YYYY-MM)'}), 400

    username = session.get('username', '')
    client = get_api_client()
    if not client:
        return jsonify({'error': 'no api client'}), 400

    delete_route_cache_entries(username, month)

    year, mon = int(month[:4]), int(month[5:7])
    month_start = datetime(year, mon, 1)
    month_end = datetime(year + 1, 1, 1) if mon == 12 else datetime(year, mon + 1, 1)

    all_entries = _load_1c_entries(client, username)
    month_entries = [e for e in all_entries if e['dt'] >= month_start and e['dt'] < month_end]

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = today - timedelta(days=7)
    pre = [e for e in month_entries if e['dt'] < cutoff]
    if pre:
        save_route_cache_entries(username, month, pre)

    return jsonify({'success': True, 'count': len(month_entries)})
