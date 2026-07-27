import sqlite3
import logging
import json
import time
import re
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)

def _retry_on_locked(fn, max_retries=5):
    for attempt in range(max_retries):
        try:
            fn()
            return
        except sqlite3.OperationalError as e:
            if 'locked' in str(e) and attempt < max_retries - 1:
                time.sleep(0.3 * (attempt + 1))
                continue
            raise

DB_NAME = "shops.db"

def lower_ru(text):
    return text.lower() if text else None

def upper_ru(text):
    return text.upper() if text else None

def get_db_connection():
    conn = sqlite3.connect(DB_NAME, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.create_function("LOWER_RU", 1, lower_ru)
    conn.create_function("UPPER_RU", 1, upper_ru)
    return conn

def init_db():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS shops (
            shop_number TEXT NOT NULL,
            sap_code TEXT NOT NULL,
            address TEXT NOT NULL,
            UNIQUE(shop_number, sap_code)
        )
    """)
    existing = {r[1] for r in c.execute("PRAGMA table_info('shops')").fetchall()}
    for col in ['dm_name', 'dm_phone', 'adm1_name', 'adm1_phone', 'adm2_name', 'adm2_phone']:
        if col not in existing:
            try:
                c.execute(f"ALTER TABLE shops ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
                logger.info(f"Added column {col} to shops table")
            except Exception as e:
                logger.warning(f"Could not add column {col} to shops table: {e}")
    c.execute("""
        CREATE TABLE IF NOT EXISTS fias_cache (
            raw TEXT PRIMARY KEY,
            normalized TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()

def add_shop_if_not_exists(shop_number, sap_code, address):
    if not all([shop_number, sap_code, address]):
        return
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT OR IGNORE INTO shops (shop_number, sap_code, address)
            VALUES (?, ?, ?)
        """, (shop_number, sap_code, address))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"add_shop_if_not_exists failed (readonly?): {e}")

def get_all_shops():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT rowid, shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone FROM shops ORDER BY shop_number")
    rows = c.fetchall()
    conn.close()
    return [{'id': r[0], 'shop_number': r[1], 'sap_code': r[2], 'address': r[3],
             'dm_name': r[4], 'dm_phone': r[5], 'adm1_name': r[6], 'adm1_phone': r[7],
             'adm2_name': r[8], 'adm2_phone': r[9]} for r in rows]

def add_shop(shop_number, sap_code, address, dm_name='', dm_phone='', adm1_name='', adm1_phone='', adm2_name='', adm2_phone=''):
    if not all([shop_number, sap_code, address]):
        return None
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "INSERT INTO shops (shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone)
    )
    rowid = c.lastrowid
    conn.commit()
    conn.close()
    return rowid

def update_shop(rowid, shop_number, sap_code, address, dm_name='', dm_phone='', adm1_name='', adm1_phone='', adm2_name='', adm2_phone=''):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "UPDATE shops SET shop_number = ?, sap_code = ?, address = ?, dm_name = ?, dm_phone = ?, adm1_name = ?, adm1_phone = ?, adm2_name = ?, adm2_phone = ? WHERE rowid = ?",
        (shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone, rowid)
    )
    affected = c.rowcount
    conn.commit()
    conn.close()
    return affected > 0

def delete_shop(rowid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM shops WHERE rowid = ?", (rowid,))
    affected = c.rowcount
    conn.commit()
    conn.close()
    return affected > 0

def find_shop_by_number(number):
    if not number:
        return None
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "SELECT shop_number, sap_code, address FROM shops WHERE shop_number = ?",
        (number,)
    )
    row = c.fetchone()
    conn.close()
    return row

def find_shop_by_sap(sap):
    if not sap:
        return None
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "SELECT shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone FROM shops WHERE sap_code = ?",
        (sap,)
    )
    row = c.fetchone()
    conn.close()
    return row

def find_shops_by_sap_list(saps):
    if not saps:
        return []
    conn = get_db_connection()
    c = conn.cursor()
    placeholders = ','.join('?' * len(saps))
    rows = c.execute(
        f"SELECT shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone FROM shops WHERE sap_code IN ({placeholders})",
        saps
    ).fetchall()
    conn.close()
    return rows

def search_shops(query):
    if not query:
        return []
    conn = get_db_connection()
    c = conn.cursor()
    like_query = f"%{query}%"
    c.execute("""
        SELECT shop_number, sap_code, address, dm_name, dm_phone, adm1_name, adm1_phone, adm2_name, adm2_phone FROM shops
        WHERE LOWER_RU(shop_number) LIKE LOWER_RU(?)
           OR LOWER_RU(sap_code) LIKE LOWER_RU(?)
           OR LOWER_RU(address) LIKE LOWER_RU(?)
    """, (like_query, like_query, like_query))
    rows = c.fetchall()
    conn.close()
    return rows

def update_shop_address(sap_code, new_address):
    if not sap_code or not new_address:
        return
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("UPDATE shops SET address = ? WHERE sap_code = ?", (new_address, sap_code))
    conn.commit()
    conn.close()

def init_user_shops_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS user_shops (
            username TEXT NOT NULL,
            sap_code TEXT NOT NULL,
            in_work INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (username, sap_code)
        )
    """)
    conn.commit()
    conn.close()

def set_user_shop_in_work(username, sap_code, in_work):
    if not username or not sap_code:
        return
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO user_shops (username, sap_code, in_work)
            VALUES (?, ?, ?)
            ON CONFLICT(username, sap_code) DO UPDATE SET in_work = excluded.in_work
        """, (username, sap_code, 1 if in_work else 0))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"set_user_shop_in_work failed: {e}")

def get_user_in_work_saps(username):
    if not username:
        return []
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT sap_code FROM user_shops WHERE username = ? AND in_work = 1", (username,))
        rows = c.fetchall()
        conn.close()
        return [r[0] for r in rows]
    except Exception as e:
        logger.warning(f"get_user_in_work_saps failed: {e}")
        return []

def get_user_shops_status(username):
    if not username:
        return {}
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT sap_code, in_work FROM user_shops WHERE username = ?", (username,))
        rows = c.fetchall()
        conn.close()
        return {r[0]: bool(r[1]) for r in rows}
    except Exception as e:
        logger.warning(f"get_user_shops_status failed: {e}")
        return {}

def get_fias_cache(raw_address):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT normalized FROM fias_cache WHERE raw = ?", (raw_address,))
    row = c.fetchone()
    conn.close()
    return row[0] if row else None

def set_fias_cache(raw, normalized):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("INSERT OR IGNORE INTO fias_cache (raw, normalized) VALUES (?, ?)", (raw, normalized))
    conn.commit()
    conn.close()

def is_document_eligible(shop_number):
    """Возвращает True, если по номеру магазина можно формировать документы (только цифры)."""
    return shop_number and shop_number.isdigit()

# --- NOTIFICATIONS ---

def init_notifications_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            storage_guid TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            dismissed INTEGER NOT NULL DEFAULT 0
        )
    """)
    c.execute("""
        CREATE INDEX IF NOT EXISTS idx_notifications_user_created
        ON notifications(username, created_at)
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS balance_snapshots (
            username TEXT NOT NULL,
            storage_guid TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (username, storage_guid)
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS balance_item_meta (
            username TEXT NOT NULL,
            storage_guid TEXT NOT NULL,
            product_name TEXT NOT NULL,
            series_name TEXT NOT NULL DEFAULT '',
            inventory_number TEXT NOT NULL DEFAULT '',
            broken INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (username, storage_guid, product_name, series_name, inventory_number)
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS balance_arrival (
            storage_guid TEXT NOT NULL,
            product_name TEXT NOT NULL,
            series_name TEXT NOT NULL DEFAULT '',
            inventory_number TEXT NOT NULL DEFAULT '',
            arrival_date TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (storage_guid, product_name, series_name, inventory_number)
        )
    """)
    # migration: add items_json column if not exists
    try:
        c.execute("ALTER TABLE notifications ADD COLUMN items_json TEXT DEFAULT NULL")
    except Exception:
        pass
    # migration: add external_id column if not exists
    try:
        c.execute("ALTER TABLE notifications ADD COLUMN external_id TEXT DEFAULT NULL")
    except Exception:
        pass
    conn.commit()
    conn.close()

def create_notification(username, type_, title, description, storage_guid=None, items=None, external_id=None):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        items_json = json.dumps(items) if items else None
        c.execute("""
            INSERT INTO notifications (username, type, title, description, storage_guid, items_json, external_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (username, type_, title, description, storage_guid, items_json, external_id))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def get_notification_by_id(notif_id, username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT id, type, title, description, storage_guid, items_json, dismissed
        FROM notifications WHERE id = ? AND username = ?
    """, (notif_id, username))
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    import json as _json
    items = _json.loads(row[5]) if row[5] else []
    return {
        'id': row[0], 'type': row[1], 'title': row[2],
        'description': row[3], 'storage_guid': row[4],
        'items': items, 'dismissed': bool(row[6])
    }

def get_active_notifications(username, hours=72):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT id, type, title, description, created_at, dismissed
        FROM notifications
        WHERE username = ? AND dismissed = 0
          AND datetime(created_at) > datetime('now', 'localtime', ?)
        ORDER BY created_at DESC
    """, (username, f'-{hours} hours'))
    rows = c.fetchall()
    conn.close()
    return [
        {
            'id': r[0], 'type': r[1], 'title': r[2],
            'description': r[3], 'created_at': r[4], 'dismissed': bool(r[5])
        }
        for r in rows
    ]

def dismiss_notification(notif_id, username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("UPDATE notifications SET dismissed=1 WHERE id=? AND username=?", (notif_id, username))
    conn.commit()
    conn.close()

def dismiss_all_notifications(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("UPDATE notifications SET dismissed=1 WHERE username=? AND dismissed=0", (username,))
    conn.commit()
    conn.close()

def count_user_notifications(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM notifications WHERE username=?", (username,))
    count = c.fetchone()[0]
    conn.close()
    return count

def get_snapshot(username, storage_guid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT data FROM balance_snapshots WHERE username=? AND storage_guid=?", (username, storage_guid))
    row = c.fetchone()
    conn.close()
    if row:
        import json
        return json.loads(row[0])
    return None

def get_snapshot_updated_at(username, storage_guid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT updated_at FROM balance_snapshots WHERE username=? AND storage_guid=?", (username, storage_guid))
    row = c.fetchone()
    conn.close()
    return row[0] if row else None

def save_snapshot(username, storage_guid, data):
    import json
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT OR REPLACE INTO balance_snapshots (username, storage_guid, data, updated_at)
            VALUES (?, ?, ?, datetime('now'))
        """, (username, storage_guid, json.dumps(data)))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)


def get_balance_item_meta(username, storage_guid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT product_name, series_name, inventory_number, broken
        FROM balance_item_meta
        WHERE username = ? AND storage_guid = ?
    """, (username, storage_guid))
    rows = c.fetchall()
    conn.close()
    result = {}
    for r in rows:
        key = f"{r[0]}|{r[1]}|{r[2]}"
        result[key] = {'broken': bool(r[3])}
    return result

def set_balance_item_broken(username, storage_guid, product_name, series_name, inventory_number, broken):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO balance_item_meta
            (username, storage_guid, product_name, series_name, inventory_number, broken, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    """, (username, storage_guid, product_name, series_name or '', inventory_number or '', 1 if broken else 0))
    conn.commit()
    conn.close()


def get_arrival_overrides(storage_guid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT product_name, series_name, inventory_number, arrival_date
        FROM balance_arrival
        WHERE storage_guid = ?
    """, (storage_guid,))
    rows = c.fetchall()
    conn.close()
    return {f"{r[0]}|{r[1]}|{r[2]}": r[3] for r in rows}

def set_arrival_override(storage_guid, product_name, series_name, inventory_number, arrival_date):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO balance_arrival
            (storage_guid, product_name, series_name, inventory_number, arrival_date, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    """, (storage_guid, product_name, series_name or '', inventory_number or '', arrival_date))
    conn.commit()
    conn.close()

# --- ANNOUNCEMENTS ---

def init_announcements_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.commit()
    conn.close()

def add_announcement(title, content):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("INSERT INTO announcements (title, content) VALUES (?, ?)", (title, content))
    conn.commit()
    conn.close()

def get_announcements(limit=3):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "SELECT id, title, content, created_at FROM announcements ORDER BY created_at DESC LIMIT ?",
        (limit,)
    )
    rows = c.fetchall()
    conn.close()
    return [
        {'id': r[0], 'title': r[1], 'content': r[2], 'created_at': r[3]}
        for r in rows
    ]


# --- PRODUCTS CATALOG ---

def init_products_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS products (
            guid TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            article TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.commit()
    conn.close()

def sync_products(products_list):
    if not products_list:
        return
    if isinstance(products_list, dict):
        products_list = products_list.get('products') or products_list.get('data') or []
    if not isinstance(products_list, list):
        return
    conn = get_db_connection()
    c = conn.cursor()
    for p in products_list:
        if not isinstance(p, dict):
            continue
        guid = p.get('guid', '')
        if not guid:
            continue
        c.execute("""
            INSERT INTO products (guid, name, article, unit, updated_at)
            VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
            ON CONFLICT(guid) DO UPDATE SET
                name = excluded.name,
                article = excluded.article,
                unit = excluded.unit,
                updated_at = datetime('now', 'localtime')
        """, (guid, p.get('name', ''), p.get('article', ''), p.get('unit', '')))
    conn.commit()
    conn.close()

def get_products_dict():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT guid, name, article, unit FROM products")
    rows = c.fetchall()
    conn.close()
    return {r[0]: {'guid': r[0], 'name': r[1], 'article': r[2], 'unit': r[3]} for r in rows}


# --- PRODUCT INSTANCES (история серийных и инвентарных номеров) ---

def init_product_instances_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS product_instances (
            product_guid TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL,
            series_name TEXT NOT NULL DEFAULT '',
            inventory_number TEXT NOT NULL DEFAULT '',
            last_storage_guid TEXT DEFAULT '',
            first_seen TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            last_seen TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            PRIMARY KEY (product_name, series_name, inventory_number)
        )
    """)
    conn.commit()
    conn.close()

def sync_product_instances_from_balances(balances, storage_guid=''):
    if not balances:
        return
    conn = get_db_connection()
    c = conn.cursor()
    now = "datetime('now', 'localtime')"
    for item in balances:
        c.execute(f"""
            INSERT INTO product_instances
                (product_name, series_name, inventory_number, last_storage_guid, last_seen)
            VALUES (?, ?, ?, ?, {now})
            ON CONFLICT(product_name, series_name, inventory_number) DO UPDATE SET
                last_storage_guid = excluded.last_storage_guid,
                last_seen = excluded.last_seen
        """, (item.get('product_name', ''), item.get('series_name', '') or '',
              item.get('inventory_number', '') or '', storage_guid))
    conn.commit()
    conn.close()

def sync_product_instances_from_items(items, storage_guid=''):
    """Sync instances from stock transfer/pick items that have product_guid."""
    if not items:
        return
    conn = get_db_connection()
    c = conn.cursor()
    now = "datetime('now', 'localtime')"
    for item in items:
        product_guid = item.get('product_guid', '') or ''
        product_name = item.get('product_name', '') or ''
        series_name = item.get('series_name', '') or ''
        inventory_number = item.get('inventory_number', '') or ''
        if not product_name and not series_name and not inventory_number:
            continue
        c.execute(f"""
            INSERT INTO product_instances
                (product_guid, product_name, series_name, inventory_number, last_storage_guid, last_seen)
            VALUES (?, ?, ?, ?, ?, {now})
            ON CONFLICT(product_name, series_name, inventory_number) DO UPDATE SET
                product_guid = CASE WHEN excluded.product_guid != '' THEN excluded.product_guid ELSE product_guid END,
                last_storage_guid = excluded.last_storage_guid,
                last_seen = excluded.last_seen
        """, (product_guid, product_name, series_name, inventory_number, storage_guid))
    conn.commit()
    conn.close()

def get_product_instances(product_name=None, product_guid=None):
    conn = get_db_connection()
    c = conn.cursor()
    params = []
    where = []
    if product_name:
        where.append("product_name = ?")
        params.append(product_name)
    if product_guid:
        where.append("product_guid = ?")
        params.append(product_guid)
    query = "SELECT product_guid, product_name, series_name, inventory_number, last_storage_guid, first_seen, last_seen FROM product_instances"
    if where:
        query += " WHERE " + " AND ".join(where)
    query += " ORDER BY last_seen DESC"
    c.execute(query, params)
    rows = c.fetchall()
    conn.close()
    return [
        {'product_guid': r[0], 'product_name': r[1], 'series_name': r[2],
         'inventory_number': r[3], 'last_storage_guid': r[4],
         'first_seen': r[5], 'last_seen': r[6]}
        for r in rows
    ]


# --- TASK SNAPSHOTS ---

def init_task_snapshots_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS task_snapshots (
            username TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (username)
        )
    """)
    conn.commit()
    conn.close()

def get_task_snapshot(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT data, updated_at FROM task_snapshots WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        import json
        return json.loads(row[0]), row[1]
    return None, None

def save_task_snapshot(username, data):
    import json
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT OR REPLACE INTO task_snapshots (username, data, updated_at)
            VALUES (?, ?, datetime('now'))
        """, (username, json.dumps(data)))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def init_task_user_snapshots_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS task_user_snapshots (
            username TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (username)
        )
    """)
    conn.commit()
    conn.close()

def get_task_user_snapshot(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT data, updated_at FROM task_user_snapshots WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        import json
        return json.loads(row[0]), row[1]
    return None, None

def save_task_user_snapshot(username, data):
    import json
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT OR REPLACE INTO task_user_snapshots (username, data, updated_at)
            VALUES (?, ?, datetime('now'))
        """, (username, json.dumps(data)))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def get_new_task_guids(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT storage_guid FROM notifications
        WHERE username = ? AND type = 'new_task' AND dismissed = 0
          AND storage_guid IS NOT NULL
    """, (username,))
    guids = [row[0] for row in c.fetchall()]
    conn.close()
    return guids

def notification_exists(username, type_, desc_substring, minutes=60):
    conn = get_db_connection()
    c = conn.cursor()
    if minutes is None:
        c.execute("""
            SELECT COUNT(*) FROM notifications
            WHERE username = ? AND type = ? AND description LIKE ?
        """, (username, type_, f'%{desc_substring}%'))
    else:
        c.execute("""
            SELECT COUNT(*) FROM notifications
            WHERE username = ? AND type = ? AND dismissed = 0
              AND description LIKE ? AND datetime(created_at) > datetime('now', 'localtime', ?)
        """, (username, type_, f'%{desc_substring}%', f'-{minutes} minutes'))
    count = c.fetchone()[0]
    conn.close()
    return count > 0

def notification_exists_by_external_id(username, external_id):
    if not external_id:
        return False
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT COUNT(*) FROM notifications
        WHERE username = ? AND external_id = ?
    """, (username, external_id))
    count = c.fetchone()[0]
    conn.close()
    return count > 0


# --- PUSH SUBSCRIPTIONS ---

def init_push_subscriptions_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            auth TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    c.execute("""
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_username
        ON push_subscriptions(username)
    """)
    conn.commit()
    conn.close()

def save_subscription(username, endpoint, auth, p256dh):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO push_subscriptions (username, endpoint, auth, p256dh)
        VALUES (?, ?, ?, ?)
    """, (username, endpoint, auth, p256dh))
    conn.commit()
    conn.close()

def get_subscriptions(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "SELECT endpoint, auth, p256dh FROM push_subscriptions WHERE username=?",
        (username,)
    )
    rows = c.fetchall()
    conn.close()
    return [
        {'endpoint': r[0], 'auth': r[1], 'p256dh': r[2]}
        for r in rows
    ]

def get_all_subscriptions():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT username, endpoint, auth, p256dh FROM push_subscriptions")
    rows = c.fetchall()
    conn.close()
    return [
        {'username': r[0], 'endpoint': r[1], 'auth': r[2], 'p256dh': r[3]}
        for r in rows
    ]

def delete_subscription(endpoint):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
    conn.commit()
    conn.close()

def delete_user_subscriptions(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM push_subscriptions WHERE username=?", (username,))
    conn.commit()
    conn.close()

def get_all_task_snapshot_users():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT username FROM task_snapshots")
    rows = c.fetchall()
    conn.close()
    return [r[0] for r in rows]


# --- USER CREDENTIALS (для фоновой проверки push-уведомлений) ---

def init_user_credentials_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS user_credentials (
            username TEXT NOT NULL PRIMARY KEY,
            password TEXT NOT NULL,
            is_service INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    try:
        c.execute("ALTER TABLE user_credentials ADD COLUMN is_service INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass
    conn.commit()
    conn.close()

def save_user_credentials(username, password):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO user_credentials (username, password, updated_at)
        VALUES (?, ?, datetime('now'))
    """, (username, password))
    conn.commit()
    conn.close()

def get_user_credentials(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT password FROM user_credentials WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    return row[0] if row else None

def get_user_by_username(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT username, password, is_service, updated_at FROM user_credentials WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        return {
            'username': row[0],
            'password': row[1],
            'is_service': bool(row[2]),
            'updated_at': row[3],
        }
    return None

def get_all_users_with_credentials():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT username FROM user_credentials")
    rows = c.fetchall()
    conn.close()
    return [r[0] for r in rows]


def clear_user_cache(username):
    """Удаляет все данные пользователя из кеша, кроме таблицы shops.
    Очищает: notifications, balance_snapshots, task_snapshots, push_subscriptions, user_credentials."""
    if not username:
        return
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM notifications WHERE username=?", (username,))
    c.execute("DELETE FROM balance_snapshots WHERE username=?", (username,))
    c.execute("DELETE FROM balance_item_meta WHERE username=?", (username,))
    c.execute("DELETE FROM task_snapshots WHERE username=?", (username,))
    c.execute("DELETE FROM task_user_snapshots WHERE username=?", (username,))
    c.execute("DELETE FROM push_subscriptions WHERE username=?", (username,))
    c.execute("DELETE FROM user_credentials WHERE username=?", (username,))
    c.execute("DELETE FROM yandex_uploads WHERE username=?", (username,))
    conn.commit()
    conn.close()
    logger.info(f"Cache cleared for user '{username}'")


# --- TASK TRACKING (taken_at / closed_at) ---

def init_task_tracking_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS task_tracking (
            guid TEXT NOT NULL,
            username TEXT NOT NULL,
            taken_at TEXT,
            closed_at TEXT,
            task_name TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (guid, username)
        )
    """)
    try:
        c.execute("ALTER TABLE task_tracking ADD COLUMN task_name TEXT NOT NULL DEFAULT ''")
    except Exception:
        pass
    conn.commit()
    conn.close()

def set_task_taken(username, guid):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO task_tracking (guid, username, taken_at)
            VALUES (?, ?, datetime('now', 'localtime'))
            ON CONFLICT(guid, username) DO UPDATE SET taken_at = datetime('now', 'localtime')
        """, (guid, username))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def clear_task_closed(username, guid):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            UPDATE task_tracking SET closed_at = NULL
            WHERE username = ? AND guid = ?
        """, (username, guid))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def set_task_closed(username, guid, task_name=''):
    import logging
    logger = logging.getLogger(__name__)
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        from datetime import datetime
        now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        logger.info(f"[DEBUG db/set_task_closed] Вставка/обновление: guid={guid}, username={username}, closed_at={now_str}(python), task_name={task_name}")
        c.execute("""
            INSERT INTO task_tracking (guid, username, closed_at, task_name)
            VALUES (?, ?, datetime('now', 'localtime'), ?)
            ON CONFLICT(guid, username) DO UPDATE SET
                closed_at = datetime('now', 'localtime'),
                task_name = COALESCE(NULLIF(?, ''), task_tracking.task_name)
        """, (guid, username, task_name, task_name))
        conn.commit()
        # Проверим что записалось
        c.execute("SELECT closed_at FROM task_tracking WHERE guid=? AND username=?", (guid, username))
        row = c.fetchone()
        logger.info(f"[DEBUG db/set_task_closed] Проверка после записи: closed_at={row[0] if row else 'NOT FOUND'}")
        conn.close()
    _retry_on_locked(_write)

def update_task_closed_date(username, guid, closed_at, task_name=''):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO task_tracking (guid, username, closed_at, task_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guid, username) DO UPDATE SET
                closed_at = ?,
                task_name = COALESCE(NULLIF(?, ''), task_tracking.task_name)
        """, (guid, username, closed_at, task_name, closed_at, task_name))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def get_tasks_tracking(guids, username):
    if not guids:
        return {}
    conn = get_db_connection()
    c = conn.cursor()
    placeholders = ','.join('?' for _ in guids)
    c.execute(f"""
        SELECT guid, taken_at, closed_at FROM task_tracking
        WHERE username = ? AND guid IN ({placeholders})
    """, (username, *guids))
    rows = c.fetchall()
    conn.close()
    return {r[0]: {'taken_at': r[1], 'closed_at': r[2]} for r in rows}


# --- YANDEX DISK UPLOAD TRACKING ---

def init_yandex_uploads_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS yandex_uploads (
            username TEXT NOT NULL PRIMARY KEY,
            tasks_hash TEXT,
            warehouse_hash TEXT,
            references_hash TEXT,
            hashes_hash TEXT
        )
    """)
    for col in ('references_hash', 'hashes_hash', 'tasks_user_hash', 'tasks_free_hash', 'tasks_closed_hash', 'ppr_hash', 'fn_schedule_hash', 'references_synced_at'):
        try:
            c.execute(f"ALTER TABLE yandex_uploads ADD COLUMN {col} TEXT")
        except Exception:
            pass
    conn.commit()
    conn.close()

def get_yandex_upload_status(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT tasks_hash, warehouse_hash, references_hash, hashes_hash, tasks_user_hash, tasks_free_hash, tasks_closed_hash, ppr_hash, fn_schedule_hash, references_synced_at FROM yandex_uploads WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        return {"tasks_hash": row[0], "warehouse_hash": row[1], "references_hash": row[2], "hashes_hash": row[3],
                "tasks_user_hash": row[4], "tasks_free_hash": row[5], "tasks_closed_hash": row[6], "ppr_hash": row[7],
                "fn_schedule_hash": row[8], "references_synced_at": row[9]}
    return None

def save_yandex_upload_status(username, tasks_hash=None, warehouse_hash=None, references_hash=None, hashes_hash=None,
                                tasks_user_hash=None, tasks_free_hash=None, tasks_closed_hash=None, ppr_hash=None,
                                fn_schedule_hash=None, references_synced_at=None):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        existing = get_yandex_upload_status(username) or {}
        c.execute("""
            INSERT OR REPLACE INTO yandex_uploads (username, tasks_hash, warehouse_hash, references_hash, hashes_hash,
                                                   tasks_user_hash, tasks_free_hash, tasks_closed_hash, ppr_hash,
                                                   fn_schedule_hash, references_synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            username,
            tasks_hash if tasks_hash is not None else existing.get("tasks_hash"),
            warehouse_hash if warehouse_hash is not None else existing.get("warehouse_hash"),
            references_hash if references_hash is not None else existing.get("references_hash"),
            hashes_hash if hashes_hash is not None else existing.get("hashes_hash"),
            tasks_user_hash if tasks_user_hash is not None else existing.get("tasks_user_hash"),
            tasks_free_hash if tasks_free_hash is not None else existing.get("tasks_free_hash"),
            tasks_closed_hash if tasks_closed_hash is not None else existing.get("tasks_closed_hash"),
            ppr_hash if ppr_hash is not None else existing.get("ppr_hash"),
            fn_schedule_hash if fn_schedule_hash is not None else existing.get("fn_schedule_hash"),
            references_synced_at if references_synced_at is not None else existing.get("references_synced_at"),
        ))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)


# --- TASK M15 TEXT ---

def init_task_m15_text_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS task_m15_text (
            task_guid TEXT PRIMARY KEY,
            equipment_text TEXT NOT NULL,
            request_code TEXT DEFAULT ''
        )
    """)
    c.execute("PRAGMA table_info(task_m15_text)")
    cols = [row[1] for row in c.fetchall()]
    if 'request_code' not in cols:
        c.execute("ALTER TABLE task_m15_text ADD COLUMN request_code TEXT DEFAULT ''")
    if 'hk_code' not in cols:
        c.execute("ALTER TABLE task_m15_text ADD COLUMN hk_code TEXT DEFAULT ''")
    conn.commit()
    conn.close()

def save_task_m15_text(task_guid, text, code='', hk_code=''):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO task_m15_text (task_guid, equipment_text, request_code, hk_code) VALUES (?, ?, ?, ?)",
        (task_guid, text, code, hk_code)
    )
    conn.commit()
    conn.close()

def get_task_m15_text(task_guid=None, hk_code=None):
    conn = get_db_connection()
    c = conn.cursor()
    if hk_code:
        c.execute("SELECT equipment_text, request_code FROM task_m15_text WHERE hk_code = ?", (hk_code,))
    else:
        c.execute("SELECT equipment_text, request_code FROM task_m15_text WHERE task_guid = ?", (task_guid,))
    row = c.fetchone()
    conn.close()
    if row:
        return {'text': row[0], 'code': row[1] or ''}
    return None

# --- TASK M15 ITEMS ---

def init_task_m15_items_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS task_m15_items (
            task_guid TEXT NOT NULL,
            product_name TEXT NOT NULL,
            series_name TEXT NOT NULL,
            PRIMARY KEY (task_guid, product_name, series_name)
        )
    """)
    conn.commit()
    conn.close()

def save_task_m15_items(task_guid, items):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM task_m15_items WHERE task_guid = ?", (task_guid,))
    for item in items:
        name = item.get('name', '')
        series = item.get('series', '')
        if name or series:
            c.execute(
                "INSERT INTO task_m15_items (task_guid, product_name, series_name) VALUES (?, ?, ?)",
                (task_guid, name, series)
            )
    conn.commit()
    conn.close()

def get_task_m15_items(task_guid):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT product_name, series_name FROM task_m15_items WHERE task_guid = ?", (task_guid,))
    rows = c.fetchall()
    conn.close()
    return [{'name': r[0], 'series': r[1]} for r in rows]

# --- USER SETTINGS ---

def init_user_settings_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            username TEXT PRIMARY KEY,
            notify_only_mine INTEGER NOT NULL DEFAULT 0,
            my_task_keywords TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    """)
    for col in ['profile_name', 'default_warehouse']:
        try:
            c.execute(f"ALTER TABLE user_settings ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        except Exception:
            pass
    for col in [('theme', 'dark'), ('mark_my_tasks', '0'), ('notify_all_warehouses', '1')]:
        try:
            c.execute(f"ALTER TABLE user_settings ADD COLUMN {col[0]} TEXT NOT NULL DEFAULT '{col[1]}'")
        except Exception:
            pass
    try:
        c.execute("ALTER TABLE user_settings ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE user_settings ADD COLUMN merry_milkman TEXT NOT NULL DEFAULT '0'")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE user_settings ADD COLUMN auto_generate_docs INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE user_settings ADD COLUMN auto_include_act INTEGER NOT NULL DEFAULT 1")
    except Exception:
        pass
    try:
        c.execute("ALTER TABLE user_settings ADD COLUMN auto_include_m15 INTEGER NOT NULL DEFAULT 1")
    except Exception:
        pass
    conn.commit()
    conn.close()

def save_user_settings(username, notify_only_mine, my_task_keywords,
                       profile_name='', default_warehouse='', theme='dark',
                       mark_my_tasks=False, notify_all_warehouses=True,
                       avatar_url='', merry_milkman=False,
                       auto_generate_docs=False, auto_include_act=True,
                       auto_include_m15=True):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT INTO user_settings (username, notify_only_mine, my_task_keywords,
            profile_name, default_warehouse, theme, mark_my_tasks,
            notify_all_warehouses, avatar_url, merry_milkman,
            auto_generate_docs, auto_include_act, auto_include_m15, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        ON CONFLICT(username) DO UPDATE SET
            notify_only_mine = excluded.notify_only_mine,
            my_task_keywords = excluded.my_task_keywords,
            profile_name = excluded.profile_name,
            default_warehouse = excluded.default_warehouse,
            theme = excluded.theme,
            mark_my_tasks = excluded.mark_my_tasks,
            notify_all_warehouses = excluded.notify_all_warehouses,
            avatar_url = excluded.avatar_url,
            merry_milkman = excluded.merry_milkman,
            auto_generate_docs = excluded.auto_generate_docs,
            auto_include_act = excluded.auto_include_act,
            auto_include_m15 = excluded.auto_include_m15,
            updated_at = datetime('now', 'localtime')
    """, (username, notify_only_mine, my_task_keywords,
          profile_name, default_warehouse, theme,
          1 if mark_my_tasks else 0,
          1 if notify_all_warehouses else 0,
          avatar_url,
          1 if merry_milkman else 0,
          1 if auto_generate_docs else 0,
          1 if auto_include_act else 0,
          1 if auto_include_m15 else 0))
    conn.commit()
    conn.close()

def get_user_settings(username):
    conn = get_db_connection()
    c = conn.cursor()
    try:
        c.execute("SELECT notify_only_mine, my_task_keywords, profile_name, default_warehouse, theme, mark_my_tasks, notify_all_warehouses, avatar_url, merry_milkman, auto_generate_docs, auto_include_act, auto_include_m15 FROM user_settings WHERE username = ?", (username,))
        row = c.fetchone()
        conn.close()
        if row:
            return {
                'notify_only_mine': bool(row[0]),
                'my_task_keywords': row[1],
                'profile_name': row[2] or '',
                'default_warehouse': row[3] or '',
                'theme': row[4] or 'dark',
                'mark_my_tasks': bool(int(row[5])) if row[5] else False,
                'notify_all_warehouses': bool(int(row[6])) if row[6] else True,
                'avatar_url': row[7] or '',
                'merry_milkman': bool(int(row[8])) if row[8] else False,
                'auto_generate_docs': bool(int(row[9])) if row[9] else False,
                'auto_include_act': bool(int(row[10])) if row[10] else True,
                'auto_include_m15': bool(int(row[11])) if row[11] else True,
            }
    except Exception:
        pass
    conn.close()
    return None

# --- FN SCHEDULE ---

def init_fn_schedule_table():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS fn_schedule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shop_number TEXT,
            sap_code TEXT,
            address TEXT,
            cashreg_number TEXT,
            engineer TEXT,
            month TEXT,
            fn_expiry TEXT,
            kkt_serial TEXT,
            be_name TEXT DEFAULT '',
            cluster_name TEXT DEFAULT '',
            gp_name TEXT DEFAULT '',
            factory_name TEXT DEFAULT '',
            ssi_ts5 TEXT DEFAULT '',
            replace_from TEXT DEFAULT '',
            replace_to TEXT DEFAULT '',
            replace_date TEXT DEFAULT '',
            status TEXT DEFAULT '',
            fn_id TEXT DEFAULT '',
            fn_prev_id TEXT DEFAULT '',
            kkt_model TEXT DEFAULT '',
            fn_model TEXT DEFAULT '',
            rnm_after_activation TEXT DEFAULT '',
            kkt_reg_status TEXT DEFAULT '',
            fp_received_date TEXT DEFAULT '',
            fn_activation_plus410 TEXT DEFAULT '',
            registry TEXT DEFAULT '',
            invoice TEXT DEFAULT '',
            payment TEXT DEFAULT '',
            comment TEXT DEFAULT '',
            card_sent TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            updated_at TEXT DEFAULT (datetime('now','localtime')),
            UNIQUE(kkt_serial)
        )
    """)
    conn.commit()
    conn.close()

def upsert_fn_schedule(items):
    conn = get_db_connection()
    c = conn.cursor()
    count = 0
    # cleanup existing data: strip leading ' from serial numbers
    c.execute("DELETE FROM fn_schedule WHERE kkt_serial LIKE ? AND substr(kkt_serial,2) IN (SELECT kkt_serial FROM fn_schedule WHERE kkt_serial NOT LIKE ?)", ("'%", "'%"))
    c.execute("UPDATE fn_schedule SET kkt_serial = substr(kkt_serial,2) WHERE kkt_serial LIKE ?", ("'%",))
    c.execute("UPDATE fn_schedule SET fn_id = substr(fn_id,2) WHERE fn_id LIKE ?", ("'%",))
    c.execute("UPDATE fn_schedule SET fn_prev_id = substr(fn_prev_id,2) WHERE fn_prev_id LIKE ?", ("'%",))
    c.execute("UPDATE fn_schedule SET rnm_after_activation = substr(rnm_after_activation,2) WHERE rnm_after_activation LIKE ?", ("'%",))
    conn.commit()
    # build cache of db addresses by sap_code
    saps = list({item.get('sap_code', '') for item in items if item.get('sap_code')})
    addr_cache = {}
    if saps:
        placeholders = ','.join('?' * len(saps))
        for row in c.execute(
            f"SELECT sap_code, address FROM shops WHERE sap_code IN ({placeholders})", saps
        ):
            addr_cache[row[0]] = row[1]
    for item in items:
        sap = item.get('sap_code', '')
        address = addr_cache.get(sap)
        if not address:
            raw = item.get('address', '')
            address = re.sub(r'^[^a-zA-Zа-яА-ЯёЁ]+', '', raw)
        c.execute("""
            INSERT INTO fn_schedule (
                shop_number, sap_code, address, cashreg_number, engineer, month,
                fn_expiry, kkt_serial, be_name, cluster_name, gp_name, factory_name,
                ssi_ts5, replace_from, replace_to, replace_date, status,
                fn_id, fn_prev_id, kkt_model, fn_model, rnm_after_activation,
                kkt_reg_status, fp_received_date, fn_activation_plus410,
                registry, invoice, payment, comment, card_sent
            ) VALUES (
                ?,?,?,?,?,?,
                ?,?,?,?,?,?,
                ?,?,?,?,?,
                ?,?,?,?,?,
                ?,?,?,?,
                ?,?,?,?
            )
            ON CONFLICT(kkt_serial) DO UPDATE SET
                shop_number=excluded.shop_number, sap_code=excluded.sap_code,
                address=excluded.address, cashreg_number=excluded.cashreg_number,
                engineer=excluded.engineer, month=excluded.month,
                fn_expiry=excluded.fn_expiry,
                be_name=excluded.be_name, cluster_name=excluded.cluster_name,
                gp_name=excluded.gp_name, factory_name=excluded.factory_name,
                ssi_ts5=excluded.ssi_ts5, replace_from=excluded.replace_from,
                replace_to=excluded.replace_to, replace_date=excluded.replace_date,
                status=excluded.status,
                fn_id=excluded.fn_id, fn_prev_id=excluded.fn_prev_id,
                kkt_model=excluded.kkt_model, fn_model=excluded.fn_model,
                rnm_after_activation=excluded.rnm_after_activation,
                kkt_reg_status=excluded.kkt_reg_status,
                fp_received_date=excluded.fp_received_date,
                fn_activation_plus410=excluded.fn_activation_plus410,
                registry=excluded.registry, invoice=excluded.invoice,
                payment=excluded.payment, comment=excluded.comment,
                card_sent=excluded.card_sent,
                updated_at=datetime('now','localtime')
        """, (
            item.get('shop_number'), sap, address,
            item.get('cashreg_number'), item.get('engineer'), item.get('month'),
            item.get('fn_expiry'), item.get('kkt_serial'),
            item.get('be_name', ''), item.get('cluster_name', ''),
            item.get('gp_name', ''), item.get('factory_name', ''),
            item.get('ssi_ts5', ''), item.get('replace_from', ''),
            item.get('replace_to', ''), item.get('replace_date', ''),
            item.get('status', ''),
            item.get('fn_id', ''), item.get('fn_prev_id', ''),
            item.get('kkt_model', ''), item.get('fn_model', ''),
            item.get('rnm_after_activation', ''),
            item.get('kkt_reg_status', ''), item.get('fp_received_date', ''),
            item.get('fn_activation_plus410', ''),
            item.get('registry', ''), item.get('invoice', ''),
            item.get('payment', ''), item.get('comment', ''),
            item.get('card_sent', '')
        ))
        count += 1
    conn.commit()
    conn.close()
    return count

def get_fn_schedule_list(engineer='', month=''):
    conn = get_db_connection()
    c = conn.cursor()
    query = "SELECT * FROM fn_schedule WHERE 1=1"
    params = []
    if engineer:
        query += " AND engineer = ?"
        params.append(engineer)
    if month:
        query += " AND month = ?"
        params.append(month)
    query += " ORDER BY shop_number"
    c.execute(query, params)
    rows = c.fetchall()
    conn.close()
    cols = [d[0] for d in c.description]
    return [dict(zip(cols, r)) for r in rows]

def get_fn_schedule_by_shop(shop_number):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM fn_schedule WHERE shop_number = ? AND status NOT IN ('Выполнена','Снят с учета') ORDER BY id", (shop_number,))
    rows = c.fetchall()
    conn.close()
    if not rows:
        return []
    cols = [d[0] for d in c.description]
    return [dict(zip(cols, r)) for r in rows]

def delete_fn_schedule(ids):
    conn = get_db_connection()
    c = conn.cursor()
    placeholders = ','.join('?' * len(ids))
    c.execute(f"DELETE FROM fn_schedule WHERE id IN ({placeholders})", ids)
    affected = c.rowcount
    conn.commit()
    conn.close()
    return affected

def get_fn_engineers():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT DISTINCT engineer FROM fn_schedule WHERE engineer != '' AND engineer IS NOT NULL ORDER BY engineer")
    rows = c.fetchall()
    conn.close()
    return [r[0] for r in rows]

def get_fn_months():
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT DISTINCT month FROM fn_schedule WHERE month != '' AND month IS NOT NULL ORDER BY month")
    rows = c.fetchall()
    conn.close()
    return [r[0] for r in rows]


# ── PPR (Planned Preventive Repairs) ────────────────────────────────────────

def init_ppr_tasks_table():
    conn = get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ppr_tasks (
            guid TEXT PRIMARY KEY,
            number TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'Принять в работу',
            date TEXT,
            period TEXT,
            priority INTEGER DEFAULT 0,
            name_department TEXT NOT NULL,
            user_name TEXT,
            guid_client TEXT,
            close_comment TEXT,
            latitude REAL DEFAULT 0.0,
            longitude REAL DEFAULT 0.0,
            has_attachments INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ppr_tasks_date ON ppr_tasks(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ppr_tasks_dept ON ppr_tasks(name_department)")
    try:
        conn.execute("ALTER TABLE ppr_tasks ADD COLUMN close_date TEXT")
    except:
        pass
    conn.close()


def get_ppr_list(year: int, quarter: int, department: str = None) -> list[dict]:
    month_start = (quarter - 1) * 3 + 1
    if quarter < 4:
        month_end = quarter * 3 + 1
        year_end = year
    else:
        month_end = 1
        year_end = year + 1
    date_start = f"{year:04d}-{month_start:02d}-01"
    date_end = f"{year_end:04d}-{month_end:02d}-01"

    query = "SELECT * FROM ppr_tasks WHERE date >= ? AND date < ?"
    params: list = [date_start, date_end]
    if department:
        query += " AND name_department = ?"
        params.append(department)
    query += " ORDER BY date DESC"

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(query, params)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_ppr_departments(year: int, quarter: int) -> list[str]:
    month_start = (quarter - 1) * 3 + 1
    if quarter < 4:
        month_end = quarter * 3 + 1
        year_end = year
    else:
        month_end = 1
        year_end = year + 1
    date_start = f"{year:04d}-{month_start:02d}-01"
    date_end = f"{year_end:04d}-{month_end:02d}-01"

    conn = get_db_connection()
    cursor = conn.execute(
        "SELECT DISTINCT name_department FROM ppr_tasks WHERE date >= ? AND date < ? ORDER BY name_department",
        (date_start, date_end)
    )
    rows = [r[0] for r in cursor.fetchall()]
    conn.close()
    return rows


def add_ppr_task(data: dict) -> str:
    task_guid = data.get("guid", str(uuid.uuid4()))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_db_connection()
    conn.execute("""
        INSERT INTO ppr_tasks (
            guid, number, name, description, status, date, period,
            priority, name_department, user_name, guid_client,
            close_comment, latitude, longitude, has_attachments,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        task_guid,
        data.get("number"),
        data.get("name"),
        data.get("description"),
        data.get("status", "open"),
        data.get("date", now[:10]),
        data.get("period"),
        data.get("priority", 0),
        data.get("name_department"),
        data.get("user_name"),
        data.get("guid_client"),
        data.get("close_comment"),
        data.get("latitude", 0.0),
        data.get("longitude", 0.0),
        1 if data.get("has_attachments") else 0,
        now,
        now
    ))
    conn.commit()
    conn.close()
    return task_guid


def add_ppr_tasks_batch(tasks_list: list[dict]) -> list[str]:
    guids = []
    conn = get_db_connection()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for data in tasks_list:
        task_guid = data.get("guid", str(uuid.uuid4()))
        guids.append(task_guid)
        conn.execute("""
            INSERT INTO ppr_tasks (
                guid, number, name, description, status, date, period,
                priority, name_department, user_name, guid_client,
                close_comment, latitude, longitude, has_attachments,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            task_guid,
            data.get("number"),
            data.get("name"),
            data.get("description"),
            data.get("status", "open"),
            data.get("date", now[:10]),
            data.get("period"),
            data.get("priority", 0),
            data.get("name_department"),
            data.get("user_name"),
            data.get("guid_client"),
            data.get("close_comment"),
            data.get("latitude", 0.0),
            data.get("longitude", 0.0),
            1 if data.get("has_attachments") else 0,
            now,
            now
        ))
    conn.commit()
    conn.close()
    return guids


def close_ppr_task(guid: str, comment: str, latitude: float = 0.0, longitude: float = 0.0, close_date: str = None) -> bool:
    now = datetime.now()
    now_str = now.strftime('%Y-%m-%d %H:%M:%S')
    close_date_val = close_date or now_str
    if len(close_date_val) <= 10:
        close_date_val = f"{close_date_val} {now.strftime('%H:%M:%S')}"
    conn = get_db_connection()
    cursor = conn.execute("""
        UPDATE ppr_tasks
        SET status = 'Завершена',
            close_comment = ?,
            close_date = ?,
            latitude = CASE WHEN ? != 0.0 THEN ? ELSE latitude END,
            longitude = CASE WHEN ? != 0.0 THEN ? ELSE longitude END,
            updated_at = ?
        WHERE guid = ? AND status != 'Завершена'
    """, (comment, close_date_val, latitude, latitude, longitude, longitude, now_str, guid))
    conn.commit()
    updated = cursor.rowcount > 0
    conn.close()
    return updated


def update_ppr_close_date(guid: str, close_date: str) -> bool:
    now = datetime.now()
    now_str = now.strftime('%Y-%m-%d %H:%M:%S')
    conn = get_db_connection()
    row = conn.execute("SELECT close_date FROM ppr_tasks WHERE guid = ?", (guid,)).fetchone()
    if row and row[0] and ' ' in row[0]:
        existing_time = row[0].split(' ', 1)[1]
        close_date = f"{close_date} {existing_time}"
    else:
        close_date = f"{close_date} {now.strftime('%H:%M:%S')}"
    cursor = conn.execute(
        "UPDATE ppr_tasks SET close_date = ?, updated_at = ? WHERE guid = ? AND status = 'Завершена'",
        (close_date, now_str, guid)
    )
    conn.commit()
    updated = cursor.rowcount > 0
    conn.close()
    return updated


# ── Route sheet cache ─────────────────────────────────────────────────────────

def init_route_sheet_cache_table():
    conn = get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS route_sheet_cache (
            username TEXT NOT NULL,
            month TEXT NOT NULL,
            row_id INTEGER NOT NULL,
            login_1c TEXT NOT NULL DEFAULT '',
            date TEXT NOT NULL,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            time TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (username, month, row_id)
        )
    """)
    conn.close()

def get_route_cache_entries(username, month):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        "SELECT date, content, type, time FROM route_sheet_cache WHERE username = ? AND month = ? ORDER BY row_id",
        (username, month)
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def save_route_cache_entries(username, month, entries):
    def _write():
        conn = get_db_connection()
        conn.execute("DELETE FROM route_sheet_cache WHERE username = ? AND month = ?", (username, month))
        for i, e in enumerate(entries):
            conn.execute(
                "INSERT INTO route_sheet_cache (username, month, row_id, login_1c, date, content, type, time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (username, month, i, username, e['date'], e['content'], e['type'], e.get('time', ''))
            )
        conn.commit()
        conn.close()
    _retry_on_locked(_write)

def delete_route_cache_entries(username, month):
    def _write():
        conn = get_db_connection()
        conn.execute("DELETE FROM route_sheet_cache WHERE username = ? AND month = ?", (username, month))
        conn.commit()
        conn.close()
    _retry_on_locked(_write)


# Инициализация БД при импорте модуля
try:
    init_db()
    init_notifications_table()
    init_announcements_table()
    init_task_snapshots_table()
    init_task_tracking_table()
    init_task_user_snapshots_table()
    init_push_subscriptions_table()
    init_products_table()
    init_product_instances_table()
    init_user_credentials_table()
    init_yandex_uploads_table()
    init_task_m15_items_table()
    init_task_m15_text_table()
    init_user_settings_table()
    init_user_shops_table()
    init_fn_schedule_table()
    init_ppr_tasks_table()
    init_route_sheet_cache_table()
except Exception as e:
    logger.warning(f"init_db failed (readonly?): {e}")