import sqlite3
import logging

logger = logging.getLogger(__name__)

DB_NAME = "shops.db"

def lower_ru(text):
    return text.lower() if text else None

def upper_ru(text):
    return text.upper() if text else None

def get_db_connection():
    conn = sqlite3.connect(DB_NAME)
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

# Инициализация БД при импорте модуля
try:
    init_db()
except Exception as e:
    logger.warning(f"init_db failed (readonly?): {e}")