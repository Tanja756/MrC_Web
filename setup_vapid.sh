#!/bin/bash
# Скрипт для генерации VAPID-ключей и записи в .env
set -e

ENV_FILE=".env"
EMAIL="${1:-admin@example.com}"

echo "=== Генерация VAPID-ключей ==="

# Создаём временную папку
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Генерируем ECDSA ключ на кривой prime256v1 (P-256)
openssl ecparam -genkey -name prime256v1 -out "$TMPDIR/private.pem" 2>/dev/null

# Извлекаем приватный ключ в base64 (raw 32 байта)
PRIVATE_KEY=$(openssl ec -in "$TMPDIR/private.pem" -outform DER 2>/dev/null | tail -c 32 | base64 -w0)

# Извлекаем публичный ключ в base64 (raw 65 байт — 0x04 + x + y)
PUBLIC_KEY=$(openssl ec -in "$TMPDIR/private.pem" -pubout -outform DER 2>/dev/null | tail -c 65 | base64 -w0)

echo "  Приватный ключ (VAPID_PRIVATE_KEY):  [${#PRIVATE_KEY} символов]"
echo "  Публичный ключ (VAPID_PUBLIC_KEY):    [${#PUBLIC_KEY} символов]"

# Читаем текущий .env
if [ -f "$ENV_FILE" ]; then
    ENV_CONTENT=$(cat "$ENV_FILE")
else
    ENV_CONTENT=""
fi

# Функция замены или добавления параметра
set_env() {
    local key="$1"
    local value="$2"
    # Экранируем для sed
    local escaped_value=$(echo "$value" | sed 's/[&/\]/\\&/g')
    if echo "$ENV_CONTENT" | grep -q "^${key}="; then
        ENV_CONTENT=$(echo "$ENV_CONTENT" | sed "s|^${key}=.*|${key}=${escaped_value}|")
    else
        ENV_CONTENT="${ENV_CONTENT}\n${key}=${escaped_value}"
    fi
}

set_env "VAPID_PUBLIC_KEY" "$PUBLIC_KEY"
set_env "VAPID_PRIVATE_KEY" "$PRIVATE_KEY"
set_env "VAPID_CLAIM_EMAIL" "$EMAIL"

# Записываем обратно
echo -e "$ENV_CONTENT" > "$ENV_FILE"

# Убираем лишние пустые строки в конце
sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$ENV_FILE" 2>/dev/null || true
echo -e "\n" >> "$ENV_FILE"

echo "=== Готово! Ключи записаны в $ENV_FILE ==="
echo "  VAPID_PUBLIC_KEY  = $PUBLIC_KEY"
echo "  VAPID_PRIVATE_KEY = $PRIVATE_KEY"
echo "  VAPID_CLAIM_EMAIL = $EMAIL"

# Показываем итоговый .env
echo ""
echo "=== Содержимое .env (VAPID секция) ==="
grep -E "^VAPID_" "$ENV_FILE" || echo "(не найдено)"