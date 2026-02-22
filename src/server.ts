import 'dotenv/config';
import path from 'node:path';
import { existsSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { authRequired, buildToken, roleRequired } from './auth';
import { connectDb, initDb, seedProducts, seedUsers } from './db';
import type { ApiOrder, DbOrder, DbUser, PublicUser, UserRole } from './types';

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_super_secret';
const DB_PATH = process.env.DB_PATH || './data.db';
const GEOCODER_PROVIDER = (process.env.GEOCODER_PROVIDER || 'yandex').toLowerCase();
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY || '';

const app = express();
const db = connectDb(DB_PATH);

initDb(db);
seedProducts(db);
seedUsers(db);

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

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

function getUserByEmail(email: string) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbUser | undefined;
}

function getUserById(id: number) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as DbUser | undefined;
}

function getOrCreateCourierForUser(userId: number) {
  let courier = db.prepare('SELECT * FROM couriers WHERE user_id = ?').get(userId) as { id: number; vehicle_type: string; status: string; max_active_orders: number } | undefined;
  if (!courier) {
    db.prepare('INSERT INTO couriers (user_id, vehicle_type, status, max_active_orders) VALUES (?, ?, ?, ?)').run(userId, 'bike', 'offline', 5);
    courier = db.prepare('SELECT * FROM couriers WHERE user_id = ?').get(userId) as { id: number; vehicle_type: string; status: string; max_active_orders: number };
  }
  return courier;
}

function getActiveOrderCountForCourier(courierId: number) {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM orders
    WHERE assigned_courier_id = ?
      AND status IN ('assigned', 'picked_up', 'on_the_way')
  `).get(courierId) as { cnt: number };
  return row.cnt;
}

function assignCourierIfPossible(orderId: number) {
  const couriers = db.prepare(`
    SELECT c.id, c.max_active_orders
    FROM couriers c
    WHERE c.status = 'available'
  `).all() as Array<{ id: number; max_active_orders: number }>;

  let selected: { id: number; active: number } | null = null;
  for (const courier of couriers) {
    const active = getActiveOrderCountForCourier(courier.id);
    if (active >= courier.max_active_orders) continue;
    if (!selected || active < selected.active) selected = { id: courier.id, active };
  }

  if (!selected) return null;

  db.prepare('UPDATE orders SET assigned_courier_id = ?, status = ? WHERE id = ?').run(selected.id, 'assigned', orderId);
  const order = db.prepare('SELECT user_id FROM orders WHERE id = ?').get(orderId) as { user_id: number };
  db.prepare('INSERT INTO order_events (order_id, status, comment, created_by) VALUES (?, ?, ?, ?)').run(orderId, 'assigned', 'Курьер назначен автоматически', order.user_id);

  return selected.id;
}

function tryAssignOldestPendingOrder() {
  const pending = db.prepare(`
    SELECT id
    FROM orders
    WHERE assigned_courier_id IS NULL AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (!pending) return null;
  return assignCourierIfPossible(pending.id);
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
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    category: row.category,
    imageUrl: row.image_url,
    inStock: Boolean(row.in_stock)
  };
}

function hasStreetName(address: string) {
  const normalized = address.trim().toLowerCase();
  if (normalized.length < 5) return false;
  const streetPattern = /\b(ул\\.?|улица|проспект|пр-т|переулок|пер\\.?|бульвар|б-р|шоссе|наб\\.?|набережная|road|rd\\.?|street|st\\.?|avenue|ave\\.?)\b/u;
  return streetPattern.test(normalized);
}

type GeocodeResult = {
  displayName: string;
  lat: number;
  lng: number;
  street?: string | null;
  houseNumber?: string | null;
};

async function geocodeSearchOsm(query: string) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: '6', addressdetails: '1' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (!res.ok) return [] as GeocodeResult[];
  const data = await res.json() as Array<any>;
  return data.map((item) => ({
    displayName: String(item.display_name || ''),
    lat: Number(item.lat),
    lng: Number(item.lon),
    street: item.address?.road || item.address?.pedestrian || item.address?.residential || null,
    houseNumber: item.address?.house_number || null
  })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
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
  const item = await res.json() as any;
  if (!item) return null;
  const address = item.address || {};
  return {
    displayName: String(item.display_name || ''),
    lat: Number(item.lat ?? lat),
    lng: Number(item.lon ?? lng),
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
  const houseNumber = components.find((c: any) => c.kind === 'house')?.name || null;
  const displayName = String(meta.text || feature?.GeoObject?.name || '');

  return { displayName, lat, lng, street, houseNumber } as GeocodeResult;
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
  const json = await res.json() as any;
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
  const json = await res.json() as any;
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

app.post('/api/auth/register', (req, res) => {
  const { fullName, email, password, phone, address } = req.body as Record<string, string>;
  if (!fullName || !email || !password) return res.status(400).json({ message: 'fullName, email и password обязательны' });

  const normalizedEmail = email.trim().toLowerCase();
  if (getUserByEmail(normalizedEmail)) return res.status(409).json({ message: 'Пользователь с таким email уже существует' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (full_name, email, phone, address, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(fullName.trim(), normalizedEmail, phone || null, address || null, hash, 'customer');

  const user = getUserById(Number(result.lastInsertRowid));
  if (!user) return res.status(500).json({ message: 'Не удалось создать пользователя' });

  return res.status(201).json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as Record<string, string>;
  if (!email || !password) return res.status(400).json({ message: 'email и password обязательны' });

  const user = getUserByEmail(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ message: 'Неверные учетные данные' });
  }

  return res.json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.get('/api/users/me', authRequired(JWT_SECRET), (req, res) => {
  const user = getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  return res.json({ user: publicUser(user) });
});

app.put('/api/users/me', authRequired(JWT_SECRET), (req, res) => {
  const { fullName, phone, address } = req.body as { fullName?: string; phone?: string | null; address?: string | null };
  const user = getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  db.prepare('UPDATE users SET full_name = ?, phone = ?, address = ? WHERE id = ?').run(
    fullName?.trim() || user.full_name,
    phone === undefined ? user.phone : phone,
    address === undefined ? user.address : address,
    user.id
  );

  const updated = getUserById(user.id)!;
  return res.json({ user: publicUser(updated) });
});

app.get('/api/products', (_req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE in_stock = 1 ORDER BY id DESC').all() as Array<{
    id: number; name: string; description: string | null; price: number; category: string | null; image_url: string | null;
  }>;
  res.json({
    products: products.map((p) => normalizeProductRow(p))
  });
});

app.get('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), (_req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.json({ products: products.map((p: any) => normalizeProductRow(p)) });
});

app.post('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), (req, res) => {
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

  const result = db.prepare(`
    INSERT INTO products (name, description, price, category, image_url, in_stock)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    body.description?.trim() || null,
    price,
    body.category?.trim() || null,
    body.imageUrl?.trim() || null,
    body.inStock === false ? 0 : 1
  );

  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid));
  return res.status(201).json({ product: normalizeProductRow(created) });
});

app.put('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;
  if (!existing) return res.status(404).json({ message: 'Товар не найден' });

  const body = req.body as {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
    imageUrl?: string;
    inStock?: boolean;
  };

  const nextName = body.name !== undefined ? String(body.name).trim() : existing.name;
  const nextPrice = body.price !== undefined ? Number(body.price) : existing.price;
  if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  db.prepare(`
    UPDATE products
    SET name = ?, description = ?, price = ?, category = ?, image_url = ?, in_stock = ?
    WHERE id = ?
  `).run(
    nextName,
    body.description !== undefined ? body.description?.trim() || null : existing.description,
    nextPrice,
    body.category !== undefined ? body.category?.trim() || null : existing.category,
    body.imageUrl !== undefined ? body.imageUrl?.trim() || null : existing.image_url,
    body.inStock !== undefined ? (body.inStock ? 1 : 0) : existing.in_stock,
    productId
  );

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  return res.json({ product: normalizeProductRow(updated) });
});

app.delete('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!existing) return res.status(404).json({ message: 'Товар не найден' });

  db.prepare('DELETE FROM products WHERE id = ?').run(productId);
  return res.json({ message: 'Товар удален' });
});

app.get('/api/cart', authRequired(JWT_SECRET), (req, res) => {
  const rows = db.prepare(`
    SELECT ci.id, ci.product_id, ci.quantity, p.name, p.price, p.image_url
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
    ORDER BY ci.id DESC
  `).all(req.user!.id) as Array<{ id: number; product_id: number; quantity: number; name: string; price: number; image_url: string | null }>;

  const items = rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    quantity: row.quantity,
    name: row.name,
    price: row.price,
    imageUrl: row.image_url,
    lineTotal: Number((row.quantity * row.price).toFixed(2))
  }));
  const total = Number(items.reduce((sum, i) => sum + i.lineTotal, 0).toFixed(2));

  res.json({ items, total });
});

app.post('/api/cart/items', authRequired(JWT_SECRET), (req, res) => {
  const { productId, quantity } = req.body as { productId: number; quantity?: number };
  const qty = Number(quantity || 1);
  if (!productId || Number.isNaN(qty) || qty <= 0) return res.status(400).json({ message: 'Неверные данные позиции корзины' });

  const product = db.prepare('SELECT id FROM products WHERE id = ? AND in_stock = 1').get(productId);
  if (!product) return res.status(404).json({ message: 'Товар не найден' });

  const existing = db.prepare('SELECT id FROM cart_items WHERE user_id = ? AND product_id = ?').get(req.user!.id, productId) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE cart_items SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
  } else {
    db.prepare('INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)').run(req.user!.id, productId, qty);
  }

  res.status(201).json({ message: 'Товар добавлен в корзину' });
});

app.put('/api/cart/items/:itemId', authRequired(JWT_SECRET), (req, res) => {
  const itemId = Number(req.params.itemId);
  const quantity = Number((req.body as { quantity?: number }).quantity);
  if (!itemId || Number.isNaN(quantity) || quantity <= 0) return res.status(400).json({ message: 'itemId и quantity должны быть валидными' });

  const item = db.prepare('SELECT id FROM cart_items WHERE id = ? AND user_id = ?').get(itemId, req.user!.id);
  if (!item) return res.status(404).json({ message: 'Позиция корзины не найдена' });

  db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ?').run(quantity, itemId);
  res.json({ message: 'Количество обновлено' });
});

app.delete('/api/cart/items/:itemId', authRequired(JWT_SECRET), (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!itemId) return res.status(400).json({ message: 'Некорректный itemId' });

  db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(itemId, req.user!.id);
  res.json({ message: 'Позиция удалена' });
});

app.post('/api/orders', authRequired(JWT_SECRET), (req, res) => {
  const body = req.body as { deliveryAddress?: string; deliveryLat?: number; deliveryLng?: number };
  const user = getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });

  const cart = db.prepare(`
    SELECT ci.product_id, ci.quantity, p.name, p.price
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
  `).all(user.id) as Array<{ product_id: number; quantity: number; name: string; price: number }>;

  if (!cart.length) return res.status(400).json({ message: 'Корзина пуста' });

  const address = (body.deliveryAddress || user.address || '').trim();
  if (!address) return res.status(400).json({ message: 'Нужен адрес доставки' });
  if (!hasStreetName(address)) {
    return res.status(400).json({ message: 'Укажите корректное название улицы в адресе доставки' });
  }

  const hasLat = body.deliveryLat !== undefined && body.deliveryLat !== null;
  const hasLng = body.deliveryLng !== undefined && body.deliveryLng !== null;
  if (hasLat !== hasLng) {
    return res.status(400).json({ message: 'Координаты доставки должны быть переданы парой' });
  }

  const deliveryLat = hasLat ? Number(body.deliveryLat) : null;
  const deliveryLng = hasLng ? Number(body.deliveryLng) : null;
  if (
    (deliveryLat !== null && (Number.isNaN(deliveryLat) || deliveryLat < -90 || deliveryLat > 90)) ||
    (deliveryLng !== null && (Number.isNaN(deliveryLng) || deliveryLng < -180 || deliveryLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты доставки' });
  }

  const total = Number(cart.reduce((sum, item) => sum + item.quantity * item.price, 0).toFixed(2));

  const createOrderTx = db.transaction(() => {
    const orderResult = db.prepare('INSERT INTO orders (user_id, status, total, delivery_address, delivery_lat, delivery_lng) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, 'pending', total, address, deliveryLat, deliveryLng);

    const orderId = Number(orderResult.lastInsertRowid);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');

    for (const item of cart) {
      insertItem.run(orderId, item.product_id, item.name, item.quantity, item.price);
    }

    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO order_events (order_id, status, comment, created_by) VALUES (?, ?, ?, ?)')
      .run(orderId, 'pending', 'Заказ создан', user.id);

    return orderId;
  });

  const orderId = createOrderTx();
  assignCourierIfPossible(orderId);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as DbOrder;
  res.status(201).json({ order: orderView(order) });
});

function fetchOrderItems(orderId: number) {
  return db.prepare(`
    SELECT product_id, product_name, quantity, unit_price
    FROM order_items
    WHERE order_id = ?
  `).all(orderId).map((item: any) => ({
    productId: item.product_id,
    name: item.product_name,
    quantity: item.quantity,
    unitPrice: item.unit_price
  }));
}

function fetchOrderEvents(orderId: number) {
  return db.prepare(`
    SELECT oe.status, oe.comment, oe.created_at, u.full_name
    FROM order_events oe
    LEFT JOIN users u ON u.id = oe.created_by
    WHERE oe.order_id = ?
    ORDER BY oe.id ASC
  `).all(orderId).map((event: any) => ({
    status: event.status,
    comment: event.comment,
    createdAt: event.created_at,
    createdBy: event.full_name || null
  }));
}

app.get('/api/orders/my', authRequired(JWT_SECRET), (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.user!.id) as DbOrder[];
  res.json({ orders: orders.map(orderView) });
});

app.get('/api/orders/assigned', authRequired(JWT_SECRET), roleRequired('courier'), (req, res) => {
  const courier = db.prepare('SELECT id FROM couriers WHERE user_id = ?').get(req.user!.id) as { id: number } | undefined;
  if (!courier) return res.json({ orders: [] });

  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE assigned_courier_id = ?
      AND status IN ('assigned', 'picked_up', 'on_the_way')
    ORDER BY id DESC
  `).all(courier.id) as DbOrder[];

  return res.json({ orders: orders.map(orderView) });
});

app.get('/api/orders/all', authRequired(JWT_SECRET), roleRequired('admin'), (_req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all() as DbOrder[];
  res.json({ orders: orders.map(orderView) });
});

app.get('/api/orders/:orderId', authRequired(JWT_SECRET), (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as DbOrder | undefined;
  if (!order) return res.status(404).json({ message: 'Заказ не найден' });

  if (req.user!.role === 'customer' && order.user_id !== req.user!.id) {
    return res.status(403).json({ message: 'Нет доступа к заказу' });
  }

  if (req.user!.role === 'courier') {
    const courier = db.prepare('SELECT id FROM couriers WHERE user_id = ?').get(req.user!.id) as { id: number } | undefined;
    if (!courier || order.assigned_courier_id !== courier.id) {
      return res.status(403).json({ message: 'Нет доступа к заказу' });
    }
  }

  res.json({ order: orderView(order), items: fetchOrderItems(orderId), events: fetchOrderEvents(orderId) });
});

app.patch('/api/orders/:orderId/status', authRequired(JWT_SECRET), (req, res) => {
  const orderId = Number(req.params.orderId);
  const { status, comment } = req.body as { status?: string; comment?: string };
  const allowed = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];

  if (!orderId || !status || !allowed.includes(status)) {
    return res.status(400).json({ message: 'Некорректный статус или orderId' });
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as DbOrder | undefined;
  if (!order) return res.status(404).json({ message: 'Заказ не найден' });

  if (req.user!.role === 'customer') {
    if (order.user_id !== req.user!.id || status !== 'cancelled') {
      return res.status(403).json({ message: 'Клиент может отменить только свой заказ' });
    }
  }

  if (req.user!.role === 'courier') {
    const courier = db.prepare('SELECT id FROM couriers WHERE user_id = ?').get(req.user!.id) as { id: number } | undefined;
    const courierAllowed = ['picked_up', 'on_the_way', 'delivered'];
    if (!courier || order.assigned_courier_id !== courier.id || !courierAllowed.includes(status)) {
      return res.status(403).json({ message: 'Заказ не назначен этому курьеру или статус запрещен' });
    }
  }

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
  db.prepare('INSERT INTO order_events (order_id, status, comment, created_by) VALUES (?, ?, ?, ?)')
    .run(orderId, status, comment || null, req.user!.id);

  if (status === 'delivered' || status === 'cancelled') {
    tryAssignOldestPendingOrder();
  }

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as DbOrder;
  return res.json({ order: orderView(updated) });
});

app.post('/api/couriers/connect', authRequired(JWT_SECRET), roleRequired('courier', 'admin'), (req, res) => {
  const body = req.body as { vehicleType?: string; status?: string; userId?: number };

  let targetUserId = req.user!.id;
  if (req.user!.role === 'admin' && body.userId) {
    targetUserId = Number(body.userId);
  }

  const targetUser = getUserById(targetUserId);
  if (!targetUser) return res.status(404).json({ message: 'Пользователь не найден' });

  if (targetUser.role !== 'courier') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('courier', targetUser.id);
  }

  const courier = getOrCreateCourierForUser(targetUser.id);
  const nextStatus = ['offline', 'available', 'busy'].includes(body.status || '') ? body.status! : 'available';

  db.prepare('UPDATE couriers SET vehicle_type = ?, status = ? WHERE id = ?')
    .run(body.vehicleType || courier.vehicle_type || 'bike', nextStatus, courier.id);

  return res.json({ message: 'Курьер подключен', courierId: courier.id, status: nextStatus });
});

app.get('/api/couriers', authRequired(JWT_SECRET), roleRequired('admin'), (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*, u.full_name, u.email, u.phone
    FROM couriers c
    JOIN users u ON u.id = c.user_id
    ORDER BY c.id DESC
  `).all() as Array<{
    id: number;
    user_id: number;
    full_name: string;
    email: string;
    phone: string | null;
    vehicle_type: string | null;
    status: string;
    max_active_orders: number;
  }>;

  res.json({
    couriers: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      vehicleType: row.vehicle_type,
      status: row.status,
      activeOrders: getActiveOrderCountForCourier(row.id),
      maxActiveOrders: row.max_active_orders
    }))
  });
});

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`API запущен на http://localhost:${PORT}`);
});
