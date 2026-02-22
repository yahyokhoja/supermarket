# Universal Supermarket Delivery (TypeScript + TSX)

Платформа доставки супермаркета:
- backend: Node.js + Express + TypeScript
- frontend: React + TSX + Vite
- БД: SQLite

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
