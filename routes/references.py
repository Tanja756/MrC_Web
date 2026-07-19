import logging
from flask import Blueprint, request, jsonify
from .helpers import api_login_required
from db import get_all_shops, add_shop, update_shop, delete_shop

logger = logging.getLogger(__name__)
references_bp = Blueprint('references', __name__, url_prefix='/api/references')


@references_bp.route('/shops')
@api_login_required
def api_shops_list():
    shops = get_all_shops()
    return jsonify(shops)


@references_bp.route('/shops', methods=['POST'])
@api_login_required
def api_shops_create():
    data = request.json or {}
    shop_number = data.get('shop_number', '').strip()
    sap_code = data.get('sap_code', '').strip()
    address = data.get('address', '').strip()
    if not all([shop_number, sap_code, address]):
        return jsonify({'error': 'Заполните все поля'}), 400
    rowid = add_shop(shop_number, sap_code, address)
    if rowid is None:
        return jsonify({'error': 'Не удалось добавить магазин (возможно, уже существует)'}), 409
    return jsonify({'id': rowid, 'shop_number': shop_number, 'sap_code': sap_code, 'address': address}), 201


@references_bp.route('/shops/<int:rowid>', methods=['PUT'])
@api_login_required
def api_shops_update(rowid):
    data = request.json or {}
    shop_number = data.get('shop_number', '').strip()
    sap_code = data.get('sap_code', '').strip()
    address = data.get('address', '').strip()
    if not all([shop_number, sap_code, address]):
        return jsonify({'error': 'Заполните все поля'}), 400
    ok = update_shop(rowid, shop_number, sap_code, address)
    if not ok:
        return jsonify({'error': 'Магазин не найден'}), 404
    return jsonify({'id': rowid, 'shop_number': shop_number, 'sap_code': sap_code, 'address': address})


@references_bp.route('/shops/<int:rowid>', methods=['DELETE'])
@api_login_required
def api_shops_delete(rowid):
    ok = delete_shop(rowid)
    if not ok:
        return jsonify({'error': 'Магазин не найден'}), 404
    return jsonify({'success': True})
