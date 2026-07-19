import re
import time
from flask import Blueprint, request, jsonify
from .helpers import api_login_required
from .fias import fetch_fias_hints
from db import (
    upsert_fn_schedule, get_fn_schedule_list, get_fn_schedule_by_shop,
    delete_fn_schedule, get_fn_engineers, get_fn_months,
    update_shop_address, get_fias_cache, set_fias_cache
)

fn_bp = Blueprint('fn', __name__, url_prefix='/api/fn')


def _build_search_string(raw: str) -> str:
    parts = [p.strip() for p in raw.split(',')]
    for i, part in enumerate(parts):
        if any(c.isalpha() for c in part):
            parts = parts[i:]
            break
    return ', '.join(p for p in parts if p)


def _select_best_hint(hints: list) -> str:
    for name_key in ("full_name", "name"):
        for h in hints:
            name = h.get(name_key, "")
            if "зд." in name:
                return name
        for h in hints:
            name = h.get(name_key, "")
            if "д." in name:
                return name
    return hints[0].get("full_name", hints[0].get("name", ""))


def _normalize_with_fallbacks(search_string: str) -> str:
    hints = fetch_fias_hints(search_string)
    if hints:
        return _select_best_hint(hints)

    clean1 = search_string.replace(" УЛ", "").replace("_УЛ", "")
    clean1 = ", ".join(p for p in (x.strip() for x in clean1.split(",")) if p)
    hints = fetch_fias_hints(clean1)
    if hints:
        return _select_best_hint(hints)

    clean2 = re.sub(r'\bУЛ\b', '', search_string)
    clean2 = ", ".join(p for p in (x.strip() for x in clean2.split(",")) if p)
    hints = fetch_fias_hints(clean2)
    if hints:
        return _select_best_hint(hints)

    clean3 = re.sub(r'([А-Яа-яЁё_])УЛ', r'\1 УЛ', search_string)
    clean3 = clean3.replace('_УЛ', ' УЛ')
    clean3 = ", ".join(p for p in (x.strip() for x in clean3.split(",")) if p)
    hints = fetch_fias_hints(clean3)
    if hints:
        return _select_best_hint(hints)

    return search_string


def normalize_address(raw_line: str) -> str:
    cached = get_fias_cache(raw_line)
    if cached:
        return cached

    search_str = _build_search_string(raw_line)
    result = _normalize_with_fallbacks(search_str)
    set_fias_cache(raw_line, result)
    return result


@fn_bp.route('/normalize-addresses', methods=['POST'])
@api_login_required
def api_fn_normalize_addresses():
    data = request.json or {}
    rows = data.get('rows', [])
    if not rows:
        return jsonify({'results': []})

    results = []
    for row in rows:
        raw = (row.get('address') or '').strip()
        sap = (row.get('sap_code') or '').strip()
        if not raw or not sap:
            results.append({**row, 'normalized': raw})
            continue

        normalized = normalize_address(raw)
        if normalized != raw and normalized:
            update_shop_address(sap, normalized)

        results.append({**row, 'address': normalized, 'normalized': normalized})
        time.sleep(0.2)

    return jsonify({'results': results})


@fn_bp.route('/upload', methods=['POST'])
@api_login_required
def api_fn_upload():
    data = request.json or {}
    rows = data.get('rows', [])
    if not rows:
        return jsonify({'count': 0})
    count = upsert_fn_schedule(rows)
    return jsonify({'count': count})


@fn_bp.route('/list')
@api_login_required
def api_fn_list():
    engineer = request.args.get('engineer', '')
    month = request.args.get('month', '')
    rows = get_fn_schedule_list(engineer, month)
    return jsonify({'rows': rows})


@fn_bp.route('/engineers')
@api_login_required
def api_fn_engineers():
    return jsonify({'engineers': get_fn_engineers()})


@fn_bp.route('/months')
@api_login_required
def api_fn_months():
    return jsonify({'months': get_fn_months()})


@fn_bp.route('/shop/<shop_number>')
@api_login_required
def api_fn_shop(shop_number):
    rows = get_fn_schedule_by_shop(shop_number)
    return jsonify({'rows': rows})


@fn_bp.route('/items', methods=['DELETE'])
@api_login_required
def api_fn_delete():
    data = request.json or {}
    ids = data.get('ids', [])
    if not ids:
        return jsonify({'deleted': 0})
    affected = delete_fn_schedule(ids)
    return jsonify({'deleted': affected})
