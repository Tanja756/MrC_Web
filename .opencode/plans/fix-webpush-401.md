# Fix WebPush 401 Unauthorized

## Root Cause
`setup_vapid.sh:18` uses `tail -c 32` on DER output from `openssl ec ... -outform DER`, which includes the public key. The last 32 bytes are the **y-coordinate** of the public key, not the actual private key. So `VAPID_PRIVATE_KEY` = y-coordinate, and every push attempt fails with 401.

## Steps

### 1. Fix `setup_vapid.sh` — line 18

Replace the broken private key extraction with proper DER parsing:

**Old:**
```bash
PRIVATE_KEY=$(openssl ec -in "$TMPDIR/private.pem" -outform DER 2>/dev/null | tail -c 32 | base64 -w0)
```

**New:**
```bash
PRIVATE_KEY=$(openssl ec -in "$TMPDIR/private.pem" -no_public -outform DER 2>/dev/null | python3 -c "
import sys, base64
data = sys.stdin.buffer.read()
idx = data.find(b'\\x04\\x20')
if idx < 0:
    sys.exit(1)
priv = data[idx+2:idx+34]
print(base64.urlsafe_b64encode(priv).decode().rstrip('='))
")
```

(`-no_public` excludes the public key from DER; Python finds the OCTET STRING tag `0x04` + length `0x20` = 32 bytes and extracts the raw private key.)

### 2. Regenerate VAPID keys

Run the fixed script:
```bash
cd /home/unknown/@temp/MrC_WebApp
bash setup_vapid.sh
```

This will overwrite `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `.env` with a correct pair.

### 3. Delete all existing push subscriptions

Old subscriptions are bound to the bogus VAPID key and will never work:
```bash
cd /home/unknown/@temp/MrC_WebApp
python3 -c "
from db import get_db_connection
conn = get_db_connection()
conn.execute('DELETE FROM push_subscriptions')
conn.commit()
conn.close()
print('Deleted all push subscriptions')
"
```

### 4. Handle 401 in error handling — `app.py:750`

Add `'401'` alongside `'410'` and `'404'` so failing subscriptions get cleaned up:

**Old:**
```python
            if '410' in err_str or '404' in err_str:
                delete_subscription(sub['endpoint'])
```

**New:**
```python
            if '410' in err_str or '404' in err_str or '401' in err_str:
                delete_subscription(sub['endpoint'])
```

### 5. Restart the app

```bash
sudo systemctl restart mrc-webapp  # or supervisorctl, or however the app runs
```

## Verification

1. Check that the new private key does NOT equal the y-coordinate:
```bash
python3 -c "
import base64, os
pub = os.environ.get('VAPID_PUBLIC_KEY') or open('.env').read().split('VAPID_PUBLIC_KEY=')[1].split('\n')[0]
priv = os.environ.get('VAPID_PRIVATE_KEY') or open('.env').read().split('VAPID_PRIVATE_KEY=')[1].split('\n')[0]
pb = base64.urlsafe_b64decode(pub + '==')
pr = base64.urlsafe_b64decode(priv + '==')
print('Private == y-coordinate:', pr == pb[33:65])  # must be False
print('Private unique:', pr.hex() != pb[33:65].hex())
"
```

2. Open the site in a browser, check that push subscription succeeds (look in DevTools > Console).
3. Trigger a warehouse balance change or task deadline for that user and confirm a push notification arrives.
