import os
import re
import uuid
import tempfile
import subprocess
from datetime import datetime
from flask import Blueprint, request, jsonify, send_file, session
from .helpers import (
    api_login_required, get_api_client,
    get_storage_name, check_balance_changes, short_date, plural,
    warehouse_pdf_html,
    get_balance_item_meta, set_balance_item_broken,
)

warehouse_bp = Blueprint('warehouse', __name__, url_prefix='/api/warehouse')


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
        products = {p['guid']: p for p in (client.get_products() or [])}
        for doc in data:
            doc['warehouse_source_name'] = storages.get(doc.get('warehouse_source', ''), doc.get('warehouse_source', ''))
            doc['warehouse_dest_name'] = storages.get(doc.get('warehouse_dest', ''), doc.get('warehouse_dest', ''))
            for item in doc.get('items', []):
                guid = item.get('product_guid', '')
                prod = products.get(guid, {})
                item['product_name'] = prod.get('name', '') or prod.get('article', '') or guid
        return jsonify(data)
    elif request.method == 'POST':
        body = request.get_json(silent=True)
        if not body:
            return jsonify({'error': 'Invalid JSON'}), 400
        result = client.create_stock_transfer(body)
        if result and result.get('_error'):
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
    products = {p['guid']: p for p in (client.get_products() or [])}
    for item in data:
        guid = item.get('product_guid', '')
        prod = products.get(guid, {})
        item['product_name'] = prod.get('name', '') or prod.get('article', '') or guid
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
    if result and result.get('_error'):
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
    if result and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True, 'data': result})
