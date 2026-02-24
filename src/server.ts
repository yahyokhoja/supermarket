import 'dotenv/config';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import morgan from 'morgan';
import type { Pool, PoolClient } from 'pg';
import { authRequired, buildToken, roleRequired } from './auth';
import { connectDb, initDb, seedProducts, seedUsers } from './db';
import type { ApiOrder, DbOrder, DbUser, PublicUser, UserRole } from './types';

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_super_secret';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://supermarket:supermarket_dev_password@localhost:5432/supermarket';
const GEOCODER_PROVIDER = (process.env.GEOCODER_PROVIDER || 'yandex').toLowerCase();
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY || '';

const app = express();
const db: Pool = connectDb(DATABASE_URL);
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req: any, _file: any, cb: any) => cb(null, uploadsDir),
    filename: (_req: any, file: any, cb: any) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    }
  }),
  fileFilter: (_req: any, file: any, cb: any) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Разрешены только изображения'));
  },
  limits: { fileSize: 6 * 1024 * 1024 }
});

const dbReady = (async () => {
  await initDb(db);
  await seedProducts(db);
  await seedUsers(db);
})();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadsDir));
app.use(async (_req, res, next) => {
  try {
    await dbReady;
    next();
  } catch (error) {
    console.error('DB bootstrap error:', error);
    res.status(500).json({ message: 'Ошибка инициализации БД' });
  }
});

function toNumber(value: unknown) {
  return Number(value);
}

function toDateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function publicUser(user: DbUser): PublicUser {
  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    address: user.address,
    role: user.role,
    createdAt: user.created_at
  };
}

function normalizeUserRow(row: any): DbUser {
  return {
    id: toNumber(row.id),
    full_name: String(row.full_name),
    email: String(row.email),
    phone: row.phone ?? null,
    address: row.address ?? null,
    password_hash: String(row.password_hash),
    role: row.role as UserRole,
    created_at: toDateString(row.created_at)
  };
}

function normalizeOrderRow(row: any): DbOrder {
  return {
    id: toNumber(row.id),
    user_id: toNumber(row.user_id),
    status: String(row.status),
    total: Number(row.total),
    delivery_address: String(row.delivery_address),
    delivery_lat: row.delivery_lat === null ? null : Number(row.delivery_lat),
    delivery_lng: row.delivery_lng === null ? null : Number(row.delivery_lng),
    assigned_courier_id: row.assigned_courier_id === null ? null : Number(row.assigned_courier_id),
    created_at: toDateString(row.created_at),
    updated_at: toDateString(row.updated_at)
  };
}

async function getUserByEmail(email: string) {
  const result = await db.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
  if (!result.rows[0]) return undefined;
  return normalizeUserRow(result.rows[0]);
}

async function getUserById(id: number) {
  const result = await db.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  if (!result.rows[0]) return undefined;
  return normalizeUserRow(result.rows[0]);
}

async function getOrCreateCourierForUser(userId: number) {
  let row = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [userId])).rows[0];
  if (!row) {
    await db.query(
      `
        INSERT INTO couriers (user_id, vehicle_type, status, max_active_orders)
        VALUES ($1, 'bike', 'offline', 5)
        ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );
    row = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [userId])).rows[0];
  }
  return {
    id: toNumber(row.id),
    vehicle_type: row.vehicle_type,
    status: row.status,
    max_active_orders: toNumber(row.max_active_orders)
  };
}

async function getActiveOrderCountForCourier(courierId: number) {
  const row = (await db.query(
    `
      SELECT COUNT(*)::text as cnt
      FROM orders
      WHERE assigned_courier_id = $1
        AND status IN ('assigned', 'picked_up', 'on_the_way')
    `,
    [courierId]
  )).rows[0];
  return Number(row.cnt || '0');
}

async function assignCourierIfPossible(orderId: number) {
  const couriersRows = (await db.query(
    `
      SELECT id, max_active_orders
      FROM couriers
      WHERE status = 'available'
    `
  )).rows;

  let selected: { id: number; active: number } | null = null;
  for (const row of couriersRows) {
    const courierId = toNumber(row.id);
    const active = await getActiveOrderCountForCourier(courierId);
    if (active >= toNumber(row.max_active_orders)) continue;
    if (!selected || active < selected.active) {
      selected = { id: courierId, active };
    }
  }

  if (!selected) return null;

  await db.query('UPDATE orders SET assigned_courier_id = $1, status = $2 WHERE id = $3', [selected.id, 'assigned', orderId]);
  const orderRow = (await db.query('SELECT user_id FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  const createdBy = orderRow ? toNumber(orderRow.user_id) : null;
  await db.query(
    'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
    [orderId, 'assigned', 'Курьер назначен автоматически', createdBy]
  );

  return selected.id;
}

async function tryAssignOldestPendingOrder() {
  const pendingRow = (await db.query(
    `
      SELECT id
      FROM orders
      WHERE assigned_courier_id IS NULL
        AND status = 'pending'
      ORDER BY id ASC
      LIMIT 1
    `
  )).rows[0];

  if (!pendingRow) return null;
  return assignCourierIfPossible(toNumber(pendingRow.id));
}

function orderView(order: DbOrder): ApiOrder {
  return {
    id: order.id,
    userId: order.user_id,
    status: order.status,
    total: order.total,
    deliveryAddress: order.delivery_address,
    deliveryLat: order.delivery_lat,
    deliveryLng: order.delivery_lng,
    assignedCourierId: order.assigned_courier_id,
    createdAt: order.created_at,
    updatedAt: order.updated_at
  };
}

function normalizeProductRow(row: any) {
  return {
    id: toNumber(row.id),
    name: row.name,
    description: row.description,
    price: Number(row.price),
    category: row.category,
    imageUrl: row.image_url,
    inStock: Boolean(row.in_stock)
  };
}

function hasStreetName(address: string) {
  const normalized = address.trim().toLowerCase();
  if (normalized.length < 3) return false;
  const streetPattern = /\b(ул\\.?|улица|проспект|пр-т|переулок|пер\\.?|бульвар|б-р|шоссе|наб\\.?|набережная|road|rd\\.?|street|st\\.?|avenue|ave\\.?)\b/u;
  if (streetPattern.test(normalized)) return true;

  const alphaOnly = normalized.replace(/[^a-zа-яё\s-]/giu, ' ').replace(/\s+/g, ' ').trim();
  if (!alphaOnly) return false;
  const tokens = alphaOnly.split(' ').filter(Boolean);
  return tokens.some((token) => token.length >= 3);
}

function parseDeliveryAddress(address: string) {
  const match = address.trim().match(/^(.+?),\s*(.+?),\s*дом\s+([0-9A-Za-zА-Яа-я\-\/]{1,12})$/u);
  if (!match) return null;
  const [, locality, street, house] = match;
  return {
    locality: locality.trim(),
    street: street.trim(),
    house: house.trim()
  };
}

type GeocodeResult = {
  displayName: string;
  lat: number;
  lng: number;
  locality?: string | null;
  street?: string | null;
  houseNumber?: string | null;
};

async function geocodeSearchOsm(query: string) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: '6', addressdetails: '1' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (!res.ok) return [] as GeocodeResult[];
  const data = (await res.json()) as Array<any>;
  return data
    .map((item) => ({
      displayName: String(item.display_name || ''),
      lat: Number(item.lat),
      lng: Number(item.lon),
      locality: item.address?.city || item.address?.town || item.address?.village || item.address?.hamlet || null,
      street: item.address?.road || item.address?.pedestrian || item.address?.residential || null,
      houseNumber: item.address?.house_number || null
    }))
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
}

async function geocodeReverseOsm(lat: number, lng: number) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    addressdetails: '1',
    zoom: '18'
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`);
  if (!res.ok) return null;
  const item = (await res.json()) as any;
  if (!item) return null;
  const address = item.address || {};
  return {
    displayName: String(item.display_name || ''),
    lat: Number(item.lat ?? lat),
    lng: Number(item.lon ?? lng),
    locality: address.city || address.town || address.village || address.hamlet || null,
    street: address.road || address.pedestrian || address.residential || null,
    houseNumber: address.house_number || null
  } as GeocodeResult;
}

function parseYandexFeature(feature: any) {
  const pos = String(feature?.GeoObject?.Point?.pos || '').trim();
  const [lonStr, latStr] = pos.split(/\s+/);
  const lng = Number(lonStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const meta = feature?.GeoObject?.metaDataProperty?.GeocoderMetaData || {};
  const components = Array.isArray(meta.Address?.Components) ? meta.Address.Components : [];
  const street = components.find((c: any) => c.kind === 'street')?.name || null;
  const locality = components.find((c: any) => c.kind === 'locality')?.name || null;
  const houseNumber = components.find((c: any) => c.kind === 'house')?.name || null;
  const displayName = String(meta.text || feature?.GeoObject?.name || '');

  return { displayName, lat, lng, locality, street, houseNumber } as GeocodeResult;
}

async function geocodeSearchYandex(query: string) {
  if (!YANDEX_GEOCODER_API_KEY) return [] as GeocodeResult[];
  const params = new URLSearchParams({
    apikey: YANDEX_GEOCODER_API_KEY,
    format: 'json',
    geocode: query,
    lang: 'ru_RU',
    results: '6'
  });
  const res = await fetch(`https://geocode-maps.yandex.ru/1.x/?${params.toString()}`);
  if (!res.ok) return [] as GeocodeResult[];
  const json = (await res.json()) as any;
  const members = json?.response?.GeoObjectCollection?.featureMember || [];
  return members.map(parseYandexFeature).filter(Boolean) as GeocodeResult[];
}

async function geocodeReverseYandex(lat: number, lng: number) {
  if (!YANDEX_GEOCODER_API_KEY) return null;
  const params = new URLSearchParams({
    apikey: YANDEX_GEOCODER_API_KEY,
    format: 'json',
    geocode: `${lng},${lat}`,
    lang: 'ru_RU',
    results: '1'
  });
  const res = await fetch(`https://geocode-maps.yandex.ru/1.x/?${params.toString()}`);
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const feature = json?.response?.GeoObjectCollection?.featureMember?.[0];
  return parseYandexFeature(feature);
}

async function geocodeSearch(query: string) {
  if (GEOCODER_PROVIDER === 'yandex') {
    const yandex = await geocodeSearchYandex(query);
    if (yandex.length) return yandex;
  }
  return geocodeSearchOsm(query);
}

async function geocodeReverse(lat: number, lng: number) {
  if (GEOCODER_PROVIDER === 'yandex') {
    const yandex = await geocodeReverseYandex(lat, lng);
    if (yandex) return yandex;
  }
  return geocodeReverseOsm(lat, lng);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'universal-supermarket-delivery', now: new Date().toISOString() });
});

app.get('/api/health/db', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    return res.json({ ok: true, db: 'up', now: new Date().toISOString() });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      db: 'down',
      message: 'База данных недоступна',
      error: error instanceof Error ? error.message : 'unknown'
    });
  }
});

app.get('/api/geocode/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ message: 'Параметр q обязателен' });
  try {
    const results = await geocodeSearch(q);
    return res.json({ provider: GEOCODER_PROVIDER, results });
  } catch {
    return res.status(502).json({ message: 'Сервис геокодирования недоступен' });
  }
});

app.get('/api/geocode/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ message: 'lat и lng обязательны' });
  }
  try {
    const result = await geocodeReverse(lat, lng);
    return res.json({ provider: GEOCODER_PROVIDER, result });
  } catch {
    return res.status(502).json({ message: 'Сервис геокодирования недоступен' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  const { fullName, email, password, phone, address } = req.body as Record<string, string>;
  if (!fullName || !email || !password) return res.status(400).json({ message: 'fullName, email и password обязательны' });

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalizedEmail);
  if (existing) return res.status(409).json({ message: 'Пользователь с таким email уже существует' });

  const hash = bcrypt.hashSync(password, 10);
  const insert = await db.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, 'customer')
      RETURNING *
    `,
    [fullName.trim(), normalizedEmail, phone || null, address || null, hash]
  );

  const user = normalizeUserRow(insert.rows[0]);
  return res.status(201).json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body as Record<string, string>;
  if (!email || !password) return res.status(400).json({ message: 'email и password обязательны' });

  const user = await getUserByEmail(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ message: 'Неверные учетные данные' });
  }

  return res.json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.get('/api/users/me', authRequired(JWT_SECRET), async (req, res) => {
  const user = await getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  return res.json({ user: publicUser(user) });
});

app.put('/api/users/me', authRequired(JWT_SECRET), async (req, res) => {
  const { fullName, phone, address } = req.body as { fullName?: string; phone?: string | null; address?: string | null };
  const user = await getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const updated = await db.query(
    `
      UPDATE users
      SET full_name = $1, phone = $2, address = $3
      WHERE id = $4
      RETURNING *
    `,
    [fullName?.trim() || user.full_name, phone === undefined ? user.phone : phone, address === undefined ? user.address : address, user.id]
  );

  return res.json({ user: publicUser(normalizeUserRow(updated.rows[0])) });
});

app.get('/api/products', async (_req, res) => {
  const rows = (await db.query('SELECT * FROM products WHERE in_stock = TRUE ORDER BY id DESC')).rows;
  res.json({ products: rows.map((row: any) => normalizeProductRow(row)) });
});

app.get('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  const rows = (await db.query('SELECT * FROM products ORDER BY id DESC')).rows;
  res.json({ products: rows.map((row: any) => normalizeProductRow(row)) });
});

app.post('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  const body = req.body as {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
    imageUrl?: string;
    inStock?: boolean;
  };

  const name = String(body.name || '').trim();
  const price = Number(body.price);
  if (!name || Number.isNaN(price) || price <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  const created = await db.query(
    `
      INSERT INTO products (name, description, price, category, image_url, in_stock)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [name, body.description?.trim() || null, price, body.category?.trim() || null, body.imageUrl?.trim() || null, body.inStock !== false]
  );

  return res.status(201).json({ product: normalizeProductRow(created.rows[0]) });
});

app.put('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const existingRow = (await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [productId])).rows[0];
  if (!existingRow) return res.status(404).json({ message: 'Товар не найден' });

  const body = req.body as {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
    imageUrl?: string;
    inStock?: boolean;
  };

  const nextName = body.name !== undefined ? String(body.name).trim() : existingRow.name;
  const nextPrice = body.price !== undefined ? Number(body.price) : Number(existingRow.price);
  if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  const updated = await db.query(
    `
      UPDATE products
      SET name = $1, description = $2, price = $3, category = $4, image_url = $5, in_stock = $6
      WHERE id = $7
      RETURNING *
    `,
    [
      nextName,
      body.description !== undefined ? body.description?.trim() || null : existingRow.description,
      nextPrice,
      body.category !== undefined ? body.category?.trim() || null : existingRow.category,
      body.imageUrl !== undefined ? body.imageUrl?.trim() || null : existingRow.image_url,
      body.inStock !== undefined ? body.inStock : existingRow.in_stock,
      productId
    ]
  );

  return res.json({ product: normalizeProductRow(updated.rows[0]) });
});

app.delete('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const deleted = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [productId]);
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Товар не найден' });

  return res.json({ message: 'Товар удален' });
});

app.post(
  '/api/admin/uploads/image',
  authRequired(JWT_SECRET),
  roleRequired('admin'),
  upload.single('image'),
  async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'Файл изображения обязателен' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${baseUrl}/uploads/${file.filename}`;
    return res.status(201).json({ imageUrl });
  }
);

app.get('/api/cart', authRequired(JWT_SECRET), async (req, res) => {
  const rows = (await db.query(
    `
      SELECT ci.id, ci.product_id, ci.quantity, p.name, p.price, p.image_url
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = $1
      ORDER BY ci.id DESC
    `,
    [req.user!.id]
  )).rows;

  const items = rows.map((row: any) => ({
    id: toNumber(row.id),
    productId: toNumber(row.product_id),
    quantity: toNumber(row.quantity),
    name: row.name,
    price: Number(row.price),
    imageUrl: row.image_url,
    lineTotal: Number((Number(row.quantity) * Number(row.price)).toFixed(2))
  }));
  const total = Number(items.reduce((sum: number, item: any) => sum + item.lineTotal, 0).toFixed(2));

  res.json({ items, total });
});

app.post('/api/cart/items', authRequired(JWT_SECRET), async (req, res) => {
  const { productId, quantity } = req.body as { productId: number; quantity?: number };
  const qty = Number(quantity || 1);
  if (!productId || Number.isNaN(qty) || qty <= 0) return res.status(400).json({ message: 'Неверные данные позиции корзины' });

  const product = (await db.query('SELECT id FROM products WHERE id = $1 AND in_stock = TRUE LIMIT 1', [productId])).rows[0];
  if (!product) return res.status(404).json({ message: 'Товар не найден' });

  await db.query(
    `
      INSERT INTO cart_items (user_id, product_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
    `,
    [req.user!.id, productId, qty]
  );

  return res.status(201).json({ message: 'Товар добавлен в корзину' });
});

app.put('/api/cart/items/:itemId', authRequired(JWT_SECRET), async (req, res) => {
  const itemId = Number(req.params.itemId);
  const quantity = Number((req.body as { quantity?: number }).quantity);
  if (!itemId || Number.isNaN(quantity) || quantity <= 0) return res.status(400).json({ message: 'itemId и quantity должны быть валидными' });

  const updated = await db.query(
    'UPDATE cart_items SET quantity = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
    [quantity, itemId, req.user!.id]
  );
  if (!updated.rows[0]) return res.status(404).json({ message: 'Позиция корзины не найдена' });

  return res.json({ message: 'Количество обновлено' });
});

app.delete('/api/cart/items/:itemId', authRequired(JWT_SECRET), async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: 'Некорректный itemId' });

  await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [itemId, req.user!.id]);
  return res.json({ message: 'Позиция удалена' });
});

app.post('/api/orders', authRequired(JWT_SECRET), async (req, res) => {
  const body = req.body as { deliveryAddress?: string; deliveryLat?: number; deliveryLng?: number };
  const user = await getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const cartRows = (await db.query(
    `
      SELECT ci.product_id, ci.quantity, p.name, p.price
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = $1
    `,
    [user.id]
  )).rows;

  if (!cartRows.length) return res.status(400).json({ message: 'Корзина пуста' });

  const address = (body.deliveryAddress || user.address || '').trim();
  if (!address) return res.status(400).json({ message: 'Нужен адрес доставки' });
  const parsedAddress = parseDeliveryAddress(address);
  if (!parsedAddress) {
    return res.status(400).json({ message: 'Адрес должен быть в формате: населенный пункт, улица, дом 44' });
  }
  if (parsedAddress.locality.length < 2) {
    return res.status(400).json({ message: 'Укажите город или населенный пункт' });
  }
  if (!hasStreetName(parsedAddress.street)) {
    return res.status(400).json({ message: 'Укажите корректное название улицы в адресе доставки' });
  }

  const hasLat = body.deliveryLat !== undefined && body.deliveryLat !== null;
  const hasLng = body.deliveryLng !== undefined && body.deliveryLng !== null;
  if (hasLat !== hasLng) return res.status(400).json({ message: 'Координаты доставки должны быть переданы парой' });

  const deliveryLat = hasLat ? Number(body.deliveryLat) : null;
  const deliveryLng = hasLng ? Number(body.deliveryLng) : null;
  if (
    (deliveryLat !== null && (Number.isNaN(deliveryLat) || deliveryLat < -90 || deliveryLat > 90)) ||
    (deliveryLng !== null && (Number.isNaN(deliveryLng) || deliveryLng < -180 || deliveryLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты доставки' });
  }

  const total = Number(
    cartRows.reduce((sum: number, row: any) => sum + Number(row.quantity) * Number(row.price), 0).toFixed(2)
  );

  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');

    const orderInsert = await client.query(
      `
        INSERT INTO orders (user_id, status, total, delivery_address, delivery_lat, delivery_lng)
        VALUES ($1, 'pending', $2, $3, $4, $5)
        RETURNING *
      `,
      [user.id, total, address, deliveryLat, deliveryLng]
    );
    const orderId = toNumber(orderInsert.rows[0].id);

    for (const item of cartRows) {
      await client.query(
        `
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [orderId, toNumber(item.product_id), String(item.name), toNumber(item.quantity), Number(item.price)]
      );
    }

    await client.query('DELETE FROM cart_items WHERE user_id = $1', [user.id]);
    await client.query(
      'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
      [orderId, 'pending', 'Заказ создан', user.id]
    );

    await client.query('COMMIT');

    await assignCourierIfPossible(orderId);

    const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
    return res.status(201).json({ order: orderView(normalizeOrderRow(orderRow)) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    return res.status(500).json({ message: 'Не удалось создать заказ' });
  } finally {
    client.release();
  }
});

async function fetchOrderItems(orderId: number) {
  const rows = (await db.query(
    `
      SELECT product_id, product_name, quantity, unit_price
      FROM order_items
      WHERE order_id = $1
    `,
    [orderId]
  )).rows;

  return rows.map((row: any) => ({
    productId: toNumber(row.product_id),
    name: String(row.product_name),
    quantity: toNumber(row.quantity),
    unitPrice: Number(row.unit_price)
  }));
}

async function fetchOrderEvents(orderId: number) {
  const rows = (await db.query(
    `
      SELECT oe.status, oe.comment, oe.created_at, u.full_name
      FROM order_events oe
      LEFT JOIN users u ON u.id = oe.created_by
      WHERE oe.order_id = $1
      ORDER BY oe.id ASC
    `,
    [orderId]
  )).rows;

  return rows.map((row: any) => ({
    status: String(row.status),
    comment: row.comment,
    createdAt: toDateString(row.created_at),
    createdBy: row.full_name || null
  }));
}

app.get('/api/orders/my', authRequired(JWT_SECRET), async (req, res) => {
  const rows = (await db.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [req.user!.id])).rows;
  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.get('/api/orders/assigned', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courier) return res.json({ orders: [] });

  const rows = (await db.query(
    `
      SELECT *
      FROM orders
      WHERE assigned_courier_id = $1
        AND status IN ('assigned', 'picked_up', 'on_the_way')
      ORDER BY id DESC
    `,
    [toNumber(courier.id)]
  )).rows;

  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.get('/api/orders/open', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courier) return res.json({ orders: [] });

  const rows = (await db.query(
    `
      SELECT *
      FROM orders
      WHERE status = 'pending'
        AND assigned_courier_id IS NULL
      ORDER BY id ASC
      LIMIT 100
    `
  )).rows;

  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.post('/api/orders/:orderId/claim', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const courierRow = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courierRow) return res.status(404).json({ message: 'Профиль курьера не найден' });
  const courierId = toNumber(courierRow.id);
  const maxActive = toNumber(courierRow.max_active_orders);
  const activeCount = await getActiveOrderCountForCourier(courierId);
  if (activeCount >= maxActive) {
    return res.status(409).json({ message: 'Достигнут лимит активных заказов курьера' });
  }

  const claimed = (await db.query(
    `
      UPDATE orders
      SET assigned_courier_id = $1, status = 'assigned'
      WHERE id = $2
        AND status = 'pending'
        AND assigned_courier_id IS NULL
      RETURNING *
    `,
    [courierId, orderId]
  )).rows[0];

  if (!claimed) {
    return res.status(409).json({ message: 'Заказ уже назначен курьеру или недоступен' });
  }

  await db.query(
    'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
    [orderId, 'assigned', 'Курьер принял заказ вручную', req.user!.id]
  );

  return res.json({ order: orderView(normalizeOrderRow(claimed)) });
});

app.get('/api/orders/all', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  const rows = (await db.query('SELECT * FROM orders ORDER BY id DESC LIMIT 200')).rows;
  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.get('/api/orders/:orderId', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });

  const order = normalizeOrderRow(orderRow);

  if (req.user!.role === 'customer' && order.user_id !== req.user!.id) {
    return res.status(403).json({ message: 'Нет доступа к заказу' });
  }

  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    if (!courier || order.assigned_courier_id !== toNumber(courier.id)) {
      return res.status(403).json({ message: 'Нет доступа к заказу' });
    }
  }

  return res.json({
    order: orderView(order),
    items: await fetchOrderItems(orderId),
    events: await fetchOrderEvents(orderId)
  });
});

app.patch('/api/orders/:orderId/status', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  const { status, comment } = req.body as { status?: string; comment?: string };
  const allowed = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];

  if (!orderId || !status || !allowed.includes(status)) {
    return res.status(400).json({ message: 'Некорректный статус или orderId' });
  }

  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });
  const order = normalizeOrderRow(orderRow);

  if (req.user!.role === 'customer') {
    if (order.user_id !== req.user!.id || status !== 'cancelled') {
      return res.status(403).json({ message: 'Клиент может отменить только свой заказ' });
    }
  }

  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    const courierAllowed = ['picked_up', 'on_the_way', 'delivered'];
    if (!courier || order.assigned_courier_id !== toNumber(courier.id) || !courierAllowed.includes(status)) {
      return res.status(403).json({ message: 'Заказ не назначен этому курьеру или статус запрещен' });
    }
  }

  await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, orderId]);
  await db.query(
    'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
    [orderId, status, comment || null, req.user!.id]
  );

  if (status === 'delivered' || status === 'cancelled') {
    await tryAssignOldestPendingOrder();
  }

  const updatedRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  return res.json({ order: orderView(normalizeOrderRow(updatedRow)) });
});

app.post('/api/couriers/connect', authRequired(JWT_SECRET), roleRequired('customer', 'courier', 'admin'), async (req, res) => {
  const body = req.body as { vehicleType?: string; status?: string; userId?: number };

  let targetUserId = req.user!.id;
  if (req.user!.role === 'admin' && body.userId) {
    targetUserId = Number(body.userId);
  }

  const targetUser = await getUserById(targetUserId);
  if (!targetUser) return res.status(404).json({ message: 'Пользователь не найден' });

  if (targetUser.role !== 'courier') {
    await db.query("UPDATE users SET role = 'courier' WHERE id = $1", [targetUser.id]);
  }

  const courier = await getOrCreateCourierForUser(targetUser.id);
  const nextStatus = ['offline', 'available', 'busy'].includes(body.status || '') ? body.status! : 'available';

  await db.query('UPDATE couriers SET vehicle_type = $1, status = $2 WHERE id = $3', [body.vehicleType || courier.vehicle_type || 'bike', nextStatus, courier.id]);
  if (nextStatus === 'available') {
    await tryAssignOldestPendingOrder();
  }
  const updatedUser = await getUserById(targetUser.id);
  const isSelfUpdate = req.user!.id === targetUser.id;

  return res.json({
    message: 'Курьер подключен',
    courierId: courier.id,
    status: nextStatus,
    ...(isSelfUpdate && updatedUser ? { token: buildToken(updatedUser, JWT_SECRET), user: publicUser(updatedUser) } : {})
  });
});

app.get('/api/couriers', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  const rows = (await db.query(
    `
      SELECT c.*, u.full_name, u.email, u.phone
      FROM couriers c
      JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC
    `
  )).rows;

  const couriers = await Promise.all(
    rows.map(async (row: any) => ({
      id: toNumber(row.id),
      userId: toNumber(row.user_id),
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      vehicleType: row.vehicle_type,
      status: row.status,
      activeOrders: await getActiveOrderCountForCourier(toNumber(row.id)),
      maxActiveOrders: toNumber(row.max_active_orders)
    }))
  );

  return res.json({ couriers });
});

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`API запущен на http://localhost:${PORT}`);
  });
}

export default app;
