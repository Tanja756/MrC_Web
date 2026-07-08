import sqlite3
import logging
import json
import time
import re

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
        "SELECT shop_number, sap_code, address FROM shops WHERE sap_code = ?",
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
        f"SELECT shop_number, sap_code, address FROM shops WHERE sap_code IN ({placeholders})",
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
        SELECT shop_number, sap_code, address FROM shops
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
    conn.commit()
    conn.close()

def create_notification(username, type_, title, description, storage_guid=None, items=None):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        items_json = json.dumps(items) if items else None
        c.execute("""
            INSERT INTO notifications (username, type, title, description, storage_guid, items_json)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (username, type_, title, description, storage_guid, items_json))
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
    conn = get_db_connection()
    c = conn.cursor()
    for p in products_list:
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

def set_task_closed(username, guid, task_name=''):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO task_tracking (guid, username, closed_at, task_name)
            VALUES (?, ?, datetime('now', 'localtime'), ?)
            ON CONFLICT(guid, username) DO UPDATE SET
                closed_at = datetime('now', 'localtime'),
                task_name = COALESCE(NULLIF(?, ''), task_tracking.task_name)
        """, (guid, username, task_name, task_name))
        conn.commit()
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
    for col in ('references_hash', 'hashes_hash', 'tasks_user_hash', 'tasks_free_hash', 'tasks_closed_hash'):
        try:
            c.execute(f"ALTER TABLE yandex_uploads ADD COLUMN {col} TEXT")
        except Exception:
            pass
    conn.commit()
    conn.close()

def get_yandex_upload_status(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT tasks_hash, warehouse_hash, references_hash, hashes_hash, tasks_user_hash, tasks_free_hash, tasks_closed_hash FROM yandex_uploads WHERE username=?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        return {"tasks_hash": row[0], "warehouse_hash": row[1], "references_hash": row[2], "hashes_hash": row[3],
                "tasks_user_hash": row[4], "tasks_free_hash": row[5], "tasks_closed_hash": row[6]}
    return None

def save_yandex_upload_status(username, tasks_hash=None, warehouse_hash=None, references_hash=None, hashes_hash=None,
                                tasks_user_hash=None, tasks_free_hash=None, tasks_closed_hash=None):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        existing = get_yandex_upload_status(username) or {}
        c.execute("""
            INSERT OR REPLACE INTO yandex_uploads (username, tasks_hash, warehouse_hash, references_hash, hashes_hash,
                                                   tasks_user_hash, tasks_free_hash, tasks_closed_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            username,
            tasks_hash if tasks_hash is not None else existing.get("tasks_hash"),
            warehouse_hash if warehouse_hash is not None else existing.get("warehouse_hash"),
            references_hash if references_hash is not None else existing.get("references_hash"),
            hashes_hash if hashes_hash is not None else existing.get("hashes_hash"),
            tasks_user_hash if tasks_user_hash is not None else existing.get("tasks_user_hash"),
            tasks_free_hash if tasks_free_hash is not None else existing.get("tasks_free_hash"),
            tasks_closed_hash if tasks_closed_hash is not None else existing.get("tasks_closed_hash"),
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
    conn.commit()
    conn.close()

def save_user_settings(username, notify_only_mine, my_task_keywords):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT INTO user_settings (username, notify_only_mine, my_task_keywords, updated_at)
        VALUES (?, ?, ?, datetime('now', 'localtime'))
        ON CONFLICT(username) DO UPDATE SET
            notify_only_mine = excluded.notify_only_mine,
            my_task_keywords = excluded.my_task_keywords,
            updated_at = datetime('now', 'localtime')
    """, (username, notify_only_mine, my_task_keywords))
    conn.commit()
    conn.close()

def get_user_settings(username):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT notify_only_mine, my_task_keywords FROM user_settings WHERE username = ?", (username,))
    row = c.fetchone()
    conn.close()
    if row:
        return {'notify_only_mine': bool(row[0]), 'my_task_keywords': row[1]}
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
    init_fn_schedule_table()
except Exception as e:
    logger.warning(f"init_db failed (readonly?): {e}")