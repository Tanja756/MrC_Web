import requests
import logging
from flask import Blueprint, request, jsonify
from .helpers import api_login_required

logger = logging.getLogger(__name__)

FIAS_API_URL = "https://fias-public-service.nalog.ru/api/spas/v2.0/GetAddressHint"
MASTER_TOKEN = "bfa2407b-1dc4-4714-9346-b678408eb099"

FIAS_HEADERS = {
    "Content-Type": "application/json",
    "master-token": MASTER_TOKEN,
    "Origin": "https://fias.nalog.ru",
    "Referer": "https://fias.nalog.ru/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
}

fias_bp = Blueprint('fias', __name__, url_prefix='/api/fias')


def fetch_fias_hints(search_string: str, address_type: int = 2) -> list:
    if not search_string or not search_string.strip():
        return []
    payload = {
        "searchString": search_string.strip(),
        "addressType": address_type,
        "searchNonActive": False
    }
    try:
        resp = requests.post(FIAS_API_URL, json=payload, headers=FIAS_HEADERS, timeout=15)
        if resp.status_code == 200:
            return resp.json().get("hints", [])
    except Exception as e:
        logger.warning(f"FIAS API error: {e}")
    return []


@fias_bp.route('/suggest')
@api_login_required
def api_fias_suggest():
    q = request.args.get('q', '').strip()
    if not q or len(q) < 3:
        return jsonify({'suggestions': []})
    hints = fetch_fias_hints(q)
    suggestions = []
    seen = set()
    for h in hints:
        name = h.get('full_name') or h.get('name') or ''
        if not name or name in seen:
            continue
        seen.add(name)
        suggestions.append({'value': name})
        if len(suggestions) >= 10:
            break
    return jsonify({'suggestions': suggestions})
