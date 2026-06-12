import os
import json
import base64
import secrets
import logging
from datetime import datetime, timedelta
from functools import wraps
from dotenv import load_dotenv
from flask import (Flask, render_template, request, redirect,
                   url_for, session, jsonify, flash)

from config import config
from api_client import OneSApiClient

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
env = os.environ.get('FLASK_ENV', 'development')
app.config.from_object(config.get(env, config['development']))
app.config['ENV'] = env

SERVER_HOST = os.environ.get('SERVER_HOST', '127.0.0.1')
SERVER_PORT = os.environ.get('SERVER_PORT', '5000')
SERVER_DB = os.environ.get('SERVER_DB', 'my_db')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


@app.context_processor
def inject_now():
    return {'now': datetime.now}


def get_api_client():
    host = session.get('server_host', SERVER_HOST)
    port = session.get('server_port', SERVER_PORT)
    db_name = session.get('db_name', SERVER_DB)
    if 'authenticated' not in session:
        return None
    return OneSApiClient(
        host=host,
        port=port,
        db_name=db_name,
        username=session['username'],
        password=session['password'],
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

        return redirect(url_for('dashboard'))

    return render_template('login.html')


@app.route('/logout')
def logout():
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


def _filter_tasks(tasks, search=None, sort=None):
    if search:
        q = search.lower()
        tasks = [t for t in tasks if any(
            q in (str(t.get(f)) or '').lower()
            for f in ('number', 'name', 'status', 'name_department', 'user')
        )]
    if sort == 'priority':
        tasks.sort(key=lambda t: -(t.get('priority') or 0))
    elif sort == 'deadline':
        tasks.sort(key=lambda t: t.get('period') or '')
    else:
        tasks.sort(key=lambda t: t.get('date') or '', reverse=True)
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
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    data = client.get_tasks_user(search=search, limit=limit, offset=offset)
    tasks = _project_tasks(data.get('tasks', []))
    tasks = _filter_tasks(tasks, search, sort)
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
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    data = client.get_tasks_unallocated(search=search, limit=limit, offset=offset)
    tasks = _project_tasks(data.get('tasks', []))
    tasks = _filter_tasks(tasks, search, sort)
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
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    data = client.get_closed_tasks_user(search=search, limit=limit, offset=offset)
    tasks = _project_tasks(data.get('tasks', []))
    tasks = _filter_tasks(tasks, search, sort)
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
    return jsonify(result or {'error': 'Failed to take task'})


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
    return jsonify(data)


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
    return jsonify(data)


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


if __name__ == '__main__':
    debug = env == 'development'
    app.run(host='0.0.0.0', port=5000, debug=debug)
