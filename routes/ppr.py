import os
import io
from datetime import datetime
from flask import Blueprint, request, jsonify, send_file
from openpyxl import load_workbook
from .helpers import api_login_required, get_api_client
from utils import compress_attachments

ppr_bp = Blueprint('ppr', __name__, url_prefix='/api/ppr')

PPR_TEMPLATE = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'templates_docs', 'ppr_template_3q.xlsx')


@ppr_bp.route('/list')
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


@ppr_bp.route('/departments')
@api_login_required
def api_ppr_departments():
    client = get_api_client()
    if not client:
        return jsonify({"departments": []})
    year = request.args.get('year', datetime.now().year, type=int)
    quarter = request.args.get('quarter', 1, type=int)
    data = client.get_ppr_departments(year, quarter)
    return jsonify(data or {"departments": []})


@ppr_bp.route('/close', methods=['POST'])
@api_login_required
def api_ppr_close():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    data = request.json or {}
    if 'attachments' in data:
        data['attachments'] = compress_attachments(data['attachments'])
    result = client.ppr_close(**data)
    if isinstance(result, dict) and result.get('_error'):
        return jsonify({'success': False, 'error': result['_error']}), 400
    return jsonify({'success': True})


@ppr_bp.route('/add', methods=['POST'])
@api_login_required
def api_ppr_add():
    client = get_api_client()
    if not client:
        return jsonify({'error': 'No connection'}), 400
    result = client.ppr_add(**request.json)
    return jsonify(result or {})


@ppr_bp.route('/export-xlsx', methods=['POST'])
@api_login_required
def api_ppr_export_xlsx():
    data = request.json or {}
    numbers = data.get('numbers', [])
    date_str = data.get('date', '')

    if not numbers:
        return jsonify({'error': 'No PPR selected'}), 400
    if not date_str:
        return jsonify({'error': 'Date is required'}), 400

    if not os.path.exists(PPR_TEMPLATE):
        return jsonify({'error': 'Template not found'}), 500

    try:
        day, month, year = map(int, date_str.split('.'))
        date_obj = datetime(year, month, day)
    except (ValueError, IndexError):
        return jsonify({'error': 'Invalid date format. Expected DD.MM.YYYY'}), 400

    numbers_set = set(numbers)

    wb = load_workbook(PPR_TEMPLATE)
    ws = wb.active

    for row_idx in range(ws.max_row, 1, -1):
        cell_val = ws.cell(row=row_idx, column=1).value
        if cell_val is None:
            ws.delete_rows(row_idx)
            continue
        cell_str = str(cell_val).strip()
        if cell_str not in numbers_set:
            ws.delete_rows(row_idx)
        else:
            ws.cell(row=row_idx, column=3).value = date_obj
            ws.cell(row=row_idx, column=3).number_format = 'DD.MM.YYYY'

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    return send_file(
        buf,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name='ppr_3q.xlsx'
    )
