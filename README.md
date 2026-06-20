# Mr.Check

Веб-интерфейс для работы с заявками 1С. Авторизация через 1С, данные тянутся напрямую из HTTP-API 1С без промежуточной БД.

## Возможности

- **Заявки** — просмотр, поиск, сортировка, закрепление. Три вкладки: в работе, свободные, закрытые. Массовое назначение, прикрепление файлов, GPS-координаты при закрытии
- **Склад** — остатки по складам с фильтрацией (всё / оборудование / ЗИП)
- **Зарплата** — помесячная разбивка начислений
- **ППР** — просмотр и закрытие планово-предупредительных работ по отделам с цветовой индикацией сроков
- **Загрузка ППР** — массовая загрузка графика ППР из XLSX (drag & drop, предпросмотр, валидация)
- **Формирование документов** — генерация АВР, Акта ФН и М15 в PDF через LibreOffice с подстановкой данных из заявки
- **Тёмная/светлая тема**
- **Адаптивная вёрстка** (десктоп + мобильные)

## Технологии

| Компонент | Технология |
|-----------|------------|
| Бэкенд | Python 3 + Flask 3.1 |
| HTTP-клиент | `requests` |
| Шаблоны | Jinja2 |
| Фронтенд | Bootstrap 5.3, Bootstrap Icons, vanilla JS |
| Парсинг XLSX | SheetJS (браузер) |
| PDF | LibreOffice headless (ODS → PDF), `pypdf` |
| БД | SQLite (кеш магазинов) |
| Сессии | Flask signed cookies |
| Продакшен | Gunicorn + systemd |

## Структура проекта

```
├── app.py                  # Flask-приложение (маршруты, ~564 строк)
├── api_client.py           # HTTP-клиент 1С API (~167 строк)
├── config.py               # Конфигурация Flask
├── db.py                   # SQLite-операции (~99 строк)
├── docgen.py               # Генерация документов (ODS → PDF, ~400 строк)
├── requirements.txt        # Зависимости Python
├── .env.example            # Шаблон переменных окружения
├── deploy.sh               # Скрипт деплоя
├── mrcheck-web.service     # systemd unit
├── templates/
│   ├── base.html           # Базовый шаблон
│   ├── login.html          # Страница входа
│   └── dashboard.html      # SPA-дашборд
├── static/
│   ├── style.css           # Кастомные стили (тёмная/светлая темы)
│   ├── dashboard.js        # Фронтенд (склад, зарплата, документы)
│   ├── tasks.js            # Фронтенд задач
│   └── ppr.js              # Фронтенд ППР и загрузки
└── templates_docs/         # ODS-шаблоны для документов
    ├── АВР.ods
    ├── ФН.ods
    ├── M15_Обратная.ods
    └── M15_Прямая.ods
```

## Установка и запуск

### Требования

- Python 3.x
- LibreOffice (для генерации PDF):
  ```bash
  sudo apt install libreoffice-headless libreoffice-calc
  ```
- HTTP-сервер 1С с API

### Разработка

```bash
git clone <repo> && cd MrC_WebApp
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# отредактируйте .env
python app.py
```

### Продакшен

```bash
sudo ./deploy.sh
```

Сервис запустится через systemd на порту 5000.

## Конфигурация

| Параметр | Описание |
|----------|----------|
| `SERVER_HOST` | Хост Flask (по умолч. `0.0.0.0`) |
| `SERVER_PORT` | Порт (по умолч. `5000`) |
| `SECRET_KEY` | Ключ для сессий Flask |
| `DB_PATH` | Путь к SQLite для кеша магазинов |
| `API_HOST` | Хост 1С HTTP-сервиса |
| `API_PORT` | Порт 1С |
| `API_DB` | Имя базы 1С |
| `API_USER` | Пользователь 1С |
| `API_PASS` | Пароль 1С |
| `API_SEARCH_LIMIT` | Лимит записей при поиске (по умолч. `500`) |
| `YANDEX_CLIENT_ID` | ID приложения Яндекс.OAuth |
| `YANDEX_CLIENT_SECRET` | Секрет приложения Яндекс.OAuth |
| `YANDEX_REFRESH_TOKEN` | Refresh-токен Яндекс.Диска (Device Auth Flow) |
| `BACKGROUND_CHECK_INTERVAL` | Интервал фоновой проверки (сек, по умолч. `600`) |
| `BALANCE_STALE_THRESHOLD` | Порог устаревания остатков (сек, по умолч. `600`) |

## Синхронизация с Яндекс.Диском

Фоновый воркер выгружает заявки, остатки складов и справочники (номенклатура, клиенты, склады) в JSON на Яндекс.Диск. Данные группируются по папкам логинов 1С в формате, максимально приближенном к ответам эндпоинтов 1С. Загрузка происходит только при изменениях (хэш SHA256). Для первоначального получения `YANDEX_REFRESH_TOKEN` используется Device Authorization Flow — `python scripts/get_yandex_token.py --dotenv`.

## API endpoints

### Аутентификация
- `GET/POST /login` — вход
- `GET /logout` — выход

### Заявки
- `GET /api/tasks/my` — мои заявки
- `GET /api/tasks/free` — свободные
- `GET /api/tasks/closed` — закрытые
- `GET /api/tasks/<guid>` — детали
- `POST /api/tasks/take` — взять в работу
- `POST /api/tasks/close` — закрыть

### Склад
- `GET /api/warehouse/storages` — список складов
- `GET /api/warehouse/balances?storage=GUID` — остатки

### Зарплата
- `GET /api/salary?start_date=&end_date=` — данные

### ППР
- `GET /api/ppr/list` — список
- `GET /api/ppr/departments` — отделы
- `POST /api/ppr/close` — закрыть
- `POST /api/ppr/add` — массовое создание

### Документы
- `POST /api/tasks/documents` — все 3 документа (ZIP)
- `POST /api/tasks/documents/act` — АВР
- `POST /api/tasks/documents/fn` — Акт ФН
- `POST /api/tasks/documents/m15` — М15

## Шаблоны документов

ODS-файлы в `templates_docs/` содержат плейсхолдеры вида `{SAP}`, `{SHOP}`, `{KA}` и т.д. При генерации они заменяются на данные из заявки. LibreOffice (headless) конвертирует ODS в PDF.
