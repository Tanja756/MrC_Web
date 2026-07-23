import logging
from flask import Blueprint, request, jsonify, session
from .helpers import api_login_required
from db import get_all_shops, add_shop, update_shop, delete_shop, set_user_shop_in_work, get_user_shops_status

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
    rowid = add_shop(shop_number, sap_code, address,
                     dm_name=data.get('dm_name', '').strip(),
                     dm_phone=data.get('dm_phone', '').strip(),
                     adm1_name=data.get('adm1_name', '').strip(),
                     adm1_phone=data.get('adm1_phone', '').strip(),
                     adm2_name=data.get('adm2_name', '').strip(),
                     adm2_phone=data.get('adm2_phone', '').strip())
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
    ok = update_shop(rowid, shop_number, sap_code, address,
                     dm_name=data.get('dm_name', '').strip(),
                     dm_phone=data.get('dm_phone', '').strip(),
                     adm1_name=data.get('adm1_name', '').strip(),
                     adm1_phone=data.get('adm1_phone', '').strip(),
                     adm2_name=data.get('adm2_name', '').strip(),
                     adm2_phone=data.get('adm2_phone', '').strip())
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


@references_bp.route('/shops/user-status')
@api_login_required
def api_shops_user_status():
    username = session.get('username', '')
    status = get_user_shops_status(username)
    return jsonify(status)


@references_bp.route('/shops/user-status', methods=['POST'])
@api_login_required
def api_shops_set_user_status():
    username = session.get('username', '')
    data = request.json or {}
    sap_code = data.get('sap_code', '').strip()
    in_work = bool(data.get('in_work', False))
    if not sap_code:
        return jsonify({'error': 'sap_code обязателен'}), 400
    set_user_shop_in_work(username, sap_code, in_work)
    return jsonify({'success': True})
