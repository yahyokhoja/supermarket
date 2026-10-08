# Universal Supermarket Delivery (TypeScript + TSX)

Платформа доставки супермаркета:
- backend: Node.js + Express + TypeScript
- frontend: React + TSX + Vite
- БД: PostgreSQL

## Функции

- Регистрация и вход (JWT)
- Кабинет пользователя
- Каталог товаров
- Корзина
- Оформление заказа
- Статусы заказа
- Роли: `customer`, `courier`, `admin`
- Панель курьера
- Админ-панель
- API взаимодействие frontend ↔ backend
- Автоназначение курьера по минимальной загрузке

## Установка

```bash
npm install
cp .env.example .env
```

Настройка более точного геокодирования (опционально, рекомендуется):

- в `.env` укажите `GEOCODER_PROVIDER=2gis`
- добавьте `DGIS_GEOCODER_API_KEY=<ваш_ключ>`

Альтернативы:
- `GEOCODER_PROVIDER=yandex` + `YANDEX_GEOCODER_API_KEY=<ваш_ключ>`
- если ключа нет, поставьте `GEOCODER_PROVIDER=osm`

Для интеграции с отдельным map-platform:
- в `.env` укажите `MAP_DATABASE_URL=postgresql://map:mappass@localhost:5434/mapdb`

## Dev запуск

Запуск всего проекта одной командой:

```bash
npm run start:all
```

Остановка всего проекта:

```bash
npm run stop:all
```

Перезапуск всего проекта:

```bash
npm run restart:all
```

Статус контейнеров и портов:

```bash
npm run status:all
```

Полная диагностика (env, docker, порты, health):

```bash
npm run doctor:all
```

Открыть: `https://localhost:5173`

Если нужен ручной режим по отдельности:

Терминал 1 (API):

```bash
npm run dev:api
```

Терминал 2 (Frontend TSX):

```bash
npm run dev:web
```

## Локальный HTTPS (телефон/геолокация)

Сгенерировать dev-сертификат:

```bash
npm run https:cert
```

Если нужен доступ по IP (например, телефон в одной Wi-Fi сети), добавьте IP в SAN:

```bash
DEV_HTTPS_IP=10.83.73.50 npm run https:cert
```

Запуск с HTTPS:

```bash
DEV_HTTPS_IP=<ваш-ip> npm run https:cert
npm run dev:all:https
```

Открыть:
- `https://localhost:5173`
- или `https://<ваш-ip>:5173` (после подтверждения сертификата в браузере)

## Локальный PostgreSQL (подготовка)

В проект добавлен локальный Postgres через Docker Compose:

```bash
npm run db:up
```

Схема больше не создаётся и не изменяется автоматически при старте API.

Для уже существующей локальной БД применяйте только версионированные миграции:

```bash
npm run db:migrate
```

Для новой пустой БД сначала явно создайте legacy baseline, затем примените миграции:

```bash
npm run db:baseline
npm run db:migrate
```

`db:baseline` откажется работать, если таблица `users` уже существует. Перед применением миграций к важной локальной базе сделайте резервную копию. Миграция этапа 1 не исправляет обнаруженные расхождения автоматически; отчёт доступен через `GET /api/admin/warehouse/consistency`.

Проверка логов:

```bash
npm run db:logs
```

Остановка:

```bash
npm run db:down
```

Пример переменных для Postgres: `.env.postgres.example`

Важно:
- backend уже работает через PostgreSQL (`DATABASE_URL`);
- для локальной разработки используется порт `55432`:
  `postgresql://supermarket:supermarket_dev_password@localhost:55432/supermarket`;
- для локальной разработки используйте `docker-compose.postgres.yml`.
- readiness API: `GET /api/health/ready` (проверяет app + postgres + map db + bootstrap).

## Production запуск

Собрать frontend и backend:

```bash
npm run build
```

Запустить сервер:

```bash
npm start
```

Открыть: `http://localhost:4000`

Проверка типов/качества:

```bash
npm run typecheck
npm run lint
npm test
```

## Deploy на Vercel

Проект подготовлен для Vercel:
- frontend деплоится как static build (`frontend/dist`)
- backend работает как serverless function (`api/index.ts`)

### Шаги

1. Подключите репозиторий в Vercel.
2. В настройках проекта задайте переменные окружения:
   - `JWT_SECRET`
   - `VERIFICATION_CODE_SECRET`
   - `PAYMENT_WEBHOOK_SECRET`
   - `GEOCODER_PROVIDER`
   - `DGIS_GEOCODER_API_KEY` (если используете `2gis`)
   - `YANDEX_GEOCODER_API_KEY` (если используете `yandex`)
3. Deploy.

### Важно про БД

Используется PostgreSQL через `DATABASE_URL`.
Для Vercel backend в serverless-режиме лучше подключать внешний Postgres (Supabase, Neon, Render Postgres и т.д.).

### Frontend на Vercel + API отдельно

Для подключения фронтенда Vercel к внешнему API укажи env в Vercel:

`VITE_API_BASE_URL=https://your-api-domain-or-tunnel`

Для карты Yandex во frontend также укажи:

`VITE_YANDEX_MAPS_API_KEY=<ваш_ключ>`

Для собственного сервера карты (map-platform):

`VITE_MAP_PLATFORM_URL=http://localhost:8090`

## Тестовые аккаунты

Пароль: `Password123!`

- Админ: `admin@universal.local`
- Курьер: `courier@universal.local`
- Покупатель: `customer@universal.local`

## Основные API

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/users/me`
- `PUT /api/users/me`
- `GET /api/products`
- `GET /api/cart`
- `POST /api/cart/items`
- `PUT /api/cart/items/:itemId`
- `DELETE /api/cart/items/:itemId`
- `POST /api/orders`
- `POST /api/orders/:orderId/pay` (создать платеж / payment intent)
- `GET /api/orders/my`
- `GET /api/orders/:orderId`
- `PATCH /api/orders/:orderId/status`
- `POST /api/payments/webhook` (подтверждение оплаты от провайдера, подпись `x-webhook-signature`)
- `GET /api/orders/assigned` (courier)
- `GET /api/orders/all` (admin)
- `POST /api/couriers/connect`
- `POST /api/couriers/revert-to-customer` (для курьера: вернуть роль покупателя, если курьер не верифицирован и точка продавца не одобрена)
- `GET /api/couriers`
- `GET /api/geocode/search?q=...`
- `GET /api/geocode/reverse?lat=...&lng=...`
- `POST /api/delivery/quote` (проверка зоны, подбор склада, ETA и стоимость)

## Оплата (новое)

- Для онлайн-оплаты используйте способ оплаты `wallet` при оформлении заказа.
- После статуса заказа `received` клиент вызывает `POST /api/orders/:orderId/pay`.
- В dev-режиме API вернет `webhookTest` payload/signature для локального mock-подтверждения.
- Подтверждение оплаты выполняется вызовом `POST /api/payments/webhook`.
- Статус `paid` больше не выставляется вручную через `/api/orders/:orderId/status`.

## Точки продавцов (новое)

Обычный пользователь (`customer`) может создать свою точку магазина с отдельным каталогом товаров (изолированные таблицы `merchant_stores` + `merchant_products`), телефоном, логотипом и геолокацией.

Важно:
- Точка и карточки товаров активны только после одобрения главным администратором (`admin@universal.local`).
- Подключение курьеров к точке тоже требует одобрения главного администратора.
- Перед созданием/обновлением точки пользователь должен подтвердить email и телефон.
- Для модерации точки обязательны KYC-поля: ИНН и документ.

Основные endpoint’ы:
- `POST /api/stores/uploads/logo` (загрузка логотипа точки)
- `GET /api/stores/my`
- `POST /api/stores/my`
- `PATCH /api/stores/my`
- `POST /api/users/me/verification/request` (`channel=email|phone`)
- `POST /api/users/me/verification/confirm` (`channel`, `code`)
- `GET /api/stores/my/products`
- `POST /api/stores/my/products`
- `PUT /api/stores/my/products/:productId`
- `DELETE /api/stores/my/products/:productId`
- `GET /api/stores/couriers` (список доступных курьеров)
- `GET /api/stores/my/courier-links`
- `POST /api/stores/my/courier-links` (заявка на подключение курьера)
- `POST /api/stores/uploads/kyc-document` (документ для KYC)

## Дополнительные возможности (новое)

- Live-трекинг заказа:
  - `GET /api/orders/:orderId/tracking` (live ETA, дистанция, позиция курьера)
  - `GET /api/orders/:orderId/items-status` (статусы позиций сборки: picked/substituted/missing)
- Курьерский маршрут:
  - `GET /api/couriers/me/route` (активный маршрут и waypoints)
  - `POST /api/couriers/me/heartbeat` теперь поддерживает `lat/lng` для live-трекинга
- Замены товаров:
  - при создании заказа `POST /api/orders` можно передать:
    - `substitutionPreference`: `allow_similar | no_substitution | contact_me`
    - `substitutionNote`: комментарий покупателя
- Штрихкод:
  - `GET /api/products/by-barcode?code=...`
  - у товара поддерживается поле `barcode`
- Центр уведомлений:
  - `GET /api/notifications`
  - `POST /api/notifications/:notificationId/read`
  - `POST /api/notifications/read-all`
- Склад и закупка:
  - `POST /api/admin/warehouse/purchase-drafts/from-low-stock`
  - `GET /api/admin/warehouse/purchase-drafts`

## Чеклист Перед Релизом

1. Прогнать сборки:
   - `npm run build:api`
   - `npm run build:web`
2. Проверить health:
   - `GET /api/health`
   - `GET /api/health/ready`
3. Проверить роли и критичный flow:
   - customer: регистрация → корзина → заказ → трекинг
   - picker: задачи сборки, статусы позиций
   - courier: heartbeat с гео, маршрут, статусы доставки
   - admin: модерация, склад, черновики закупки
4. Проверить БД-бэкап и восстановление.
5. Проверить CORS и HTTPS на frontend/backend.
6. Проверить, что `JWT_SECRET`, `DATABASE_URL`, ключи геокодера и оплаты выставлены корректно.

Одобрение главным админом:
- `GET /api/admin/stores?status=pending`
- `PATCH /api/admin/stores/:storeId/review` (`approved|rejected`)
- `GET /api/admin/stores/:storeId/courier-links`
- `PATCH /api/admin/stores/:storeId/courier-links/:linkId/review` (`approved|rejected`)
- `GET /api/admin/stores/:storeId/tenant-routing`
- `PATCH /api/admin/stores/:storeId/tenant-routing` (`mode=shared|dedicated`, `dsnKey`, `dedicatedDatabaseUrl`)
- `POST /api/admin/stores/:storeId/migrate-products` (`stage=all|copy|verify|cutover`, `dryRun`, `dsnKey`)
- UI: админ-панель (`admin@universal.local`) -> вкладка `Точки продавцов` для модерации точек и заявок на курьеров.
  - В каждой точке есть кнопки `Dry run` и `Мигрировать товары`.

### Tenant routing (shared -> dedicated)

- Добавлена таблица `tenant_db_routing` и `TenantDbResolver`.
- По умолчанию все точки работают в `shared` режиме (общая Postgres).
- В dedicated режиме маршрутизируется каталог точки (`merchant_products`).
- Метаданные точки и связи с курьерами остаются в shared БД.
- Для выделенной БД переключайте точку в `mode=dedicated` и задавайте `dsnKey`.
- DSN можно передать:
  - в БД полем `dedicatedDatabaseUrl`, или
  - через env `TENANT_DB_URL_<DSN_KEY>` (например `TENANT_DB_URL_STORE_42=postgresql://...`).

Мигратор `shared -> dedicated` для каталога точки (`merchant_products`):

```bash
# Полный прогон: copy + verify + cutover
npm run migrate:merchant-products -- --store-id 42 --dsn-key STORE_42

# Только копирование
npm run migrate:merchant-products -- --store-id 42 --dsn-key STORE_42 --stage copy

# Только проверка
npm run migrate:merchant-products -- --store-id 42 --dsn-key STORE_42 --stage verify

# Только cutover
npm run migrate:merchant-products -- --store-id 42 --dsn-key STORE_42 --stage cutover

# Проверка плана без изменений
npm run migrate:merchant-products -- --store-id 42 --dsn-key STORE_42 --dry-run
```

## Логика доставки (новое)

- Проверка, входит ли точка доставки в `delivery_zones` (map-platform / PostGIS).
- Тариф по зоне из `delivery_zone_tariffs` (base/per-km/min/max + ETA параметры).
- Выбор склада с учетом:
  - активного статуса склада,
  - координат склада,
  - достаточного остатка по всем товарам заказа.
- В заказ сохраняются:
  - зона доставки,
  - выбранный склад,
  - расстояние по прямой,
  - оценка маршрута,
  - ETA,
  - стоимость доставки.

Обновление точки склада через админку:
- Админ-панель -> вкладка `Склад` -> блок `Точка склада на карте`.
- После сохранения координаты обновляются сразу в:
  - основной БД проекта (`warehouses.lat/lng`)
  - map-platform PostGIS (`public.warehouses.geom`)

## Этап 2: документный складской учёт

Добавлены черновики и проведение складских документов, поставщики, дробные количества, средневзвешенная складская стоимость, снимки инвентаризации, связанные обратные операции и контролируемое снятие ручных резервов. Legacy-стоимость после миграции помечается неизвестной, а не нулевой. Прямые API приёмки и списания отключены, чтобы нельзя было обойти документы.

Модель, ограничения и безопасный порядок миграции описаны в [docs/stage2-warehouse-accounting.md](docs/stage2-warehouse-accounting.md).
