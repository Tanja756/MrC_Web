import sqlite3
import logging
import json
import time

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

def get_announcements(limit=5):
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
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
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
            PRIMARY KEY (guid, username)
        )
    """)
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

def set_task_closed(username, guid):
    def _write():
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO task_tracking (guid, username, closed_at)
            VALUES (?, ?, datetime('now', 'localtime'))
            ON CONFLICT(guid, username) DO UPDATE SET closed_at = datetime('now', 'localtime')
        """, (guid, username))
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


# Инициализация БД при импорте модуля
try:
    init_db()
    init_notifications_table()
    init_announcements_table()
    init_task_snapshots_table()
    init_task_tracking_table()
    init_task_user_snapshots_table()
    init_push_subscriptions_table()
    init_user_credentials_table()
except Exception as e:
    logger.warning(f"init_db failed (readonly?): {e}")