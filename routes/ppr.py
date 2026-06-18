from datetime import datetime
from flask import Blueprint, request, jsonify
from .helpers import api_login_required, get_api_client

ppr_bp = Blueprint('ppr', __name__, url_prefix='/api/ppr')


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
    data = request.json
    result = client.ppr_close(**data)
    if result and result.get('_error'):
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
