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

Настройка точного геокодирования РФ (опционально, рекомендуется):

- в `.env` оставьте `GEOCODER_PROVIDER=yandex`
- добавьте `YANDEX_GEOCODER_API_KEY=<ваш_ключ>`

Если ключа нет, поставьте `GEOCODER_PROVIDER=osm`.

## Dev запуск

Терминал 1 (API):

```bash
npm run dev:api
```

Терминал 2 (Frontend TSX):

```bash
npm run dev:web
```

Открыть: `http://localhost:5173`

## Локальный PostgreSQL (подготовка)

В проект добавлен локальный Postgres через Docker Compose:

```bash
npm run db:up
```

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
- для локальной разработки используйте `docker-compose.postgres.yml`.

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

## Deploy на Vercel

Проект подготовлен для Vercel:
- frontend деплоится как static build (`frontend/dist`)
- backend работает как serverless function (`api/index.ts`)

### Шаги

1. Подключите репозиторий в Vercel.
2. В настройках проекта задайте переменные окружения:
   - `JWT_SECRET`
   - `GEOCODER_PROVIDER`
   - `YANDEX_GEOCODER_API_KEY` (если используете `yandex`)
3. Deploy.

### Важно про БД

Используется PostgreSQL через `DATABASE_URL`.
Для Vercel backend в serverless-режиме лучше подключать внешний Postgres (Supabase, Neon, Render Postgres и т.д.).

### Frontend на Vercel + API отдельно

Для подключения фронтенда Vercel к внешнему API укажи env в Vercel:

`VITE_API_BASE_URL=https://your-api-domain-or-tunnel`

## Тестовые аккаунты

Пароль: `Password123!`

- Админ: `admin@universal.local`
- Курьер: `courier@universal.local`

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
- `GET /api/orders/my`
- `GET /api/orders/:orderId`
- `PATCH /api/orders/:orderId/status`
- `GET /api/orders/assigned` (courier)
- `GET /api/orders/all` (admin)
- `POST /api/couriers/connect`
- `GET /api/couriers`
- `GET /api/geocode/search?q=...`
- `GET /api/geocode/reverse?lat=...&lng=...`
