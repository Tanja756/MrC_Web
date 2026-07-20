import logging
from flask import Blueprint, request, jsonify, session, Response
from db import get_subscriptions, save_subscription, delete_subscription, get_announcements
from .helpers import (
    api_login_required, get_api_client, send_push_notification,
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CLAIM_EMAIL,
)

logger = logging.getLogger(__name__)
misc_bp = Blueprint('misc', __name__)


# --- Salary ---
@misc_bp.route('/api/salary')
@api_login_required
def api_salary():
    client = get_api_client()
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    if not all([start_date, end_date, client]):
        return jsonify({"data": [], "totalAmount": 0.0})
    return jsonify(client.get_salary(start_date, end_date))


# --- Profile (local only — 1C не имеет profile endpoint) ---
@misc_bp.route('/api/profile')
@api_login_required
def api_profile_get():
    username = session.get('username', '')
    if not username:
        return jsonify({"profile": {}})
    try:
        from db import get_user_settings
        settings = get_user_settings(username) or {}
        return jsonify({"profile": {
            "notifyOnlyMine": "true" if settings.get("notify_only_mine") else "",
            "myTaskKeywords": settings.get("my_task_keywords", ""),
            "profileName": settings.get("profile_name", ""),
            "defaultWarehouse": settings.get("default_warehouse", ""),
            "theme": settings.get("theme", "dark"),
            "markMyTasks": "true" if settings.get("mark_my_tasks") else "",
            "notifyAllWarehouses": "true" if settings.get("notify_all_warehouses", True) else "",
        }})
    except Exception as e:
        logger.warning(f"Failed to fetch profile: {e}")
        return jsonify({"profile": {}})


@misc_bp.route('/api/profile/clear-cache', methods=['POST'])
@api_login_required
def api_profile_clear_cache():
    username = session.get('username', '')
    if not username:
        return jsonify({'error': 'Not authenticated'}), 401
    try:
        from db import clear_user_cache
        clear_user_cache(username)
        return jsonify({'success': True, 'message': 'Кеш очищен'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@misc_bp.route('/api/profile', methods=['POST'])
@api_login_required
def api_profile_post():
    username = session.get('username', '')
    if not username:
        return jsonify({'error': 'Not authenticated'}), 401
    profile = request.json.get('profile', {})
    try:
        from db import save_user_settings
        notify_only_mine = 1 if profile.get('notifyOnlyMine') == 'true' else 0
        my_task_keywords = profile.get('myTaskKeywords', '')
        profile_name = profile.get('profileName', '')
        default_warehouse = profile.get('defaultWarehouse', '')
        theme = profile.get('theme', 'dark')
        mark_my_tasks = profile.get('markMyTasks') == 'true'
        notify_all_warehouses = profile.get('notifyAllWarehouses') == 'true'
        save_user_settings(username, notify_only_mine, my_task_keywords,
                           profile_name=profile_name,
                           default_warehouse=default_warehouse,
                           theme=theme,
                           mark_my_tasks=mark_my_tasks,
                           notify_all_warehouses=notify_all_warehouses)
        return jsonify({"status": "ok"})
    except Exception as e:
        logger.warning(f"Failed to save profile: {e}")
        return jsonify({"status": "error", "error": str(e)}), 500


# --- Announcements ---
@misc_bp.route('/api/announcements')
@api_login_required
def api_announcements():
    return jsonify(get_announcements())


# --- Push ---
@misc_bp.route('/api/push/vapid-public-key')
@api_login_required
def api_vapid_public_key():
    return jsonify({'publicKey': VAPID_PUBLIC_KEY})


@misc_bp.route('/api/push/subscribe', methods=['POST'])
@api_login_required
def api_push_subscribe():
    username = session.get('username', '')
    data = request.get_json(force=True)
    endpoint = data.get('endpoint', '')
    keys = data.get('keys', {})
    auth = keys.get('auth', '')
    p256dh = keys.get('p256dh', '')
    if not endpoint or not auth or not p256dh:
        return jsonify({'error': 'missing fields'}), 400
    save_subscription(username, endpoint, auth, p256dh)
    return jsonify({'ok': True})


@misc_bp.route('/api/push/unsubscribe', methods=['POST'])
@api_login_required
def api_push_unsubscribe():
    data = request.get_json(force=True)
    endpoint = data.get('endpoint', '')
    if endpoint:
        delete_subscription(endpoint)
    return jsonify({'ok': True})


@misc_bp.route('/api/push/test', methods=['POST'])
@api_login_required
def api_push_test():
    username = session.get('username', '')
    send_push_notification(username, 'Тестовое уведомление', 'Это тестовое push-уведомление со страницы зарплаты')
    return jsonify({'ok': True})


# --- Shop ---
@misc_bp.route('/api/shop/by-sap')
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

@misc_bp.route('/api/shop/by-sap-list', methods=['POST'])
@api_login_required
def api_shop_by_sap_list():
    data = request.json or {}
    saps = data.get('saps', [])
    if not saps:
        return jsonify({})
    from db import find_shops_by_sap_list
    rows = find_shops_by_sap_list(saps)
    result = {r[1]: {'shop': r[0], 'sap': r[1], 'addr': r[2]} for r in rows}
    return jsonify(result)


# --- Priorities ---
@misc_bp.route('/api/priorities')
@api_login_required
def api_priorities():
    return jsonify(session.get('priorities', []))


# --- Static file endpoints ---
@misc_bp.route('/sw.js')
def service_worker():
    return Response(open('sw.js', 'rb').read(), mimetype='application/javascript')


@misc_bp.route('/manifest.json')
def manifest():
    return Response(open('templates/manifest.json', 'rb').read(), mimetype='application/manifest+json')
