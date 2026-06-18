import os
import io
import zipfile
from datetime import datetime
from flask import Blueprint, request, jsonify, session
from api_client import OneSApiClient
from db import set_task_taken, set_task_closed
from .helpers import (
    api_login_required, get_api_client,
    project_tasks, attach_tracking, filter_tasks, paginate,
    SERVER_HOST, SERVER_PORT, SERVER_DB,
)

tasks_bp = Blueprint('tasks', __name__, url_prefix='/api/tasks')


@tasks_bp.route('/my')
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
    tasks = project_tasks(data.get('tasks', []))
    attach_tracking(tasks, username)
    tasks = filter_tasks(tasks, search, sort, dir)
    tasks, total = paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@tasks_bp.route('/free')
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
    data = client.get_tasks_unallocated(limit=5000, offset=0)
    tasks = project_tasks(data.get('tasks', []))
    tasks = filter_tasks(tasks, search, sort, dir)
    tasks, total = paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@tasks_bp.route('/closed')
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
    tasks = project_tasks(data.get('tasks', []))
    attach_tracking(tasks, username)
    tasks = filter_tasks(tasks, search, sort, dir)
    tasks, total = paginate(tasks, limit, offset)
    return jsonify({"tasks": tasks, "total": total})


@tasks_bp.route('/<guid>')
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


@tasks_bp.route('/take', methods=['POST'])
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


@tasks_bp.route('/take-bulk', methods=['POST'])
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


@tasks_bp.route('/close', methods=['POST'])
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


@tasks_bp.route('/reject', methods=['POST'])
@api_login_required
def api_task_reject():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = request.json
    guid = data.get('guid')
    comment = data.get('comment', '').strip()
    if not guid:
        return jsonify({'error': 'GUID required'}), 400
    if not comment:
        return jsonify({'error': 'Укажите причину отмены'}), 400
    result = client.task_reject(guid, comment)
    if result and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error'], 'detail': result}), 400
    return jsonify({'success': True})


@tasks_bp.route('/<guid>/attachments')
@api_login_required
def api_task_attachments(guid):
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = client.get_task_attachments(guid)
    if data is None:
        return jsonify({'attachments': []})
    return jsonify(data)


@tasks_bp.route('/documents')
@api_login_required
def api_tasks_documents():
    client = get_api_client()
    data = client.get_clients() if client else []
    return jsonify(data)


@tasks_bp.route('/documents', methods=['POST'])
def api_task_documents_post():
    from docgen import generate_documents, extract_task_data
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
            host=SERVER_HOST, port=SERVER_PORT, db_name=SERVER_DB,
            username=login, password=password,
        )
    else:
        client = get_api_client()
        if not client:
            return jsonify({'error': 'Authentication required'}), 401
    closed = client.task_is_closed(guid)
    if closed and closed.get('closed'):
        return jsonify({'error': 'Задача уже закрыта. Формирование документов невозможно.'}), 400
    all_tasks = []
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            all_tasks.extend(data['tasks'])
    task = next((t for t in all_tasks if t.get('guid') == guid), None)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    try:
        pdfs = generate_documents(task, profile_name=profile_name,
                                  include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15,
                                  field_overrides=fields)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
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
    from docgen import generate_documents, extract_task_data
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
    closed = client.task_is_closed(guid)
    if closed and closed.get('closed'):
        return jsonify({'error': 'Задача уже закрыта. Формирование документов невозможно.'}), 400
    all_tasks = []
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            all_tasks.extend(data['tasks'])
    task = next((t for t in all_tasks if t.get('guid') == guid), None)
    if not task:
        return jsonify({'error': 'Task not found'}), 404
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    try:
        pdfs = generate_documents(task, include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15, field_overrides=fields,
                                  profile_name=profile_name)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    pdf_path = pdfs[0]
    with open(pdf_path, 'rb') as f:
        data = f.read()
    os.unlink(pdf_path)
    return data, 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': f'attachment; filename="{ts}_{sap}_{suffix}.pdf"',
    }


@tasks_bp.route('/documents/act', methods=['POST'])
def api_task_documents_act():
    return _make_doc_endpoint(True, False, False, 'AVR')


@tasks_bp.route('/documents/fn', methods=['POST'])
def api_task_documents_fn():
    return _make_doc_endpoint(False, True, False, 'FN')


@tasks_bp.route('/documents/m15', methods=['POST'])
def api_task_documents_m15():
    return _make_doc_endpoint(False, False, True, 'm15')
