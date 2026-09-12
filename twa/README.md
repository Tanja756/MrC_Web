# TWA-обёртка MrCheck (Google Play)

Trusted Web Activity: нативное приложение-обёртка вокруг PWA. Открывает
`https://<домен>/` в полнорэкранном Custom Tab без адресной строки, с диалогом
«Войти по отпечатку» и т.д. Офлайн-мост (Яндекс.Диск) работает как в браузере —
service worker PWA активен внутри TWA.

## Шаг 0. Требования

- Android Studio (или CLI: JDK 17 + Android SDK 34 + Gradle).
- HTTPS на домене приложения (TWA работает только по https).
- `assetlinks.json` на сервере (см. шаг 4).

## Шаг 1. Заменить placeholder-значения

Во всех файлах ниже замените:

| Placeholder | Где | На что |
|---|---|---|
| `mrc.example.com` | `app/src/main/AndroidManifest.xml` (host в intent-filter), `app/src/main/res/values/strings.xml` (`assetUrl`) | боевой домен приложения |
| `ru.mrcheck.app` | `app/build.gradle` (`namespace`, `applicationId`), `app/src/main/res/values/strings.xml` (`assetStatements` → `package_name`), `assetlinks.json.example` | желаемый package name |
| `ЗАМЕНИТЕ_НА_SHA256_ОТПЕЧАТОК` | `app/src/main/res/values/strings.xml` (`assetStatements`) | SHA-256 отпечаток (шаг 2) |

## Шаг 2. Ключ подписи и отпечаток

```bash
# создать keystore (один раз, СОХРАНИТЬ надёжно — перевыпуск невозможен)
keytool -genkeypair -v -keystore release.keystore -alias mrcheck \
        -keyalg RSA -keysize 2048 -validity 10950

# узнать SHA-256 отпечаток
keytool -list -v -keystore release.keystore -alias mrcheck | grep SHA256
```

Для публикации Google Play подписывает app своим ключом: возьмите отпечаток
из Google Play Console (Setup → App signing → **App signing key certificate**,
SHA-256) — он должен быть в `assetlinks.json` вместе с вашим upload-ключом.

## Шаг 3. Сборка

```bash
cd twa
# параметры подписи через окружение (не храните пароли в репо)
export TWA_KEYSTORE=/путь/release.keystore
export TWA_KEYSTORE_PASSWORD=...
export TWA_KEY_ALIAS=mrcheck
export TWA_KEY_PASSWORD=...

./gradlew bundleRelease   # или: android studio → Build → Generate Signed Bundle
# результат: app/build/outputs/bundle/release/app-release.aab
```

(Gradle wrapper при первом запуске: `gradle wrapper --gradle-version 8.7`
или просто откройте папку `twa/` в Android Studio — он сгенерирует wrapper.)

## Шаг 4. assetlinks.json на сервере

Положите файл `assetlinks.json` в корень приложения (рядом с `app.py`) или
задайте в `/opt/mrcheck-web/.env`:

```
TWA_PACKAGE_NAME=ru.mrcheck.app
TWA_CERT_FINGERPRINT=<SHA256 из шага 2>
```

и `sudo ./deploy.sh`. Проверка (домен + package подставить свои):

```bash
curl https://<домен>/.well-known/assetlinks.json
# и Android-проверка:
adb shell pm verify-app-links --re-verify ru.mrcheck.app
adb shell logcat | grep -i IntentFilter
```

Файл должен отдаваться с кодом 200 и валидным JSON — иначе Chrome не
установит связь «сайт ↔ приложение» и приложение будет открываться в обычном
Custom Tab с адресной строкой.

## Шаг 5. Публикация

Google Play Console → Create app → загрузить `app-release.aab`.
Иконка 512×512 уже сгенерирована: `twa/play/ic_launcher-playstore.png`.

## Проверка после установки

1. Приложение открывается **без адресной строки** (иначе — см. шаг 4).
2. Офлайн-мост: «Настройки → Синхронизация данных», тест «блокировка
   провайдера» (см. корневой README / Фаза 3 e2e-тесты).
3. Push-уведомления приходят внутри TWA (не требуют изменений).
