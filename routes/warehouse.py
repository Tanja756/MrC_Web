import io
import os
import re
import uuid
import base64
import tempfile
import subprocess
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, send_file, session
from .helpers import (
    api_login_required, get_api_client,
    get_storage_name, check_balance_changes, short_date, plural,
    warehouse_pdf_html,
    get_balance_item_meta, set_balance_item_broken,
    get_arrival_overrides, set_arrival_override,
    sync_and_enrich_products, enrich_products_to_dict,
)
from utils import compress_attachments

warehouse_bp = Blueprint('warehouse', __name__, url_prefix='/api/warehouse')

# In-memory cache for stock-transfers-history (4-hour TTL)
_stock_transfers_history_cache = {
    "data": None,
    "updated_at": None,
}
STOCK_TRANSFERS_HISTORY_TTL = 4 * 3600  # 4 hours


@warehouse_bp.route('/storages')
@api_login_required
def api_storages():
    client = get_api_client()
    data = client.get_storages() if client else []
    return jsonify(data)


@warehouse_bp.route('/balances')
@api_login_required
def api_balances():
    client = get_api_client()
    storage_guid = request.args.get('storage')
    if not storage_guid or not client:
        return jsonify([])
    data = client.get_balances(storage_guid)
    storage_name = get_storage_name(client, storage_guid)
    check_balance_changes(session.get('username', ''), storage_guid, data, storage_name)
    username = session.get('username', '')
    meta = get_balance_item_meta(username, storage_guid) if username else {}
    for item in data:
        item['date_arrival'] = short_date(item.get('date_arrival'))
        item['date_writeoff'] = short_date(item.get('date_writeoff'))
        key = f"{item.get('product_name','')}|{item.get('series_name','') or ''}|{item.get('inventory_number','') or ''}"
        item['broken'] = meta.get(key, {}).get('broken', False)
    overrides = get_arrival_overrides(storage_guid)
    for item in data:
        key = f"{item.get('product_name','')}|{item.get('series_name','') or ''}|{item.get('inventory_number','') or ''}"
        if key in overrides:
            item['date_arrival'] = short_date(overrides[key])
    def _sort_date(item):
        d = item.get('date_arrival')
        if not d or d == '—':
            return datetime.min
        try:
            return datetime.strptime(d, '%d.%m.%Y')
        except ValueError:
            return datetime.min
    data.sort(key=_sort_date, reverse=True)
    return jsonify(data)


@warehouse_bp.route('/balances/toggle-broken', methods=['POST'])
@api_login_required
def api_balance_toggle_broken():
    username = session.get('username', '')
    if not username:
        return jsonify({'error': 'Not authenticated'}), 401
    body = request.get_json(silent=True) or {}
    storage_guid = body.get('storage_guid')
    product_name = body.get('product_name', '')
    series_name = body.get('series_name', '')
    inventory_number = body.get('inventory_number', '')
    broken = body.get('broken', False)
    if not storage_guid:
        return jsonify({'error': 'storage_guid required'}), 400
    set_balance_item_broken(username, storage_guid, product_name, series_name, inventory_number, broken)
    return jsonify({'ok': True})


@warehouse_bp.route('/movements')
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
        item['date_arrival'] = short_date(item.get('date_arrival'))
        item['date_writeoff'] = short_date(item.get('date_writeoff'))
    return jsonify(data)


@warehouse_bp.route('/export-pdf', methods=['POST'])
@api_login_required
def api_warehouse_export_pdf():
    data = request.get_json()
    storage_name = data.get('storage_name', 'Склад')
    date_str = data.get('date', datetime.now().strftime('%d.%m.%Y'))
    balances = data.get('balances', [])
    html = warehouse_pdf_html(storage_name, date_str, balances)
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


@warehouse_bp.route('/stock-transfers', methods=['GET', 'POST'])
@api_login_required
def api_stock_transfers():
    client = get_api_client()
    if not client:
        if request.method == 'GET':
            return jsonify([])
        return jsonify({'error': 'No connection'}), 400
    if request.method == 'GET':
        data = client.get_stock_transfers()
        storages = {s['guid']: s['name'] for s in (client.get_storages() or [])}
        for doc in data:
            doc['warehouse_source_name'] = storages.get(doc.get('warehouse_source', ''), doc.get('warehouse_source', ''))
            doc['warehouse_dest_name'] = storages.get(doc.get('warehouse_dest', ''), doc.get('warehouse_dest', ''))
        sync_and_enrich_products(
            [item for doc in data for item in (doc.get('items', []))],
            client=client
        )
        return jsonify(data)
    elif request.method == 'POST':
        body = request.get_json(silent=True)
        if not body:
            return jsonify({'error': 'Invalid JSON'}), 400
        if 'attachments' in body:
            body['attachments'] = compress_attachments(body['attachments'])
        result = client.create_stock_transfer(body)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True, 'data': result})


@warehouse_bp.route('/balances-pick')
@api_login_required
def api_balances_pick():
    client = get_api_client()
    storage_guid = request.args.get('storage')
    if not storage_guid or not client:
        return jsonify([])
    data = client.get_balances_pick(storage_guid)
    sync_and_enrich_products(data, client=client)
    return jsonify(data)


@warehouse_bp.route('/stock-transfers/comment', methods=['PATCH'])
@api_login_required
def api_stock_transfer_add_comment():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    body = request.get_json(silent=True)
    if not body:
        return jsonify({'error': 'Invalid JSON'}), 400
    task_guid = body.get('task_guid')
    comment = body.get('comment', '').strip()
    if not task_guid or not comment:
        return jsonify({'error': 'task_guid and comment required'}), 400
    result = client.add_transfer_comment(task_guid, comment)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True, 'data': result})


@warehouse_bp.route('/stock-transfers/amount', methods=['PATCH'])
@api_login_required
def api_stock_transfer_change_amount():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    body = request.get_json(silent=True)
    if not body:
        return jsonify({'error': 'Invalid JSON'}), 400
    doc_item_guid = body.get('guid')
    task_guid = body.get('task_guid')
    amount = body.get('amount')
    if not doc_item_guid or not task_guid or amount is None:
        return jsonify({'error': 'guid, task_guid and amount required'}), 400
    result = client.change_transfer_amount(doc_item_guid, task_guid, int(amount))
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True, 'data': result})


@warehouse_bp.route('/stock-transfers/<task_guid>/attachment/<attachment_guid>')
@api_login_required
def api_stock_transfer_attachment(task_guid, attachment_guid):
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = client.get_stock_transfer_attachment(task_guid, attachment_guid)
    if not data or data.get('error'):
        return jsonify({'error': 'Not found'}), 404
    try:
        content = base64.b64decode(data.get('content', ''))
    except Exception:
        return jsonify({'error': 'Invalid attachment content'}), 500
    filename = data.get('filename', 'file')
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    mime_map = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp','bmp':'image/bmp','pdf':'application/pdf','zip':'application/zip','doc':'application/msword','docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','xls':'application/vnd.ms-excel','xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    mime = mime_map.get(ext, 'application/octet-stream')
    return send_file(
        io.BytesIO(content),
        mimetype=mime,
        as_attachment=False,
        download_name=filename
    )


@warehouse_bp.route('/stock-transfers/attachments', methods=['POST'])
@api_login_required
def api_stock_transfer_add_attachments():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    body = request.get_json(silent=True)
    if not body:
        return jsonify({'error': 'Invalid JSON'}), 400
    task_guid = body.get('task_guid')
    attachments = compress_attachments(body.get('attachments', []))
    if not task_guid or not attachments:
        return jsonify({'error': 'task_guid and attachments required'}), 400
    result = client.add_transfer_attachments(task_guid, attachments)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True, 'data': result})


@warehouse_bp.route('/stock-transfers/attachments', methods=['DELETE'])
@api_login_required
def api_stock_transfer_delete_attachment():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    body = request.get_json(silent=True)
    if not body:
        return jsonify({'error': 'Invalid JSON'}), 400
    task_guid = body.get('task_guid')
    attachment_guid = body.get('attachment_guid')
    if not task_guid or not attachment_guid:
        return jsonify({'error': 'task_guid and attachment_guid required'}), 400
    result = client.delete_transfer_attachment(task_guid, attachment_guid)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True})


@warehouse_bp.route('/update-arrival-from-transfers', methods=['POST'])
@api_login_required
def api_update_arrival_from_transfers():
    body = request.get_json(silent=True) or {}
    storage_guid = body.get('storage_guid')
    if not storage_guid:
        return jsonify({'error': 'storage_guid required'}), 400

    # Fetch or reuse cached archive data
    global _stock_transfers_history_cache
    cached = _stock_transfers_history_cache.get("data")
    if cached is None:
        client = get_api_client()
        if not client:
            return jsonify({'error': 'Нет соединения'}), 502
        cached = client.get_stock_transfers_history()
        if not cached:
            return jsonify({'error': 'Не удалось загрузить архив перемещений'}), 502
        all_items = [item for doc in cached for item in (doc.get('items', []))]
        sync_and_enrich_products(all_items, client=client)
        _stock_transfers_history_cache["data"] = cached
        _stock_transfers_history_cache["updated_at"] = datetime.now()

    updated = 0
    seen = set()
    for doc in cached:
        if doc.get('warehouse_dest') != storage_guid:
            continue
        doc_date = doc.get('date', '')
        if not doc_date:
            continue
        date_part = doc_date[:10]
        for item in doc.get('items', []):
            series = item.get('series') or {}
            pname = item.get('product_name', '') or ''
            sname = (series.get('name') or '') if isinstance(series, dict) else ''
            inv = (series.get('inventory_number') or '') if isinstance(series, dict) else ''
            key = f"{pname}|{sname}|{inv}"
            if key in seen:
                continue
            seen.add(key)
            set_arrival_override(storage_guid, pname, sname, inv, date_part)
            updated += 1

    return jsonify({'updated': updated})


# ─────── Stock Transfers History (Archive) ───────

@warehouse_bp.route('/stock-transfers-history')
@api_login_required
def api_stock_transfers_history():
    global _stock_transfers_history_cache
    now = datetime.now()

    # Check in-memory cache (4-hour TTL)
    cached = _stock_transfers_history_cache["data"]
    updated = _stock_transfers_history_cache["updated_at"]
    if cached is not None and updated is not None:
        elapsed = (now - updated).total_seconds()
        if elapsed < STOCK_TRANSFERS_HISTORY_TTL:
            # Ensure enriched even for cached data (fresh start after code update)
            client_for_enrich = get_api_client()
            if client_for_enrich:
                storages = {s['guid']: s['name'] for s in (client_for_enrich.get_storages() or [])}
                for doc in cached:
                    if not doc.get('warehouse_source_name'):
                        doc['warehouse_source_name'] = storages.get(doc.get('warehouse_source', ''), doc.get('warehouse_source', ''))
                        doc['warehouse_dest_name'] = storages.get(doc.get('warehouse_dest', ''), doc.get('warehouse_dest', ''))
                items_to_enrich = [item for doc in cached if not any(
                    item.get('product_name') for item in doc.get('items', [])
                ) for item in doc.get('items', [])]
                if items_to_enrich:
                    sync_and_enrich_products(items_to_enrich, client=client_for_enrich)
            return jsonify(cached)

    client = get_api_client()
    if not client:
        return jsonify([])

    data = client.get_stock_transfers_history()
    if data is None:
        return jsonify({'error': 'Upstream error'}), 502

    # Enrich with storage names and product names
    storages = {s['guid']: s['name'] for s in (client.get_storages() or [])}
    for doc in data:
        doc['warehouse_source_name'] = storages.get(doc.get('warehouse_source', ''), doc.get('warehouse_source', ''))
        doc['warehouse_dest_name'] = storages.get(doc.get('warehouse_dest', ''), doc.get('warehouse_dest', ''))
    sync_and_enrich_products(
        [item for doc in data for item in (doc.get('items', []))],
        client=client
    )

    # Sort by date DESC (from new to old) — parse as datetime
    def _parse_dt(s):
        if not s:
            return datetime.min
        for fmt in ('%d.%m.%Y %H:%M:%S', '%d.%m.%Y', '%d.%m.%y %H:%M:%S', '%d.%m.%y %H:%M', '%d.%m.%Y %H:%M', '%d.%m.%y'):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                continue
        return datetime.min

    def _sort_dt(doc):
        return _parse_dt(doc.get('date', ''))
    data.sort(key=_sort_dt, reverse=True)

    # Update cache (only cache non-empty results)
    if data:
        _stock_transfers_history_cache["data"] = data
        _stock_transfers_history_cache["updated_at"] = now

    return jsonify(data)


@warehouse_bp.route('/stock-transfers-history-attachment')
@api_login_required
def api_stock_transfers_history_attachment():
    doc_guid = request.args.get('doc_guid')
    attachment_guid = request.args.get('attachment_guid')

    if not doc_guid or not attachment_guid:
        return jsonify({'error': 'doc_guid and attachment_guid are required'}), 400

    # Find document date from cache
    cached = _stock_transfers_history_cache.get("data")
    if not cached:
        return jsonify({'error': 'Document not found in cache'}), 404

    found_doc = None
    for doc in cached:
        if doc.get('guid') == doc_guid:
            found_doc = doc
            break

    if not found_doc:
        return jsonify({'error': 'Document not found in cache'}), 404

    doc_date = found_doc.get('date')
    if not doc_date:
        return jsonify({'error': 'Document date not available in cache'}), 404

    # Request 1C with date filter
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 502

    # Extract date portion (e.g. "10.06.2026 12:25:33" -> "10.06.2026")
    short_date_str = doc_date[:10] if len(doc_date) >= 10 else doc_date
    response_data = client.get_stock_transfers_history_attachment(doc_guid, attachment_guid, short_date_str)

    if not response_data:
        return jsonify({'error': 'Attachment not found'}), 404

    # Case 1: direct attachment response ({"guid": ..., "filename": ..., "content": ...})
    if isinstance(response_data, dict) and 'content' in response_data:
        return _send_attachment(response_data)

    # Case 2: list of documents for that day — find matching one
    if isinstance(response_data, list):
        for doc in response_data:
            if doc.get('guid') == doc_guid:
                attachments = doc.get('attachments', [])
                for att in attachments:
                    if att.get('guid') == attachment_guid:
                        return _send_attachment(att)
                break

    return jsonify({'error': 'Attachment not found'}), 404


def _send_attachment(att):
    try:
        content = base64.b64decode(att.get('content', ''))
    except Exception:
        return jsonify({'error': 'Invalid attachment content'}), 500
    filename = att.get('filename', 'file')
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    mime_map = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp','bmp':'image/bmp','pdf':'application/pdf','zip':'application/zip','doc':'application/msword','docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','xls':'application/vnd.ms-excel','xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    mime = mime_map.get(ext, 'application/octet-stream')
    return send_file(
        io.BytesIO(content),
        mimetype=mime,
        as_attachment=False,
        download_name=filename,
    )
