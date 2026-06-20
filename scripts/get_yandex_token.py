#!/usr/bin/env python3
import os
import sys
import time
import json
import argparse

import requests


TOKEN_URL = "https://oauth.yandex.ru/token"
DEVICE_CODE_URL = "https://oauth.yandex.ru/device/code"


def load_env_client():
    try:
        from dotenv import load_dotenv, set_key, find_dotenv
        load_dotenv()
        client_id = os.environ.get("YANDEX_CLIENT_ID", "")
        client_secret = os.environ.get("YANDEX_CLIENT_SECRET", "")
        return client_id, client_secret, find_dotenv()
    except ImportError:
        return os.environ.get("YANDEX_CLIENT_ID", ""), os.environ.get("YANDEX_CLIENT_SECRET", ""), None


def request_device_code(client_id):
    r = requests.post(DEVICE_CODE_URL, data={
        "client_id": client_id,
        "scope": "cloud_api:disk.write cloud_api:disk.read",
    })
    r.raise_for_status()
    return r.json()


def poll_token(client_id, client_secret, device_code, interval=5):
    data = {
        "grant_type": "device_code",
        "code": device_code,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    while True:
        r = requests.post(TOKEN_URL, data=data)
        resp = r.json()
        if "access_token" in resp:
            return resp
        if resp.get("error") == "authorization_pending":
            time.sleep(interval)
            continue
        if resp.get("error") == "slow_down":
            interval += 5
            time.sleep(interval)
            continue
        raise RuntimeError(f"Yandex OAuth error: {resp.get('error_description', resp.get('error', 'unknown'))}")


def main():
    parser = argparse.ArgumentParser(description="Get Yandex OAuth refresh token for Yandex.Disk")
    parser.add_argument("--client-id", help="Yandex OAuth client ID (overrides .env)")
    parser.add_argument("--client-secret", help="Yandex OAuth client secret (overrides .env)")
    parser.add_argument("--dotenv", action="store_true", help="Write YANDEX_REFRESH_TOKEN to .env")
    args = parser.parse_args()

    client_id = args.client_id
    client_secret = args.client_secret
    dotenv_path = None

    if not client_id or not client_secret:
        env_id, env_secret, found = load_env_client()
        if not client_id:
            client_id = env_id
        if not client_secret:
            client_secret = env_secret
        if args.dotenv:
            dotenv_path = found

    if not client_id:
        print("Error: YANDEX_CLIENT_ID not set. Provide --client-id or set in .env", file=sys.stderr)
        sys.exit(1)
    if not client_secret:
        print("Error: YANDEX_CLIENT_SECRET not set. Provide --client-secret or set in .env", file=sys.stderr)
        sys.exit(1)

    print("Requesting device code from Yandex...")
    device = request_device_code(client_id)
    code = device["user_code"]
    url = device["verification_url"]
    device_code = device["device_code"]

    print()
    print("╔══════════════════════════════════════════════════╗")
    print("║                                                ║")
    print(f"║   Перейдите по ссылке:                         ║")
    print(f"║   {url:<46}║")
    print(f"║                                                ║")
    print(f"║   И введите код:  {code:<28}║")
    print(f"║                                                ║")
    print("╚══════════════════════════════════════════════════╝")
    print()
    print("Ожидание подтверждения...")

    try:
        token_data = poll_token(client_id, client_secret, device_code)
    except KeyboardInterrupt:
        print("\nОтменено.")
        sys.exit(1)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    access_token = token_data["access_token"]
    refresh_token = token_data.get("refresh_token", "")

    print()
    print("✓ Авторизация успешна!")
    print()
    print("Добавьте в .env:") if not args.dotenv else None
    print(f"  YANDEX_CLIENT_ID={client_id}")
    print(f"  YANDEX_CLIENT_SECRET={client_secret}")
    print(f"  YANDEX_REFRESH_TOKEN={refresh_token}")
    print()

    if args.dotenv:
        try:
            from dotenv import set_key
            if not dotenv_path:
                dotenv_path = ".env"
            set_key(dotenv_path, "YANDEX_CLIENT_ID", client_id)
            set_key(dotenv_path, "YANDEX_CLIENT_SECRET", client_secret)
            set_key(dotenv_path, "YANDEX_REFRESH_TOKEN", refresh_token)
            print(f"✓ Записано в {dotenv_path}")
        except ImportError:
            print("Warning: python-dotenv not available, skipping write to .env", file=sys.stderr)
        except Exception as e:
            print(f"Warning: failed to write .env: {e}", file=sys.stderr)

    print("Access token (действует 1 год):")
    print(f"  {access_token}")
    print()


if __name__ == "__main__":
    main()
