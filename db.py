import sqlite3
import logging

logger = logging.getLogger(__name__)

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
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
    conn.commit()
    conn.close()

def create_notification(username, type_, title, description, storage_guid=None):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT INTO notifications (username, type, title, description, storage_guid)
        VALUES (?, ?, ?, ?, ?)
    """, (username, type_, title, description, storage_guid))
    conn.commit()
    conn.close()

def get_active_notifications(username, hours=72):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT id, type, title, description, created_at, dismissed
        FROM notifications
        WHERE username = ? AND dismissed = 0
          AND datetime(created_at) > datetime('now', ?)
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
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO balance_snapshots (username, storage_guid, data, updated_at)
        VALUES (?, ?, ?, datetime('now'))
    """, (username, storage_guid, json.dumps(data)))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT OR REPLACE INTO task_snapshots (username, data, updated_at)
        VALUES (?, ?, datetime('now'))
    """, (username, json.dumps(data)))
    conn.commit()
    conn.close()

def notification_exists(username, type_, desc_substring, minutes=60):
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        SELECT COUNT(*) FROM notifications
        WHERE username = ? AND type = ? AND dismissed = 0
          AND description LIKE ? AND datetime(created_at) > datetime('now', ?)
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


# Инициализация БД при импорте модуля
try:
    init_db()
    init_notifications_table()
    init_announcements_table()
    init_task_snapshots_table()
    init_push_subscriptions_table()
except Exception as e:
    logger.warning(f"init_db failed (readonly?): {e}")