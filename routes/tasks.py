import os
import io
import zipfile
from datetime import datetime
from urllib.parse import quote
from flask import Blueprint, request, jsonify, session
from api_client import OneSApiClient

from db import set_task_closed, clear_task_closed, update_task_closed_date, save_task_m15_items, save_task_m15_text
from .helpers import (
    api_login_required, get_api_client,
    project_tasks, attach_tracking, filter_tasks,
    auto_close_tracked_tasks, get_new_task_guids,
    SERVER_HOST, SERVER_PORT, SERVER_DB,
    make_etag_response,
)
from utils import compress_attachments, compress_image

tasks_bp = Blueprint('tasks', __name__, url_prefix='/api/tasks')


def _resolve_client(login='', password=''):
    if login and password:
        return OneSApiClient(
            host=SERVER_HOST, port=SERVER_PORT, db_name=SERVER_DB,
            username=login, password=password,
        )
    return get_api_client()


def _fetch_task(client, guid):
    task = client.get_task(guid)
    if task and '_error' not in task:
        return task
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            for t in data['tasks']:
                if t.get('guid') == guid:
                    return t
    return None


@tasks_bp.route('/my')
@api_login_required
def api_tasks_my():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": []})
    search = request.args.get('search')
    sort = request.args.get('sort')
    dir = request.args.get('dir', 'desc')
    username = session.get('username', '')
    data = client.get_tasks_user(limit=5000, offset=0)
    tasks = project_tasks(data.get('tasks', []))
    attach_tracking(tasks, username)
    tasks = filter_tasks(tasks, search, sort, dir)
    return make_etag_response({"tasks": tasks})


@tasks_bp.route('/free')
@api_login_required
def api_tasks_free():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": []})
    search = request.args.get('search')
    sort = request.args.get('sort')
    dir = request.args.get('dir', 'desc')
    username = session.get('username', '')
    data = client.get_tasks_unallocated(limit=5000, offset=0)
    tasks = project_tasks(data.get('tasks', []))
    new_guids = get_new_task_guids(username)
    for t in tasks:
        if t.get('guid') in new_guids:
            t['is_new'] = True
    tasks = filter_tasks(tasks, search, sort, dir)
    return make_etag_response({"tasks": tasks})


@tasks_bp.route('/closed')
@api_login_required
def api_tasks_closed():
    client = get_api_client()
    if not client:
        return jsonify({"tasks": []})
    search = request.args.get('search', '')
    sort = request.args.get('sort', '')
    dir = request.args.get('dir', 'desc')
    username = session.get('username', '')
    data = client.get_closed_tasks_user(limit=5000, offset=0)
    tasks = project_tasks(data.get('tasks', []))
    attach_tracking(tasks, username)
    auto_close_tracked_tasks(tasks, username)
    tasks = filter_tasks(tasks, search, sort, dir)
    return make_etag_response({"tasks": tasks})


@tasks_bp.route('/<guid>')
@api_login_required
def api_task_detail(guid):
    client = get_api_client()
    username = session.get('username', '')
    if not client:
        return jsonify({'error': 'No connection'}), 400
    task = client.get_task(guid)
    if task and '_error' not in task:
        task.pop('docs', None)
        task.pop('services', None)
        for att in task.get('attachments', []):
            att.pop('content', None)
        attach_tracking([task], username)
        return jsonify(task)
    for fetcher in ('get_tasks_user', 'get_tasks_unallocated', 'get_closed_tasks_user'):
        data = getattr(client, fetcher)()
        if data and 'tasks' in data:
            for t in data['tasks']:
                if t.get('guid') == guid:
                    attach_tracking([t], username)
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
    results = []
    for guid in guids:
        result = client.task_take(guid)
        ok = bool(result and (result.get('status') in ('Выполнить', 'OK')))
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
    guid_doc = data.get('guidDoc')
    comment = data.get('comment', '')
    latitude = data.get('latitude', 0.0)
    longitude = data.get('longitude', 0.0)
    attachments = compress_attachments(data.get('attachments', []))
    result = client.task_close(guid, guid_doc, comment, latitude, longitude, attachments)
    if result is None:
        return jsonify({'success': False, 'error': 'Empty response from 1C'}), 400
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error'], 'detail': result}), 400
    task_name = (data.get('taskName', '') or '').strip()
    set_task_closed(session.get('username', ''), guid, task_name)
    return jsonify({'success': True})


@tasks_bp.route('/<guid>/update-closed-at', methods=['POST'])
@api_login_required
def api_task_update_closed_at(guid):
    username = session.get('username', '')
    if not username:
        return jsonify({'error': 'No auth'}), 401
    data = request.json or {}
    closed_at = (data.get('closed_at') or '').strip()
    if not closed_at:
        return jsonify({'error': 'closed_at required'}), 400
    try:
        datetime.strptime(closed_at, '%Y-%m-%d %H:%M:%S')
    except ValueError:
        return jsonify({'error': 'Invalid date format, expected YYYY-MM-DD HH:MM:SS'}), 400
    task_name = (data.get('taskName', '') or '').strip()
    update_task_closed_date(username, guid, closed_at, task_name)
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
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error'], 'detail': result}), 400
    return jsonify({'success': True})


@tasks_bp.route('/redirect', methods=['POST'])
@api_login_required
def api_task_redirect():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = request.json
    guid = data.get('guid')
    comment = data.get('comment', '').strip()
    if not guid:
        return jsonify({'error': 'GUID required'}), 400
    if not comment:
        return jsonify({'error': 'Укажите причину возврата'}), 400
    result = client.task_redirect(guid, comment)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error'], 'detail': result}), 400
    clear_task_closed(session.get('username', ''), guid)
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
    for att in data.get('attachments', []):
        content = att.get('content')
        if content:
            att['content'] = compress_image(content, att.get('filename', ''))
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
    client = _resolve_client(login, password)
    if not client:
        return jsonify({'error': 'Authentication required'}), 401
    task = _fetch_task(client, guid)
    if task is None:
        return jsonify({'error': 'Task not found'}), 404
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    shop = parsed.get('shop', '')
    code = parsed.get('code', '')
    hk = parsed.get('zd', '')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    try:
        pdfs = generate_documents(task, profile_name=profile_name,
                                  include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15,
                                  field_overrides=fields)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    if fields and fields.get('items'):
        if include_m15:
            save_task_m15_items(guid, fields['items'])
        text = '\n'.join(f"{item['name']} ({item['series']})" for item in fields['items'])
        save_task_m15_text(guid, text, code, hk_code=hk)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in pdfs:
            zf.write(path, os.path.basename(path))
            os.unlink(path)
    buf.seek(0)
    return buf.getvalue(), 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': f'attachment; filename="{quote(f"{ts}-{sap}-{shop}-{code}-doc.zip", safe="")}"; filename*=UTF-8\'\'{quote(f"{ts}-{sap}-{shop}-{code}-doc.zip", safe="")}',
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
    client = _resolve_client(login, password)
    if not client:
        return jsonify({'error': 'Authentication required'}), 401
    task = _fetch_task(client, guid)
    if task is None:
        return jsonify({'error': 'Task not found'}), 404
    parsed = extract_task_data(task)
    sap = parsed.get('sap', 'unknown')
    shop = parsed.get('shop', '')
    code = parsed.get('code', '')
    hk = parsed.get('zd', '')
    ts = datetime.now().strftime('%Y.%m.%d_%H.%M')
    try:
        pdfs = generate_documents(task, include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15, field_overrides=fields,
                                  profile_name=profile_name)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    if fields and fields.get('items'):
        if include_m15:
            save_task_m15_items(guid, fields['items'])
        text = '\n'.join(f"{item['name']} ({item['series']})" for item in fields['items'])
        save_task_m15_text(guid, text, code, hk_code=hk)
    pdf_path = pdfs[0]
    with open(pdf_path, 'rb') as f:
        data = f.read()
    os.unlink(pdf_path)
    return data, 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': f'attachment; filename="{quote(f"{ts}-{sap}-{shop}-{code}-{suffix}.pdf", safe="")}"; filename*=UTF-8\'\'{quote(f"{ts}-{sap}-{shop}-{code}-{suffix}.pdf", safe="")}',
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


@tasks_bp.route('/documents/upload-to-yandex', methods=['POST'])
def api_task_documents_upload_yandex():
    from docgen import generate_documents, extract_task_data
    from yandex_disk import YandexDiskClient
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
    client = _resolve_client(login, password)
    if not client:
        return jsonify({'error': 'Authentication required'}), 401
    task = _fetch_task(client, guid)
    if task is None:
        return jsonify({'error': 'Task not found'}), 404
    parsed = extract_task_data(task)
    try:
        pdfs = generate_documents(task, profile_name=profile_name,
                                  include_act=include_act, include_fn=include_fn,
                                  include_m15=include_m15,
                                  field_overrides=fields)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    if fields and fields.get('items'):
        if include_m15:
            save_task_m15_items(guid, fields['items'])
        text = '\n'.join(f"{item['name']} ({item['series']})" for item in fields['items'])
        save_task_m15_text(guid, text, parsed.get('code', ''), hk_code=parsed.get('zd', ''))

    hk_code = parsed.get('zd', '')
    sap = parsed.get('sap', 'unknown')
    username = session.get('username', '')
    today = datetime.now().strftime('%Y.%m.%d')

    yandex = YandexDiskClient()
    remote_dir = f"{username}/Docs/{today}/{sap}/{hk_code}/"
    yandex.ensure_folder(remote_dir)

    uploaded = []
    for pdf_path in pdfs:
        fname = os.path.basename(pdf_path)
        try:
            with open(pdf_path, 'rb') as f:
                data = f.read()
            yandex.upload_file(remote_dir, fname, data)
            uploaded.append(fname)
        except Exception as e:
            return jsonify({'error': f'Failed to upload {fname}: {str(e)}'}), 500
        finally:
            if os.path.exists(pdf_path):
                os.unlink(pdf_path)

    return jsonify({'success': True, 'files': uploaded})


@tasks_bp.route('/<guid>/m15-items', methods=['GET'])
@api_login_required
def api_task_m15_items(guid):
    from db import get_task_m15_items
    return jsonify(get_task_m15_items(guid))


@tasks_bp.route('/<guid>/m15-text', methods=['GET'])
@api_login_required
def api_task_m15_text(guid):
    from db import get_task_m15_text
    data = get_task_m15_text(task_guid=guid)
    if data:
        return jsonify(data)
    hk = request.args.get('hk', '')
    if hk:
        data = get_task_m15_text(hk_code=hk)
        if data:
            return jsonify(data)
    return jsonify({'text': None, 'code': ''})
