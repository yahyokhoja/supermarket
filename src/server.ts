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
import { authRequired, buildToken, roleRequired, setAuthUserResolver } from './auth';
import { connectDb, initDb, seedProductCategories, seedProducts, seedUsers } from './db';
import type { ApiOrder, DbOrder, DbUser, PublicUser, UserRole } from './types';

const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_super_secret';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://supermarket:supermarket_dev_password@localhost:5432/supermarket';
const SYSTEM_ADMIN_EMAIL = 'admin@universal.local';
const ADMIN_PERMISSIONS = [
  'view_orders',
  'view_analytics',
  'manage_products',
  'manage_warehouse',
  'manage_users',
  'manage_couriers',
  'view_audit',
  'search_db'
] as const;
type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
const GEOCODER_PROVIDER = (process.env.GEOCODER_PROVIDER || 'yandex').toLowerCase();
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';

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
  await seedProductCategories(db);
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
    isActive: user.is_active,
    permissions: user.permissions,
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
    is_active: row.is_active !== false,
    session_version: Number(row.session_version ?? 0),
    permissions: Array.isArray(row.permissions)
      ? row.permissions.map((p: unknown) => String(p))
      : [],
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

setAuthUserResolver(async (userId) => {
  const row = (await db.query(
    `
      SELECT id, email, role, is_active, session_version
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  )).rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    email: String(row.email),
    role: row.role as UserRole,
    isActive: row.is_active !== false,
    sessionVersion: Number(row.session_version ?? 0)
  };
});

async function logAdminAction(
  adminUserId: number,
  action: string,
  entityType: string,
  entityId: number | null,
  details: Record<string, unknown> | null = null
) {
  await db.query(
    `
      INSERT INTO admin_audit_logs (admin_user_id, action, entity_type, entity_id, details)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [adminUserId, action, entityType, entityId, details ? JSON.stringify(details) : null]
  );
}

function isSystemAdmin(user: Pick<DbUser, 'email'>) {
  return user.email.trim().toLowerCase() === SYSTEM_ADMIN_EMAIL;
}

function normalizePermissions(input: unknown): AdminPermission[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(ADMIN_PERMISSIONS);
  return Array.from(new Set(input.map((p) => String(p).trim()).filter((p) => allowed.has(p)))) as AdminPermission[];
}

async function getUserPermissions(userId: number) {
  const row = (await db.query('SELECT permissions FROM users WHERE id = $1 LIMIT 1', [userId])).rows[0];
  if (!row) return [] as string[];
  if (!Array.isArray(row.permissions)) return [] as string[];
  return row.permissions.map((p: unknown) => String(p));
}

async function adminHasPermission(userId: number, permission: AdminPermission) {
  const user = await getUserById(userId);
  if (!user || user.role !== 'admin') return false;
  if (isSystemAdmin(user)) return true;
  const permissions = await getUserPermissions(userId);
  return permissions.includes(permission);
}

async function requireAdminPermission(req: express.Request, res: express.Response, permission: AdminPermission) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: 'Требуется авторизация' });
    return false;
  }
  const allowed = await adminHasPermission(userId, permission);
  if (!allowed) {
    res.status(403).json({ message: 'Недостаточно прав для этого действия' });
    return false;
  }
  return true;
}

async function getOrCreateCourierForUser(userId: number) {
  let row = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [userId])).rows[0];
  if (!row) {
    await db.query(
      `
        INSERT INTO couriers (user_id, vehicle_type, status, verification_status, max_active_orders)
        VALUES ($1, 'bike', 'offline', 'pending', 5)
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
    verification_status: row.verification_status,
    transport_license: row.transport_license,
    vehicle_registration_number: row.vehicle_registration_number,
    tech_passport_image_url: row.tech_passport_image_url,
    verification_comment: row.verification_comment,
    verification_requested_at: row.verification_requested_at ? toDateString(row.verification_requested_at) : null,
    verification_reviewed_by: row.verification_reviewed_by === null ? null : toNumber(row.verification_reviewed_by),
    verified_at: row.verified_at ? toDateString(row.verified_at) : null,
    max_active_orders: toNumber(row.max_active_orders)
  };
}

function courierEligible(courier: {
  verification_status?: string | null;
  transport_license?: string | null;
  vehicle_registration_number?: string | null;
  tech_passport_image_url?: string | null;
}) {
  return (
    courier.verification_status === 'approved' &&
    Boolean(courier.transport_license) &&
    Boolean(courier.vehicle_registration_number) &&
    Boolean(courier.tech_passport_image_url)
  );
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

async function getDefaultWarehouseId(client: Pool | PoolClient) {
  const row = (await client.query("SELECT id FROM warehouses WHERE code = 'MAIN' LIMIT 1")).rows[0];
  if (row) return toNumber(row.id);
  const created = (await client.query(
    `
      INSERT INTO warehouses (code, name, is_active)
      VALUES ('MAIN', 'Основной склад', TRUE)
      RETURNING id
    `
  )).rows[0];
  return toNumber(created.id);
}

async function ensureWarehouseStockRow(client: Pool | PoolClient, warehouseId: number, productId: number) {
  await client.query(
    `
      INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, reserved_quantity, reorder_min, reorder_target)
      VALUES ($1, $2, 0, 0, 5, 20)
      ON CONFLICT (warehouse_id, product_id) DO NOTHING
    `,
    [warehouseId, productId]
  );
}

async function syncProductAvailabilityFromWarehouse(client: Pool | PoolClient, productId: number) {
  const row = (await client.query(
    `
      SELECT
        COALESCE(SUM(quantity), 0)::text AS total_quantity,
        COALESCE(SUM(reserved_quantity), 0)::text AS total_reserved
      FROM warehouse_stock
      WHERE product_id = $1
    `,
    [productId]
  )).rows[0];

  const totalQuantity = Number(row?.total_quantity || '0');
  const totalReserved = Number(row?.total_reserved || '0');
  const available = Math.max(totalQuantity - totalReserved, 0);
  await client.query(
    `
      UPDATE products
      SET
        stock_quantity = $1,
        in_stock = CASE WHEN $1 <= 0 THEN FALSE ELSE in_stock END
      WHERE id = $3
    `,
    [available, productId]
  );
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
    inStock: Boolean(row.in_stock),
    stockQuantity: Math.max(0, toNumber(row.stock_quantity ?? 0))
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

function parseCategoryPath(value: string | null | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return { category: '', subcategory: '' };
  const parts = raw
    .split(/[>/]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    category: parts[0] || '',
    subcategory: parts[1] || ''
  };
}

function composeCategoryPath(category: string, subcategory?: string | null) {
  const c = category.trim();
  const s = String(subcategory || '').trim();
  if (!c) return '';
  return s ? `${c} > ${s}` : c;
}

async function categoryExists(categoryPath: string) {
  const parsed = parseCategoryPath(categoryPath);
  if (!parsed.category) return true;
  const row = (await db.query(
    `
      SELECT 1
      FROM product_categories
      WHERE lower(category_name) = lower($1)
        AND lower(COALESCE(subcategory_name, '')) = lower($2)
      LIMIT 1
    `,
    [parsed.category, parsed.subcategory]
  )).rows[0];
  return Boolean(row);
}

function extractJsonObject(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickResponseText(responseData: any) {
  if (typeof responseData?.output_text === 'string' && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
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
      INSERT INTO users (full_name, email, phone, address, password_hash, role, permissions)
      VALUES ($1, $2, $3, $4, $5, 'customer', '{}')
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
  if (!user.is_active) {
    return res.status(403).json({ message: 'Аккаунт заблокирован администратором' });
  }

  return res.json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.get('/api/users/me', authRequired(JWT_SECRET), async (req, res) => {
  const user = await getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  if (!user.is_active) return res.status(403).json({ message: 'Аккаунт заблокирован администратором' });
  return res.json({ user: publicUser(user) });
});

app.put('/api/users/me', authRequired(JWT_SECRET), async (req, res) => {
  const { fullName, phone, address } = req.body as { fullName?: string; phone?: string | null; address?: string | null };
  const user = await getUserById(req.user!.id);
  if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
  if (!user.is_active) return res.status(403).json({ message: 'Аккаунт заблокирован администратором' });

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
  const rows = (await db.query('SELECT * FROM products WHERE in_stock = TRUE AND stock_quantity > 0 ORDER BY id DESC')).rows;
  res.json({ products: rows.map((row: any) => normalizeProductRow(row)) });
});

app.get('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  if (!(await requireAdminPermission(_req, res, 'manage_products'))) return;
  const rows = (await db.query('SELECT * FROM products ORDER BY id DESC')).rows;
  res.json({ products: rows.map((row: any) => normalizeProductRow(row)) });
});

app.get('/api/admin/categories', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const rows = (await db.query(
    `
      SELECT category_name, subcategory_name
      FROM product_categories
      ORDER BY category_name ASC, subcategory_name ASC NULLS FIRST
    `
  )).rows;

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const category = String(row.category_name || '').trim();
    const sub = row.subcategory_name ? String(row.subcategory_name).trim() : '';
    if (!category) continue;
    if (!grouped.has(category)) grouped.set(category, []);
    if (sub) grouped.get(category)!.push(sub);
  }

  return res.json({
    categories: Array.from(grouped.entries()).map(([name, subcategories]) => ({
      name,
      subcategories
    }))
  });
});

app.post('/api/admin/categories', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const body = req.body as { category?: string; subcategory?: string | null };
  const category = String(body.category || '').trim();
  const subcategory = String(body.subcategory || '').trim();
  if (!category) return res.status(400).json({ message: 'Категория обязательна' });

  await db.query(
    `
      INSERT INTO product_categories (category_name, subcategory_name)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [category, subcategory || null]
  );
  await logAdminAction(req.user!.id, 'category.create', 'product_category', null, { category, subcategory: subcategory || null });
  return res.status(201).json({ message: 'Категория сохранена' });
});

app.post('/api/admin/products/smart-detect', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ message: 'OPENAI_API_KEY не задан. Укажите ключ в .env для умного распознавания.' });
  }

  const body = req.body as { imageUrl?: string };
  const imageUrl = String(body.imageUrl || '').trim();
  if (!imageUrl) return res.status(400).json({ message: 'imageUrl обязателен' });

  const categoryRows = (await db.query(
    `
      SELECT category_name, subcategory_name
      FROM product_categories
      ORDER BY category_name ASC, subcategory_name ASC NULLS FIRST
    `
  )).rows;
  const categories = categoryRows.map((row: any) => ({
    category: String(row.category_name || '').trim(),
    subcategory: row.subcategory_name ? String(row.subcategory_name).trim() : ''
  }));

  const prompt = [
    'Ты помощник для админ-панели супермаркета.',
    'По фото товара верни JSON с полями: name, category, subcategory, description.',
    'Используй только одну из доступных категорий/подкатегорий из списка ниже.',
    'Если подкатегория не подходит, верни пустую строку.',
    'Описание короткое: 1-2 предложения, без цены и без количества.',
    'Верни только JSON без пояснений.',
    `Доступные категории: ${JSON.stringify(categories)}`
  ].join('\n');

  const aiRes = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageUrl }
          ]
        }
      ],
      temperature: 0.2
    })
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text().catch(() => '');
    return res.status(502).json({ message: `Ошибка AI-распознавания: ${errText || aiRes.statusText}` });
  }

  const aiData = await aiRes.json();
  const text = pickResponseText(aiData);
  const parsed = extractJsonObject(text);
  if (!parsed) {
    return res.status(502).json({ message: 'Не удалось разобрать ответ AI. Повторите попытку.' });
  }

  const name = String(parsed.name || '').trim();
  const category = String(parsed.category || '').trim();
  const subcategory = String(parsed.subcategory || '').trim();
  const description = String(parsed.description || '').trim();

  if (!name || !category) {
    return res.status(502).json({ message: 'AI не смог надежно определить товар. Добавьте данные вручную.' });
  }

  const fullCategory = composeCategoryPath(category, subcategory);
  if (!(await categoryExists(fullCategory))) {
    return res.status(400).json({ message: 'AI предложил категорию вне справочника. Выберите вручную.' });
  }

  return res.json({
    suggestion: {
      name,
      category,
      subcategory,
      description
    }
  });
});

app.patch('/api/admin/categories/rename', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const body = req.body as {
    oldCategory?: string;
    oldSubcategory?: string | null;
    newCategory?: string;
    newSubcategory?: string | null;
  };

  const oldCategory = String(body.oldCategory || '').trim();
  const oldSubcategory = String(body.oldSubcategory || '').trim();
  const newCategory = String(body.newCategory || '').trim();
  const newSubcategory = String(body.newSubcategory || '').trim();

  if (!oldCategory || !newCategory) {
    return res.status(400).json({ message: 'oldCategory и newCategory обязательны' });
  }

  const oldPath = composeCategoryPath(oldCategory, oldSubcategory || null);
  const newPath = composeCategoryPath(newCategory, newSubcategory || null);

  if (oldSubcategory) {
    await db.query(
      `
        UPDATE product_categories
        SET category_name = $1, subcategory_name = $2
        WHERE lower(category_name) = lower($3)
          AND lower(COALESCE(subcategory_name, '')) = lower($4)
      `,
      [newCategory, newSubcategory || null, oldCategory, oldSubcategory]
    );
    await db.query('UPDATE products SET category = $1 WHERE category = $2', [newPath, oldPath]);
  } else {
    await db.query(
      `
        UPDATE product_categories
        SET category_name = $1
        WHERE lower(category_name) = lower($2)
      `,
      [newCategory, oldCategory]
    );
    await db.query(
      `
        UPDATE products
        SET category = CASE
          WHEN NULLIF(TRIM(SPLIT_PART(category, '>', 2)), '') IS NULL THEN $1
          ELSE $1 || ' > ' || TRIM(SPLIT_PART(category, '>', 2))
        END
        WHERE lower(TRIM(SPLIT_PART(category, '>', 1))) = lower($2)
      `,
      [newCategory, oldCategory]
    );
  }

  await logAdminAction(req.user!.id, 'category.rename', 'product_category', null, {
    oldCategory,
    oldSubcategory: oldSubcategory || null,
    newCategory,
    newSubcategory: newSubcategory || null
  });
  return res.json({ message: 'Категория переименована' });
});

app.delete('/api/admin/categories', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const body = req.body as { category?: string; subcategory?: string | null };
  const category = String(body.category || '').trim();
  const subcategory = String(body.subcategory || '').trim();
  if (!category) return res.status(400).json({ message: 'category обязателен' });

  if (subcategory) {
    const path = composeCategoryPath(category, subcategory);
    await db.query(
      `
        DELETE FROM product_categories
        WHERE lower(category_name) = lower($1)
          AND lower(COALESCE(subcategory_name, '')) = lower($2)
      `,
      [category, subcategory]
    );
    await db.query('UPDATE products SET category = NULL WHERE category = $1', [path]);
  } else {
    await db.query('DELETE FROM product_categories WHERE lower(category_name) = lower($1)', [category]);
    await db.query(
      `
        UPDATE products
        SET category = NULL
        WHERE lower(TRIM(SPLIT_PART(category, '>', 1))) = lower($1)
      `,
      [category]
    );
  }

  await logAdminAction(req.user!.id, 'category.delete', 'product_category', null, {
    category,
    subcategory: subcategory || null
  });
  return res.json({ message: 'Категория удалена' });
});

app.post('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const body = req.body as {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
    imageUrl?: string;
    inStock?: boolean;
    stockQuantity?: number;
  };

  const name = String(body.name || '').trim();
  const price = Number(body.price);
  if (!name || Number.isNaN(price) || price <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  const stockQuantityRaw = body.stockQuantity !== undefined ? Number(body.stockQuantity) : 0;
  const stockQuantity = Math.floor(stockQuantityRaw);
  if (!Number.isFinite(stockQuantityRaw) || stockQuantity < 0) {
    return res.status(400).json({ message: 'Количество в наличии должно быть целым числом 0 или больше' });
  }

  const categoryPath = String(body.category || '').trim();
  if (categoryPath && !(await categoryExists(categoryPath))) {
    return res.status(400).json({ message: 'Категория/подкатегория не найдена в справочнике' });
  }

  const created = await db.query(
    `
      INSERT INTO products (name, description, price, category, image_url, in_stock, stock_quantity)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
    [
      name,
      body.description?.trim() || null,
      price,
      categoryPath || null,
      body.imageUrl?.trim() || null,
      stockQuantity > 0 && (body.inStock !== undefined ? Boolean(body.inStock) : true),
      stockQuantity
    ]
  );

  const createdProduct = normalizeProductRow(created.rows[0]);
  const defaultWarehouseId = await getDefaultWarehouseId(db);
  await ensureWarehouseStockRow(db, defaultWarehouseId, createdProduct.id);
  await db.query(
    `
      UPDATE warehouse_stock
      SET quantity = $1, reserved_quantity = 0, updated_at = NOW()
      WHERE warehouse_id = $2 AND product_id = $3
    `,
    [stockQuantity, defaultWarehouseId, createdProduct.id]
  );
  await syncProductAvailabilityFromWarehouse(db, createdProduct.id);

  const freshCreated = (await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [createdProduct.id])).rows[0];
  return res.status(201).json({ product: normalizeProductRow(freshCreated) });
});

app.put('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
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
    stockQuantity?: number;
  };

  const nextName = body.name !== undefined ? String(body.name).trim() : existingRow.name;
  const nextPrice = body.price !== undefined ? Number(body.price) : Number(existingRow.price);
  if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  const nextCategory =
    body.category !== undefined ? String(body.category || '').trim() : String(existingRow.category || '').trim();
  if (nextCategory && !(await categoryExists(nextCategory))) {
    return res.status(400).json({ message: 'Категория/подкатегория не найдена в справочнике' });
  }

  const nextStockQuantityRaw =
    body.stockQuantity !== undefined ? Number(body.stockQuantity) : Number(existingRow.stock_quantity ?? 0);
  const nextStockQuantity = Math.floor(nextStockQuantityRaw);
  if (!Number.isFinite(nextStockQuantityRaw) || nextStockQuantity < 0) {
    return res.status(400).json({ message: 'Количество в наличии должно быть целым числом 0 или больше' });
  }

  const updated = await db.query(
    `
      UPDATE products
      SET name = $1, description = $2, price = $3, category = $4, image_url = $5, in_stock = $6, stock_quantity = $7
      WHERE id = $8
      RETURNING *
    `,
    [
      nextName,
      body.description !== undefined ? body.description?.trim() || null : existingRow.description,
      nextPrice,
      nextCategory || null,
      body.imageUrl !== undefined ? body.imageUrl?.trim() || null : existingRow.image_url,
      nextStockQuantity > 0 && (body.inStock !== undefined ? Boolean(body.inStock) : Boolean(existingRow.in_stock)),
      nextStockQuantity,
      productId
    ]
  );

  if (body.stockQuantity !== undefined) {
    const defaultWarehouseId = await getDefaultWarehouseId(db);
    await ensureWarehouseStockRow(db, defaultWarehouseId, productId);
    await db.query(
      `
        UPDATE warehouse_stock
        SET quantity = $1 + reserved_quantity, updated_at = NOW()
        WHERE warehouse_id = $2 AND product_id = $3
      `,
      [nextStockQuantity, defaultWarehouseId, productId]
    );
    await syncProductAvailabilityFromWarehouse(db, productId);
  }

  const freshUpdated = (await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [productId])).rows[0];
  return res.json({ product: normalizeProductRow(freshUpdated || updated.rows[0]) });
});

app.delete('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const deleted = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [productId]);
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Товар не найден' });

  return res.json({ message: 'Товар удален' });
});

app.get('/api/admin/warehouse/overview', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;

  const [warehouseRows, stockRows, movementRows] = await Promise.all([
    db.query('SELECT id, code, name, is_active FROM warehouses ORDER BY id ASC'),
    db.query(
      `
        SELECT
          ws.warehouse_id,
          w.code AS warehouse_code,
          w.name AS warehouse_name,
          ws.product_id,
          p.name AS product_name,
          p.image_url,
          p.category,
          ws.quantity,
          ws.reserved_quantity,
          GREATEST(ws.quantity - ws.reserved_quantity, 0) AS available_quantity,
          ws.reorder_min,
          ws.reorder_target,
          ws.updated_at
        FROM warehouse_stock ws
        JOIN warehouses w ON w.id = ws.warehouse_id
        JOIN products p ON p.id = ws.product_id
        ORDER BY w.id ASC, p.name ASC
      `
    ),
    db.query(
      `
        SELECT
          sm.id,
          sm.movement_type,
          sm.quantity,
          sm.reason,
          sm.reference_type,
          sm.reference_id,
          sm.created_at,
          w.name AS warehouse_name,
          p.name AS product_name,
          u.full_name AS created_by_name
        FROM stock_movements sm
        JOIN warehouses w ON w.id = sm.warehouse_id
        JOIN products p ON p.id = sm.product_id
        LEFT JOIN users u ON u.id = sm.created_by
        ORDER BY sm.id DESC
        LIMIT 120
      `
    )
  ]);

  const stock = stockRows.rows.map((row: any) => ({
    warehouseId: toNumber(row.warehouse_id),
    warehouseCode: String(row.warehouse_code),
    warehouseName: String(row.warehouse_name),
    productId: toNumber(row.product_id),
    productName: String(row.product_name),
    category: row.category ?? null,
    imageUrl: row.image_url ?? null,
    quantity: toNumber(row.quantity),
    reservedQuantity: toNumber(row.reserved_quantity),
    availableQuantity: toNumber(row.available_quantity),
    reorderMin: toNumber(row.reorder_min),
    reorderTarget: toNumber(row.reorder_target),
    updatedAt: toDateString(row.updated_at)
  }));

  const lowStock = stock
    .filter((item) => item.availableQuantity < item.reorderMin)
    .map((item) => ({
      ...item,
      orderSuggestion: Math.max(item.reorderTarget - item.availableQuantity, 0)
    }));

  return res.json({
    warehouses: warehouseRows.rows.map((row: any) => ({
      id: toNumber(row.id),
      code: String(row.code),
      name: String(row.name),
      isActive: row.is_active !== false
    })),
    stock,
    lowStock,
    movements: movementRows.rows.map((row: any) => ({
      id: toNumber(row.id),
      movementType: String(row.movement_type),
      quantity: toNumber(row.quantity),
      reason: row.reason ?? null,
      referenceType: row.reference_type ?? null,
      referenceId: row.reference_id === null ? null : toNumber(row.reference_id),
      warehouseName: String(row.warehouse_name),
      productName: String(row.product_name),
      createdBy: row.created_by_name ?? null,
      createdAt: toDateString(row.created_at)
    }))
  });
});

app.get('/api/admin/pick-tasks', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;

  const taskRows = (await db.query(
    `
      SELECT
        pt.id,
        pt.order_id,
        pt.warehouse_id,
        pt.status,
        pt.assigned_to,
        pt.created_by,
        pt.started_at,
        pt.completed_at,
        pt.created_at,
        pt.updated_at,
        w.name AS warehouse_name,
        u.full_name AS assigned_to_name,
        c.full_name AS created_by_name
      FROM pick_tasks pt
      JOIN warehouses w ON w.id = pt.warehouse_id
      LEFT JOIN users u ON u.id = pt.assigned_to
      LEFT JOIN users c ON c.id = pt.created_by
      ORDER BY pt.id DESC
      LIMIT 120
    `
  )).rows;

  const itemRows = (await db.query(
    `
      SELECT
        pti.pick_task_id,
        pti.product_id,
        pti.product_name,
        pti.requested_qty,
        pti.picked_qty
      FROM pick_task_items pti
      ORDER BY pti.pick_task_id DESC, pti.id ASC
    `
  )).rows;

  const itemsByTask = new Map<number, Array<{ productId: number; productName: string; requestedQty: number; pickedQty: number }>>();
  for (const row of itemRows) {
    const taskId = toNumber(row.pick_task_id);
    if (!itemsByTask.has(taskId)) itemsByTask.set(taskId, []);
    itemsByTask.get(taskId)!.push({
      productId: toNumber(row.product_id),
      productName: String(row.product_name),
      requestedQty: toNumber(row.requested_qty),
      pickedQty: toNumber(row.picked_qty)
    });
  }

  return res.json({
    tasks: taskRows.map((row: any) => ({
      id: toNumber(row.id),
      orderId: toNumber(row.order_id),
      warehouseId: toNumber(row.warehouse_id),
      warehouseName: String(row.warehouse_name),
      status: String(row.status),
      assignedTo: row.assigned_to === null ? null : toNumber(row.assigned_to),
      assignedToName: row.assigned_to_name ?? null,
      createdBy: row.created_by === null ? null : toNumber(row.created_by),
      createdByName: row.created_by_name ?? null,
      startedAt: row.started_at ? toDateString(row.started_at) : null,
      completedAt: row.completed_at ? toDateString(row.completed_at) : null,
      createdAt: toDateString(row.created_at),
      updatedAt: toDateString(row.updated_at),
      items: itemsByTask.get(toNumber(row.id)) || []
    }))
  });
});

app.post('/api/admin/stock/receive', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as { warehouseId?: number; productId?: number; quantity?: number; reason?: string };
  const productId = Number(body.productId);
  const quantity = Math.floor(Number(body.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Нужны корректные productId и quantity > 0' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(client);
    await ensureWarehouseStockRow(client, warehouseId, productId);
    await client.query(
      `
        UPDATE warehouse_stock
        SET quantity = quantity + $1, updated_at = NOW()
        WHERE warehouse_id = $2 AND product_id = $3
      `,
      [quantity, warehouseId, productId]
    );
    await client.query(
      `
        INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, created_by)
        VALUES ($1, $2, 'receive', $3, $4, $5)
      `,
      [warehouseId, productId, quantity, String(body.reason || '').trim() || null, req.user!.id]
    );
    await syncProductAvailabilityFromWarehouse(client, productId);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Приемка проведена' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось провести приемку', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/stock/writeoff', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as { warehouseId?: number; productId?: number; quantity?: number; reason?: string };
  const productId = Number(body.productId);
  const quantity = Math.floor(Number(body.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Нужны корректные productId и quantity > 0' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(client);
    await ensureWarehouseStockRow(client, warehouseId, productId);
    const row = (await client.query(
      `
        SELECT quantity, reserved_quantity
        FROM warehouse_stock
        WHERE warehouse_id = $1 AND product_id = $2
        FOR UPDATE
      `,
      [warehouseId, productId]
    )).rows[0];
    const available = Math.max(toNumber(row?.quantity ?? 0) - toNumber(row?.reserved_quantity ?? 0), 0);
    if (available < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Недостаточно свободного остатка. Доступно: ${available}` });
    }

    await client.query(
      `
        UPDATE warehouse_stock
        SET quantity = quantity - $1, updated_at = NOW()
        WHERE warehouse_id = $2 AND product_id = $3
      `,
      [quantity, warehouseId, productId]
    );
    await client.query(
      `
        INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, created_by)
        VALUES ($1, $2, 'writeoff', $3, $4, $5)
      `,
      [warehouseId, productId, quantity, String(body.reason || '').trim() || null, req.user!.id]
    );
    await syncProductAvailabilityFromWarehouse(client, productId);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Списание проведено' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось провести списание', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/stock/reserve', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as {
    warehouseId?: number;
    productId?: number;
    quantity?: number;
    reason?: string;
    referenceType?: string;
    referenceId?: number;
  };
  const productId = Number(body.productId);
  const quantity = Math.floor(Number(body.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Нужны корректные productId и quantity > 0' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(client);
    await ensureWarehouseStockRow(client, warehouseId, productId);
    const row = (await client.query(
      `
        SELECT quantity, reserved_quantity
        FROM warehouse_stock
        WHERE warehouse_id = $1 AND product_id = $2
        FOR UPDATE
      `,
      [warehouseId, productId]
    )).rows[0];
    const available = Math.max(toNumber(row?.quantity ?? 0) - toNumber(row?.reserved_quantity ?? 0), 0);
    if (available < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Недостаточно остатка для резерва. Доступно: ${available}` });
    }
    await client.query(
      `
        UPDATE warehouse_stock
        SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
        WHERE warehouse_id = $2 AND product_id = $3
      `,
      [quantity, warehouseId, productId]
    );
    await client.query(
      `
        INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
        VALUES ($1, $2, 'reserve', $3, $4, $5, $6, $7)
      `,
      [
        warehouseId,
        productId,
        quantity,
        String(body.reason || '').trim() || null,
        String(body.referenceType || '').trim() || null,
        body.referenceId ? Number(body.referenceId) : null,
        req.user!.id
      ]
    );
    await syncProductAvailabilityFromWarehouse(client, productId);
    await client.query('COMMIT');
    return res.status(201).json({ message: 'Резерв создан' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось создать резерв', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/pick-tasks/from-order', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as { orderId?: number; warehouseId?: number; assignedTo?: number | null };
  const orderId = Number(body.orderId);
  if (!orderId) return res.status(400).json({ message: 'orderId обязателен' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(client);
    const activeTask = (await client.query(
      `
        SELECT id
        FROM pick_tasks
        WHERE order_id = $1
          AND status IN ('new', 'in_progress')
        LIMIT 1
      `,
      [orderId]
    )).rows[0];
    if (activeTask) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `Задача сборки уже существует: #${toNumber(activeTask.id)}` });
    }

    const items = (await client.query(
      `
        SELECT product_id, product_name, quantity
        FROM order_items
        WHERE order_id = $1
        ORDER BY id ASC
      `,
      [orderId]
    )).rows;
    if (!items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'У заказа нет позиций для сборки' });
    }

    const taskRow = (await client.query(
      `
        INSERT INTO pick_tasks (order_id, warehouse_id, status, assigned_to, created_by)
        VALUES ($1, $2, 'new', $3, $4)
        RETURNING id
      `,
      [orderId, warehouseId, body.assignedTo ? Number(body.assignedTo) : null, req.user!.id]
    )).rows[0];
    const taskId = toNumber(taskRow.id);

    for (const item of items) {
      const productId = toNumber(item.product_id);
      const requestedQty = toNumber(item.quantity);
      await ensureWarehouseStockRow(client, warehouseId, productId);
      const stock = (await client.query(
        `
          SELECT quantity, reserved_quantity
          FROM warehouse_stock
          WHERE warehouse_id = $1 AND product_id = $2
          FOR UPDATE
        `,
        [warehouseId, productId]
      )).rows[0];
      const available = Math.max(toNumber(stock?.quantity ?? 0) - toNumber(stock?.reserved_quantity ?? 0), 0);
      if (available < requestedQty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `Недостаточно остатка для товара "${String(item.product_name)}". Нужно: ${requestedQty}, доступно: ${available}`
        });
      }

      await client.query(
        `
          UPDATE warehouse_stock
          SET reserved_quantity = reserved_quantity + $1, updated_at = NOW()
          WHERE warehouse_id = $2 AND product_id = $3
        `,
        [requestedQty, warehouseId, productId]
      );
      await client.query(
        `
          INSERT INTO pick_task_items (pick_task_id, product_id, product_name, requested_qty, picked_qty)
          VALUES ($1, $2, $3, $4, 0)
        `,
        [taskId, productId, String(item.product_name), requestedQty]
      );
      await client.query(
        `
          INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
          VALUES ($1, $2, 'reserve', $3, $4, 'pick_task', $5, $6)
        `,
        [warehouseId, productId, requestedQty, `Резерв под задачу сборки #${taskId}`, taskId, req.user!.id]
      );
      await syncProductAvailabilityFromWarehouse(client, productId);
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: 'Задача сборки создана', taskId });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось создать задачу сборки', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/pick-tasks/:taskId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const taskId = Number(req.params.taskId);
  if (!taskId) return res.status(400).json({ message: 'Некорректный taskId' });
  const body = req.body as { status?: 'new' | 'in_progress' | 'done' | 'cancelled'; assignedTo?: number | null };
  const status = String(body.status || '').trim();
  if (!['new', 'in_progress', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'Некорректный статус задачи сборки' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const task = (await client.query(
      `
        SELECT id, warehouse_id, status, assigned_to
        FROM pick_tasks
        WHERE id = $1
        FOR UPDATE
      `,
      [taskId]
    )).rows[0];
    if (!task) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Задача сборки не найдена' });
    }

    const currentStatus = String(task.status);
    if (['done', 'cancelled'].includes(currentStatus) && currentStatus !== status) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Финальную задачу нельзя перевести в другой статус' });
    }

    const itemRows = (await client.query(
      `
        SELECT product_id, requested_qty
        FROM pick_task_items
        WHERE pick_task_id = $1
        ORDER BY id ASC
        FOR UPDATE
      `,
      [taskId]
    )).rows;

    if (status === 'done' && !['new', 'in_progress', 'done'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Задачу можно завершить только из статусов new/in_progress' });
    }
    if (status === 'cancelled' && !['new', 'in_progress', 'cancelled'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Задачу можно отменить только из статусов new/in_progress' });
    }

    if (status === 'done' && currentStatus !== 'done') {
      for (const item of itemRows) {
        const productId = toNumber(item.product_id);
        const qty = toNumber(item.requested_qty);
        const stock = (await client.query(
          `
            SELECT quantity, reserved_quantity
            FROM warehouse_stock
            WHERE warehouse_id = $1 AND product_id = $2
            FOR UPDATE
          `,
          [toNumber(task.warehouse_id), productId]
        )).rows[0];
        const quantity = toNumber(stock?.quantity ?? 0);
        const reserved = toNumber(stock?.reserved_quantity ?? 0);
        if (quantity < qty || reserved < qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Недостаточно резерва для productId=${productId}` });
        }
        await client.query(
          `
            UPDATE warehouse_stock
            SET quantity = quantity - $1, reserved_quantity = reserved_quantity - $1, updated_at = NOW()
            WHERE warehouse_id = $2 AND product_id = $3
          `,
          [qty, toNumber(task.warehouse_id), productId]
        );
        await client.query(
          `
            UPDATE pick_task_items
            SET picked_qty = requested_qty
            WHERE pick_task_id = $1 AND product_id = $2
          `,
          [taskId, productId]
        );
        await client.query(
          `
            INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
            VALUES ($1, $2, 'pick', $3, $4, 'pick_task', $5, $6)
          `,
          [toNumber(task.warehouse_id), productId, qty, `Списано по задаче сборки #${taskId}`, taskId, req.user!.id]
        );
        await syncProductAvailabilityFromWarehouse(client, productId);
      }
    }

    if (status === 'cancelled' && currentStatus !== 'cancelled') {
      for (const item of itemRows) {
        const productId = toNumber(item.product_id);
        const qty = toNumber(item.requested_qty);
        const stock = (await client.query(
          `
            SELECT reserved_quantity
            FROM warehouse_stock
            WHERE warehouse_id = $1 AND product_id = $2
            FOR UPDATE
          `,
          [toNumber(task.warehouse_id), productId]
        )).rows[0];
        const reserved = toNumber(stock?.reserved_quantity ?? 0);
        if (reserved < qty) {
          await client.query('ROLLBACK');
          return res.status(400).json({ message: `Некорректный резерв для productId=${productId}` });
        }
        await client.query(
          `
            UPDATE warehouse_stock
            SET reserved_quantity = reserved_quantity - $1, updated_at = NOW()
            WHERE warehouse_id = $2 AND product_id = $3
          `,
          [qty, toNumber(task.warehouse_id), productId]
        );
        await client.query(
          `
            INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
            VALUES ($1, $2, 'release', $3, $4, 'pick_task', $5, $6)
          `,
          [toNumber(task.warehouse_id), productId, qty, `Резерв снят по отмене задачи #${taskId}`, taskId, req.user!.id]
        );
        await syncProductAvailabilityFromWarehouse(client, productId);
      }
    }

    const nextAssignedTo = body.assignedTo === undefined ? (task.assigned_to === null ? null : toNumber(task.assigned_to)) : body.assignedTo;

    await client.query(
      `
        UPDATE pick_tasks
        SET
          status = $1,
          assigned_to = $2,
          started_at = CASE WHEN $1 = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
          completed_at = CASE WHEN $1 IN ('done', 'cancelled') THEN NOW() ELSE completed_at END,
          updated_at = NOW()
        WHERE id = $3
      `,
      [status, nextAssignedTo, taskId]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Задача сборки обновлена' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось обновить задачу сборки', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.post(
  '/api/admin/uploads/image',
  authRequired(JWT_SECRET),
  roleRequired('admin'),
  upload.single('image'),
  async (req, res) => {
    if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'Файл изображения обязателен' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${baseUrl}/uploads/${file.filename}`;
    return res.status(201).json({ imageUrl });
  }
);

app.post(
  '/api/couriers/uploads/tech-passport',
  authRequired(JWT_SECRET),
  roleRequired('customer', 'courier', 'admin'),
  upload.single('image'),
  async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'Файл изображения обязателен' });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${baseUrl}/uploads/${file.filename}`;
    return res.status(201).json({ imageUrl });
  }
);

app.get('/api/couriers/me', authRequired(JWT_SECRET), roleRequired('courier', 'admin'), async (req, res) => {
  const courierRow = (await db.query(
    `
      SELECT c.*, u.full_name as reviewed_by_name
      FROM couriers c
      LEFT JOIN users u ON u.id = c.verification_reviewed_by
      WHERE c.user_id = $1
      LIMIT 1
    `,
    [req.user!.id]
  )).rows[0];
  if (!courierRow) return res.status(404).json({ message: 'Профиль курьера не найден' });

  return res.json({
    courier: {
      id: toNumber(courierRow.id),
      userId: toNumber(courierRow.user_id),
      vehicleType: courierRow.vehicle_type,
      status: courierRow.status,
      verificationStatus: courierRow.verification_status,
      transportLicense: courierRow.transport_license,
      vehicleRegistrationNumber: courierRow.vehicle_registration_number,
      techPassportImageUrl: courierRow.tech_passport_image_url,
      verificationComment: courierRow.verification_comment,
      verificationRequestedAt: courierRow.verification_requested_at ? toDateString(courierRow.verification_requested_at) : null,
      verificationReviewedBy: courierRow.reviewed_by_name || null,
      verifiedAt: courierRow.verified_at ? toDateString(courierRow.verified_at) : null,
      isEligible: courierEligible(courierRow)
    }
  });
});

app.patch('/api/couriers/me/verification', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const body = req.body as {
    vehicleType?: string;
    transportLicense?: string;
    vehicleRegistrationNumber?: string;
    techPassportImageUrl?: string;
  };

  const courierRow = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courierRow) return res.status(404).json({ message: 'Профиль курьера не найден' });

  const vehicleType = String(body.vehicleType ?? courierRow.vehicle_type ?? '').trim();
  const transportLicense = String(body.transportLicense ?? courierRow.transport_license ?? '').trim();
  const vehicleRegistrationNumber = String(body.vehicleRegistrationNumber ?? courierRow.vehicle_registration_number ?? '').trim();
  const techPassportImageUrl = String(body.techPassportImageUrl ?? courierRow.tech_passport_image_url ?? '').trim();

  if (!vehicleType || !transportLicense || !vehicleRegistrationNumber || !techPassportImageUrl) {
    return res.status(400).json({ message: 'Нужно указать транспорт, права/лицензию, госномер и фото техпаспорта' });
  }

  const updated = (await db.query(
    `
      UPDATE couriers
      SET vehicle_type = $1,
          transport_license = $2,
          vehicle_registration_number = $3,
          tech_passport_image_url = $4,
          verification_status = 'submitted',
          verification_comment = NULL,
          verification_requested_at = NOW(),
          verification_reviewed_by = NULL,
          verified_at = NULL
      WHERE id = $5
      RETURNING *
    `,
    [vehicleType, transportLicense, vehicleRegistrationNumber, techPassportImageUrl, toNumber(courierRow.id)]
  )).rows[0];

  return res.json({
    courier: {
      id: toNumber(updated.id),
      userId: toNumber(updated.user_id),
      vehicleType: updated.vehicle_type,
      status: updated.status,
      verificationStatus: updated.verification_status,
      transportLicense: updated.transport_license,
      vehicleRegistrationNumber: updated.vehicle_registration_number,
      techPassportImageUrl: updated.tech_passport_image_url,
      verificationComment: updated.verification_comment,
      verificationRequestedAt: updated.verification_requested_at ? toDateString(updated.verification_requested_at) : null,
      verificationReviewedBy: null,
      verifiedAt: updated.verified_at ? toDateString(updated.verified_at) : null,
      isEligible: courierEligible(updated)
    }
  });
});

app.get('/api/admin/users', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  if (!(await requireAdminPermission(_req, res, 'manage_users'))) return;
  const rows = (await db.query(
    `
      SELECT id, full_name, email, phone, address, role, is_active, permissions, created_at
      FROM users
      ORDER BY id DESC
    `
  )).rows;

  return res.json({
    users: rows.map((row: any) => ({
      id: toNumber(row.id),
      fullName: String(row.full_name),
      email: String(row.email),
      phone: row.phone,
      address: row.address,
      role: row.role,
      isActive: row.is_active !== false,
      permissions: Array.isArray(row.permissions) ? row.permissions.map((p: unknown) => String(p)) : [],
      createdAt: toDateString(row.created_at)
    }))
  });
});

app.post('/api/admin/users/:userId/reset-password', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_users'))) return;
  const userId = Number(req.params.userId);
  const newPassword = String((req.body as { newPassword?: string }).newPassword || '');
  if (!userId) return res.status(400).json({ message: 'Некорректный userId' });
  if (newPassword.length < 8) return res.status(400).json({ message: 'Пароль должен быть минимум 8 символов' });

  const hash = bcrypt.hashSync(newPassword, 10);
  const updated = (await db.query(
    `
      UPDATE users
      SET password_hash = $1,
          session_version = session_version + 1
      WHERE id = $2
      RETURNING id
    `,
    [hash, userId]
  )).rows[0];
  if (!updated) return res.status(404).json({ message: 'Пользователь не найден' });

  await logAdminAction(req.user!.id, 'user.reset_password', 'user', userId, null);
  return res.json({ message: 'Пароль сброшен администратором' });
});

app.patch('/api/admin/users/:userId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_users'))) return;
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Некорректный userId' });

  const body = req.body as { role?: UserRole; isActive?: boolean; permissions?: string[] };
  const allowedRoles: UserRole[] = ['customer', 'courier', 'admin'];
  if (body.role !== undefined && !allowedRoles.includes(body.role)) {
    return res.status(400).json({ message: 'Недопустимая роль пользователя' });
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive должен быть boolean' });
  }

  const existing = await getUserById(userId);
  if (!existing) return res.status(404).json({ message: 'Пользователь не найден' });
  if (isSystemAdmin(existing)) {
    return res.status(403).json({ message: 'Системного администратора нельзя редактировать' });
  }

  const nextRole = body.role ?? existing.role;
  const nextIsActive = body.isActive ?? existing.is_active;
  const currentAdmin = await getUserById(req.user!.id);
  const canManagePermissions = Boolean(currentAdmin && isSystemAdmin(currentAdmin));
  if (body.permissions !== undefined && !canManagePermissions) {
    return res.status(403).json({ message: 'Только системный администратор может менять права сотрудников' });
  }
  const nextPermissions = body.permissions !== undefined ? normalizePermissions(body.permissions) : existing.permissions;

  if (existing.id === req.user!.id) {
    if (!nextIsActive) return res.status(400).json({ message: 'Нельзя заблокировать самого себя' });
    if (nextRole !== 'admin') return res.status(400).json({ message: 'Нельзя снять роль admin у самого себя' });
  }

  const updatedRow = (await db.query(
    `
      UPDATE users
      SET role = $1,
          is_active = $2,
          session_version = session_version + 1,
          permissions = $4
      WHERE id = $3
      RETURNING *
    `,
    [nextRole, nextIsActive, userId, nextPermissions]
  )).rows[0];

  if (nextRole === 'courier') {
    await getOrCreateCourierForUser(userId);
  } else if (existing.role === 'courier') {
    await db.query("UPDATE couriers SET status = 'offline' WHERE user_id = $1", [userId]);
  }

  await logAdminAction(req.user!.id, 'user.update', 'user', userId, {
    role: { from: existing.role, to: nextRole },
    isActive: { from: existing.is_active, to: nextIsActive },
    permissions: { from: existing.permissions, to: nextPermissions }
  });

  return res.json({ user: publicUser(normalizeUserRow(updatedRow)) });
});

app.post('/api/admin/users/:userId/force-logout', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_users'))) return;
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Некорректный userId' });

  const existing = await getUserById(userId);
  if (!existing) return res.status(404).json({ message: 'Пользователь не найден' });
  if (isSystemAdmin(existing)) {
    return res.status(403).json({ message: 'Нельзя завершить сессии системного администратора' });
  }

  await db.query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [userId]);
  await logAdminAction(req.user!.id, 'user.force_logout', 'user', userId, null);

  return res.json({ message: 'Все сессии пользователя завершены' });
});

app.delete('/api/admin/users/:userId', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_users'))) return;
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Некорректный userId' });
  if (userId === req.user!.id) return res.status(400).json({ message: 'Нельзя удалить самого себя' });

  const existing = await getUserById(userId);
  if (!existing) return res.status(404).json({ message: 'Пользователь не найден' });
  if (isSystemAdmin(existing)) {
    return res.status(403).json({ message: 'Системного администратора нельзя удалить' });
  }

  await db.query('DELETE FROM users WHERE id = $1', [userId]);
  await logAdminAction(req.user!.id, 'user.delete', 'user', userId, {
    email: existing.email,
    role: existing.role
  });
  return res.json({ message: 'Пользователь удален' });
});

app.post('/api/admin/staff', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  const adminUser = await getUserById(req.user!.id);
  if (!adminUser || !isSystemAdmin(adminUser)) {
    return res.status(403).json({ message: 'Только системный администратор может создавать сотрудников' });
  }

  const body = req.body as {
    fullName?: string;
    email?: string;
    password?: string;
    phone?: string;
    address?: string;
    permissions?: string[];
  };
  const fullName = String(body.fullName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!fullName || !email || password.length < 8) {
    return res.status(400).json({ message: 'Нужны fullName, email и пароль минимум 8 символов' });
  }

  const existingUser = await getUserByEmail(email);
  if (existingUser) return res.status(409).json({ message: 'Пользователь с таким email уже существует' });

  const permissions = normalizePermissions(body.permissions);
  const hash = bcrypt.hashSync(password, 10);
  const createdRow = (await db.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role, permissions)
      VALUES ($1, $2, $3, $4, $5, 'admin', $6)
      RETURNING *
    `,
    [fullName, email, body.phone?.trim() || null, body.address?.trim() || null, hash, permissions]
  )).rows[0];
  const created = normalizeUserRow(createdRow);

  await logAdminAction(req.user!.id, 'staff.create', 'user', created.id, {
    email: created.email,
    permissions: created.permissions
  });

  return res.status(201).json({ user: publicUser(created) });
});

app.get('/api/admin/audit-logs', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'view_audit'))) return;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const rows = (await db.query(
    `
      SELECT l.id,
             l.action,
             l.entity_type,
             l.entity_id,
             l.details,
             l.created_at,
             u.id AS admin_id,
             u.full_name AS admin_full_name,
             u.email AS admin_email
      FROM admin_audit_logs l
      LEFT JOIN users u ON u.id = l.admin_user_id
      ORDER BY l.id DESC
      LIMIT $1
    `,
    [limit]
  )).rows;

  return res.json({
    logs: rows.map((row: any) => ({
      id: toNumber(row.id),
      action: String(row.action),
      entityType: String(row.entity_type),
      entityId: row.entity_id === null ? null : toNumber(row.entity_id),
      details: row.details ?? null,
      createdAt: toDateString(row.created_at),
      admin: row.admin_id
        ? {
            id: toNumber(row.admin_id),
            fullName: String(row.admin_full_name || ''),
            email: String(row.admin_email || '')
          }
        : null
    }))
  });
});

app.get('/api/admin/search', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'search_db'))) return;
  const q = String(req.query.q || '').trim();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 10;
  if (q.length < 2) {
    return res.json({
      query: q,
      suggestions: [] as string[],
      results: {
        users: [] as any[],
        products: [] as any[],
        orders: [] as any[],
        couriers: [] as any[]
      }
    });
  }

  const like = `%${q}%`;
  const prefix = `${q}%`;

  const [usersRows, productsRows, ordersRows, couriersRows, suggestionRows] = await Promise.all([
    db.query(
      `
        SELECT id, full_name, email, phone, role, is_active
        FROM users
        WHERE full_name ILIKE $1
           OR email ILIKE $1
           OR COALESCE(phone, '') ILIKE $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [like, limit]
    ),
    db.query(
      `
        SELECT id, name, category, price, in_stock
        FROM products
        WHERE name ILIKE $1
           OR COALESCE(description, '') ILIKE $1
           OR COALESCE(category, '') ILIKE $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [like, limit]
    ),
    db.query(
      `
        SELECT id, user_id, status, total, delivery_address, assigned_courier_id
        FROM orders
        WHERE delivery_address ILIKE $1
           OR status ILIKE $1
           OR CAST(id AS TEXT) ILIKE $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [like, limit]
    ),
    db.query(
      `
        SELECT c.id, c.user_id, c.vehicle_type, c.status, c.verification_status, u.full_name, u.email
        FROM couriers c
        JOIN users u ON u.id = c.user_id
        WHERE COALESCE(c.vehicle_type, '') ILIKE $1
           OR c.status ILIKE $1
           OR c.verification_status ILIKE $1
           OR u.full_name ILIKE $1
           OR u.email ILIKE $1
        ORDER BY c.id DESC
        LIMIT $2
      `,
      [like, limit]
    ),
    db.query(
      `
        SELECT value
        FROM (
          SELECT full_name AS value FROM users WHERE full_name ILIKE $1
          UNION ALL
          SELECT email AS value FROM users WHERE email ILIKE $1
          UNION ALL
          SELECT name AS value FROM products WHERE name ILIKE $1
          UNION ALL
          SELECT category AS value FROM products WHERE category IS NOT NULL AND category ILIKE $1
          UNION ALL
          SELECT delivery_address AS value FROM orders WHERE delivery_address ILIKE $1
        ) s
        WHERE value IS NOT NULL
        LIMIT 25
      `,
      [prefix]
    )
  ]);

  const suggestions = Array.from(
    new Set(
      suggestionRows.rows
        .map((row: any) => String(row.value || '').trim())
        .filter((v: string) => v.length > 0)
    )
  ).slice(0, 10);

  return res.json({
    query: q,
    suggestions,
    results: {
      users: usersRows.rows.map((row: any) => ({
        id: toNumber(row.id),
        fullName: String(row.full_name),
        email: String(row.email),
        phone: row.phone ?? null,
        role: row.role,
        isActive: row.is_active !== false
      })),
      products: productsRows.rows.map((row: any) => ({
        id: toNumber(row.id),
        name: String(row.name),
        category: row.category ?? null,
        price: Number(row.price),
        inStock: row.in_stock !== false,
        stockQuantity: Math.max(0, toNumber(row.stock_quantity ?? 0))
      })),
      orders: ordersRows.rows.map((row: any) => ({
        id: toNumber(row.id),
        userId: toNumber(row.user_id),
        status: String(row.status),
        total: Number(row.total),
        deliveryAddress: String(row.delivery_address),
        assignedCourierId: row.assigned_courier_id === null ? null : toNumber(row.assigned_courier_id)
      })),
      couriers: couriersRows.rows.map((row: any) => ({
        id: toNumber(row.id),
        userId: toNumber(row.user_id),
        fullName: String(row.full_name),
        email: String(row.email),
        vehicleType: row.vehicle_type ?? null,
        status: String(row.status),
        verificationStatus: String(row.verification_status)
      }))
    }
  });
});

app.get('/api/admin/analytics', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'view_analytics'))) return;

  const [totalsRes, rangeRes, dailyRes, topProductsRes, topLocalitiesRes] = await Promise.all([
    db.query(
      `
        SELECT
          COUNT(*)::text AS orders_total,
          COUNT(*) FILTER (WHERE status = 'pending')::text AS pending_count,
          COUNT(*) FILTER (WHERE status = 'assigned')::text AS assigned_count,
          COUNT(*) FILTER (WHERE status = 'picked_up')::text AS picked_up_count,
          COUNT(*) FILTER (WHERE status = 'on_the_way')::text AS on_the_way_count,
          COUNT(*) FILTER (WHERE status = 'delivered')::text AS delivered_count,
          COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled_count,
          COALESCE(SUM(total), 0)::text AS revenue_total,
          COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0)::text AS delivered_revenue,
          COALESCE(AVG(total), 0)::text AS avg_check
        FROM orders
      `
    ),
    db.query(
      `
        SELECT
          COUNT(*)::text AS orders_30d,
          COALESCE(SUM(total), 0)::text AS revenue_30d,
          COALESCE(AVG(total), 0)::text AS avg_check_30d
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `
    ),
    db.query(
      `
        SELECT
          TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
          COUNT(*)::text AS orders_count,
          COALESCE(SUM(total), 0)::text AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY 1
        ORDER BY 1
      `
    ),
    db.query(
      `
        SELECT
          oi.product_name,
          SUM(oi.quantity)::text AS qty,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'delivered'
        GROUP BY oi.product_name
        ORDER BY SUM(oi.quantity) DESC, oi.product_name ASC
        LIMIT 10
      `
    ),
    db.query(
      `
        SELECT
          TRIM(SPLIT_PART(delivery_address, ',', 1)) AS locality,
          COUNT(*)::text AS orders_count,
          COALESCE(SUM(total), 0)::text AS revenue
        FROM orders
        GROUP BY 1
        ORDER BY COUNT(*) DESC, locality ASC
        LIMIT 10
      `
    )
  ]);

  const totals = totalsRes.rows[0] || {};
  const range = rangeRes.rows[0] || {};

  return res.json({
    totals: {
      ordersTotal: Number(totals.orders_total || 0),
      pendingCount: Number(totals.pending_count || 0),
      assignedCount: Number(totals.assigned_count || 0),
      pickedUpCount: Number(totals.picked_up_count || 0),
      onTheWayCount: Number(totals.on_the_way_count || 0),
      deliveredCount: Number(totals.delivered_count || 0),
      cancelledCount: Number(totals.cancelled_count || 0),
      revenueTotal: Number(totals.revenue_total || 0),
      deliveredRevenue: Number(totals.delivered_revenue || 0),
      avgCheck: Number(totals.avg_check || 0)
    },
    range30d: {
      orders: Number(range.orders_30d || 0),
      revenue: Number(range.revenue_30d || 0),
      avgCheck: Number(range.avg_check_30d || 0)
    },
    daily14d: dailyRes.rows.map((row: any) => ({
      day: String(row.day),
      orders: Number(row.orders_count || 0),
      revenue: Number(row.revenue || 0)
    })),
    topProducts: topProductsRes.rows.map((row: any) => ({
      productName: String(row.product_name),
      quantity: Number(row.qty || 0),
      revenue: Number(row.revenue || 0)
    })),
    topLocalities: topLocalitiesRes.rows.map((row: any) => ({
      locality: String(row.locality || '').trim() || 'Не указано',
      orders: Number(row.orders_count || 0),
      revenue: Number(row.revenue || 0)
    }))
  });
});

app.patch('/api/admin/couriers/:courierId/verification', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_couriers'))) return;
  const courierId = Number(req.params.courierId);
  const body = req.body as { status?: string; comment?: string };
  if (!courierId) return res.status(400).json({ message: 'Некорректный courierId' });
  if (!body.status || !['approved', 'rejected'].includes(body.status)) {
    return res.status(400).json({ message: 'status должен быть approved или rejected' });
  }

  const existing = (await db.query('SELECT * FROM couriers WHERE id = $1 LIMIT 1', [courierId])).rows[0];
  if (!existing) return res.status(404).json({ message: 'Курьер не найден' });

  const reviewComment = body.comment ? String(body.comment).trim() : null;
  const reviewed = (await db.query(
    `
      UPDATE couriers
      SET verification_status = $1,
          verification_comment = $2,
          verification_reviewed_by = $3,
          verified_at = NOW()
      WHERE id = $4
      RETURNING *
    `,
    [body.status, reviewComment, req.user!.id, courierId]
  )).rows[0];

  await logAdminAction(req.user!.id, 'courier.verification_review', 'courier', courierId, {
    status: body.status,
    comment: reviewComment
  });

  return res.json({
    courier: {
      id: toNumber(reviewed.id),
      userId: toNumber(reviewed.user_id),
      verificationStatus: reviewed.verification_status,
      verificationComment: reviewed.verification_comment,
      verifiedAt: reviewed.verified_at ? toDateString(reviewed.verified_at) : null,
      isEligible: courierEligible(reviewed)
    }
  });
});

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
  const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
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
  const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
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
  if (!courierEligible(courierRow)) {
    return res.status(403).json({ message: 'Курьер не верифицирован. Добавьте данные транспорта и фото техпаспорта.' });
  }
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
  if (!(await requireAdminPermission(_req, res, 'view_orders'))) return;
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
    const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    const courierAllowed = ['picked_up', 'on_the_way', 'delivered'];
    if (!courier || order.assigned_courier_id !== toNumber(courier.id) || !courierAllowed.includes(status)) {
      return res.status(403).json({ message: 'Заказ не назначен этому курьеру или статус запрещен' });
    }
    if (!courierEligible(courier)) {
      return res.status(403).json({ message: 'Курьер не верифицирован. Смена статуса недоступна.' });
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
    if (!(await requireAdminPermission(req, res, 'manage_couriers'))) return;
    targetUserId = Number(body.userId);
  }

  const targetUser = await getUserById(targetUserId);
  if (!targetUser) return res.status(404).json({ message: 'Пользователь не найден' });

  if (targetUser.role !== 'courier') {
    await db.query("UPDATE users SET role = 'courier' WHERE id = $1", [targetUser.id]);
  }

  const courier = await getOrCreateCourierForUser(targetUser.id);
  const nextStatus = ['offline', 'available', 'busy'].includes(body.status || '') ? body.status! : 'available';
  if (nextStatus === 'available' && !courierEligible(courier)) {
    return res.status(403).json({ message: 'Сначала пройдите верификацию курьера: транспорт, права и фото техпаспорта' });
  }

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
  if (!(await requireAdminPermission(_req, res, 'manage_couriers'))) return;
  const rows = (await db.query(
    `
      SELECT c.*, u.full_name, u.email, u.phone, r.full_name as reviewed_by_name
      FROM couriers c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN users r ON r.id = c.verification_reviewed_by
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
      verificationStatus: row.verification_status,
      transportLicense: row.transport_license,
      vehicleRegistrationNumber: row.vehicle_registration_number,
      techPassportImageUrl: row.tech_passport_image_url,
      verificationComment: row.verification_comment,
      verificationRequestedAt: row.verification_requested_at ? toDateString(row.verification_requested_at) : null,
      verificationReviewedBy: row.reviewed_by_name || null,
      verifiedAt: row.verified_at ? toDateString(row.verified_at) : null,
      isEligible: courierEligible(row),
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
