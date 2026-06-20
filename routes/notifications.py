from flask import Blueprint, request, jsonify, session
from db import (
    get_active_notifications, dismiss_notification, dismiss_all_notifications,
    get_notification_by_id, set_balance_item_broken, get_announcements,
)
from .helpers import api_login_required, refresh_balance_if_stale, check_tasks, copy_seed_notifications

notif_bp = Blueprint('notifications', __name__, url_prefix='/api/notifications')


@notif_bp.route('')
@api_login_required
def api_notifications():
    username = session.get('username', '')
    if not username:
        return jsonify([])
    storage_guid = request.args.get('storage')
    if storage_guid:
        try:
            refresh_balance_if_stale(username, storage_guid)
        except Exception:
            pass
    if request.args.get('check_tasks'):
        try:
            check_tasks(username)
        except Exception:
            pass
    notifs = get_active_notifications(username)
    if not notifs:
        copy_seed_notifications(username)
        notifs = get_active_notifications(username)
    return jsonify(notifs)


@notif_bp.route('/<int:notif_id>/dismiss', methods=['POST'])
@api_login_required
def api_notification_dismiss(notif_id):
    dismiss_notification(notif_id, session.get('username', ''))
    return jsonify({'ok': True})


@notif_bp.route('/dismiss-all', methods=['POST'])
@api_login_required
def api_notifications_dismiss_all():
    dismiss_all_notifications(session.get('username', ''))
    return jsonify({'ok': True})


@notif_bp.route('/<int:notif_id>/mark-broken', methods=['POST'])
@api_login_required
def api_notification_mark_broken(notif_id):
    username = session.get('username', '')
    notif = get_notification_by_id(notif_id, username)
    if not notif:
        return jsonify({'error': 'Уведомление не найдено'}), 404
    if notif['type'] != 'warehouse_arrival':
        return jsonify({'error': 'Неверный тип уведомления'}), 400
    if notif['dismissed']:
        return jsonify({'error': 'Уведомление уже скрыто'}), 400
    items = notif.get('items', [])
    storage_guid = notif['storage_guid']
    count = 0
    for item in items:
        series = item.get('series_name', '') or ''
        if not series:
            continue
        set_balance_item_broken(username, storage_guid, item['product_name'],
                                series, item.get('inventory_number', '') or '', True)
        count += 1
    dismiss_notification(notif_id, username)
    return jsonify({'ok': True, 'count': count})
