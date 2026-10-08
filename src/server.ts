import 'dotenv/config';
import path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Server as NetServer } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import multer from 'multer';
import morgan from 'morgan';
import type { Pool, PoolClient } from 'pg';
import { authRequired, buildToken, roleRequired, setAuthUserResolver } from './auth';
import { connectDb } from './db';
import { HttpError } from './http-error';
import { migrateMerchantProducts, type MerchantProductsMigrationStage } from './merchant-product-migration';
import { createCorsMiddleware, createIpRateLimiter, parseCorsAllowlist, securityHeaders } from './security';
import { TenantDbResolver } from './tenant-db';
import {
  consumePickTaskReservations,
  inventoryConsistencyReport,
  postSingleStockOperation,
  recordOrderReservation,
  releaseManualReservation,
  releaseOrderReservations
} from './inventory-service';
import {
  cancelInventoryDocument,
  createInventoryDraft,
  getInventoryDocument,
  inventoryValuationReport,
  listInventoryDocuments,
  postInventoryDocument,
  updateInventoryDraft,
  type DraftInput
} from './inventory-documents';
import type { ApiOrder, DbOrder, DbUser, PublicUser, UserRole } from './types';
import { validateBody, validateParams } from './validation';
import { loginBodySchema, registerBodySchema, verificationConfirmBodySchema, verificationRequestBodySchema } from './validation/schemas/auth';
import { cartAddItemBodySchema, cartItemParamsSchema, cartUpdateItemBodySchema } from './validation/schemas/cart';
import { createOrderBodySchema, orderIdParamsSchema, updateOrderStatusBodySchema } from './validation/schemas/orders';
import { updateMeBodySchema } from './validation/schemas/users';
import { accessibleStoreIds, accessibleWarehouseIds, hasStoreAccess, warehouseOperational } from './network-access';

const PORT = Number(process.env.PORT || 4000);
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
function readAppSecret(name: string, fallback: string) {
  const value = String(process.env[name] || '').trim();
  if (value && value !== fallback) return value;
  if (NODE_ENV === 'production') {
    throw new Error(`Environment variable ${name} must be configured with a secure value in production`);
  }
  return value || fallback;
}
const JWT_SECRET = readAppSecret('JWT_SECRET', 'change_me_super_secret');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://supermarket:supermarket_dev_password@localhost:55432/supermarket';
const MAP_DATABASE_URL = process.env.MAP_DATABASE_URL || 'postgresql://map:mappass@localhost:5434/mapdb';
const ADMIN_PERMISSIONS = [
  'view_orders',
  'manage_orders',
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
const DGIS_GEOCODER_API_KEY = process.env.DGIS_GEOCODER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini';
const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mockpay';
const PAYMENT_WEBHOOK_SECRET = readAppSecret('PAYMENT_WEBHOOK_SECRET', 'dev_payment_webhook_secret_change_me');
const VERIFICATION_CODE_SECRET = readAppSecret('VERIFICATION_CODE_SECRET', 'dev_verification_code_secret_change_me');
const CORS_ORIGIN_ALLOWLIST = parseCorsAllowlist(process.env.CORS_ORIGIN_ALLOWLIST);
const COURIER_ONLINE_TTL_MS = 5 * 60 * 1000; // 5 минут считаем онлайн
const VERIFICATION_CODE_EXPIRES_MS = 10 * 60 * 1000;
const VERIFICATION_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const VERIFICATION_CODE_MAX_ATTEMPTS = 5;
const VERIFICATION_CODE_LOCK_MINUTES = 10;
const ORDER_STATUS = {
  assembling: 'assembling',
  courierAssigned: 'courier_assigned',
  courierPicked: 'courier_picked',
  onTheWay: 'on_the_way',
  arrived: 'arrived',
  received: 'received',
  paid: 'paid',
  cancelled: 'cancelled'
} as const;
type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];
const CUSTOMER_EDITABLE_STATUSES: OrderStatus[] = [ORDER_STATUS.assembling, ORDER_STATUS.courierAssigned];
const MAX_UPLOAD_FILE_SIZE_BYTES = 12 * 1024 * 1024; // увеличили лимит до 12 МБ для мобильных фото

type OrderUpdateReason =
  | 'created'
  | 'status_changed'
  | 'address_changed'
  | 'courier_assigned'
  | 'courier_location'
  | 'picking_updated'
  | 'payment_updated'
  | 'deleted'
  | 'updated';
type OrderUpdateListener = (reason: OrderUpdateReason) => void;
const orderUpdateListeners = new Map<number, Set<OrderUpdateListener>>();

function subscribeOrderUpdates(orderId: number, listener: OrderUpdateListener) {
  const current = orderUpdateListeners.get(orderId) ?? new Set<OrderUpdateListener>();
  current.add(listener);
  orderUpdateListeners.set(orderId, current);
  return () => {
    const next = orderUpdateListeners.get(orderId);
    if (!next) return;
    next.delete(listener);
    if (next.size === 0) {
      orderUpdateListeners.delete(orderId);
    }
  };
}

function notifyOrderUpdated(orderId: number, reason: OrderUpdateReason = 'updated') {
  const listeners = orderUpdateListeners.get(orderId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener(reason);
    } catch (error) {
      console.warn(`Order update listener failed for #${orderId}:`, error);
    }
  }
}

async function notifyCourierOrdersUpdated(courierId: number, reason: OrderUpdateReason = 'courier_location') {
  const rows = (
    await db.query(
      `
        SELECT id
        FROM orders
        WHERE assigned_courier_id = $1
          AND status NOT IN ('paid', 'cancelled')
      `,
      [courierId]
    )
  ).rows as Array<{ id: number }>;
  for (const row of rows) {
    notifyOrderUpdated(toNumber(row.id), reason);
  }
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const inboundId = String(req.headers['x-request-id'] || '').trim();
  const requestId = inboundId || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'STORAGE_FULL'
  | 'INTERNAL_ERROR';

function mapErrorCode(statusCode: number): ApiErrorCode {
  if (statusCode === 400) return 'VALIDATION_ERROR';
  if (statusCode === 401) return 'AUTH_REQUIRED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 413) return 'PAYLOAD_TOO_LARGE';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode === 507) return 'STORAGE_FULL';
  return 'INTERNAL_ERROR';
}

function wrapAsyncHandler(handler: any) {
  if (typeof handler !== 'function') return handler;
  if (handler.length === 4) return handler;
  return function wrappedHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
    try {
      const maybePromise = handler(req, res, next);
      if (maybePromise && typeof maybePromise.then === 'function') {
        void maybePromise.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function wrapRouteArg(arg: any): any {
  if (Array.isArray(arg)) return arg.map((item) => wrapRouteArg(item));
  return wrapAsyncHandler(arg);
}

function patchAsyncRouteErrorHandling(targetApp: express.Application) {
  const methods = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
  for (const method of methods) {
    const original = (targetApp as any)[method].bind(targetApp);
    (targetApp as any)[method] = (...args: any[]) => {
      return original(...args.map((arg: any) => wrapRouteArg(arg)));
    };
  }
}

patchAsyncRouteErrorHandling(app);

const db: Pool = connectDb(DATABASE_URL);
const mapDb: Pool = connectDb(MAP_DATABASE_URL);
const tenantDbResolver = new TenantDbResolver(db);
let dbBootstrapError: Error | null = null;
let mapBootstrapError: Error | null = null;
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
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES }
});

const dbReady = db.query('SELECT 1').catch((error) => {
  dbBootstrapError = error instanceof Error ? error : new Error(String(error));
  console.error('DB bootstrap error:', dbBootstrapError);
});

const mapReady = (async () => {
  await mapDb.query(`
    CREATE TABLE IF NOT EXISTS public.delivery_zone_tariffs (
      zone_name TEXT PRIMARY KEY,
      base_fee NUMERIC(12,2) NOT NULL DEFAULT 1.50,
      per_km_fee NUMERIC(12,2) NOT NULL DEFAULT 0.35,
      min_fee NUMERIC(12,2) NOT NULL DEFAULT 1.50,
      max_fee NUMERIC(12,2) NOT NULL DEFAULT 25.00,
      eta_base_min INTEGER NOT NULL DEFAULT 20,
      eta_per_km_min NUMERIC(12,2) NOT NULL DEFAULT 5.00,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await mapDb.query(`
    INSERT INTO public.delivery_zone_tariffs (zone_name)
    SELECT dz.name
    FROM public.delivery_zones dz
    ON CONFLICT (zone_name) DO NOTHING;
  `);
})().catch((error) => {
  mapBootstrapError = error instanceof Error ? error : new Error(String(error));
  console.error('Map bootstrap warning:', mapBootstrapError);
});

const apiRateLimiter = createIpRateLimiter({
  windowMs: 60_000,
  max: 180,
  message: 'Слишком много запросов. Попробуйте снова через минуту.',
  keyPrefix: 'api',
  skip: (req) => req.path.startsWith('/api/health')
});
const authRateLimiter = createIpRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Слишком много попыток авторизации. Повторите позже.',
  keyPrefix: 'auth'
});

app.use(securityHeaders);
app.use(createCorsMiddleware({ allowlist: CORS_ORIGIN_ALLOWLIST }));
app.use('/api', apiRateLimiter);
const defaultJsonParser = express.json({ limit: '1mb' });
const webhookJsonParser = express.json({
  limit: '512kb',
  verify: (req: any, _res, buffer) => {
    req.rawBody = buffer.toString('utf8');
  }
});
app.use((req, res, next) => {
  if (req.path === '/api/payments/webhook') {
    return webhookJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadsDir));
app.use(async (_req, res, next) => {
  try {
    await dbReady;
    if (dbBootstrapError) {
      return res.status(500).json({
        message: 'Ошибка инициализации БД',
        ...(process.env.NODE_ENV !== 'production' ? { error: dbBootstrapError.message } : {})
      });
    }
    next();
  } catch (error) {
    console.error('DB bootstrap error:', error);
    res.status(500).json({
      message: 'Ошибка инициализации БД',
      ...(process.env.NODE_ENV !== 'production' && error instanceof Error ? { error: error.message } : {})
    });
  }
});

// Marketplace/delivery entry points are retained as historical code only and are
// not active in the standalone retail-network product.
app.use((req,res,next)=>{
  const disabled = req.path==='/api/auth/register' ||
    req.path.startsWith('/api/cart') || req.path.startsWith('/api/delivery/') ||
    req.path.startsWith('/api/couriers') || req.path.startsWith('/api/stores/my') ||
    req.path.startsWith('/api/stores/uploads') ||
    (req.path.startsWith('/api/orders') && !req.path.startsWith('/api/admin/'));
  if(disabled)return res.status(410).json({message:'Функция отключена: доставку и клиентские заказы обслуживает HARID24'});
  next();
});

function toNumber(value: unknown) {
  return Number(value);
}

function toDateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeUserRole(value: unknown): UserRole {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'owner' || raw === 'customer' || raw === 'courier' || raw === 'admin' || raw === 'picker') {
    return raw;
  }
  // Backward compatibility for legacy rows.
  if (raw === 'user') return 'customer';
  return 'customer';
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
    warehouseScopes: user.warehouse_scopes,
    emailVerifiedAt: user.email_verified_at ?? null,
    phoneVerifiedAt: user.phone_verified_at ?? null,
    createdAt: user.created_at
  };
}

function parseWarehouseScopes(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const result = Array.from(
    new Set(
      value
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.floor(n))
    )
  );
  return result.length ? result : null;
}

function normalizeUserRow(row: any): DbUser {
  return {
    id: toNumber(row.id),
    full_name: String(row.full_name),
    email: String(row.email),
    phone: row.phone ?? null,
    address: row.address ?? null,
    password_hash: String(row.password_hash),
    role: normalizeUserRole(row.role),
    is_active: row.is_active !== false,
    session_version: Number(row.session_version ?? 0),
    permissions: Array.isArray(row.permissions)
      ? row.permissions.map((p: unknown) => String(p))
      : [],
    warehouse_scopes: parseWarehouseScopes(row.warehouse_scopes),
    email_verified_at: row.email_verified_at ? toDateString(row.email_verified_at) : null,
    phone_verified_at: row.phone_verified_at ? toDateString(row.phone_verified_at) : null,
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
    serviceable: row.serviceable === null || row.serviceable === undefined ? null : Boolean(row.serviceable),
    delivery_zone: row.delivery_zone === null ? null : String(row.delivery_zone),
    fulfillment_warehouse: row.fulfillment_warehouse === null ? null : String(row.fulfillment_warehouse),
    fulfillment_warehouse_code: row.fulfillment_warehouse_code === null ? null : String(row.fulfillment_warehouse_code),
    warehouse_distance_km: row.warehouse_distance_km === null ? null : Number(row.warehouse_distance_km),
    route_distance_km: row.route_distance_km === null ? null : Number(row.route_distance_km),
    delivery_eta_min: row.delivery_eta_min === null ? null : Number(row.delivery_eta_min),
    delivery_fee: row.delivery_fee === null ? null : Number(row.delivery_fee),
    courier_fee: row.courier_fee === null ? null : Number(row.courier_fee),
    payment_method: row.payment_method === null ? null : String(row.payment_method),
    substitution_preference: row.substitution_preference === null || row.substitution_preference === undefined ? 'contact_me' : String(row.substitution_preference),
    substitution_note: row.substitution_note === null || row.substitution_note === undefined ? null : String(row.substitution_note),
    assigned_courier_id: row.assigned_courier_id === null ? null : Number(row.assigned_courier_id),
    created_at: toDateString(row.created_at),
    updated_at: toDateString(row.updated_at),
    customer_full_name: row.customer_full_name === undefined ? null : row.customer_full_name,
    customer_phone: row.customer_phone === undefined ? null : row.customer_phone,
    pick_task_status: row.pick_task_status === undefined ? null : row.pick_task_status,
    picker_id: row.picker_id === undefined || row.picker_id === null ? null : toNumber(row.picker_id),
    picker_name: row.picker_name === undefined ? null : row.picker_name
  };
}

type MerchantStoreStatus = 'pending' | 'approved' | 'rejected';
type MerchantCourierLinkStatus = 'pending' | 'approved' | 'rejected';

function normalizeMerchantStoreStatus(value: unknown): MerchantStoreStatus {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'approved') return 'approved';
  if (raw === 'rejected') return 'rejected';
  return 'pending';
}

function normalizeMerchantCourierLinkStatus(value: unknown): MerchantCourierLinkStatus {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'approved') return 'approved';
  if (raw === 'rejected') return 'rejected';
  return 'pending';
}

function normalizeVerificationChannel(value: unknown): 'email' | 'phone' | null {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'email') return 'email';
  if (raw === 'phone') return 'phone';
  return null;
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeTin(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '');
}

function isValidTin(value: string) {
  return /^\d{9,14}$/.test(value);
}

function isLikelyDocumentUrl(value: string) {
  if (!value) return false;
  return /^(\/uploads\/|https?:\/\/)/i.test(value);
}

function merchantStoreView(row: any) {
  return {
    id: toNumber(row.id),
    ownerUserId: toNumber(row.owner_user_id),
    name: String(row.name),
    logoUrl: row.logo_url ?? null,
    phone: String(row.phone),
    description: row.description ?? null,
    tin: row.tin ?? null,
    legalDocumentUrl: row.legal_document_url ?? null,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    status: normalizeMerchantStoreStatus(row.status),
    approvedByAdminId: row.approved_by_admin_id === null ? null : toNumber(row.approved_by_admin_id),
    approvedAt: row.approved_at ? toDateString(row.approved_at) : null,
    rejectionReason: row.rejection_reason ?? null,
    createdAt: toDateString(row.created_at),
    updatedAt: toDateString(row.updated_at)
  };
}

function merchantProductView(row: any) {
  return {
    id: toNumber(row.id),
    storeId: toNumber(row.store_id),
    name: String(row.name),
    description: row.description ?? null,
    price: Number(row.price),
    barcode: row.barcode ?? null,
    imageUrl: row.image_url ?? null,
    unit: row.unit ?? 'шт',
    inStock: row.in_stock !== false,
    stockQuantity: toNumber(row.stock_quantity ?? 0),
    createdAt: toDateString(row.created_at),
    updatedAt: toDateString(row.updated_at)
  };
}

function merchantCourierLinkView(row: any) {
  return {
    id: toNumber(row.id),
    storeId: toNumber(row.store_id),
    courierId: toNumber(row.courier_id),
    requestedByUserId: toNumber(row.requested_by_user_id),
    status: normalizeMerchantCourierLinkStatus(row.status),
    approvedByAdminId: row.approved_by_admin_id === null ? null : toNumber(row.approved_by_admin_id),
    approvedAt: row.approved_at ? toDateString(row.approved_at) : null,
    rejectionReason: row.rejection_reason ?? null,
    courierName: row.courier_name ?? null,
    courierEmail: row.courier_email ?? null,
    courierPhone: row.courier_phone ?? null,
    createdAt: toDateString(row.created_at),
    updatedAt: toDateString(row.updated_at)
  };
}

function tenantRoutingView(row: any) {
  const mode = String(row?.mode || '').trim().toLowerCase() === 'dedicated' ? 'dedicated' : 'shared';
  const dsnKey = row?.dsn_key ? String(row.dsn_key) : null;
  const dedicatedDatabaseUrl = row?.dedicated_database_url ? String(row.dedicated_database_url) : null;
  return {
    storeId: toNumber(row.store_id),
    mode,
    dsnKey,
    dedicatedDatabaseUrlSet: Boolean(dedicatedDatabaseUrl),
    createdAt: row.created_at ? toDateString(row.created_at) : null,
    updatedAt: row.updated_at ? toDateString(row.updated_at) : null
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

async function getMerchantStoreByOwner(userId: number) {
  const row = (await db.query('SELECT * FROM merchant_stores WHERE owner_user_id = $1 LIMIT 1', [userId])).rows[0];
  return row || null;
}

async function getMerchantStoreById(storeId: number) {
  const row = (await db.query('SELECT * FROM merchant_stores WHERE id = $1 LIMIT 1', [storeId])).rows[0];
  return row || null;
}

async function getTenantPoolByStoreId(storeId: number) {
  const resolved = await tenantDbResolver.resolveStorePool(storeId);
  return resolved.pool;
}

async function assertStoreOwnerAccess(req: express.Request, res: express.Response, storeId: number) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: 'Требуется авторизация' });
    return null;
  }
  const store = await getMerchantStoreById(storeId);
  if (!store) {
    res.status(404).json({ message: 'Точка не найдена' });
    return null;
  }
  if (toNumber(store.owner_user_id) !== userId) {
    res.status(403).json({ message: 'Нет доступа к этой точке' });
    return null;
  }
  return store;
}

async function getWarehouseIdByCode(client: Pool | PoolClient, code: string | null | undefined) {
  const safe = String(code || '').trim();
  if (!safe) return null;
  const row = (await client.query('SELECT id FROM warehouses WHERE lower(code) = lower($1) LIMIT 1', [safe])).rows[0];
  return row ? toNumber(row.id) : null;
}

async function findAvailablePickerId(client: Pool | PoolClient, warehouseId: number | null) {
  // Выбираем только свободного сборщика (без активных задач)
  const rows = (
    await client.query(
      `
        SELECT u.id,
               COALESCE(active_tasks.count, 0) AS active_count
        FROM users u
        LEFT JOIN (
          SELECT assigned_to AS picker_id, COUNT(*) AS count
          FROM pick_tasks
          WHERE status IN ('new','in_progress')
          GROUP BY assigned_to
        ) active_tasks ON active_tasks.picker_id = u.id
        WHERE u.role = 'picker'
          AND u.is_active = TRUE
          AND COALESCE(active_tasks.count, 0) = 0
        ORDER BY active_tasks.count ASC, u.id ASC
        LIMIT 1
      `
    )
  ).rows;
  if (!rows.length) return null;
  return toNumber(rows[0].id);
}

async function pickerHasAnotherActiveTask(
  client: Pool | PoolClient,
  pickerId: number,
  opts: { excludeTaskId?: number | null } = {}
) {
  const excludeTaskId = opts.excludeTaskId ? Number(opts.excludeTaskId) : null;
  const row = (
    await client.query(
      `
        SELECT id
        FROM pick_tasks
        WHERE assigned_to = $1
          AND status IN ('new', 'in_progress')
          AND ($2::bigint IS NULL OR id <> $2::bigint)
        LIMIT 1
      `,
      [pickerId, excludeTaskId]
    )
  ).rows[0];
  return row ? toNumber(row.id) : null;
}

async function createPickTaskInternal(
  client: PoolClient,
  orderId: number,
  warehouseId: number,
  creatorUserId: number,
  assignedTo: number | null
) {
  const activeTask = (
    await client.query(
      `
        SELECT id
        FROM pick_tasks
        WHERE order_id = $1
          AND status IN ('new', 'in_progress')
        LIMIT 1
      `,
      [orderId]
    )
  ).rows[0];
  if (activeTask) {
    return toNumber(activeTask.id);
  }

  const items = (
    await client.query(
      `
        SELECT product_id, product_name, quantity
        FROM order_items
        WHERE order_id = $1
        ORDER BY w.id ASC
      `,
      [orderId]
    )
  ).rows;
  if (!items.length) {
    throw new HttpError(400, 'У заказа нет позиций для сборки');
  }

  if (assignedTo) {
    const conflictTaskId = await pickerHasAnotherActiveTask(client, assignedTo);
    if (conflictTaskId) {
      throw new HttpError(409, `У сборщика уже есть активная задача #${conflictTaskId}`);
    }
  }

  const taskRow = (
    await client.query(
      `
        INSERT INTO pick_tasks (order_id, warehouse_id, status, assigned_to, created_by)
        VALUES ($1, $2, 'new', $3, $4)
        RETURNING id
      `,
      [orderId, warehouseId, assignedTo, creatorUserId]
    )
  ).rows[0];
  const taskId = toNumber(taskRow.id);

  for (const item of items) {
    const productId = toNumber(item.product_id);
    const requestedQty = toNumber(item.quantity);
    await client.query(
      `
        INSERT INTO pick_task_items (pick_task_id, product_id, product_name, requested_qty, picked_qty)
        VALUES ($1, $2, $3, $4, 0)
      `,
      [taskId, productId, String(item.product_name), requestedQty]
    );
  }

  await recordOrderReservation(client, {
    orderId,
    taskId,
    warehouseId,
    createdBy: creatorUserId,
    items: items.map((item: any) => ({
      productId: toNumber(item.product_id),
      productName: String(item.product_name),
      quantity: toNumber(item.quantity)
    }))
  });

  return taskId;
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
    role: normalizeUserRole(row.role),
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

type NotificationPayload = {
  userId: number;
  level?: 'info' | 'warning' | 'success';
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: number | null;
};

async function createNotification(payload: NotificationPayload) {
  if (!payload.userId || !payload.title.trim()) return;
  await db.query(
    `
      INSERT INTO notifications (user_id, level, title, body, entity_type, entity_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      payload.userId,
      payload.level || 'info',
      payload.title.trim(),
      payload.body ? payload.body.trim() : null,
      payload.entityType || null,
      payload.entityId ?? null
    ]
  );
}

async function createNotificationForAdmins(payload: Omit<NotificationPayload, 'userId'>) {
  const rows = (
    await db.query(
      `
        SELECT id
        FROM users
        WHERE role = 'admin' AND is_active = TRUE
      `
    )
  ).rows;
  await Promise.all(rows.map((row: any) => createNotification({ ...payload, userId: toNumber(row.id) })));
}

function isSystemAdmin(user: Pick<DbUser, 'role'>) {
  return user.role === 'owner';
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

async function getAdminWarehouseScopeIds(userId: number) {
  const user = await getUserById(userId);
  if (!user || !['owner','admin','picker'].includes(user.role)) return [] as number[];
  return accessibleWarehouseIds(db,userId);
}

async function sanitizeWarehouseScopes(input: unknown) {
  const parsed = parseWarehouseScopes(input);
  if (parsed === null) return null;
  if (!parsed.length) return null;
  const rows = (await db.query(
    `
      SELECT id
      FROM warehouses
      WHERE id = ANY($1::bigint[])
    `,
    [parsed]
  )).rows;
  const existing = new Set(rows.map((r: any) => toNumber(r.id)));
  const sanitized = parsed.filter((id) => existing.has(id));
  return sanitized.length ? sanitized : null;
}

function applyWarehouseScopeToQuery(
  baseWhere: string[],
  params: any[],
  allowedWarehouseIds: number[] | null,
  columnSql = 'warehouse_id'
) {
  if (allowedWarehouseIds === null) return;
  if (!allowedWarehouseIds.length) {
    baseWhere.push('1 = 0');
    return;
  }
  params.push(allowedWarehouseIds);
  baseWhere.push(`${columnSql} = ANY($${params.length}::bigint[])`);
}

async function assertWarehouseAccess(req: express.Request, res: express.Response, warehouseId: number) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: 'Требуется авторизация' });
    return false;
  }
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(userId);
  if (allowedWarehouseIds === null) return true;
  if (allowedWarehouseIds.includes(warehouseId)) return true;
  res.status(403).json({ message: 'Нет доступа к выбранному складу' });
  return false;
}

async function assertWarehouseOperation(req:express.Request,res:express.Response,warehouseId:number){
  if(!(await assertWarehouseAccess(req,res,warehouseId)))return false;
  if(!(await warehouseOperational(db,warehouseId))){res.status(409).json({message:'Склад не сопоставлен с активным супермаркетом; новые операции запрещены'});return false}
  return true;
}

async function adminHasPermission(userId: number, permission: AdminPermission) {
  const user = await getUserById(userId);
  if (!user || !['owner','admin'].includes(user.role)) return false;
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

async function requireChiefAdmin(req: express.Request, res: express.Response) {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ message: 'Требуется авторизация' });
    return false;
  }
  const user = await getUserById(userId);
  if (!user || user.role !== 'owner') {
    res.status(403).json({ message: 'Только владелец сети может выполнить это действие' });
    return false;
  }
  return true;
}

async function getOrCreateCourierForUser(userId: number) {
  let row = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [userId])).rows[0];
  if (!row) {
    await db.query(
      `
        INSERT INTO couriers (user_id, vehicle_type, status, verification_status, max_active_orders, last_seen_at)
        VALUES ($1, 'bike', 'offline', 'pending', 5, NOW())
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
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
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

function courierIsOnline(courier: { last_seen_at?: any }) {
  if (!courier?.last_seen_at) return false;
  const lastSeen = new Date(courier.last_seen_at).getTime();
  if (!Number.isFinite(lastSeen)) return false;
  return Date.now() - lastSeen <= COURIER_ONLINE_TTL_MS;
}

async function evaluateCourierCustomerRevert(userId: number, courierRow: any) {
  const activeOrders = await getActiveOrderCountForCourier(toNumber(courierRow.id));
  if (activeOrders > 0) {
    return {
      canRevertToCustomer: false,
      revertToCustomerReason: 'Сначала завершите или передайте активные доставки',
      merchantStoreStatus: null as MerchantStoreStatus | null
    };
  }

  const store = await getMerchantStoreByOwner(userId);
  const merchantStoreStatus = store ? normalizeMerchantStoreStatus(store.status) : null;
  const courierVerified = String(courierRow.verification_status || '').trim().toLowerCase() === 'approved';
  const sellerApproved = merchantStoreStatus === 'approved';

  if (courierVerified) {
    return {
      canRevertToCustomer: false,
      revertToCustomerReason: 'Переход назад доступен только для не верифицированных курьеров',
      merchantStoreStatus
    };
  }
  if (sellerApproved) {
    return {
      canRevertToCustomer: false,
      revertToCustomerReason: 'Переход назад недоступен: ваша точка продавца уже одобрена',
      merchantStoreStatus
    };
  }

  return {
    canRevertToCustomer: true,
    revertToCustomerReason: null as string | null,
    merchantStoreStatus
  };
}

async function getActiveOrderCountForCourier(courierId: number, client: Pool | PoolClient = db) {
  const row = (await client.query(
    `
      SELECT COUNT(*)::text as cnt
      FROM orders
      WHERE assigned_courier_id = $1
        AND status IN ('courier_assigned', 'courier_picked', 'on_the_way', 'arrived')
    `,
    [courierId]
  )).rows[0];
  return Number(row.cnt || '0');
}

async function assignCourierIfPossible(orderId: number) {
  const client = await db.connect();
  let selectedCourierId: number | null = null;
  let createdBy: number | null = null;
  try {
    await client.query('BEGIN');
    const orderRow = (
      await client.query(
        `
          SELECT id, user_id
          FROM orders
          WHERE id = $1
            AND status = $2
            AND assigned_courier_id IS NULL
          FOR UPDATE
          LIMIT 1
        `,
        [orderId, ORDER_STATUS.assembling]
      )
    ).rows[0];
    if (!orderRow) {
      await client.query('ROLLBACK');
      return null;
    }
    createdBy = toNumber(orderRow.user_id);

    const selectedCourier = (
      await client.query(
        `
          SELECT c.id, c.user_id
          FROM couriers c
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS active_count
            FROM orders o
            WHERE o.assigned_courier_id = c.id
              AND o.status IN ('courier_assigned', 'courier_picked', 'on_the_way', 'arrived')
          ) active ON TRUE
          WHERE c.status = 'available'
            AND c.verification_status = 'approved'
            AND c.transport_license IS NOT NULL AND btrim(c.transport_license) <> ''
            AND c.vehicle_registration_number IS NOT NULL AND btrim(c.vehicle_registration_number) <> ''
            AND c.tech_passport_image_url IS NOT NULL AND btrim(c.tech_passport_image_url) <> ''
            AND c.last_seen_at IS NOT NULL
            AND c.last_seen_at >= NOW() - INTERVAL '5 minutes'
            AND COALESCE(active.active_count, 0) < c.max_active_orders
          ORDER BY COALESCE(active.active_count, 0) ASC, c.id ASC
          FOR UPDATE OF c SKIP LOCKED
          LIMIT 1
        `
      )
    ).rows[0];
    if (!selectedCourier) {
      await client.query('COMMIT');
      return null;
    }

    const updatedOrder = (
      await client.query(
        `
          UPDATE orders
          SET assigned_courier_id = $1, status = $2, updated_at = NOW()
          WHERE id = $3
            AND status = $4
            AND assigned_courier_id IS NULL
          RETURNING id
        `,
        [toNumber(selectedCourier.id), ORDER_STATUS.courierAssigned, orderId, ORDER_STATUS.assembling]
      )
    ).rows[0];
    if (!updatedOrder) {
      await client.query('ROLLBACK');
      return null;
    }
    selectedCourierId = toNumber(selectedCourier.id);

    await client.query(
      'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
      [orderId, ORDER_STATUS.courierAssigned, 'Курьер назначен автоматически', createdBy]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!selectedCourierId) return null;

  if (createdBy) {
    await createNotification({
      userId: createdBy,
      level: 'info',
      title: `Курьер назначен на заказ #${orderId}`,
      body: 'Ожидайте прибытия курьера',
      entityType: 'order',
      entityId: orderId
    });
  }
  const courierUser = (await db.query('SELECT user_id FROM couriers WHERE id = $1 LIMIT 1', [selectedCourierId])).rows[0];
  if (courierUser?.user_id) {
    await createNotification({
      userId: toNumber(courierUser.user_id),
      level: 'info',
      title: `Новый назначенный заказ #${orderId}`,
      body: 'Откройте раздел доставок',
      entityType: 'order',
      entityId: orderId
    });
  }
  notifyOrderUpdated(orderId, 'courier_assigned');

  return selectedCourierId;
}

async function tryAssignOldestPendingOrder() {
  const pendingRow = (await db.query(
    `
      SELECT id
      FROM orders
      WHERE assigned_courier_id IS NULL
        AND status = $1
      ORDER BY id ASC
      LIMIT 1
    `,
    [ORDER_STATUS.assembling]
  )).rows[0];

  if (!pendingRow) return null;
  return assignCourierIfPossible(toNumber(pendingRow.id));
}

async function assignPickTaskIfPossible(taskId: number) {
  const taskRow = (await db.query('SELECT warehouse_id FROM pick_tasks WHERE id = $1 AND assigned_to IS NULL LIMIT 1', [taskId])).rows[0];
  if (!taskRow) return null;

  const warehouseId = toNumber(taskRow.warehouse_id);
  const pickerId = await findAvailablePickerId(db, warehouseId);
  if (!pickerId) return null;

  await db.query('UPDATE pick_tasks SET assigned_to = $1, status = $2 WHERE id = $3', [pickerId, 'in_progress', taskId]);
  return pickerId;
}

async function tryAssignOldestPendingPickTask() {
  const pendingRow = (await db.query(
    `
      SELECT id
      FROM pick_tasks
      WHERE assigned_to IS NULL
        AND status = 'new'
      ORDER BY id ASC
      LIMIT 1
    `
  )).rows[0];

  if (!pendingRow) return null;
  return assignPickTaskIfPossible(toNumber(pendingRow.id));
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
      WHERE id = $2
    `,
    [available, productId]
  );
}

function orderView(order: DbOrder): ApiOrder {
  const hasCoords = order.delivery_lat !== null && order.delivery_lat !== undefined && order.delivery_lng !== null && order.delivery_lng !== undefined;
  const routeUrl = hasCoords ? `https://www.google.com/maps/dir/?api=1&destination=${order.delivery_lat},${order.delivery_lng}` : null;
  return {
    id: order.id,
    userId: order.user_id,
    status: order.status,
    total: order.total,
    deliveryAddress: order.delivery_address,
    deliveryLat: order.delivery_lat,
    deliveryLng: order.delivery_lng,
    serviceable: order.serviceable,
    deliveryZone: order.delivery_zone,
    fulfillmentWarehouse: order.fulfillment_warehouse,
    fulfillmentWarehouseCode: order.fulfillment_warehouse_code,
    warehouseDistanceKm: order.warehouse_distance_km,
    routeDistanceKm: order.route_distance_km,
    deliveryEtaMin: order.delivery_eta_min,
    deliveryFee: order.delivery_fee,
    courierFee: order.courier_fee,
    paymentMethod: order.payment_method,
    substitutionPreference: order.substitution_preference ?? 'contact_me',
    substitutionNote: order.substitution_note ?? null,
    assignedCourierId: order.assigned_courier_id,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    customerName: order.customer_full_name ?? null,
    customerPhone: order.customer_phone ?? null,
    pickTaskStatus: order.pick_task_status ?? null,
    pickerId: order.picker_id ?? null,
    pickerName: order.picker_name ?? null,
    routeUrl
  };
}

function normalizeProductRow(row: any) {
  return {
    id: toNumber(row.id),
    name: row.name,
    description: row.description,
    price: Number(row.price),
    category: row.category,
    barcode: row.barcode ?? null,
    imageUrl: row.image_url,
    unit: row.unit ?? 'шт',
    inStock: Boolean(row.in_stock),
    stockQuantity: Math.max(0, toNumber(row.stock_quantity ?? 0)),
    homeWarehouseId: row.home_warehouse_id === null || row.home_warehouse_id === undefined ? null : toNumber(row.home_warehouse_id)
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

type DeliveryQuote = {
  hasCoordinates: boolean;
  inDeliveryZone: boolean | null;
  serviceable: boolean | null;
  zoneName: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  warehouseDistanceKm: number | null;
  routeDistanceKm: number | null;
  etaMin: number | null;
  deliveryFee: number | null;
  reason: string | null;
};

function round2(value: number) {
  return Number(value.toFixed(2));
}

type PaymentTxStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

function normalizePaymentStatus(value: unknown): PaymentTxStatus {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'succeeded') return 'succeeded';
  if (raw === 'failed') return 'failed';
  if (raw === 'cancelled') return 'cancelled';
  return 'pending';
}

function hashVerificationCode(code: string) {
  return createHmac('sha256', VERIFICATION_CODE_SECRET).update(code).digest('hex');
}

function verificationCodeMatches(stored: unknown, plainCode: string) {
  const raw = String(stored || '').trim();
  if (!raw) return false;
  const hashed = hashVerificationCode(plainCode);
  if (raw.length === hashed.length && safeEqualHex(raw, hashed)) return true;
  // Backward compatibility for older rows created before hashing rollout.
  return raw === plainCode;
}

function signWebhookPayload(payloadText: string) {
  return createHmac('sha256', PAYMENT_WEBHOOK_SECRET).update(payloadText).digest('hex');
}

function safeEqualHex(actualHex: string, expectedHex: string) {
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthKm * c;
}

function estimateRouteDistanceKm(straightDistanceKm: number) {
  // Approximation for city routing where road path > straight-line.
  return Math.max(straightDistanceKm * 1.25, straightDistanceKm);
}

type ZoneTariff = {
  zoneName: string;
  baseFee: number;
  perKmFee: number;
  minFee: number;
  maxFee: number;
  etaBaseMin: number;
  etaPerKmMin: number;
};

function estimateEtaByTariff(routeDistanceKm: number, tariff: ZoneTariff) {
  return Math.max(Math.round(tariff.etaBaseMin + routeDistanceKm * tariff.etaPerKmMin), 10);
}

function estimateDeliveryFeeByTariff(routeDistanceKm: number, tariff: ZoneTariff) {
  const raw = tariff.baseFee + routeDistanceKm * tariff.perKmFee;
  return round2(Math.min(Math.max(raw, tariff.minFee), tariff.maxFee));
}

function buildDemandFromRows(rows: Array<{ product_id?: number; quantity?: number }>) {
  const demand = new Map<number, number>();
  for (const row of rows) {
    const productId = Number(row.product_id || 0);
    const qty = Number(row.quantity || 0);
    if (!productId || qty <= 0) continue;
    demand.set(productId, (demand.get(productId) || 0) + qty);
  }
  return demand;
}

async function getUserCartDemand(userId: number) {
  const rows = (await db.query(
    `
      SELECT product_id, SUM(quantity)::int AS quantity
      FROM cart_items
      WHERE user_id = $1
      GROUP BY product_id
    `,
    [userId]
  )).rows as Array<{ product_id: number; quantity: number }>;
  return buildDemandFromRows(rows);
}

async function findBestWarehouseForDemand(deliveryLat: number, deliveryLng: number, demandByProduct: Map<number, number>) {
  const rows = (await db.query(
    `
      SELECT id, code, name, lat, lng
      FROM warehouses
      WHERE is_active = TRUE
        AND lat IS NOT NULL
        AND lng IS NOT NULL
      ORDER BY id ASC
    `
  )).rows;

  if (!rows.length) return null;

  const need = Array.from(demandByProduct.entries());
  const needCount = need.length;
  const scored: Array<{
    id: number;
    code: string;
    name: string;
    lat: number;
    lng: number;
    straightDistanceKm: number;
    coversAllDemand: boolean;
    coveredRatio: number;
    minAvailabilityRatio: number;
  }> = [];

  for (const row of rows) {
    const warehouseId = toNumber(row.id);
    const code = String(row.code || '');
    const name = String(row.name || '');
    const lat = Number(row.lat);
    const lng = Number(row.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    let coversAllDemand = true;
    let covered = 0;
    let minAvailabilityRatio = 1;

    if (needCount === 0) {
      coversAllDemand = true;
      covered = 0;
      minAvailabilityRatio = 1;
    } else {
      for (const [productId, requiredQty] of need) {
        const stockRow = (await db.query(
          `
            SELECT quantity, reserved_quantity
            FROM warehouse_stock
            WHERE warehouse_id = $1
              AND product_id = $2
            LIMIT 1
          `,
          [warehouseId, productId]
        )).rows[0];
        const qty = Number(stockRow?.quantity || 0);
        const reserved = Number(stockRow?.reserved_quantity || 0);
        const available = Math.max(qty - reserved, 0);
        if (available >= requiredQty) {
          covered += 1;
          const ratio = requiredQty > 0 ? available / requiredQty : 1;
          minAvailabilityRatio = Math.min(minAvailabilityRatio, ratio);
        } else {
          coversAllDemand = false;
          const ratio = requiredQty > 0 ? available / requiredQty : 0;
          minAvailabilityRatio = Math.min(minAvailabilityRatio, ratio);
        }
      }
    }

    const straightDistanceKm = haversineKm(deliveryLat, deliveryLng, lat, lng);
    scored.push({
      id: warehouseId,
      code,
      name,
      lat,
      lng,
      straightDistanceKm,
      coversAllDemand,
      coveredRatio: needCount === 0 ? 1 : covered / needCount,
      minAvailabilityRatio
    });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => {
    // 1) Полное покрытие лучше частичного
    if (a.coversAllDemand !== b.coversAllDemand) return a.coversAllDemand ? -1 : 1;
    // 2) Больше покрытие товаров
    if (a.coveredRatio !== b.coveredRatio) return b.coveredRatio - a.coveredRatio;
    // 3) Лучшая минимальная обеспеченность
    if (a.minAvailabilityRatio !== b.minAvailabilityRatio) return b.minAvailabilityRatio - a.minAvailabilityRatio;
    // 4) Ближе к клиенту
    return a.straightDistanceKm - b.straightDistanceKm;
  });
  return scored[0] || null;
}

async function getZoneTariffForPoint(deliveryLat: number, deliveryLng: number): Promise<{
  inZone: boolean;
  tariff: ZoneTariff | null;
}> {
  const pointSql = 'ST_SetSRID(ST_Point($1, $2), 4326)';
  const row = (await mapDb.query(
    `
      SELECT
        dz.name AS zone_name,
        t.base_fee,
        t.per_km_fee,
        t.min_fee,
        t.max_fee,
        t.eta_base_min,
        t.eta_per_km_min
      FROM public.delivery_zones dz
      LEFT JOIN public.delivery_zone_tariffs t
        ON lower(t.zone_name) = lower(dz.name)
       AND t.is_active = TRUE
      WHERE ST_Contains(dz.geom, ${pointSql})
      ORDER BY ST_Area(dz.geom::geography) ASC
      LIMIT 1
    `,
    [deliveryLng, deliveryLat]
  )).rows[0];

  if (!row) return { inZone: false, tariff: null };

  const tariff: ZoneTariff = {
    zoneName: String(row.zone_name || ''),
    baseFee: Number(row.base_fee ?? 1.5),
    perKmFee: Number(row.per_km_fee ?? 0.35),
    minFee: Number(row.min_fee ?? 1.5),
    maxFee: Number(row.max_fee ?? 25),
    etaBaseMin: Number(row.eta_base_min ?? 20),
    etaPerKmMin: Number(row.eta_per_km_min ?? 5)
  };

  return { inZone: true, tariff };
}

async function buildDeliveryQuote(
  deliveryLat: number | null,
  deliveryLng: number | null,
  demandByProduct: Map<number, number>
): Promise<DeliveryQuote> {
  if (deliveryLat === null || deliveryLng === null) {
    return {
      hasCoordinates: false,
      inDeliveryZone: null,
      serviceable: null,
      zoneName: null,
      warehouseCode: null,
      warehouseName: null,
      warehouseDistanceKm: null,
      routeDistanceKm: null,
      etaMin: null,
      deliveryFee: null,
      reason: 'Нет координат точки доставки'
    };
  }

  try {
    await mapReady;
    const zoneResult = await getZoneTariffForPoint(deliveryLat, deliveryLng);
    const inDeliveryZone = zoneResult.inZone;
    if (!inDeliveryZone) {
      // Fallback: если зона не настроена, но есть склад с координатами – обслуживаем ближайшим складом.
      const fallbackWarehouse = await findBestWarehouseForDemand(deliveryLat, deliveryLng, demandByProduct);
      if (fallbackWarehouse) {
        const straightKm = Math.max(fallbackWarehouse.straightDistanceKm, 0);
        const routeKm = estimateRouteDistanceKm(straightKm);
        return {
          hasCoordinates: true,
          inDeliveryZone: false,
          serviceable: true,
          zoneName: 'Вне зоны (ближайший склад)',
          warehouseCode: fallbackWarehouse.code,
          warehouseName: fallbackWarehouse.name,
          warehouseDistanceKm: Number(straightKm.toFixed(3)),
          routeDistanceKm: Number(routeKm.toFixed(3)),
          etaMin: null,
          deliveryFee: null,
          reason: null
        };
      }

      return {
        hasCoordinates: true,
        inDeliveryZone: false,
        serviceable: false,
        zoneName: null,
        warehouseCode: null,
        warehouseName: null,
        warehouseDistanceKm: null,
        routeDistanceKm: null,
        etaMin: null,
        deliveryFee: null,
        reason: 'Точка вне зоны доставки'
      };
    }

    const selectedWarehouse = await findBestWarehouseForDemand(deliveryLat, deliveryLng, demandByProduct);
    if (!selectedWarehouse) {
      return {
        hasCoordinates: true,
        inDeliveryZone: true,
        serviceable: false,
        zoneName: zoneResult.tariff?.zoneName || null,
        warehouseCode: null,
        warehouseName: null,
        warehouseDistanceKm: null,
        routeDistanceKm: null,
        etaMin: null,
        deliveryFee: null,
        reason: 'Нет доступного склада'
      };
    }

    if (!selectedWarehouse.coversAllDemand) {
      return {
        hasCoordinates: true,
        inDeliveryZone: true,
        serviceable: false,
        zoneName: zoneResult.tariff?.zoneName || null,
        warehouseCode: selectedWarehouse.code,
        warehouseName: selectedWarehouse.name,
        warehouseDistanceKm: Number(selectedWarehouse.straightDistanceKm.toFixed(3)),
        routeDistanceKm: Number(estimateRouteDistanceKm(selectedWarehouse.straightDistanceKm).toFixed(3)),
        etaMin: null,
        deliveryFee: null,
        reason: 'Недостаточно товаров на складах для полного заказа'
      };
    }

    const straightKm = Math.max(selectedWarehouse.straightDistanceKm, 0);
    const routeKm = estimateRouteDistanceKm(straightKm);
    const tariff: ZoneTariff = zoneResult.tariff || {
      zoneName: 'Доставка',
      baseFee: 1.5,
      perKmFee: 0.35,
      minFee: 1.5,
      maxFee: 25,
      etaBaseMin: 20,
      etaPerKmMin: 5
    };
    const etaMin = estimateEtaByTariff(routeKm, tariff);
    const deliveryFee = estimateDeliveryFeeByTariff(routeKm, tariff);

    return {
      hasCoordinates: true,
      inDeliveryZone: true,
      serviceable: true,
      zoneName: tariff.zoneName,
      warehouseCode: selectedWarehouse.code,
      warehouseName: selectedWarehouse.name,
      warehouseDistanceKm: Number(straightKm.toFixed(3)),
      routeDistanceKm: Number(routeKm.toFixed(3)),
      etaMin,
      deliveryFee,
      reason: null
    };
  } catch (error) {
    console.error('Delivery quote failed:', error);
      return {
        hasCoordinates: true,
        inDeliveryZone: null,
        serviceable: null,
        zoneName: null,
        warehouseCode: null,
        warehouseName: null,
        warehouseDistanceKm: null,
        routeDistanceKm: null,
        etaMin: null,
        deliveryFee: null,
        reason: 'Сервис карты недоступен'
    };
  }
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
  try {
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
  } catch {
    return [] as GeocodeResult[];
  }
}

async function geocodeReverseOsm(lat: number, lng: number) {
  try {
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
  } catch {
    return null;
  }
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
  try {
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
  } catch {
    return [] as GeocodeResult[];
  }
}

async function geocodeReverseYandex(lat: number, lng: number) {
  if (!YANDEX_GEOCODER_API_KEY) return null;
  try {
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
  } catch {
    return null;
  }
}

function parse2gisLocality(fullName: string) {
  const parts = fullName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  return parts[parts.length - 2] || null;
}

function parse2gisStreetAndHouse(fullName: string) {
  const parts = fullName
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return { street: null as string | null, houseNumber: null as string | null };
  const last = parts[parts.length - 1] || '';
  const match = last.match(/^(.*?)(\d+[A-Za-zА-Яа-я\-\/]*)$/u);
  if (!match) return { street: last || null, houseNumber: null };
  const street = match[1]?.trim() || null;
  const houseNumber = match[2]?.trim() || null;
  return { street, houseNumber };
}

async function geocodeSearch2gis(query: string) {
  if (!DGIS_GEOCODER_API_KEY) return [] as GeocodeResult[];
  try {
    const params = new URLSearchParams({
      q: query,
      key: DGIS_GEOCODER_API_KEY
    });
    const res = await fetch(`https://catalog.api.2gis.com/3.0/items/geocode?${params.toString()}`);
    if (!res.ok) return [] as GeocodeResult[];
    const json = (await res.json()) as any;
    const items = Array.isArray(json?.result?.items) ? json.result.items : [];
    return items
      .map((item: any) => {
        const lat = Number(item?.point?.lat);
        const lng = Number(item?.point?.lon);
        const fullName = String(item?.full_name || item?.name || '').trim();
        const parsed = parse2gisStreetAndHouse(fullName);
        return {
          displayName: fullName || String(item?.name || ''),
          lat,
          lng,
          locality: parse2gisLocality(fullName),
          street: parsed.street,
          houseNumber: parsed.houseNumber
        } as GeocodeResult;
      })
      .filter((item: GeocodeResult) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
  } catch {
    return [] as GeocodeResult[];
  }
}

async function geocodeReverse2gis(lat: number, lng: number) {
  if (!DGIS_GEOCODER_API_KEY) return null;
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      key: DGIS_GEOCODER_API_KEY
    });
    const res = await fetch(`https://catalog.api.2gis.com/3.0/items/geocode?${params.toString()}`);
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const item = Array.isArray(json?.result?.items) ? json.result.items[0] : null;
    if (!item) return null;
    const fullName = String(item?.full_name || item?.name || '').trim();
    const parsed = parse2gisStreetAndHouse(fullName);
    return {
      displayName: fullName || String(item?.name || ''),
      lat: Number(item?.point?.lat ?? lat),
      lng: Number(item?.point?.lon ?? lng),
      locality: parse2gisLocality(fullName),
      street: parsed.street,
      houseNumber: parsed.houseNumber
    } as GeocodeResult;
  } catch {
    return null;
  }
}

async function geocodeSearch(query: string) {
  if (GEOCODER_PROVIDER === '2gis') {
    const dgis: GeocodeResult[] = await geocodeSearch2gis(query);
    const dgisWithHouse = dgis.filter((item) => Boolean(String(item.houseNumber || '').trim()));
    if (dgisWithHouse.length) return dgisWithHouse;
    if (dgis.length) {
      const yandex = await geocodeSearchYandex(query);
      if (yandex.length) return yandex;
      return dgis;
    }
  }
  if (GEOCODER_PROVIDER === 'yandex') {
    const yandex = await geocodeSearchYandex(query);
    if (yandex.length) return yandex;
  }
  return geocodeSearchOsm(query);
}

async function geocodeReverse(lat: number, lng: number) {
  if (GEOCODER_PROVIDER === '2gis') {
    const dgis = await geocodeReverse2gis(lat, lng);
    if (dgis && String(dgis.houseNumber || '').trim()) return dgis;
    const yandex = await geocodeReverseYandex(lat, lng);
    if (yandex && String(yandex.houseNumber || '').trim()) return yandex;
    if (dgis) return dgis;
    if (yandex) return yandex;
  }
  if (GEOCODER_PROVIDER === 'yandex') {
    const yandex = await geocodeReverseYandex(lat, lng);
    if (yandex) return yandex;
  }
  return geocodeReverseOsm(lat, lng);
}

async function resolveCoordinatesFromAddress(address: string) {
  const normalized = String(address || '').trim();
  if (!normalized) return null as { lat: number; lng: number } | null;
  try {
    const results = await geocodeSearch(normalized);
    if (!results.length) return null;
    const withHouse = results.find((item) => Boolean(String(item.houseNumber || '').trim()));
    const candidate = withHouse || results[0];
    if (!candidate) return null;
    if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) return null;
    return { lat: candidate.lat, lng: candidate.lng };
  } catch {
    return null;
  }
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

app.get('/api/health/ready', async (_req, res) => {
  const checks = {
    app: true,
    db: false,
    mapDb: false,
    dbBootstrap: dbBootstrapError ? 'error' : 'ok',
    mapBootstrap: mapBootstrapError ? 'error' : 'ok'
  };

  try {
    await db.query('SELECT 1');
    checks.db = true;
  } catch {
    checks.db = false;
  }

  try {
    await mapDb.query('SELECT 1');
    checks.mapDb = true;
  } catch {
    checks.mapDb = false;
  }

  const ok = checks.app && checks.db && checks.mapDb && !dbBootstrapError && !mapBootstrapError;
  if (!ok) {
    return res.status(503).json({
      ok: false,
      checks,
      now: new Date().toISOString(),
      errors: {
        dbBootstrapError: dbBootstrapError?.message || null,
        mapBootstrapError: mapBootstrapError?.message || null
      }
    });
  }

  return res.json({ ok: true, checks, now: new Date().toISOString() });
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

app.post('/api/delivery/quote', authRequired(JWT_SECRET), async (req, res) => {
  const body = req.body as { deliveryAddress?: string; deliveryLat?: number | null; deliveryLng?: number | null };
  const address = String(body.deliveryAddress || '').trim();
  if (address) {
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
  }

  const hasLat = body.deliveryLat !== undefined && body.deliveryLat !== null;
  const hasLng = body.deliveryLng !== undefined && body.deliveryLng !== null;
  if (hasLat !== hasLng) return res.status(400).json({ message: 'Координаты доставки должны быть переданы парой' });

  let deliveryLat = hasLat ? Number(body.deliveryLat) : null;
  let deliveryLng = hasLng ? Number(body.deliveryLng) : null;
  if (
    (deliveryLat !== null && (Number.isNaN(deliveryLat) || deliveryLat < -90 || deliveryLat > 90)) ||
    (deliveryLng !== null && (Number.isNaN(deliveryLng) || deliveryLng < -180 || deliveryLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты доставки' });
  }

  if (deliveryLat === null || deliveryLng === null) {
    const resolved = await resolveCoordinatesFromAddress(address);
    if (resolved) {
      deliveryLat = resolved.lat;
      deliveryLng = resolved.lng;
    }
  }

  const demandByProduct = await getUserCartDemand(req.user!.id);
  const quote = await buildDeliveryQuote(deliveryLat, deliveryLng, demandByProduct);
  return res.json({ quote });
});

app.post('/api/auth/register', authRateLimiter, validateBody(registerBodySchema), async (req, res) => {
  const { fullName, email, password, phone, address } = req.body as {
    fullName: string;
    email: string;
    password: string;
    phone?: string | null;
    address?: string | null;
  };

  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ message: 'Пользователь с таким email уже существует' });

  const hash = bcrypt.hashSync(password, 10);
  const insert = await db.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role, permissions)
      VALUES ($1, $2, $3, $4, $5, 'customer', '{}')
      RETURNING *
    `,
    [fullName.trim(), email, phone ?? null, address ?? null, hash]
  );

  const user = normalizeUserRow(insert.rows[0]);
  return res.status(201).json({ token: buildToken(user, JWT_SECRET), user: publicUser(user) });
});

app.post('/api/auth/login', authRateLimiter, validateBody(loginBodySchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const user = await getUserByEmail(email);
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

app.get('/api/admin/network/context',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{
  const stores=await accessibleStoreIds(db,req.user!.id);
  const rows=(await db.query(`SELECT id,name,code,address,is_active FROM business_stores WHERE ($1::bigint[] IS NULL OR id=ANY($1::bigint[])) ORDER BY name`,[stores])).rows;
  return res.json({role:req.user!.role,stores:rows,canViewAll:req.user!.role==='owner',message:req.user!.role==='admin'&&!rows.length?'Вам пока не назначен супермаркет':null});
});

app.get('/api/admin/network/stores',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{
  const stores=await accessibleStoreIds(db,req.user!.id);
  const rows=(await db.query(`SELECT s.id,s.name,s.code,s.address,s.phone,s.is_active,s.archived_at,count(w.id)::int warehouse_count FROM business_stores s LEFT JOIN warehouses w ON w.business_store_id=s.id WHERE ($1::bigint[] IS NULL OR s.id=ANY($1::bigint[])) GROUP BY s.id ORDER BY s.archived_at NULLS FIRST,s.name`,[stores])).rows;
  return res.json({stores:rows});
});

app.post('/api/admin/network/stores',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{
  const body=req.body as {name?:string;code?:string;address?:string;phone?:string};
  const name=String(body.name||'').trim(),code=String(body.code||'').trim().toUpperCase();
  if(name.length<2||code.length<2)return res.status(400).json({message:'Укажите название и код супермаркета'});
  let company=(await db.query(`SELECT id FROM companies ORDER BY id LIMIT 2`)).rows;
  if(company.length>1)return res.status(409).json({message:'В БД несколько компаний; требуется ручное сопоставление сети'});
  if(!company.length)company=(await db.query(`INSERT INTO companies(name) VALUES('Торговая сеть') RETURNING id`)).rows;
  const row=(await db.query(`INSERT INTO business_stores(company_id,name,code,address,phone) VALUES($1,$2,$3,$4,$5) RETURNING *`,[company[0].id,name,code,String(body.address||'').trim()||null,String(body.phone||'').trim()||null])).rows[0];
  await logAdminAction(req.user!.id,'network_store.create','business_store',Number(row.id),{name,code});
  return res.status(201).json({store:row});
});

app.get('/api/admin/network/stores/:storeId',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{const id=Number(req.params.storeId);if(!(await hasStoreAccess(db,req.user!.id,id)))return res.status(403).json({message:'Нет доступа к супермаркету'});const row=(await db.query(`SELECT s.*,count(w.id)::int warehouse_count FROM business_stores s LEFT JOIN warehouses w ON w.business_store_id=s.id WHERE s.id=$1 GROUP BY s.id`,[id])).rows[0];if(!row)return res.status(404).json({message:'Супермаркет не найден'});return res.json({store:row})});

app.put('/api/admin/network/stores/:storeId',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const id=Number(req.params.storeId),body=req.body as Record<string,unknown>,name=String(body.name||'').trim(),code=String(body.code||'').trim().toUpperCase();if(name.length<2||code.length<2)return res.status(400).json({message:'Укажите название и код супермаркета'});const row=(await db.query(`UPDATE business_stores SET name=$1,code=$2,address=$3,phone=$4,updated_at=NOW() WHERE id=$5 RETURNING *`,[name,code,String(body.address||'').trim()||null,String(body.phone||'').trim()||null,id])).rows[0];if(!row)return res.status(404).json({message:'Супермаркет не найден'});await logAdminAction(req.user!.id,'network_store.update','business_store',id,{name,code});return res.json({store:row})});

app.post('/api/admin/network/stores/:storeId/archive',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const id=Number(req.params.storeId);const blockers=(await db.query(`SELECT (SELECT count(*) FROM inventory_documents d JOIN warehouses w ON w.id IN(d.source_warehouse_id,d.destination_warehouse_id) WHERE w.business_store_id=$1 AND d.status='draft')::int drafts,(SELECT count(*) FROM inventory_reservations r JOIN warehouses w ON w.id=r.warehouse_id WHERE w.business_store_id=$1 AND r.status='active')::int reservations,(SELECT count(*) FROM pick_tasks p JOIN warehouses w ON w.id=p.warehouse_id WHERE w.business_store_id=$1 AND p.status IN('new','in_progress'))::int pick_tasks`,[id])).rows[0];if(!blockers)return res.status(404).json({message:'Супермаркет не найден'});await db.query(`INSERT INTO store_archive_checks(store_id,checked_by,blockers) VALUES($1,$2,$3)`,[id,req.user!.id,blockers]);const reasons=Object.entries(blockers).filter(([,v])=>Number(v)>0).map(([k,v])=>`${k}: ${v}`);if(reasons.length)return res.status(409).json({message:'Архивирование заблокировано активными процессами',reasons});const row=(await db.query(`UPDATE business_stores SET is_active=FALSE,archived_at=NOW(),archived_by=$1,updated_at=NOW() WHERE id=$2 AND archived_at IS NULL RETURNING id`,[req.user!.id,id])).rows[0];if(!row)return res.status(404).json({message:'Активный супермаркет не найден'});await logAdminAction(req.user!.id,'network_store.archive','business_store',id,{});return res.json({message:'Супермаркет архивирован'})});

app.get('/api/admin/network/assignments',authRequired(JWT_SECRET),roleRequired('owner'),async(_req,res)=>{
  const rows=(await db.query(`SELECT a.id,a.user_id,a.store_id,a.permissions,a.assigned_at,u.full_name,u.email,s.name store_name FROM store_user_assignments a JOIN users u ON u.id=a.user_id JOIN business_stores s ON s.id=a.store_id WHERE a.is_active ORDER BY u.full_name,s.name`)).rows;
  return res.json({assignments:rows});
});

app.post('/api/admin/network/assignments',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{
  const body=req.body as {userId?:number;storeId?:number;permissions?:string[]};const userId=Number(body.userId),storeId=Number(body.storeId);
  const user=(await db.query(`SELECT role,is_active FROM users WHERE id=$1`,[userId])).rows[0];
  if(!user||user.role!=='admin'||user.is_active===false)return res.status(400).json({message:'Назначить можно только активного администратора'});
  if(!(await db.query(`SELECT 1 FROM business_stores WHERE id=$1 AND is_active`,[storeId])).rowCount)return res.status(404).json({message:'Супермаркет не найден'});
  const permissions=normalizePermissions(body.permissions);
  const client=await db.connect();try{await client.query('BEGIN');const row=(await client.query(`INSERT INTO store_user_assignments(user_id,store_id,permissions,assigned_by) VALUES($1,$2,$3,$4) RETURNING *`,[userId,storeId,permissions,req.user!.id])).rows[0];await client.query(`INSERT INTO store_assignment_audit(assignment_id,user_id,store_id,action,permissions,actor_user_id) VALUES($1,$2,$3,'assigned',$4,$5)`,[row.id,userId,storeId,permissions,req.user!.id]);await client.query('COMMIT');return res.status(201).json({assignment:row});}catch(e:any){await client.query('ROLLBACK');if(e?.code==='23505')return res.status(409).json({message:'Активное назначение уже существует'});throw e;}finally{client.release()}
});

app.delete('/api/admin/network/assignments/:assignmentId',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{
  const client=await db.connect();try{await client.query('BEGIN');const row=(await client.query(`UPDATE store_user_assignments SET is_active=FALSE,revoked_by=$1,revoked_at=NOW() WHERE id=$2 AND is_active RETURNING *`,[req.user!.id,Number(req.params.assignmentId)])).rows[0];if(!row){await client.query('ROLLBACK');return res.status(404).json({message:'Активное назначение не найдено'})}await client.query(`INSERT INTO store_assignment_audit(assignment_id,user_id,store_id,action,permissions,actor_user_id) VALUES($1,$2,$3,'revoked',$4,$5)`,[row.id,row.user_id,row.store_id,row.permissions,req.user!.id]);await client.query('COMMIT');return res.json({message:'Доступ отозван'});}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
});

app.get('/api/admin/network/mapping-report',authRequired(JWT_SECRET),roleRequired('owner'),async(_req,res)=>{
  const rows=(await db.query(`SELECT m.warehouse_id,w.code warehouse_code,w.name warehouse_name,m.proposed_store_id,s.name proposed_store_name,m.status,m.reason,coalesce(sum(ws.quantity),0)::text stock_quantity,coalesce(sum(ws.reserved_quantity),0)::text reserved_quantity FROM legacy_warehouse_store_mapping m JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN business_stores s ON s.id=m.proposed_store_id LEFT JOIN warehouse_stock ws ON ws.warehouse_id=w.id GROUP BY m.warehouse_id,w.code,w.name,m.proposed_store_id,s.name,m.status,m.reason ORDER BY m.status,w.name`)).rows;
  return res.json({rows,requiresManualDecision:rows.filter(r=>r.status!=='confirmed').length});
});

app.get('/api/admin/network/mapping/:warehouseId/preview',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const warehouseId=Number(req.params.warehouseId),storeId=Number(req.query.storeId);const row=(await db.query(`SELECT w.id,m.status,w.business_store_id,(SELECT count(*) FROM inventory_documents d WHERE d.source_warehouse_id=w.id OR d.destination_warehouse_id=w.id)::int documents,(SELECT count(*) FROM inventory_operations o JOIN inventory_operation_lines l ON l.operation_id=o.id WHERE l.warehouse_id=w.id)::int operations,(SELECT count(*) FROM inventory_reservations r WHERE r.warehouse_id=w.id)::int reservations,(SELECT count(*) FROM stock_movements sm WHERE sm.warehouse_id=w.id)::int movements,(SELECT count(*) FROM inventory_documents d JOIN warehouses other ON other.id=CASE WHEN d.source_warehouse_id=w.id THEN d.destination_warehouse_id ELSE d.source_warehouse_id END WHERE d.document_type='transfer' AND (d.source_warehouse_id=w.id OR d.destination_warehouse_id=w.id) AND other.business_store_id IS NOT NULL AND other.business_store_id<>$2)::int conflicting_transfers FROM warehouses w JOIN legacy_warehouse_store_mapping m ON m.warehouse_id=w.id WHERE w.id=$1`,[warehouseId,storeId])).rows[0];if(!row)return res.status(404).json({message:'Legacy-склад не найден'});return res.json({preview:row,canConfirm:row.status==='unresolved'&&Number(row.conflicting_transfers)===0})});

app.post('/api/admin/network/mapping/:warehouseId/confirm',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const warehouseId=Number(req.params.warehouseId),storeId=Number((req.body as any).storeId),key=String(req.headers['x-idempotency-key']||'').trim();if(!key)return res.status(400).json({message:'Требуется X-Idempotency-Key'});const client=await db.connect();try{await client.query('BEGIN');const map=(await client.query(`SELECT * FROM legacy_warehouse_store_mapping WHERE warehouse_id=$1 FOR UPDATE`,[warehouseId])).rows[0];if(!map)throw new HttpError(404,'Legacy-склад не найден');if(map.status==='confirmed'){if(Number(map.proposed_store_id)===storeId&&map.idempotency_key===key){await client.query('COMMIT');return res.json({reused:true})}throw new HttpError(409,'Подтверждённую принадлежность нельзя изменить обычным сопоставлением')}const store=(await client.query(`SELECT id,company_id FROM business_stores WHERE id=$1 AND is_active AND archived_at IS NULL`,[storeId])).rows[0];if(!store)throw new HttpError(404,'Активный супермаркет не найден');const dep=(await client.query(`SELECT (SELECT count(*) FROM inventory_documents d WHERE d.source_warehouse_id=$1 OR d.destination_warehouse_id=$1)::int documents,(SELECT count(*) FROM inventory_reservations r WHERE r.warehouse_id=$1)::int reservations,(SELECT count(*) FROM stock_movements sm WHERE sm.warehouse_id=$1)::int movements,(SELECT count(*) FROM inventory_documents d JOIN warehouses other ON other.id=CASE WHEN d.source_warehouse_id=$1 THEN d.destination_warehouse_id ELSE d.source_warehouse_id END WHERE d.document_type='transfer' AND (d.source_warehouse_id=$1 OR d.destination_warehouse_id=$1) AND other.business_store_id IS NOT NULL AND other.business_store_id<>$2)::int conflicts`,[warehouseId,storeId])).rows[0];if(Number(dep.conflicts)>0)throw new HttpError(409,'Найдены межскладские связи с другим магазином; требуется ручное решение');await client.query(`UPDATE warehouses SET business_store_id=$1,company_id=$2 WHERE id=$3`,[storeId,store.company_id,warehouseId]);await client.query(`UPDATE legacy_warehouse_store_mapping SET proposed_store_id=$1,status='confirmed',reason='Подтверждено владельцем',decided_by=$2,decided_at=NOW(),confirmed_at=NOW(),idempotency_key=$3,dependency_snapshot=$4 WHERE warehouse_id=$5`,[storeId,req.user!.id,key,dep,warehouseId]);await client.query(`INSERT INTO admin_audit_logs(admin_user_id,action,entity_type,entity_id,details) VALUES($1,'legacy_warehouse_mapping.confirm','warehouse',$2,$3)`,[req.user!.id,warehouseId,JSON.stringify({storeId,dependencies:dep})]);await client.query('COMMIT');return res.json({reused:false,warehouseId,storeId})}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}});

app.get('/api/admin/network/stores/:storeId/products',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{const storeId=Number(req.params.storeId);if(!(await hasStoreAccess(db,req.user!.id,storeId)))return res.status(403).json({message:'Нет доступа к супермаркету'});const rows=(await db.query(`SELECT p.id,p.name,p.price legacy_price,s.is_listed,s.sale_price,s.updated_at FROM products p LEFT JOIN store_product_settings s ON s.product_id=p.id AND s.store_id=$1 ORDER BY p.name`,[storeId])).rows;return res.json({products:rows,pricePolicy:'explicit_store_price_required'})});

app.put('/api/admin/network/stores/:storeId/products/:productId',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{const storeId=Number(req.params.storeId),productId=Number(req.params.productId);if(!(await hasStoreAccess(db,req.user!.id,storeId)))return res.status(403).json({message:'Нет доступа к супермаркету'});const actor=await getUserById(req.user!.id);if(actor?.role!=='owner'&&!actor?.permissions.includes('manage_products'))return res.status(403).json({message:'Нет права управлять ассортиментом'});const body=req.body as {isListed?:boolean;salePrice?:number|null};if(typeof body.isListed!=='boolean')return res.status(400).json({message:'isListed обязателен'});const price=body.salePrice===null||body.salePrice===undefined?null:Number(body.salePrice);if(body.isListed&&(price===null||!Number.isFinite(price)||price<0))return res.status(400).json({message:'Для включённого товара нужна явная магазинная цена'});const row=(await db.query(`INSERT INTO store_product_settings(store_id,product_id,is_listed,sale_price,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(store_id,product_id) DO UPDATE SET is_listed=EXCLUDED.is_listed,sale_price=EXCLUDED.sale_price,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING *`,[storeId,productId,body.isListed,price,req.user!.id])).rows[0];await logAdminAction(req.user!.id,'store_product.update','store_product',productId,{storeId,isListed:body.isListed,salePrice:price});return res.json({setting:row})});

app.get('/api/admin/network/report',authRequired(JWT_SECRET),roleRequired('admin'),async(req,res)=>{
  const warehouses=await accessibleWarehouseIds(db,req.user!.id);
  const row=(await db.query(`SELECT count(DISTINCT ws.product_id)::int product_count,count(DISTINCT ws.warehouse_id)::int warehouse_count,coalesce(sum(ws.quantity),0)::text quantity,coalesce(sum(CASE WHEN c.cost_known THEN c.inventory_value ELSE 0 END),0)::text known_value,count(*) FILTER(WHERE NOT c.cost_known)::int unknown_cost_rows FROM warehouse_stock ws JOIN warehouse_stock_costs c USING(warehouse_id,product_id) WHERE ($1::bigint[] IS NULL OR ws.warehouse_id=ANY($1::bigint[]))`,[warehouses])).rows[0];
  return res.json({totals:{productsTotal:row.product_count,warehousesTotal:row.warehouse_count,quantity:row.quantity,knownValue:row.known_value,unknownCostRows:row.unknown_cost_rows}});
});

app.get('/api/admin/legacy-orders',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const status=String(req.query.status||'').trim(),q=String(req.query.q||'').trim(),limit=Math.min(100,Math.max(1,Number(req.query.limit)||50)),offset=Math.max(0,Number(req.query.offset)||0);const rows=(await db.query(`SELECT o.id,o.status,o.total,o.delivery_address,o.payment_method,o.created_at,o.updated_at,count(oi.id)::int item_count FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE ($1='' OR o.status=$1) AND ($2='' OR o.id::text=$2) GROUP BY o.id ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,[status,q,limit,offset])).rows;return res.json({orders:rows,readOnly:true})});

app.get('/api/admin/legacy-orders/:orderId',authRequired(JWT_SECRET),roleRequired('owner'),async(req,res)=>{const id=Number(req.params.orderId);const order=(await db.query(`SELECT id,status,total,delivery_address,payment_method,created_at,updated_at FROM orders WHERE id=$1`,[id])).rows[0];if(!order)return res.status(404).json({message:'Архивный заказ не найден'});const [items,events,movements]=await Promise.all([db.query(`SELECT id,product_id,product_name,quantity,unit_price FROM order_items WHERE order_id=$1 ORDER BY id`,[id]),db.query(`SELECT id,status,comment,created_at FROM order_events WHERE order_id=$1 ORDER BY id`,[id]),db.query(`SELECT id,warehouse_id,product_id,movement_type,quantity,reason,created_at FROM stock_movements WHERE reference_type IN('order','pick_task') AND (reference_id=$1 OR reference_id IN(SELECT id FROM pick_tasks WHERE order_id=$1)) ORDER BY id`,[id])]);return res.json({order,items:items.rows,events:events.rows,movements:movements.rows,readOnly:true})});

app.get('/api/admin/legacy-users-report',authRequired(JWT_SECRET),roleRequired('owner'),async(_req,res)=>{const rows=(await db.query(`SELECT role,is_active,count(*)::int count FROM users WHERE role IN('customer','courier') GROUP BY role,is_active ORDER BY role,is_active DESC`)).rows;return res.json({rows,note:'Роли не изменены автоматически'})});

app.put('/api/users/me', authRequired(JWT_SECRET), validateBody(updateMeBodySchema), async (req, res) => {
  const { fullName, phone, address } = req.body as { fullName?: string; phone?: string | null; address?: string | null };
  const user = await getUserById(req.user!.id);
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  if (!user.is_active) throw new HttpError(403, 'Аккаунт заблокирован администратором');

  const nextPhone = phone === undefined ? user.phone : phone;
  const phoneChanged = nextPhone !== user.phone;
  const updated = await db.query(
    `
      UPDATE users
      SET full_name = $1,
          phone = $2,
          address = $3,
          phone_verified_at = CASE WHEN $5 THEN NULL ELSE phone_verified_at END
      WHERE id = $4
      RETURNING *
    `,
    [fullName?.trim() || user.full_name, nextPhone, address === undefined ? user.address : address, user.id, phoneChanged]
  );

  return res.json({ user: publicUser(normalizeUserRow(updated.rows[0])) });
});

app.get('/api/notifications', authRequired(JWT_SECRET), async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number((req.query.limit as string) || 50)));
  const rows = (
    await db.query(
      `
        SELECT id, level, title, body, entity_type, entity_id, is_read, created_at, read_at
        FROM notifications
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT $2
      `,
      [req.user!.id, limit]
    )
  ).rows;
  const unreadCountRow = (
    await db.query(
      `
        SELECT COUNT(*)::text AS unread_count
        FROM notifications
        WHERE user_id = $1 AND is_read = FALSE
      `,
      [req.user!.id]
    )
  ).rows[0];
  return res.json({
    unreadCount: toNumber(unreadCountRow?.unread_count || 0),
    notifications: rows.map((row: any) => ({
      id: toNumber(row.id),
      level: String(row.level || 'info'),
      title: String(row.title || ''),
      body: row.body ?? null,
      entityType: row.entity_type ?? null,
      entityId: row.entity_id === null ? null : toNumber(row.entity_id),
      isRead: row.is_read === true,
      createdAt: toDateString(row.created_at),
      readAt: row.read_at ? toDateString(row.read_at) : null
    }))
  });
});

app.post('/api/notifications/:notificationId/read', authRequired(JWT_SECRET), async (req, res) => {
  const notificationId = Number(req.params.notificationId);
  if (!notificationId) return res.status(400).json({ message: 'Некорректный notificationId' });
  const updated = (
    await db.query(
      `
        UPDATE notifications
        SET is_read = TRUE, read_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `,
      [notificationId, req.user!.id]
    )
  ).rows[0];
  if (!updated) return res.status(404).json({ message: 'Уведомление не найдено' });
  return res.json({ ok: true });
});

app.post('/api/notifications/read-all', authRequired(JWT_SECRET), async (req, res) => {
  await db.query(
    `
      UPDATE notifications
      SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND is_read = FALSE
    `,
    [req.user!.id]
  );
  return res.json({ ok: true });
});

app.post(
  '/api/users/me/verification/request',
  authRateLimiter,
  authRequired(JWT_SECRET),
  validateBody(verificationRequestBodySchema),
  async (req, res) => {
    const { channel } = req.body as { channel: 'email' | 'phone' };

    const user = await getUserById(req.user!.id);
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
    if (channel === 'phone' && (!user.phone || !String(user.phone).trim())) {
      return res.status(400).json({ message: 'Сначала укажите номер телефона в профиле' });
    }

    const recentRequest = (
      await db.query(
        `
        SELECT id
        FROM user_verification_codes
        WHERE user_id = $1
          AND channel = $2
          AND purpose = 'store_onboarding'
          AND created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
        ORDER BY id DESC
        LIMIT 1
      `,
        [user.id, channel, VERIFICATION_CODE_RESEND_COOLDOWN_MS]
      )
    ).rows[0];
    if (recentRequest) {
      return res.status(429).json({ message: 'Слишком частая отправка кода. Попробуйте через минуту.' });
    }

    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRES_MS);
    const codeHash = hashVerificationCode(code);
    await db.query(
      `
      UPDATE user_verification_codes
      SET used_at = NOW()
      WHERE user_id = $1
        AND channel = $2
        AND purpose = 'store_onboarding'
        AND used_at IS NULL
    `,
      [user.id, channel]
    );
    await db.query(
      `
      INSERT INTO user_verification_codes (user_id, channel, purpose, code, attempts_count, locked_until, expires_at)
      VALUES ($1, $2, 'store_onboarding', $3, 0, NULL, $4)
    `,
      [user.id, channel, codeHash, expiresAt.toISOString()]
    );

    const responseBody: Record<string, unknown> = {
      message:
        channel === 'email'
          ? 'Код подтверждения email создан'
          : 'Код подтверждения телефона создан',
      channel,
      expiresAt: expiresAt.toISOString()
    };
    if (NODE_ENV !== 'production') {
      responseBody.message =
        channel === 'email'
          ? 'Код подтверждения email создан (dev-режим: код возвращен в ответе)'
          : 'Код подтверждения телефона создан (dev-режим: код возвращен в ответе)';
      responseBody.code = code;
    }
    return res.json(responseBody);
  }
);

app.post('/api/users/me/verification/confirm', authRequired(JWT_SECRET), validateBody(verificationConfirmBodySchema), async (req, res) => {
  const { channel, code } = req.body as { channel: 'email' | 'phone'; code: string };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const verificationRow = (
      await client.query(
        `
          SELECT id, code, attempts_count, locked_until, expires_at
          FROM user_verification_codes
          WHERE user_id = $1
            AND channel = $2
            AND purpose = 'store_onboarding'
            AND used_at IS NULL
          ORDER BY id DESC
          FOR UPDATE
          LIMIT 1
        `,
        [req.user!.id, channel]
      )
    ).rows[0];
    if (!verificationRow || new Date(verificationRow.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Неверный или просроченный код подтверждения' });
    }

    const lockedUntilTime = verificationRow.locked_until ? new Date(verificationRow.locked_until).getTime() : null;
    if (lockedUntilTime && lockedUntilTime > Date.now()) {
      await client.query('ROLLBACK');
      return res.status(429).json({ message: 'Слишком много неверных попыток. Повторите позже.' });
    }

    if (!verificationCodeMatches(verificationRow.code, code)) {
      const nextAttempts = toNumber(verificationRow.attempts_count ?? 0) + 1;
      const lockNow = nextAttempts >= VERIFICATION_CODE_MAX_ATTEMPTS;
      await client.query(
        `
          UPDATE user_verification_codes
          SET attempts_count = $1,
              locked_until = CASE WHEN $2 THEN NOW() + ($3::int * INTERVAL '1 minute') ELSE NULL END
          WHERE id = $4
        `,
        [nextAttempts, lockNow, VERIFICATION_CODE_LOCK_MINUTES, toNumber(verificationRow.id)]
      );
      await client.query('COMMIT');
      if (lockNow) {
        return res.status(429).json({ message: 'Слишком много неверных попыток. Повторите позже.' });
      }
      return res.status(400).json({ message: 'Неверный или просроченный код подтверждения' });
    }

    await client.query(
      'UPDATE user_verification_codes SET used_at = NOW(), locked_until = NULL WHERE id = $1',
      [toNumber(verificationRow.id)]
    );
    if (channel === 'email') {
      await client.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [req.user!.id]);
    } else {
      await client.query('UPDATE users SET phone_verified_at = NOW() WHERE id = $1', [req.user!.id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const updatedUser = await getUserById(req.user!.id);
  if (!updatedUser) return res.status(404).json({ message: 'Пользователь не найден' });
  return res.json({ message: `${channel === 'email' ? 'Email' : 'Телефон'} подтвержден`, user: publicUser(updatedUser) });
});

app.post('/api/stores/uploads/logo', authRequired(JWT_SECRET), roleRequired('customer'), upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'Файл логотипа обязателен' });
  return res.status(201).json({ logoUrl: `/uploads/${file.filename}` });
});

app.post('/api/stores/uploads/kyc-document', authRequired(JWT_SECRET), roleRequired('customer'), upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'Файл документа обязателен' });
  return res.status(201).json({ documentUrl: `/uploads/${file.filename}` });
});

app.post('/api/stores/uploads/product-image', authRequired(JWT_SECRET), roleRequired('customer'), upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'Файл изображения товара обязателен' });
  return res.status(201).json({ imageUrl: `/uploads/${file.filename}` });
});

app.get('/api/stores/my', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.json({ store: null });
  return res.json({ store: merchantStoreView(store) });
});

app.post('/api/stores/my', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const existing = await getMerchantStoreByOwner(req.user!.id);
  if (existing) return res.status(409).json({ message: 'У вас уже есть точка. Можно редактировать существующую.' });

  const owner = await getUserById(req.user!.id);
  if (!owner) return res.status(404).json({ message: 'Пользователь не найден' });
  if (!owner.email_verified_at || !owner.phone_verified_at) {
    return res.status(403).json({ message: 'Перед созданием магазина подтвердите email и телефон' });
  }

  const body = req.body as {
    name?: string;
    logoUrl?: string;
    phone?: string;
    description?: string;
    tin?: string;
    legalDocumentUrl?: string;
    lat?: number;
    lng?: number;
  };
  const name = String(body.name || '').trim();
  const logoUrl = String(body.logoUrl || '').trim() || null;
  const phone = String(body.phone || '').trim();
  const description = String(body.description || '').trim() || null;
  const tin = normalizeTin(body.tin);
  const legalDocumentUrl = String(body.legalDocumentUrl || '').trim();
  const lat = body.lat === undefined || body.lat === null ? null : Number(body.lat);
  const lng = body.lng === undefined || body.lng === null ? null : Number(body.lng);

  if (!name || name.length < 2 || name.length > 120) {
    return res.status(400).json({ message: 'Название точки должно быть от 2 до 120 символов' });
  }
  if (!phone || phone.length < 5 || phone.length > 30) {
    return res.status(400).json({ message: 'Укажите корректный номер телефона точки' });
  }
  if (!isValidTin(tin)) {
    return res.status(400).json({ message: 'Укажите корректный ИНН (9-14 цифр)' });
  }
  if (!isLikelyDocumentUrl(legalDocumentUrl)) {
    return res.status(400).json({ message: 'Загрузите документ KYC (ссылка на файл обязательна)' });
  }
  if ((lat === null) !== (lng === null)) {
    return res.status(400).json({ message: 'Координаты lat/lng должны передаваться парой' });
  }
  if (
    (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
    (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты точки' });
  }

  const created = (
    await db.query(
      `
        INSERT INTO merchant_stores (
          owner_user_id, name, logo_url, phone, description, tin, legal_document_url, lat, lng, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING *
      `,
      [req.user!.id, name, logoUrl, phone, description, tin, legalDocumentUrl, lat, lng]
    )
  ).rows[0];
  await tenantDbResolver.ensureStoreRouting(toNumber(created.id));

  return res.status(201).json({
    store: merchantStoreView(created),
    message: 'Точка создана и отправлена на одобрение главному администратору'
  });
});

app.patch('/api/stores/my', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });

  const owner = await getUserById(req.user!.id);
  if (!owner) return res.status(404).json({ message: 'Пользователь не найден' });
  if (!owner.email_verified_at || !owner.phone_verified_at) {
    return res.status(403).json({ message: 'Перед отправкой на модерацию подтвердите email и телефон' });
  }

  const body = req.body as {
    name?: string;
    logoUrl?: string;
    phone?: string;
    description?: string;
    tin?: string;
    legalDocumentUrl?: string;
    lat?: number | null;
    lng?: number | null;
  };
  const nextName = body.name !== undefined ? String(body.name).trim() : String(store.name);
  const nextLogoUrl = body.logoUrl !== undefined ? (String(body.logoUrl || '').trim() || null) : store.logo_url;
  const nextPhone = body.phone !== undefined ? String(body.phone).trim() : String(store.phone);
  const nextDescription = body.description !== undefined ? (String(body.description || '').trim() || null) : store.description;
  const nextTin = body.tin !== undefined ? normalizeTin(body.tin) : normalizeTin(store.tin);
  const nextLegalDocumentUrl =
    body.legalDocumentUrl !== undefined ? String(body.legalDocumentUrl || '').trim() : String(store.legal_document_url || '');
  const nextLat = body.lat !== undefined ? (body.lat === null ? null : Number(body.lat)) : (store.lat === null ? null : Number(store.lat));
  const nextLng = body.lng !== undefined ? (body.lng === null ? null : Number(body.lng)) : (store.lng === null ? null : Number(store.lng));

  if (!nextName || nextName.length < 2 || nextName.length > 120) {
    return res.status(400).json({ message: 'Название точки должно быть от 2 до 120 символов' });
  }
  if (!nextPhone || nextPhone.length < 5 || nextPhone.length > 30) {
    return res.status(400).json({ message: 'Укажите корректный номер телефона точки' });
  }
  if (!isValidTin(nextTin)) {
    return res.status(400).json({ message: 'Укажите корректный ИНН (9-14 цифр)' });
  }
  if (!isLikelyDocumentUrl(nextLegalDocumentUrl)) {
    return res.status(400).json({ message: 'Загрузите документ KYC (ссылка на файл обязательна)' });
  }
  if ((nextLat === null) !== (nextLng === null)) {
    return res.status(400).json({ message: 'Координаты lat/lng должны передаваться парой' });
  }
  if (
    (nextLat !== null && (!Number.isFinite(nextLat) || nextLat < -90 || nextLat > 90)) ||
    (nextLng !== null && (!Number.isFinite(nextLng) || nextLng < -180 || nextLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты точки' });
  }

  const updated = (
    await db.query(
      `
        UPDATE merchant_stores
        SET
          name = $1,
          logo_url = $2,
          phone = $3,
          description = $4,
          tin = $5,
          legal_document_url = $6,
          lat = $7,
          lng = $8,
          status = 'pending',
          approved_by_admin_id = NULL,
          approved_at = NULL,
          rejection_reason = NULL
        WHERE id = $9
        RETURNING *
      `,
      [nextName, nextLogoUrl, nextPhone, nextDescription, nextTin, nextLegalDocumentUrl, nextLat, nextLng, toNumber(store.id)]
    )
  ).rows[0];
  await notifyCourierOrdersUpdated(toNumber(updated.id), 'courier_location');

  return res.json({
    store: merchantStoreView(updated),
    message: 'Изменения отправлены на повторное одобрение главному администратору'
  });
});

app.get('/api/stores/my/products', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });
  if (normalizeMerchantStoreStatus(store.status) !== 'approved') {
    return res.status(403).json({ message: 'Каталог доступен после одобрения точки главным администратором' });
  }

  const tenantPool = await getTenantPoolByStoreId(toNumber(store.id));
  const rows = (
    await tenantPool.query(
      `
        SELECT *
        FROM merchant_products
        WHERE store_id = $1
        ORDER BY id DESC
      `,
      [toNumber(store.id)]
    )
  ).rows;
  return res.json({ products: rows.map((row: any) => merchantProductView(row)) });
});

app.post('/api/stores/my/products', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });
  if (normalizeMerchantStoreStatus(store.status) !== 'approved') {
    return res.status(403).json({ message: 'Добавление товаров доступно после одобрения точки главным администратором' });
  }

  const body = req.body as { name?: string; description?: string; price?: number; barcode?: string; imageUrl?: string; unit?: string; inStock?: boolean; stockQuantity?: number };
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim() || null;
  const imageUrl = String(body.imageUrl || '').trim() || null;
  const price = Number(body.price);
  const stockQuantity = Math.max(0, Math.floor(Number(body.stockQuantity ?? 0)));
  const inStock = body.inStock === undefined ? stockQuantity > 0 : Boolean(body.inStock) && stockQuantity > 0;

  if (!name || name.length < 2 || name.length > 180) {
    return res.status(400).json({ message: 'Название товара должно быть от 2 до 180 символов' });
  }
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ message: 'Укажите корректную цену товара' });
  }

  const tenantPool = await getTenantPoolByStoreId(toNumber(store.id));
  const created = (
    await tenantPool.query(
      `
        INSERT INTO merchant_products (store_id, name, description, price, barcode, image_url, unit, in_stock, stock_quantity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [toNumber(store.id), name, description, round2(price), String(body.barcode || '').trim() || null, imageUrl, body.unit?.trim() || 'шт', inStock, stockQuantity]
    )
  ).rows[0];

  return res.status(201).json({ product: merchantProductView(created) });
});

app.put('/api/stores/my/products/:productId', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });
  if (normalizeMerchantStoreStatus(store.status) !== 'approved') {
    return res.status(403).json({ message: 'Редактирование товаров доступно после одобрения точки главным администратором' });
  }

  const tenantPool = await getTenantPoolByStoreId(toNumber(store.id));
  const existing = (
    await tenantPool.query(
      `
        SELECT *
        FROM merchant_products
        WHERE id = $1 AND store_id = $2
        LIMIT 1
      `,
      [productId, toNumber(store.id)]
    )
  ).rows[0];
  if (!existing) return res.status(404).json({ message: 'Товар точки не найден' });

  const body = req.body as { name?: string; description?: string; price?: number; barcode?: string; imageUrl?: string; unit?: string; inStock?: boolean; stockQuantity?: number };
  const nextName = body.name !== undefined ? String(body.name).trim() : String(existing.name);
  const nextDescription = body.description !== undefined ? (String(body.description || '').trim() || null) : existing.description;
  const nextImageUrl = body.imageUrl !== undefined ? (String(body.imageUrl || '').trim() || null) : existing.image_url;
  const nextUnit = body.unit !== undefined ? String(body.unit || '').trim() || 'шт' : String(existing.unit || 'шт').trim() || 'шт';
  const nextPrice = body.price !== undefined ? Number(body.price) : Number(existing.price);
  const nextStockQuantity = body.stockQuantity !== undefined ? Math.max(0, Math.floor(Number(body.stockQuantity))) : toNumber(existing.stock_quantity);
  const nextInStock = body.inStock !== undefined ? Boolean(body.inStock) && nextStockQuantity > 0 : (existing.in_stock !== false && nextStockQuantity > 0);

  if (!nextName || nextName.length < 2 || nextName.length > 180) {
    return res.status(400).json({ message: 'Название товара должно быть от 2 до 180 символов' });
  }
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
    return res.status(400).json({ message: 'Укажите корректную цену товара' });
  }

  const updated = (
    await tenantPool.query(
      `
        UPDATE merchant_products
        SET
          name = $1,
          description = $2,
          price = $3,
          barcode = $4,
          image_url = $5,
          unit = $6,
          in_stock = $7,
          stock_quantity = $8
        WHERE id = $9
        RETURNING *
      `,
      [
        nextName,
        nextDescription,
        round2(nextPrice),
        body.barcode !== undefined ? (String(body.barcode || '').trim() || null) : (existing.barcode ?? null),
        nextImageUrl,
        nextUnit,
        nextInStock,
        nextStockQuantity,
        productId
      ]
    )
  ).rows[0];

  return res.json({ product: merchantProductView(updated) });
});

app.delete('/api/stores/my/products/:productId', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });

  const tenantPool = await getTenantPoolByStoreId(toNumber(store.id));
  const deleted = (
    await tenantPool.query(
      `
        DELETE FROM merchant_products
        WHERE id = $1 AND store_id = $2
        RETURNING id
      `,
      [productId, toNumber(store.id)]
    )
  ).rows[0];
  if (!deleted) return res.status(404).json({ message: 'Товар точки не найден' });
  return res.json({ message: 'Товар удален' });
});

app.get('/api/stores/my/courier-links', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });

  const rows = (
    await db.query(
      `
        SELECT l.*,
               u.full_name AS courier_name,
               u.email AS courier_email,
               u.phone AS courier_phone
        FROM merchant_store_courier_links l
        JOIN couriers c ON c.id = l.courier_id
        JOIN users u ON u.id = c.user_id
        WHERE l.store_id = $1
        ORDER BY l.id DESC
      `,
      [toNumber(store.id)]
    )
  ).rows;
  return res.json({ links: rows.map((row: any) => merchantCourierLinkView(row)) });
});

app.post('/api/stores/my/courier-links', authRequired(JWT_SECRET), roleRequired('customer'), async (req, res) => {
  const store = await getMerchantStoreByOwner(req.user!.id);
  if (!store) return res.status(404).json({ message: 'Сначала создайте свою точку' });
  if (normalizeMerchantStoreStatus(store.status) !== 'approved') {
    return res.status(403).json({ message: 'Подключение курьера доступно после одобрения точки главным администратором' });
  }

  const courierId = Number((req.body as { courierId?: number }).courierId);
  if (!courierId) return res.status(400).json({ message: 'Некорректный courierId' });
  const courierExists = (await db.query('SELECT id FROM couriers WHERE id = $1 LIMIT 1', [courierId])).rows[0];
  if (!courierExists) return res.status(404).json({ message: 'Курьер не найден' });

  const existing = (
    await db.query(
      `
        SELECT *
        FROM merchant_store_courier_links
        WHERE store_id = $1 AND courier_id = $2
        LIMIT 1
      `,
      [toNumber(store.id), courierId]
    )
  ).rows[0];

  if (existing) {
    if (normalizeMerchantCourierLinkStatus(existing.status) === 'approved') {
      return res.json({ link: merchantCourierLinkView(existing), message: 'Курьер уже подключен к вашей точке' });
    }
    const updated = (
      await db.query(
        `
          UPDATE merchant_store_courier_links
          SET
            status = 'pending',
            approved_by_admin_id = NULL,
            approved_at = NULL,
            rejection_reason = NULL
          WHERE id = $1
          RETURNING *
        `,
        [toNumber(existing.id)]
      )
    ).rows[0];
    return res.status(201).json({ link: merchantCourierLinkView(updated), message: 'Заявка на подключение курьера отправлена заново' });
  }

  const created = (
    await db.query(
      `
        INSERT INTO merchant_store_courier_links (store_id, courier_id, requested_by_user_id, status)
        VALUES ($1, $2, $3, 'pending')
        RETURNING *
      `,
      [toNumber(store.id), courierId, req.user!.id]
    )
  ).rows[0];
  return res.status(201).json({ link: merchantCourierLinkView(created), message: 'Заявка на подключение курьера отправлена главному администратору' });
});

app.get('/api/products', authRequired(JWT_SECRET), roleRequired('customer', 'courier', 'admin'), async (req, res) => {
  const rows = (await db.query('SELECT * FROM products WHERE in_stock = TRUE AND stock_quantity > 0 ORDER BY id DESC')).rows;
  res.json({ products: rows.map((row: any) => normalizeProductRow(row)) });
});

app.get('/api/products/by-barcode', authRequired(JWT_SECRET), roleRequired('picker', 'admin', 'courier', 'customer'), async (req, res) => {
  const barcode = String(req.query.code || '').trim();
  if (!barcode) return res.status(400).json({ message: 'Параметр code обязателен' });
  const row = (
    await db.query(
      `
        SELECT *
        FROM products
        WHERE barcode = $1
        LIMIT 1
      `,
      [barcode]
    )
  ).rows[0];
  if (!row) return res.status(404).json({ message: 'Товар по штрихкоду не найден' });
  return res.json({ product: normalizeProductRow(row) });
});

app.get('/api/admin/products', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  if (!(await requireAdminPermission(_req, res, 'manage_products'))) return;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(_req.user!.id);
  const rows =
    allowedWarehouseIds === null
      ? (await db.query('SELECT * FROM products ORDER BY id DESC')).rows
      : (
          await db.query(
            `
              SELECT * FROM products
              WHERE home_warehouse_id = ANY($1)
              ORDER BY id DESC
            `,
            [allowedWarehouseIds.length ? allowedWarehouseIds : [-1]]
          )
        ).rows;
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

app.post('/api/admin/categories', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.patch('/api/admin/categories/rename', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.delete('/api/admin/categories', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.post('/api/admin/products', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const body = req.body as {
    name?: string;
    description?: string;
    price?: number;
    category?: string;
    barcode?: string;
    imageUrl?: string;
    unit?: string;
    inStock?: boolean;
    stockQuantity?: number;
    warehouseId?: number;
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
  if (stockQuantity !== 0) {
    return res.status(400).json({ message: 'Начальный остаток проводится отдельной складской операцией после создания товара' });
  }

  const categoryPath = String(body.category || '').trim();
  if (categoryPath && !(await categoryExists(categoryPath))) {
    return res.status(400).json({ message: 'Категория/подкатегория не найдена в справочнике' });
  }
  const warehouseId = Number(body.warehouseId);
  if (!Number.isFinite(warehouseId) || warehouseId <= 0) return res.status(400).json({ message: 'Выберите склад для товара' });
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;

  const created = await db.query(
    `
      INSERT INTO products (name, description, price, category, barcode, image_url, unit, in_stock, stock_quantity, home_warehouse_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `,
    [
      name,
      body.description?.trim() || null,
      price,
      categoryPath || null,
      String(body.barcode || '').trim() || null,
      body.imageUrl?.trim() || null,
      body.unit?.trim() || 'шт',
      body.inStock !== undefined ? Boolean(body.inStock) : true,
      0,
      warehouseId
    ]
  );

  const createdProduct = normalizeProductRow(created.rows[0]);
  await ensureWarehouseStockRow(db, warehouseId, createdProduct.id);
  await syncProductAvailabilityFromWarehouse(db, createdProduct.id);

  const freshCreated = (await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [createdProduct.id])).rows[0];
  return res.status(201).json({ product: normalizeProductRow(freshCreated) });
});

app.put('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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
    barcode?: string;
    imageUrl?: string;
    unit?: string;
    inStock?: boolean;
    stockQuantity?: number;
    warehouseId?: number;
  };

  const nextName = body.name !== undefined ? String(body.name).trim() : existingRow.name;
  const nextPrice = body.price !== undefined ? Number(body.price) : Number(existingRow.price);
  if (!nextName || Number.isNaN(nextPrice) || nextPrice <= 0) {
    return res.status(400).json({ message: 'Нужны корректные name и price' });
  }

  const nextCategory =
    body.category !== undefined ? String(body.category || '').trim() : String(existingRow.category || '').trim();
  const nextUnit =
    body.unit !== undefined ? String(body.unit || '').trim() : String(existingRow.unit || 'шт').trim() || 'шт';
  if (nextCategory && !(await categoryExists(nextCategory))) {
    return res.status(400).json({ message: 'Категория/подкатегория не найдена в справочнике' });
  }

  const nextStockQuantityRaw =
    body.stockQuantity !== undefined ? Number(body.stockQuantity) : Number(existingRow.stock_quantity ?? 0);
  const nextStockQuantity = Math.floor(nextStockQuantityRaw);
  if (!Number.isFinite(nextStockQuantityRaw) || nextStockQuantity < 0) {
    return res.status(400).json({ message: 'Количество в наличии должно быть целым числом 0 или больше' });
  }
  if (body.stockQuantity !== undefined) {
    return res.status(400).json({ message: 'Остаток нельзя изменять через карточку товара. Используйте складскую операцию.' });
  }

  const existingWarehouseId = existingRow.home_warehouse_id ? toNumber(existingRow.home_warehouse_id) : null;
  const nextWarehouseIdRaw = body.warehouseId !== undefined ? Number(body.warehouseId) : existingWarehouseId;
  if (!nextWarehouseIdRaw) return res.status(400).json({ message: 'У товара должен быть склад' });
  const nextWarehouseId = nextWarehouseIdRaw;
  // запрет смены склада без доступа
  if (!(await assertWarehouseAccess(req, res, nextWarehouseId))) return;
  if (existingWarehouseId && existingWarehouseId !== nextWarehouseId) {
    return res.status(400).json({ message: 'Товар закреплен за складом и не может быть перенесен' });
  }

  const updated = await db.query(
    `
      UPDATE products
      SET name = $1, description = $2, price = $3, category = $4, barcode = $5, image_url = $6, unit = $7, in_stock = $8, home_warehouse_id = $9
      WHERE id = $10
      RETURNING *
    `,
    [
      nextName,
      body.description !== undefined ? body.description?.trim() || null : existingRow.description,
      nextPrice,
      nextCategory || null,
      body.barcode !== undefined ? (String(body.barcode || '').trim() || null) : existingRow.barcode,
      body.imageUrl !== undefined ? body.imageUrl?.trim() || null : existingRow.image_url,
      nextUnit,
      body.inStock !== undefined ? Boolean(body.inStock) : Boolean(existingRow.in_stock),
      nextWarehouseId,
      productId
    ]
  );

  const freshUpdated = (await db.query('SELECT * FROM products WHERE id = $1 LIMIT 1', [productId])).rows[0];
  return res.json({ product: normalizeProductRow(freshUpdated || updated.rows[0]) });
});

app.delete('/api/admin/products/:productId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_products'))) return;
  const productId = Number(req.params.productId);
  if (!productId) return res.status(400).json({ message: 'Некорректный productId' });

  const deleted = await db.query('DELETE FROM products WHERE id = $1 RETURNING id', [productId]);
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Товар не найден' });

  return res.json({ message: 'Товар удален' });
});

app.post('/api/admin/warehouses', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;

  const adminUser = await getUserById(req.user!.id);
  if (!adminUser || !['owner','admin'].includes(adminUser.role)) {
    return res.status(403).json({ message: 'Недостаточно прав' });
  }

  const body = req.body as { code?: string; name?: string; storeId?:number; lat?: number | null; lng?: number | null; isActive?: boolean };
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  const hasLat = body.lat !== undefined && body.lat !== null;
  const hasLng = body.lng !== undefined && body.lng !== null;
  const lat = hasLat ? Number(body.lat) : null;
  const lng = hasLng ? Number(body.lng) : null;
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);
  const storeId=Number(body.storeId);
  if(!storeId)return res.status(400).json({message:'Для склада необходимо выбрать супермаркет'});
  if(!(await hasStoreAccess(db,req.user!.id,storeId)))return res.status(403).json({message:'Нет доступа к выбранному супермаркету'});

  if (!code || code.length < 2 || code.length > 32 || !/^[A-Z0-9_-]+$/.test(code)) {
    return res.status(400).json({ message: 'Код точки должен содержать 2-32 символа: A-Z, 0-9, _, -' });
  }
  if (!name || name.length < 2 || name.length > 120) {
    return res.status(400).json({ message: 'Название точки должно быть от 2 до 120 символов' });
  }
  if (hasLat !== hasLng) {
    return res.status(400).json({ message: 'Координаты lat/lng должны передаваться парой' });
  }
  if (
    (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
    (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты точки' });
  }

  const isChiefAdmin = isSystemAdmin(adminUser);
  if (!isChiefAdmin) {
    const ownedCountRow = (
      await db.query(
        `
          SELECT COUNT(*)::text AS cnt
          FROM warehouses
          WHERE created_by_admin_id = $1
        `,
        [adminUser.id]
      )
    ).rows[0];
    const ownedCount = Number(ownedCountRow?.cnt || '0');
    if (ownedCount >= 1) {
      return res.status(409).json({ message: 'Обычный администратор может создать только одну свою точку' });
    }
  }

  try {
    const created = (
      await db.query(
        `
          INSERT INTO warehouses (code, name, lat, lng, created_by_admin_id, is_active, business_store_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, code, name, lat, lng, is_active, created_by_admin_id
        `,
        [code, name, lat, lng, adminUser.id, isActive,storeId]
      )
    ).rows[0];

    await logAdminAction(req.user!.id, 'warehouse.create', 'warehouse', toNumber(created.id), {
      code,
      name,
      createdByAdminId: adminUser.id
    });

    return res.status(201).json({
      warehouse: {
        id: toNumber(created.id),
        code: String(created.code),
        name: String(created.name),
        lat: created.lat === null ? null : Number(created.lat),
        lng: created.lng === null ? null : Number(created.lng),
        isActive: created.is_active !== false,
        createdByAdminId: created.created_by_admin_id === null ? null : toNumber(created.created_by_admin_id)
      }
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      return res.status(409).json({ message: 'Точка с таким кодом уже существует' });
    }
    return res.status(500).json({ message: 'Не удалось создать точку', error: error instanceof Error ? error.message : 'unknown' });
  }
});

app.get('/api/admin/warehouse/overview', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);

  const [warehouseRows, stockRows, movementRows] = await Promise.all([
    db.query(
      `
        SELECT w.id, w.code, w.name, w.lat, w.lng, w.is_active, w.created_by_admin_id,
               w.business_store_id, s.name AS business_store_name,
               COALESCE(m.status, CASE WHEN w.business_store_id IS NULL THEN 'unresolved' ELSE 'confirmed' END) AS mapping_status
        FROM warehouses w
        LEFT JOIN business_stores s ON s.id=w.business_store_id
        LEFT JOIN legacy_warehouse_store_mapping m ON m.warehouse_id=w.id
        ORDER BY id ASC
      `
    ),
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
          p.unit,
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
          sm.warehouse_id,
          sm.product_id,
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
    unit: row.unit ?? null,
    imageUrl: row.image_url ?? null,
    quantity: toNumber(row.quantity),
    reservedQuantity: toNumber(row.reserved_quantity),
    availableQuantity: toNumber(row.available_quantity),
    reorderMin: toNumber(row.reorder_min),
    reorderTarget: toNumber(row.reorder_target),
    updatedAt: toDateString(row.updated_at)
  }));

  const scopedStock = allowedWarehouseIds === null
    ? stock
    : stock.filter((item) => allowedWarehouseIds.includes(item.warehouseId));

  const lowStock = scopedStock
    .filter((item) => item.availableQuantity < item.reorderMin)
    .map((item) => ({
      ...item,
      orderSuggestion: Math.max(item.reorderTarget - item.availableQuantity, 0)
    }));

  return res.json({
    warehouses: warehouseRows.rows
      .map((row: any) => ({
        id: toNumber(row.id),
        code: String(row.code),
        name: String(row.name),
        lat: row.lat === null ? null : Number(row.lat),
        lng: row.lng === null ? null : Number(row.lng),
        isActive: row.is_active !== false,
        createdByAdminId: row.created_by_admin_id === null ? null : toNumber(row.created_by_admin_id),
        storeId: row.business_store_id === null ? null : toNumber(row.business_store_id),
        storeName: row.business_store_name ?? null,
        mappingStatus: String(row.mapping_status)
      }))
      .filter((w) => (allowedWarehouseIds === null ? true : allowedWarehouseIds.includes(w.id))),
    stock: scopedStock,
    lowStock,
    movements: movementRows.rows
      .map((row: any) => ({
        id: toNumber(row.id),
        warehouseId: toNumber(row.warehouse_id ?? 0),
        productId: toNumber(row.product_id ?? 0),
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
      .filter((m) => (allowedWarehouseIds === null ? true : allowedWarehouseIds.includes(m.warehouseId)))
  });
});

app.get('/api/admin/warehouse/consistency', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);
  const rows = await inventoryConsistencyReport(db);
  const scoped = allowedWarehouseIds === null ? rows : rows.filter((row) => allowedWarehouseIds.includes(row.warehouseId));
  return res.json({
    rows: scoped,
    consistent: scoped.every((row) => row.consistent),
    historicalJournalComplete: false,
    note: 'Исторический журнал до миграции этапа 1 может быть неполным; автоматическое исправление не выполняется.'
  });
});

app.get('/api/admin/warehouse/purchase-drafts', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);
  const rows = (
    await db.query(
      `
        SELECT d.id, d.warehouse_id, d.status, d.created_by, d.items_json, d.created_at, d.updated_at,
               w.name AS warehouse_name,
               u.full_name AS created_by_name
        FROM warehouse_purchase_drafts d
        LEFT JOIN warehouses w ON w.id = d.warehouse_id
        LEFT JOIN users u ON u.id = d.created_by
        ORDER BY d.id DESC
        LIMIT 100
      `
    )
  ).rows.filter((row: any) => (allowedWarehouseIds === null ? true : allowedWarehouseIds.includes(toNumber(row.warehouse_id))));
  return res.json({
    drafts: rows.map((row: any) => ({
      id: toNumber(row.id),
      warehouseId: row.warehouse_id === null ? null : toNumber(row.warehouse_id),
      warehouseName: row.warehouse_name ?? null,
      status: String(row.status || 'draft'),
      createdBy: row.created_by === null ? null : toNumber(row.created_by),
      createdByName: row.created_by_name ?? null,
      items: Array.isArray(row.items_json) ? row.items_json : [],
      createdAt: toDateString(row.created_at),
      updatedAt: toDateString(row.updated_at)
    }))
  });
});

app.post('/api/admin/warehouse/purchase-drafts/from-low-stock', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as { warehouseId?: number | null };
  const warehouseId = body.warehouseId ? Number(body.warehouseId) : null;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);
  if (warehouseId && allowedWarehouseIds !== null && !allowedWarehouseIds.includes(warehouseId)) {
    return res.status(403).json({ message: 'Нет доступа к выбранному складу' });
  }

  const params: any[] = [];
  let whereSql = '';
  if (warehouseId) {
    params.push(warehouseId);
    whereSql = 'WHERE ws.warehouse_id = $1';
  } else if (allowedWarehouseIds !== null) {
    params.push(allowedWarehouseIds.length ? allowedWarehouseIds : [-1]);
    whereSql = 'WHERE ws.warehouse_id = ANY($1)';
  }

  const rows = (
    await db.query(
      `
        SELECT ws.warehouse_id,
               w.name AS warehouse_name,
               ws.product_id,
               p.name AS product_name,
               ws.reorder_target,
               GREATEST(ws.quantity - ws.reserved_quantity, 0) AS available_quantity
        FROM warehouse_stock ws
        JOIN warehouses w ON w.id = ws.warehouse_id
        JOIN products p ON p.id = ws.product_id
        ${whereSql}
        ORDER BY ws.warehouse_id ASC, p.name ASC
      `,
      params
    )
  ).rows;

  const lowItems = rows
    .map((row: any) => ({
      warehouseId: toNumber(row.warehouse_id),
      warehouseName: String(row.warehouse_name || ''),
      productId: toNumber(row.product_id),
      productName: String(row.product_name || ''),
      availableQuantity: toNumber(row.available_quantity),
      reorderTarget: toNumber(row.reorder_target),
      orderSuggestion: Math.max(toNumber(row.reorder_target) - toNumber(row.available_quantity), 0)
    }))
    .filter((item) => item.orderSuggestion > 0);

  if (!lowItems.length) {
    return res.status(409).json({ message: 'Нет товаров для автопополнения' });
  }

  const grouped = new Map<number, typeof lowItems>();
  for (const item of lowItems) {
    if (!grouped.has(item.warehouseId)) grouped.set(item.warehouseId, []);
    grouped.get(item.warehouseId)!.push(item);
  }

  const createdDrafts: any[] = [];
  for (const [wId, items] of grouped.entries()) {
    const created = (
      await db.query(
        `
          INSERT INTO warehouse_purchase_drafts (warehouse_id, status, created_by, items_json)
          VALUES ($1, 'draft', $2, $3::jsonb)
          RETURNING *
        `,
        [wId, req.user!.id, JSON.stringify(items)]
      )
    ).rows[0];
    createdDrafts.push({
      id: toNumber(created.id),
      warehouseId: toNumber(created.warehouse_id),
      status: String(created.status),
      items
    });
  }

  await createNotificationForAdmins({
    level: 'warning',
    title: 'Создан черновик закупки по низким остаткам',
    body: `Черновиков: ${createdDrafts.length}`,
    entityType: 'purchase_draft',
    entityId: createdDrafts[0]?.id ?? null
  });

  return res.status(201).json({ drafts: createdDrafts });
});

app.get('/api/admin/stock/movements', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);

  const query = req.query as Record<string, string | undefined>;
  const warehouseId = Number(query.warehouseId || 0);
  const productQuery = String(query.product || '').trim();
  const movementType = String(query.movementType || '').trim().toLowerCase();
  const documentId = String(query.documentId || '').trim();
  const dateFromRaw = String(query.dateFrom || '').trim();
  const dateToRaw = String(query.dateTo || '').trim();
  const limitRaw = Number(query.limit || 200);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 1000) : 200;

  const allowedMovementTypes = new Set(['receive', 'writeoff', 'reserve', 'release', 'pick', 'opening_balance', 'receipt', 'transfer', 'stocktake', 'reversal']);
  if (movementType && !allowedMovementTypes.has(movementType)) {
    return res.status(400).json({ message: 'Некорректный movementType' });
  }
  if (warehouseId && allowedWarehouseIds !== null && !allowedWarehouseIds.includes(warehouseId)) {
    return res.status(403).json({ message: 'Нет доступа к выбранному складу' });
  }
  if (documentId && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(documentId)) return res.status(400).json({ message: 'Некорректный documentId' });

  let dateFrom: Date | null = null;
  let dateTo: Date | null = null;
  if (dateFromRaw) {
    dateFrom = new Date(dateFromRaw);
    if (Number.isNaN(dateFrom.getTime())) return res.status(400).json({ message: 'Некорректный dateFrom' });
  }
  if (dateToRaw) {
    dateTo = new Date(dateToRaw);
    if (Number.isNaN(dateTo.getTime())) return res.status(400).json({ message: 'Некорректный dateTo' });
  }

  const params: any[] = [];
  const where: string[] = [];

  if (warehouseId) {
    params.push(warehouseId);
    where.push(`sm.warehouse_id = $${params.length}`);
  }
  if (!warehouseId) {
    applyWarehouseScopeToQuery(where, params, allowedWarehouseIds, 'sm.warehouse_id');
  }
  if (movementType) {
    params.push(movementType);
    where.push(`sm.movement_type = $${params.length}`);
  }
  if (documentId) {
    params.push(documentId);
    where.push(`sm.document_id = $${params.length}::uuid`);
  }
  if (productQuery) {
    params.push(`%${productQuery}%`);
    params.push(`%${productQuery}%`);
    where.push(`(p.name ILIKE $${params.length - 1} OR CAST(p.id AS TEXT) ILIKE $${params.length})`);
  }
  if (dateFrom) {
    params.push(dateFrom.toISOString());
    where.push(`sm.created_at >= $${params.length}::timestamptz`);
  }
  if (dateTo) {
    params.push(dateTo.toISOString());
    where.push(`sm.created_at <= $${params.length}::timestamptz`);
  }

  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = (await db.query(
    `
      SELECT
        sm.id,
        sm.warehouse_id,
        sm.product_id,
        sm.movement_type,
        sm.quantity,
        sm.reason,
        sm.reference_type,
        sm.reference_id,
        sm.document_id,
        sm.operation_id,
        sm.unit_cost,
        sm.value_delta,
        sm.created_at,
        w.name AS warehouse_name,
        p.name AS product_name,
        u.full_name AS created_by_name
      FROM stock_movements sm
      JOIN warehouses w ON w.id = sm.warehouse_id
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN users u ON u.id = sm.created_by
      ${whereSql}
      ORDER BY sm.id DESC
      LIMIT $${params.length}
    `,
    params
  )).rows;

  return res.json({
    movements: rows.map((row: any) => ({
      id: toNumber(row.id),
      warehouseId: toNumber(row.warehouse_id),
      productId: toNumber(row.product_id),
      movementType: String(row.movement_type),
      quantity: String(row.quantity),
      reason: row.reason ?? null,
      referenceType: row.reference_type ?? null,
      referenceId: row.reference_id === null ? null : toNumber(row.reference_id),
      documentId: row.document_id ?? null,
      operationId: row.operation_id ?? null,
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      valueDelta: row.value_delta === null ? null : String(row.value_delta),
      warehouseName: String(row.warehouse_name),
      productName: String(row.product_name),
      createdBy: row.created_by_name ?? null,
      createdAt: toDateString(row.created_at)
    }))
  });
});

app.patch('/api/admin/warehouses/:warehouseId/location', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const warehouseId = Number(req.params.warehouseId);
  if (!warehouseId) return res.status(400).json({ message: 'Некорректный warehouseId' });
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;

  const body = req.body as { lat?: number; lng?: number };
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ message: 'Нужны корректные координаты lat/lng' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const existing = (await client.query(
      'SELECT id, code, name FROM warehouses WHERE id = $1 LIMIT 1',
      [warehouseId]
    )).rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Склад не найден' });
    }

    const updated = (await client.query(
      `
        UPDATE warehouses
        SET lat = $1, lng = $2
        WHERE id = $3
        RETURNING id, code, name, lat, lng, is_active
      `,
      [lat, lng, warehouseId]
    )).rows[0];

    await client.query('COMMIT');

    let mapSynchronized=true;
    try {
      const mapUpdate = await mapDb.query(`UPDATE public.warehouses SET geom=ST_SetSRID(ST_MakePoint($1,$2),4326) WHERE lower(name)=lower($3)`,[lng,lat,String(existing.name)]);
      if(!mapUpdate.rowCount)await mapDb.query(`INSERT INTO public.warehouses(name,geom) VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326))`,[String(existing.name),lng,lat]);
    } catch(mapError){mapSynchronized=false;console.warn('Optional map warehouse location sync failed:',mapError instanceof Error?mapError.message:'unknown')}

    await logAdminAction(req.user!.id, 'warehouse.location_update', 'warehouse', warehouseId, {
      code: String(existing.code),
      name: String(existing.name),
      lat,
      lng
    });

    return res.json({
      warehouse: {
        id: toNumber(updated.id),
        code: String(updated.code),
        name: String(updated.name),
        lat: updated.lat === null ? null : Number(updated.lat),
        lng: updated.lng === null ? null : Number(updated.lng),
        isActive: updated.is_active !== false
      },
      mapSynchronized,
      warning: mapSynchronized?null:'Координаты сохранены, но синхронизация с картографическим сервисом временно недоступна'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось обновить координаты склада', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/warehouses/:warehouseId/location', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const warehouseId = Number(req.params.warehouseId);
  if (!warehouseId) return res.status(400).json({ message: 'Некорректный warehouseId' });
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT id, code, name FROM warehouses WHERE id = $1 LIMIT 1',
      [warehouseId]
    )).rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Склад не найден' });
    }

    await client.query(
      `
        UPDATE warehouses
        SET lat = NULL, lng = NULL
        WHERE id = $1
      `,
      [warehouseId]
    );

    await client.query('COMMIT');

    let mapSynchronized=true;
    try{await mapDb.query('DELETE FROM public.warehouses WHERE lower(name) = lower($1)',[String(existing.name)])}catch(mapError){mapSynchronized=false;console.warn('Optional map warehouse location delete sync failed:',mapError instanceof Error?mapError.message:'unknown')}

    await logAdminAction(req.user!.id, 'warehouse.location_delete', 'warehouse', warehouseId, {
      code: String(existing.code),
      name: String(existing.name)
    });

    return res.json({ message: 'Точка склада удалена',mapSynchronized,warning:mapSynchronized?null:'Основная запись удалена, но картографический сервис временно недоступен' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось удалить точку склада', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/pick-tasks', authRequired(JWT_SECRET), roleRequired('admin', 'picker'), async (req, res) => {
  let whereSql = '';
  let params: any[] = [];

  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
    const allowedWarehouseIds = await getAdminWarehouseScopeIds(req.user!.id);
    const where: string[] = [];
    applyWarehouseScopeToQuery(where, params, allowedWarehouseIds, 'pt.warehouse_id');
    whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  } else {
    // picker: видит все свои задачи
    whereSql = `WHERE pt.assigned_to = $1`;
    params = [req.user!.id];
  }

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
      ${whereSql}
      ORDER BY pt.id DESC
      LIMIT 120
    `,
    params
  )).rows;

  const itemRows = (await db.query(
    `
      SELECT
        pti.id,
        pti.pick_task_id,
        pti.product_id,
        pti.product_name,
        pti.requested_qty,
        pti.picked_qty,
        pti.result_status,
        pti.substitute_product_name,
        pti.result_note,
        pti.barcode_scanned
      FROM pick_task_items pti
      ORDER BY pti.pick_task_id DESC, pti.id ASC
    `
  )).rows;

  const itemsByTask = new Map<number, Array<{
    id: number;
    productId: number;
    productName: string;
    requestedQty: number;
    pickedQty: number;
    resultStatus: string;
    substituteProductName: string | null;
    resultNote: string | null;
    barcodeScanned: string | null;
  }>>();
  for (const row of itemRows) {
    const taskId = toNumber(row.pick_task_id);
    if (!itemsByTask.has(taskId)) itemsByTask.set(taskId, []);
    itemsByTask.get(taskId)!.push({
      id: toNumber(row.id),
      productId: toNumber(row.product_id),
      productName: String(row.product_name),
      requestedQty: toNumber(row.requested_qty),
      pickedQty: toNumber(row.picked_qty),
      resultStatus: String(row.result_status || 'pending'),
      substituteProductName: row.substitute_product_name ?? null,
      resultNote: row.result_note ?? null,
      barcodeScanned: row.barcode_scanned ?? null
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

app.get('/api/admin/suppliers', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const includeArchived = String(req.query.includeArchived || '') === 'true';
  const rows = (await db.query(
    `SELECT s.*, EXISTS(SELECT 1 FROM inventory_documents d WHERE d.supplier_id=s.id) AS linked
     FROM suppliers s WHERE ($1::boolean OR s.archived_at IS NULL) ORDER BY s.archived_at NULLS FIRST,s.name`, [includeArchived]
  )).rows;
  return res.json({ suppliers: rows });
});

app.post('/api/admin/suppliers', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const body = req.body as Record<string, unknown>;
  const name = String(body.name || '').trim();
  if (!name) return res.status(400).json({ message: 'Название поставщика обязательно' });
  const created = (await db.query(
    `INSERT INTO suppliers(name,tax_id,phone,email,address,comment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name,String(body.taxId||'').trim()||null,String(body.phone||'').trim()||null,String(body.email||'').trim()||null,String(body.address||'').trim()||null,String(body.comment||'').trim()||null,req.user!.id]
  )).rows[0];
  await logAdminAction(req.user!.id,'supplier.create','supplier',toNumber(created.id),{name});
  return res.status(201).json({ supplier: created });
});

app.put('/api/admin/suppliers/:supplierId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const id=Number(req.params.supplierId),body=req.body as Record<string,unknown>,name=String(body.name||'').trim();
  if(!id||!name)return res.status(400).json({message:'Некорректный поставщик или пустое название'});
  const updated=(await db.query(`UPDATE suppliers SET name=$1,tax_id=$2,phone=$3,email=$4,address=$5,comment=$6,updated_at=NOW() WHERE id=$7 RETURNING *`,[name,String(body.taxId||'').trim()||null,String(body.phone||'').trim()||null,String(body.email||'').trim()||null,String(body.address||'').trim()||null,String(body.comment||'').trim()||null,id])).rows[0];
  if(!updated)return res.status(404).json({message:'Поставщик не найден'});await logAdminAction(req.user!.id,'supplier.update','supplier',id,{name});return res.json({supplier:updated});
});

app.delete('/api/admin/suppliers/:supplierId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  const id=Number(req.params.supplierId);if(!id)return res.status(400).json({message:'Некорректный supplierId'});
  const updated=(await db.query(`UPDATE suppliers SET archived_at=COALESCE(archived_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING id`,[id])).rows[0];
  if(!updated)return res.status(404).json({message:'Поставщик не найден'});await logAdminAction(req.user!.id,'supplier.archive','supplier',id,{});return res.json({message:'Поставщик помещён в архив'});
});

app.get('/api/admin/inventory/documents', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  return res.json({documents:await listInventoryDocuments(db,await getAdminWarehouseScopeIds(req.user!.id))});
});

app.get('/api/admin/inventory/documents/:documentId', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  const doc=await getInventoryDocument(db,String(req.params.documentId));
  for(const wid of [doc.source_warehouse_id,doc.destination_warehouse_id].filter(Boolean))if(!(await assertWarehouseAccess(req,res,Number(wid))))return;
  return res.json({document:doc});
});

app.post('/api/admin/inventory/documents', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  const body=req.body as DraftInput;
  for(const wid of [body.sourceWarehouseId,body.destinationWarehouseId].filter(Boolean))if(!(await assertWarehouseOperation(req,res,Number(wid))))return;
  const result=await createInventoryDraft(db,body,req.user!.id);await logAdminAction(req.user!.id,'inventory_document.create','inventory_document',null,{documentId:result.id,type:body.documentType});return res.status(201).json(result);
});

app.put('/api/admin/inventory/documents/:documentId', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  const body=req.body as DraftInput&{version?:number};for(const wid of [body.sourceWarehouseId,body.destinationWarehouseId].filter(Boolean))if(!(await assertWarehouseOperation(req,res,Number(wid))))return;
  return res.json(await updateInventoryDraft(db,String(req.params.documentId),Number(body.version),body,req.user!.id));
});

app.post('/api/admin/inventory/documents/:documentId/post', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  const id=String(req.params.documentId),doc=await getInventoryDocument(db,id);for(const wid of [doc.source_warehouse_id,doc.destination_warehouse_id].filter(Boolean))if(!(await assertWarehouseOperation(req,res,Number(wid))))return;
  const result=await postInventoryDocument(db,id,String(req.headers['x-idempotency-key']||''),req.user!.id);await logAdminAction(req.user!.id,'inventory_document.post','inventory_document',null,{documentId:id,operationId:result.operationId,reused:result.reused});return res.status(result.reused?200:201).json(result);
});

app.post('/api/admin/inventory/documents/:documentId/cancel', authRequired(JWT_SECRET), roleRequired('admin'), async (req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;
  const id=String(req.params.documentId),doc=await getInventoryDocument(db,id);for(const wid of [doc.source_warehouse_id,doc.destination_warehouse_id].filter(Boolean))if(!(await assertWarehouseOperation(req,res,Number(wid))))return;
  const result=await cancelInventoryDocument(db,id,String(req.headers['x-idempotency-key']||''),req.user!.id);await logAdminAction(req.user!.id,'inventory_document.cancel','inventory_document',null,{documentId:id,...result});return res.json(result);
});

app.get('/api/admin/inventory/valuation', authRequired(JWT_SECRET), roleRequired('admin'), async(req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;return res.json({rows:await inventoryValuationReport(db,await getAdminWarehouseScopeIds(req.user!.id)),historicalJournalComplete:false});
});

app.get('/api/admin/inventory/reservations', authRequired(JWT_SECRET), roleRequired('admin'), async(req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;const allowed=await getAdminWarehouseScopeIds(req.user!.id),params:any[]=[];const where=allowed===null?'':(params.push(allowed),`AND r.warehouse_id=ANY($1::bigint[])`);
  const rows=(await db.query(`SELECT r.id,r.warehouse_id,w.name warehouse_name,r.product_id,p.name product_name,r.quantity::text quantity,r.original_quantity::text original_quantity,r.status,r.reason,r.order_id,r.pick_task_id,r.created_at FROM inventory_reservations r JOIN warehouses w ON w.id=r.warehouse_id JOIN products p ON p.id=r.product_id WHERE r.status='active' ${where} ORDER BY r.created_at DESC`,params)).rows;return res.json({reservations:rows});
});

app.post('/api/admin/inventory/reservations/:reservationId/release', authRequired(JWT_SECRET), roleRequired('admin'), async(req,res)=>{
  if (!(await requireAdminPermission(req,res,'manage_warehouse'))) return;const id=Number(req.params.reservationId),body=req.body as{quantity?:string;reason?:string};const row=(await db.query(`SELECT warehouse_id FROM inventory_reservations WHERE id=$1`,[id])).rows[0];if(!row)return res.status(404).json({message:'Резерв не найден'});if(!(await assertWarehouseOperation(req,res,Number(row.warehouse_id))))return;const reason=String(body.reason||'').trim();if(!reason)return res.status(400).json({message:'Причина снятия резерва обязательна'});const result=await releaseManualReservation(db,{reservationId:id,quantity:String(body.quantity||''),reason,idempotencyKey:String(req.headers['x-idempotency-key']||''),createdBy:req.user!.id});await logAdminAction(req.user!.id,'inventory_reservation.release','inventory_reservation',id,{quantity:String(body.quantity),reason,operationId:result.operationId});return res.status(result.reused?200:201).json(result);
});

app.post('/api/admin/stock/receive', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  return res.status(410).json({ message: 'Прямая приёмка отключена. Создайте и проведите документ «Приёмка».' });
  /* legacy parser retained temporarily for client compatibility diagnostics; unreachable by design */
  const body = req.body as { warehouseId?: number; productId?: number; quantity?: number; reason?: string };
  const productId = Number(body.productId);
  const quantity = Math.floor(Number(body.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Нужны корректные productId и quantity > 0' });
  }

  const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(db);
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;
  const operation = await postSingleStockOperation(db, {
    operationType: 'receive',
    idempotencyKey: String(req.headers['x-idempotency-key'] || ''),
    payload: { warehouseId, productId, quantity, reason: String(body.reason || '').trim() || null },
    warehouseId,
    productId,
    quantity,
    reason: String(body.reason || '').trim() || null,
    referenceType: 'manual_receive',
    createdBy: req.user!.id
  });
  return res.status(operation.reused ? 200 : 201).json({
    message: operation.reused ? 'Приемка уже была проведена' : 'Приемка проведена',
    operationId: operation.operationId,
    reused: operation.reused
  });
});

app.post('/api/admin/stock/writeoff', authRequired(JWT_SECRET), roleRequired('admin'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  return res.status(410).json({ message: 'Прямое списание отключено. Создайте и проведите документ «Списание».' });
  /* legacy parser retained temporarily for client compatibility diagnostics; unreachable by design */
  const body = req.body as { warehouseId?: number; productId?: number; quantity?: number; reason?: string };
  const productId = Number(body.productId);
  const quantity = Math.floor(Number(body.quantity));
  if (!productId || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Нужны корректные productId и quantity > 0' });
  }

  const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(db);
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;
  const operation = await postSingleStockOperation(db, {
    operationType: 'writeoff',
    idempotencyKey: String(req.headers['x-idempotency-key'] || ''),
    payload: { warehouseId, productId, quantity, reason: String(body.reason || '').trim() || null },
    warehouseId,
    productId,
    quantity,
    reason: String(body.reason || '').trim() || null,
    referenceType: 'manual_writeoff',
    createdBy: req.user!.id
  });
  return res.status(operation.reused ? 200 : 201).json({
    message: operation.reused ? 'Списание уже было проведено' : 'Списание проведено',
    operationId: operation.operationId,
    reused: operation.reused
  });
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

  const warehouseId = body.warehouseId ? Number(body.warehouseId) : await getDefaultWarehouseId(db);
  if (!(await assertWarehouseAccess(req, res, warehouseId))) return;
  const operation = await postSingleStockOperation(db, {
    operationType: 'manual_reserve',
    idempotencyKey: String(req.headers['x-idempotency-key'] || ''),
    payload: {
      warehouseId,
      productId,
      quantity,
      reason: String(body.reason || '').trim() || null,
      referenceType: String(body.referenceType || '').trim() || null,
      referenceId: body.referenceId ? Number(body.referenceId) : null
    },
    warehouseId,
    productId,
    quantity,
    reason: String(body.reason || '').trim() || null,
    referenceType: String(body.referenceType || '').trim() || 'manual_reserve',
    referenceId: body.referenceId ? Number(body.referenceId) : null,
    createdBy: req.user!.id
  });
  return res.status(operation.reused ? 200 : 201).json({
    message: operation.reused ? 'Резерв уже был создан' : 'Резерв создан',
    operationId: operation.operationId,
    reused: operation.reused
  });
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
    if (!(await assertWarehouseAccess(req, res, warehouseId))) {
      await client.query('ROLLBACK');
      return;
    }
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

    const taskId = await createPickTaskInternal(
      client,
      orderId,
      warehouseId,
      req.user!.id,
      body.assignedTo ? Number(body.assignedTo) : null
    );
    await client.query('COMMIT');
    notifyOrderUpdated(orderId, 'picking_updated');
    return res.status(201).json({ message: 'Задача сборки создана', taskId });
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as any)?.code === '23505') {
      return res.status(409).json({ message: 'Задача сборки для заказа уже существует' });
    }
    if (error instanceof Error && /У сборщика уже есть активная задача/i.test(error.message)) {
      return res.status(409).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Не удалось создать задачу сборки', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/pick-tasks/:taskId', authRequired(JWT_SECRET), roleRequired('admin', 'picker'), async (req, res) => {
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  }
  const taskId = Number(req.params.taskId);
  if (!taskId) return res.status(400).json({ message: 'Некорректный taskId' });
  const body = req.body as { status?: 'new' | 'in_progress' | 'done' | 'handed_to_courier' | 'cancelled'; assignedTo?: number | null };
  const status = String(body.status || '').trim();
  if (!['new', 'in_progress', 'done', 'handed_to_courier', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'Некорректный статус задачи сборки' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const task = (await client.query(
      `
        SELECT id, warehouse_id, order_id, status, assigned_to
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
    if (req.user!.role === 'admin') {
      if (!(await assertWarehouseAccess(req, res, toNumber(task.warehouse_id)))) {
        await client.query('ROLLBACK');
        return;
      }
    } else {
      // picker: может менять только свои или свободные задачи
      if (task.assigned_to !== null && toNumber(task.assigned_to) !== req.user!.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'Задача уже назначена другому сборщику' });
      }
      // назначение всегда на себя
      body.assignedTo = req.user!.id;
    }

    const currentStatus = String(task.status);
    if (['cancelled', 'handed_to_courier'].includes(currentStatus) && currentStatus !== status) {
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
    if (status === 'handed_to_courier' && !['done', 'handed_to_courier'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Отдать курьеру можно только после завершения сборки' });
    }
    if (status === 'cancelled' && !['new', 'in_progress', 'cancelled'].includes(currentStatus)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Задачу можно отменить только из статусов new/in_progress' });
    }

    if (status === 'done' && currentStatus !== 'done') {
      await consumePickTaskReservations(client, toNumber(task.order_id), taskId, req.user!.id);
      await client.query('UPDATE pick_task_items SET picked_qty = requested_qty WHERE pick_task_id = $1', [taskId]);
    }

    if (status === 'cancelled' && currentStatus !== 'cancelled') {
      await releaseOrderReservations(client, toNumber(task.order_id), taskId, req.user!.id);
    }

    const nextAssignedTo = body.assignedTo === undefined ? (task.assigned_to === null ? null : toNumber(task.assigned_to)) : body.assignedTo;
    const nextStatus = String(status);
    if (nextAssignedTo && ['new', 'in_progress'].includes(nextStatus)) {
      const conflictTaskId = await pickerHasAnotherActiveTask(client, Number(nextAssignedTo), { excludeTaskId: taskId });
      if (conflictTaskId) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: `У сборщика уже есть активная задача #${conflictTaskId}` });
      }
    }

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
    notifyOrderUpdated(toNumber(task.order_id), 'picking_updated');
    await tryAssignOldestPendingPickTask();
    return res.json({ message: 'Задача сборки обновлена' });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return res.status(500).json({ message: 'Не удалось обновить задачу сборки', error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    client.release();
  }
});

app.patch('/api/admin/pick-tasks/:taskId/items/:itemId', authRequired(JWT_SECRET), roleRequired('admin', 'picker'), async (req, res) => {
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_warehouse'))) return;
  }
  const taskId = Number(req.params.taskId);
  const itemId = Number(req.params.itemId);
  if (!taskId || !itemId) return res.status(400).json({ message: 'Некорректный taskId или itemId' });
  const body = req.body as {
    resultStatus?: 'pending' | 'picked' | 'substituted' | 'missing';
    substituteProductName?: string | null;
    resultNote?: string | null;
    barcode?: string | null;
  };
  const resultStatus = String(body.resultStatus || '').trim().toLowerCase();
  if (!['pending', 'picked', 'substituted', 'missing'].includes(resultStatus)) {
    return res.status(400).json({ message: 'Некорректный resultStatus' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const task = (
      await client.query(
        `
          SELECT id, warehouse_id, order_id, assigned_to
          FROM pick_tasks
          WHERE id = $1
          FOR UPDATE
        `,
        [taskId]
      )
    ).rows[0];
    if (!task) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Задача сборки не найдена' });
    }
    if (req.user!.role === 'admin') {
      if (!(await assertWarehouseAccess(req, res, toNumber(task.warehouse_id)))) {
        await client.query('ROLLBACK');
        return;
      }
    } else if (task.assigned_to !== null && toNumber(task.assigned_to) !== req.user!.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Задача уже назначена другому сборщику' });
    }

    const existingItem = (
      await client.query(
        `
          SELECT id, product_id, requested_qty
          FROM pick_task_items
          WHERE id = $1 AND pick_task_id = $2
          FOR UPDATE
        `,
        [itemId, taskId]
      )
    ).rows[0];
    if (!existingItem) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Позиция задачи не найдена' });
    }
    const requestedQty = toNumber(existingItem.requested_qty);
    const pickedQty = resultStatus === 'missing' || resultStatus === 'pending' ? 0 : requestedQty;
    const substituteProductName =
      resultStatus === 'substituted' ? (String(body.substituteProductName || '').trim() || 'Замена') : null;
    const resultNote = String(body.resultNote || '').trim() || null;
    const barcode = String(body.barcode || '').trim() || null;

    await client.query(
      `
        UPDATE pick_task_items
        SET result_status = $1,
            substitute_product_name = $2,
            result_note = $3,
            barcode_scanned = $4,
            picked_qty = $5
        WHERE id = $6
      `,
      [resultStatus, substituteProductName, resultNote, barcode, pickedQty, itemId]
    );
    await client.query('COMMIT');
    notifyOrderUpdated(toNumber(task.order_id), 'picking_updated');

    if (resultStatus === 'substituted' || resultStatus === 'missing') {
      const order = (await db.query('SELECT user_id FROM orders WHERE id = $1 LIMIT 1', [toNumber(task.order_id)])).rows[0];
      if (order?.user_id) {
        await createNotification({
          userId: toNumber(order.user_id),
          level: resultStatus === 'missing' ? 'warning' : 'info',
          title: resultStatus === 'missing' ? `Позиция недоступна в заказе #${toNumber(task.order_id)}` : `В заказе #${toNumber(task.order_id)} предложена замена`,
          body:
            resultStatus === 'missing'
              ? `Товар не найден на складе. ${resultNote || ''}`.trim()
              : `Замена: ${substituteProductName || 'выбрана'}. ${resultNote || ''}`.trim(),
          entityType: 'order',
          entityId: toNumber(task.order_id)
        });
      }
    }

    return res.json({ message: 'Позиция задачи обновлена' });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(500).json({ message: 'Не удалось обновить позицию задачи', error: error instanceof Error ? error.message : 'unknown' });
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

    const imageUrl = `/uploads/${file.filename}`;
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

    const imageUrl = `/uploads/${file.filename}`;
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
  const revertState = await evaluateCourierCustomerRevert(req.user!.id, courierRow);

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
      isEligible: courierEligible(courierRow),
      lastSeenAt: courierRow.last_seen_at ? new Date(courierRow.last_seen_at).toISOString() : null,
      isOnline: courierIsOnline(courierRow),
      merchantStoreStatus: revertState.merchantStoreStatus,
      canRevertToCustomer: revertState.canRevertToCustomer,
      revertToCustomerReason: revertState.revertToCustomerReason
    }
  });
});

app.post('/api/couriers/revert-to-customer', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const userId = req.user!.id;
  const courierRow = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [userId])).rows[0];
  if (!courierRow) return res.status(404).json({ message: 'Профиль курьера не найден' });

  const revertState = await evaluateCourierCustomerRevert(userId, courierRow);
  if (!revertState.canRevertToCustomer) {
    return res.status(409).json({ message: revertState.revertToCustomerReason || 'Смена роли недоступна' });
  }

  await db.query("UPDATE users SET role = 'customer' WHERE id = $1", [userId]);
  await db.query("UPDATE couriers SET status = 'offline', last_seen_at = NOW() WHERE user_id = $1", [userId]);

  const updatedUser = await getUserById(userId);
  if (!updatedUser) return res.status(404).json({ message: 'Пользователь не найден' });

  return res.json({
    message: 'Вы снова покупатель',
    token: buildToken(updatedUser, JWT_SECRET),
    user: publicUser(updatedUser)
  });
});

app.get('/api/stores/couriers', authRequired(JWT_SECRET), roleRequired('customer'), async (_req, res) => {
  const rows = (
    await db.query(
      `
        SELECT c.id,
               c.vehicle_type,
               c.status,
               c.verification_status,
               c.last_seen_at,
               u.full_name,
               u.email,
               u.phone
        FROM couriers c
        JOIN users u ON u.id = c.user_id
        WHERE c.verification_status = 'approved'
        ORDER BY c.id DESC
        LIMIT 500
      `
    )
  ).rows;

  return res.json({
    couriers: rows.map((row: any) => ({
      id: toNumber(row.id),
      fullName: String(row.full_name || ''),
      email: String(row.email || ''),
      phone: row.phone ?? null,
      vehicleType: row.vehicle_type ?? null,
      status: String(row.status || 'offline'),
      isOnline: courierIsOnline(row)
    }))
  });
});

app.post('/api/couriers/me/heartbeat', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const body = req.body as { busy?: boolean; lat?: number | null; lng?: number | null };
  const courierRow = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courierRow) return res.status(404).json({ message: 'Профиль курьера не найден' });

  const nextStatus = body.busy ? 'busy' : 'available';
  if (nextStatus === 'available' && !courierEligible(courierRow)) {
    return res.status(403).json({ message: 'Сначала пройдите верификацию курьера' });
  }

  const hasLat = body.lat !== undefined && body.lat !== null;
  const hasLng = body.lng !== undefined && body.lng !== null;
  if (hasLat !== hasLng) return res.status(400).json({ message: 'Координаты lat/lng должны передаваться парой' });
  const nextLat = hasLat ? Number(body.lat) : null;
  const nextLng = hasLng ? Number(body.lng) : null;
  if (
    (nextLat !== null && (!Number.isFinite(nextLat) || nextLat < -90 || nextLat > 90)) ||
    (nextLng !== null && (!Number.isFinite(nextLng) || nextLng < -180 || nextLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты курьера' });
  }

  const updated = (
    await db.query(
      `
        UPDATE couriers
        SET status = $1,
            last_seen_at = NOW(),
            current_lat = CASE WHEN $3::double precision IS NULL THEN current_lat ELSE $3::double precision END,
            current_lng = CASE WHEN $4::double precision IS NULL THEN current_lng ELSE $4::double precision END,
            current_location_updated_at = CASE WHEN $3::double precision IS NULL THEN current_location_updated_at ELSE NOW() END
        WHERE id = $2
        RETURNING *
      `,
      [nextStatus, toNumber(courierRow.id), nextLat, nextLng]
    )
  ).rows[0];

  return res.json({
    status: nextStatus,
    isOnline: courierIsOnline(updated),
    lastSeenAt: updated.last_seen_at ? new Date(updated.last_seen_at).toISOString() : null,
    location: updated.current_lat === null || updated.current_lng === null
      ? null
      : { lat: Number(updated.current_lat), lng: Number(updated.current_lng), updatedAt: updated.current_location_updated_at ? toDateString(updated.current_location_updated_at) : null }
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

app.get('/api/admin/users', authRequired(JWT_SECRET), roleRequired('owner'), async (_req, res) => {
  if (!(await requireAdminPermission(_req, res, 'manage_users'))) return;
  const rows = (await db.query(
    `
      SELECT id, full_name, email, phone, address, role, is_active, permissions, warehouse_scopes, created_at
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
      warehouseScopes: parseWarehouseScopes(row.warehouse_scopes),
      createdAt: toDateString(row.created_at)
    }))
  });
});

app.post('/api/admin/users/:userId/reset-password', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.patch('/api/admin/users/:userId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'manage_users'))) return;
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Некорректный userId' });

  const body = req.body as { role?: UserRole; isActive?: boolean; permissions?: string[]; warehouseScopes?: number[] | null };
  const allowedRoles: UserRole[] = ['customer', 'courier', 'admin', 'picker'];
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
  if (body.warehouseScopes !== undefined && !canManagePermissions) {
    return res.status(403).json({ message: 'Только системный администратор может менять доступ к складам' });
  }
  let nextWarehouseScopes = body.warehouseScopes !== undefined ? await sanitizeWarehouseScopes(body.warehouseScopes) : existing.warehouse_scopes;
  if (nextRole !== 'admin') {
    nextWarehouseScopes = null;
  }
  if (nextRole === 'admin' && !nextPermissions.includes('manage_warehouse')) {
    nextWarehouseScopes = null;
  }
  if (nextRole === 'admin' && nextPermissions.includes('manage_warehouse') && body.warehouseScopes !== undefined && nextWarehouseScopes === null) {
    // null means full access for warehouse module
    nextWarehouseScopes = null;
  }

  if (existing.id === req.user!.id) {
    if (!nextIsActive) return res.status(400).json({ message: 'Нельзя заблокировать самого себя' });
    if (nextRole !== existing.role) return res.status(400).json({ message: 'Нельзя изменить собственную роль' });
  }

  const updatedRow = (await db.query(
    `
      UPDATE users
      SET role = $1,
          is_active = $2,
          session_version = session_version + 1,
          permissions = $4,
          warehouse_scopes = $5
      WHERE id = $3
      RETURNING *
    `,
    [nextRole, nextIsActive, userId, nextPermissions, nextWarehouseScopes]
  )).rows[0];

  if (nextRole === 'courier') {
    await getOrCreateCourierForUser(userId);
  } else if (existing.role === 'courier') {
    await db.query("UPDATE couriers SET status = 'offline' WHERE user_id = $1", [userId]);
  }

  await logAdminAction(req.user!.id, 'user.update', 'user', userId, {
    role: { from: existing.role, to: nextRole },
    isActive: { from: existing.is_active, to: nextIsActive },
    permissions: { from: existing.permissions, to: nextPermissions },
    warehouseScopes: { from: existing.warehouse_scopes, to: nextWarehouseScopes }
  });

  return res.json({ user: publicUser(normalizeUserRow(updatedRow)) });
});

app.post('/api/admin/users/:userId/force-logout', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.delete('/api/admin/users/:userId', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.post('/api/admin/staff', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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
    warehouseScopes?: number[] | null;
    role?: UserRole;
  };
  const fullName = String(body.fullName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!fullName || !email || password.length < 8) {
    return res.status(400).json({ message: 'Нужны fullName, email и пароль минимум 8 символов' });
  }

  const existingUser = await getUserByEmail(email);
  if (existingUser) return res.status(409).json({ message: 'Пользователь с таким email уже существует' });

  const role: UserRole = body.role && ['admin', 'courier', 'picker'].includes(body.role) ? (body.role as UserRole) : 'admin';
  const permissions = normalizePermissions(body.permissions);
  const nextPermissions =
    role === 'admin' && !permissions.includes('manage_warehouse')
      ? (['manage_warehouse', ...permissions] as AdminPermission[])
      : permissions;
  const warehouseScopes = nextPermissions.includes('manage_warehouse') ? await sanitizeWarehouseScopes(body.warehouseScopes) : null;
  const hash = bcrypt.hashSync(password, 10);
  const createdRow = (await db.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role, permissions, warehouse_scopes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    [fullName, email, body.phone?.trim() || null, body.address?.trim() || null, hash, role, nextPermissions, warehouseScopes]
  )).rows[0];
  const created = normalizeUserRow(createdRow);

  await logAdminAction(req.user!.id, 'staff.create', 'user', created.id, {
    email: created.email,
    permissions: created.permissions,
    warehouseScopes: created.warehouse_scopes
  });

  return res.status(201).json({ user: publicUser(created) });
});

app.get('/api/admin/stores', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const status = String(req.query.status || '').trim().toLowerCase();
  const whereSql = ['pending', 'approved', 'rejected'].includes(status) ? 'WHERE s.status = $1' : '';
  const params = whereSql ? [status] : [];

  const rows = (
    await db.query(
      `
        SELECT s.*,
               owner.full_name AS owner_name,
               owner.email AS owner_email
        FROM merchant_stores s
        JOIN users owner ON owner.id = s.owner_user_id
        ${whereSql}
        ORDER BY s.id DESC
      `,
      params
    )
  ).rows;

  return res.json({
    stores: rows.map((row: any) => ({
      ...merchantStoreView(row),
      ownerName: row.owner_name ?? null,
      ownerEmail: row.owner_email ?? null
    }))
  });
});

app.patch('/api/admin/stores/:storeId/review', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  if (!storeId) return res.status(400).json({ message: 'Некорректный storeId' });

  const body = req.body as { decision?: 'approved' | 'rejected'; reason?: string };
  const decision = String(body.decision || '').trim().toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ message: 'decision должен быть approved или rejected' });
  }
  const reason = String(body.reason || '').trim() || null;

  const existing = await getMerchantStoreById(storeId);
  if (!existing) return res.status(404).json({ message: 'Точка не найдена' });

  const updated = (
    await db.query(
      `
        UPDATE merchant_stores
        SET
          status = $1,
          approved_by_admin_id = $2,
          approved_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END,
          rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END
        WHERE id = $4
        RETURNING *
      `,
      [decision, req.user!.id, reason, storeId]
    )
  ).rows[0];

  await logAdminAction(req.user!.id, 'merchant_store.review', 'merchant_store', storeId, {
    decision,
    reason
  });
  await createNotification({
    userId: toNumber(existing.owner_user_id),
    level: decision === 'approved' ? 'success' : 'warning',
    title: decision === 'approved' ? 'Точка одобрена администратором' : 'Точка отклонена администратором',
    body: reason || null,
    entityType: 'store',
    entityId: storeId
  });

  return res.json({ store: merchantStoreView(updated) });
});

app.get('/api/admin/stores/:storeId/tenant-routing', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  if (!storeId) return res.status(400).json({ message: 'Некорректный storeId' });
  const store = await getMerchantStoreById(storeId);
  if (!store) return res.status(404).json({ message: 'Точка не найдена' });

  await tenantDbResolver.ensureStoreRouting(storeId);
  const row = (
    await db.query(
      `
        SELECT *
        FROM tenant_db_routing
        WHERE store_id = $1
        LIMIT 1
      `,
      [storeId]
    )
  ).rows[0];

  return res.json({ routing: tenantRoutingView(row) });
});

app.patch('/api/admin/stores/:storeId/tenant-routing', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  if (!storeId) return res.status(400).json({ message: 'Некорректный storeId' });
  const store = await getMerchantStoreById(storeId);
  if (!store) return res.status(404).json({ message: 'Точка не найдена' });

  const body = req.body as { mode?: 'shared' | 'dedicated'; dsnKey?: string | null; dedicatedDatabaseUrl?: string | null };
  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode !== 'shared' && mode !== 'dedicated') {
    return res.status(400).json({ message: 'mode должен быть shared или dedicated' });
  }

  const dsnKey = String(body.dsnKey || '').trim() || null;
  const dedicatedDatabaseUrl = String(body.dedicatedDatabaseUrl || '').trim() || null;
  if (mode === 'dedicated' && !dsnKey) {
    return res.status(400).json({ message: 'Для mode=dedicated нужно передать dsnKey' });
  }

  await db.query(
    `
      INSERT INTO tenant_db_routing (store_id, mode, dsn_key, dedicated_database_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (store_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        dsn_key = EXCLUDED.dsn_key,
        dedicated_database_url = EXCLUDED.dedicated_database_url
    `,
    [storeId, mode, mode === 'dedicated' ? dsnKey : null, mode === 'dedicated' ? dedicatedDatabaseUrl : null]
  );

  tenantDbResolver.invalidate(storeId);

  const row = (
    await db.query(
      `
        SELECT *
        FROM tenant_db_routing
        WHERE store_id = $1
        LIMIT 1
      `,
      [storeId]
    )
  ).rows[0];

  await logAdminAction(req.user!.id, 'tenant_routing.update', 'tenant_db_routing', storeId, {
    mode,
    dsnKey: mode === 'dedicated' ? dsnKey : null,
    dedicatedDatabaseUrlSet: mode === 'dedicated' ? Boolean(dedicatedDatabaseUrl) : false
  });

  return res.json({ routing: tenantRoutingView(row) });
});

app.post('/api/admin/stores/:storeId/migrate-products', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  if (!storeId) return res.status(400).json({ message: 'Некорректный storeId' });
  const store = await getMerchantStoreById(storeId);
  if (!store) return res.status(404).json({ message: 'Точка не найдена' });

  const body = req.body as {
    dsnKey?: string;
    dedicatedDatabaseUrl?: string | null;
    stage?: MerchantProductsMigrationStage;
    dryRun?: boolean;
  };
  const dsnKey = String(body.dsnKey || `STORE_${storeId}`).trim();
  const stage = (String(body.stage || 'all').trim().toLowerCase() as MerchantProductsMigrationStage) || 'all';
  const dryRun = Boolean(body.dryRun);
  const dedicatedDatabaseUrl = String(body.dedicatedDatabaseUrl || '').trim() || null;
  if (!dsnKey) return res.status(400).json({ message: 'dsnKey обязателен' });
  if (!['all', 'copy', 'verify', 'cutover'].includes(stage)) {
    return res.status(400).json({ message: 'stage должен быть all, copy, verify или cutover' });
  }

  const result = await migrateMerchantProducts({
    sharedPool: db,
    storeId,
    dsnKey,
    dedicatedUrl: dedicatedDatabaseUrl,
    stage,
    dryRun,
    onCutover: async () => {
      tenantDbResolver.invalidate(storeId);
    }
  });

  await logAdminAction(req.user!.id, 'merchant_products.migrate', 'merchant_store', storeId, {
    stage,
    dryRun,
    dsnKey,
    dedicatedDatabaseUrlSet: Boolean(dedicatedDatabaseUrl),
    copiedRows: result.copiedRows,
    verifiedRows: result.verifiedRows,
    cutoverApplied: result.cutoverApplied
  });

  return res.json({ result });
});

app.get('/api/admin/stores/:storeId/courier-links', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  if (!storeId) return res.status(400).json({ message: 'Некорректный storeId' });
  const store = await getMerchantStoreById(storeId);
  if (!store) return res.status(404).json({ message: 'Точка не найдена' });
  const rows = (
    await db.query(
      `
        SELECT l.*,
               u.full_name AS courier_name,
               u.email AS courier_email,
               u.phone AS courier_phone
        FROM merchant_store_courier_links l
        JOIN couriers c ON c.id = l.courier_id
        JOIN users u ON u.id = c.user_id
        WHERE l.store_id = $1
        ORDER BY l.id DESC
      `,
      [storeId]
    )
  ).rows;

  return res.json({ links: rows.map((row: any) => merchantCourierLinkView(row)) });
});

app.patch('/api/admin/stores/:storeId/courier-links/:linkId/review', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireChiefAdmin(req, res))) return;
  const storeId = Number(req.params.storeId);
  const linkId = Number(req.params.linkId);
  if (!storeId || !linkId) return res.status(400).json({ message: 'Некорректный storeId или linkId' });

  const body = req.body as { decision?: 'approved' | 'rejected'; reason?: string };
  const decision = String(body.decision || '').trim().toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ message: 'decision должен быть approved или rejected' });
  }
  const reason = String(body.reason || '').trim() || null;

  const existing = (
    await db.query(
      `
        SELECT *
        FROM merchant_store_courier_links
        WHERE id = $1 AND store_id = $2
        LIMIT 1
      `,
      [linkId, storeId]
    )
  ).rows[0];
  if (!existing) return res.status(404).json({ message: 'Заявка на курьера не найдена' });

  const updated = (
    await db.query(
      `
        UPDATE merchant_store_courier_links
        SET
          status = $1,
          approved_by_admin_id = $2,
          approved_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END,
          rejection_reason = CASE WHEN $1 = 'rejected' THEN $3 ELSE NULL END
        WHERE id = $4
        RETURNING *
      `,
      [decision, req.user!.id, reason, linkId]
    )
  ).rows[0];

  await logAdminAction(req.user!.id, 'merchant_store_courier_link.review', 'merchant_store_courier_link', linkId, {
    storeId,
    decision,
    reason
  });
  const store = await getMerchantStoreById(storeId);
  if (store) {
    await createNotification({
      userId: toNumber(store.owner_user_id),
      level: decision === 'approved' ? 'success' : 'warning',
      title: decision === 'approved' ? 'Курьер подключен к вашей точке' : 'Заявка на курьера отклонена',
      body: reason || null,
      entityType: 'store_courier_link',
      entityId: linkId
    });
  }

  return res.json({ link: merchantCourierLinkView(updated) });
});

app.get('/api/admin/audit-logs', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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

app.get('/api/admin/search', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
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
        SELECT c.id, c.user_id, c.vehicle_type, c.status, c.verification_status, c.last_seen_at, u.full_name, u.email
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
        isOnline: courierIsOnline(row),
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        verificationStatus: String(row.verification_status)
      }))
    }
  });
});

app.get('/api/admin/analytics', authRequired(JWT_SECRET), roleRequired('owner'), async (req, res) => {
  if (!(await requireAdminPermission(req, res, 'view_analytics'))) return;

  const [totalsRes, rangeRes, dailyRes, topProductsRes, topLocalitiesRes] = await Promise.all([
    db.query(
      `
        SELECT
          COUNT(*)::text AS orders_total,
          COUNT(*) FILTER (WHERE status = 'assembling')::text AS pending_count,
          COUNT(*) FILTER (WHERE status = 'courier_assigned')::text AS assigned_count,
          COUNT(*) FILTER (WHERE status = 'courier_picked')::text AS picked_up_count,
          COUNT(*) FILTER (WHERE status = 'on_the_way')::text AS on_the_way_count,
          COUNT(*) FILTER (WHERE status = 'arrived')::text AS arrived_count,
          COUNT(*) FILTER (WHERE status = 'received')::text AS received_count,
          COUNT(*) FILTER (WHERE status = 'paid')::text AS delivered_count,
          COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled_count,
          COALESCE(SUM(total), 0)::text AS revenue_total,
          COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0)::text AS delivered_revenue,
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
        WHERE o.status = 'paid'
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
      arrivedCount: Number(totals.arrived_count || 0),
      receivedCount: Number(totals.received_count || 0),
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
  await createNotification({
    userId: toNumber(reviewed.user_id),
    level: body.status === 'approved' ? 'success' : 'warning',
    title: body.status === 'approved' ? 'Верификация курьера подтверждена' : 'Верификация курьера отклонена',
    body: reviewComment || null,
    entityType: 'courier_verification',
    entityId: courierId
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

app.post('/api/cart/items', authRequired(JWT_SECRET), validateBody(cartAddItemBodySchema), async (req, res) => {
  const { productId, quantity } = req.body as { productId: number; quantity?: number };
  const qty = Number(quantity || 1);

  const product = (await db.query('SELECT id FROM products WHERE id = $1 AND in_stock = TRUE LIMIT 1', [productId])).rows[0];
  if (!product) throw new HttpError(404, 'Товар не найден');

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

app.put(
  '/api/cart/items/:itemId',
  authRequired(JWT_SECRET),
  validateParams(cartItemParamsSchema),
  validateBody(cartUpdateItemBodySchema),
  async (req, res) => {
    const { itemId } = req.params as unknown as { itemId: number };
    const { quantity } = req.body as { quantity: number };

    const updated = await db.query(
      'UPDATE cart_items SET quantity = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [quantity, itemId, req.user!.id]
    );
    if (!updated.rows[0]) throw new HttpError(404, 'Позиция корзины не найдена');

    return res.json({ message: 'Количество обновлено' });
  }
);

app.delete('/api/cart/items/:itemId', authRequired(JWT_SECRET), validateParams(cartItemParamsSchema), async (req, res) => {
  const { itemId } = req.params as unknown as { itemId: number };

  await db.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [itemId, req.user!.id]);
  return res.json({ message: 'Позиция удалена' });
});

app.post('/api/orders', authRequired(JWT_SECRET), validateBody(createOrderBodySchema), async (req, res) => {
  const body = req.body as {
    deliveryAddress?: string;
    deliveryLat?: number;
    deliveryLng?: number;
    paymentMethod?: string;
    substitutionPreference?: 'allow_similar' | 'no_substitution' | 'contact_me';
    substitutionNote?: string;
  };
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

  let deliveryLat = hasLat ? Number(body.deliveryLat) : null;
  let deliveryLng = hasLng ? Number(body.deliveryLng) : null;
  if (
    (deliveryLat !== null && (Number.isNaN(deliveryLat) || deliveryLat < -90 || deliveryLat > 90)) ||
    (deliveryLng !== null && (Number.isNaN(deliveryLng) || deliveryLng < -180 || deliveryLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты доставки' });
  }

  if (deliveryLat === null || deliveryLng === null) {
    const resolved = await resolveCoordinatesFromAddress(address);
    if (resolved) {
      deliveryLat = resolved.lat;
      deliveryLng = resolved.lng;
    }
  }

  if (deliveryLat === null || deliveryLng === null) {
    return res.status(409).json({ message: 'Не удалось определить координаты адреса. Укажите точку на карте.' });
  }

  const demandByProduct = buildDemandFromRows(cartRows);
  const deliveryQuote = await buildDeliveryQuote(deliveryLat, deliveryLng, demandByProduct);
  if (!deliveryQuote.warehouseCode && !deliveryQuote.warehouseName) {
    return res.status(409).json({ message: 'Не удалось автоматически назначить склад сборки по расстоянию' });
  }
  if (deliveryQuote.serviceable === false) {
    return res.status(409).json({ message: deliveryQuote.reason || 'Доставка по этому адресу недоступна' });
  }

  const total = Number(
    cartRows.reduce((sum: number, row: any) => sum + Number(row.quantity) * Number(row.price), 0).toFixed(2)
  );
  const paymentMethod = ['cash', 'wallet'].includes(String(body.paymentMethod || '').toLowerCase())
    ? String(body.paymentMethod).toLowerCase()
    : 'cash';
  const substitutionPreferenceRaw = String(body.substitutionPreference || 'contact_me').trim().toLowerCase();
  const substitutionPreference = ['allow_similar', 'no_substitution', 'contact_me'].includes(substitutionPreferenceRaw)
    ? substitutionPreferenceRaw
    : 'contact_me';
  const substitutionNote = String(body.substitutionNote || '').trim() || null;
  const courierFee = deliveryQuote.deliveryFee ?? null;

  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');

    const orderInsert = await client.query(
      `
        INSERT INTO orders (
          user_id, status, total, delivery_address, delivery_lat, delivery_lng,
          serviceable, delivery_zone, fulfillment_warehouse, fulfillment_warehouse_code,
          warehouse_distance_km, route_distance_km, delivery_eta_min, delivery_fee,
          courier_fee, payment_method, substitution_preference, substitution_note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *
      `,
      [
        user.id,
        ORDER_STATUS.assembling,
        total,
        address,
        deliveryLat,
        deliveryLng,
        deliveryQuote.serviceable,
        deliveryQuote.zoneName,
        deliveryQuote.warehouseName,
        deliveryQuote.warehouseCode,
        deliveryQuote.warehouseDistanceKm,
        deliveryQuote.routeDistanceKm,
        deliveryQuote.etaMin,
        deliveryQuote.deliveryFee,
        courierFee,
        paymentMethod,
        substitutionPreference,
        substitutionNote
      ]
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
      [orderId, ORDER_STATUS.assembling, 'Заказ создан', user.id]
    );

    // Автосоздание задачи сборки и резерва является обязательным.
    // Иначе заказ окажется в неконсистентном состоянии без гарантии остатков.
    const warehouseId =
      (await getWarehouseIdByCode(client, deliveryQuote.warehouseCode)) ??
      (await getDefaultWarehouseId(client));
    const pickerId = await findAvailablePickerId(client, warehouseId);
    await createPickTaskInternal(client, orderId, warehouseId, req.user!.id, pickerId);

    await client.query('COMMIT');

    await tryAssignOldestPendingPickTask();
    await createNotification({
      userId: user.id,
      level: 'success',
      title: `Заказ #${orderId} создан`,
      body: `Статус: собирается. ETA: ${deliveryQuote.etaMin ?? '—'} мин.`,
      entityType: 'order',
      entityId: orderId
    });
    notifyOrderUpdated(orderId, 'created');

    const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
    return res.status(201).json({ order: orderView(normalizeOrderRow(orderRow)) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create order failed:', error);
    const message = error instanceof Error ? error.message : 'Не удалось создать заказ';
    if (
      message.includes('Недостаточно остатка') ||
      message.includes('У заказа нет позиций для сборки') ||
      message.includes('склад')
    ) {
      return res.status(409).json({ message });
    }
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

async function fetchOrderItemsStatus(orderId: number) {
  const rows = (
    await db.query(
      `
        SELECT pti.id,
               pti.product_id,
               pti.product_name,
               pti.requested_qty,
               pti.picked_qty,
               pti.result_status,
               pti.substitute_product_name,
               pti.result_note
        FROM pick_tasks pt
        JOIN pick_task_items pti ON pti.pick_task_id = pt.id
        WHERE pt.order_id = $1
        ORDER BY pti.id ASC
      `,
      [orderId]
    )
  ).rows;

  return rows.map((row: any) => ({
    id: toNumber(row.id),
    productId: toNumber(row.product_id),
    productName: String(row.product_name),
    requestedQty: toNumber(row.requested_qty),
    pickedQty: toNumber(row.picked_qty),
    resultStatus: String(row.result_status || 'pending'),
    substituteProductName: row.substitute_product_name ?? null,
    resultNote: row.result_note ?? null
  }));
}

async function fetchOrderTracking(orderId: number) {
  const row = (
    await db.query(
      `
        SELECT o.*,
               c.current_lat,
               c.current_lng,
               c.current_location_updated_at,
               c.last_seen_at,
               cu.full_name AS courier_name,
               cu.phone AS courier_phone
        FROM orders o
        LEFT JOIN couriers c ON c.id = o.assigned_courier_id
        LEFT JOIN users cu ON cu.id = c.user_id
        WHERE o.id = $1
        LIMIT 1
      `,
      [orderId]
    )
  ).rows[0];
  if (!row) return null;

  const order = normalizeOrderRow(row);
  const hasCourierLocation = row.current_lat !== null && row.current_lng !== null;
  const hasDeliveryPoint = order.delivery_lat !== null && order.delivery_lng !== null;
  let liveDistanceKm: number | null = null;
  let etaLiveMin: number | null = order.delivery_eta_min;
  if (hasCourierLocation && hasDeliveryPoint) {
    liveDistanceKm = haversineKm(Number(row.current_lat), Number(row.current_lng), Number(order.delivery_lat), Number(order.delivery_lng));
    const speedKmPerHour = 25;
    etaLiveMin = Math.max(Math.round((liveDistanceKm / speedKmPerHour) * 60) + 2, 1);
  }

  return {
    orderId: order.id,
    status: order.status,
    etaBaseMin: order.delivery_eta_min,
    etaLiveMin,
    liveDistanceKm: liveDistanceKm === null ? null : round2(liveDistanceKm),
    routeUrl:
      order.delivery_lat !== null && order.delivery_lng !== null
        ? `https://www.google.com/maps/dir/?api=1&destination=${order.delivery_lat},${order.delivery_lng}`
        : null,
    courier: row.assigned_courier_id
      ? {
          id: toNumber(row.assigned_courier_id),
          name: row.courier_name || null,
          phone: row.courier_phone || null,
          isOnline: row.last_seen_at ? courierIsOnline({ last_seen_at: row.last_seen_at }) : false,
          location: hasCourierLocation
            ? {
                lat: Number(row.current_lat),
                lng: Number(row.current_lng),
                updatedAt: row.current_location_updated_at ? toDateString(row.current_location_updated_at) : null
              }
            : null
        }
      : null
  };
}

async function fetchOrderDetailsPayload(orderId: number) {
  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return null;
  const order = normalizeOrderRow(orderRow);
  const [items, events, itemsStatus, tracking] = await Promise.all([
    fetchOrderItems(orderId),
    fetchOrderEvents(orderId),
    fetchOrderItemsStatus(orderId),
    fetchOrderTracking(orderId)
  ]);

  return {
    order: orderView(order),
    items,
    itemsStatus,
    events,
    tracking
  };
}

app.get('/api/orders/my', authRequired(JWT_SECRET), async (req, res) => {
  const rows = (
    await db.query(
      `
        SELECT o.*,
               u.full_name AS customer_full_name,
               u.phone AS customer_phone,
               pts.pick_task_status,
               pts.picker_id,
               pts.picker_name
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN LATERAL (
          SELECT pt.status AS pick_task_status,
                 pt.assigned_to AS picker_id,
                 pu.full_name AS picker_name
          FROM pick_tasks pt
          LEFT JOIN users pu ON pu.id = pt.assigned_to
          WHERE pt.order_id = o.id
          ORDER BY pt.id DESC
          LIMIT 1
        ) pts ON TRUE
        WHERE o.user_id = $1 AND o.archived_at IS NULL
        ORDER BY o.id DESC
      `,
      [req.user!.id]
    )
  ).rows;
  const orders = rows.map((row: any) => orderView(normalizeOrderRow(row)));
  if (!orders.length) return res.json({ orders: [] });

  const orderIds = orders.map((order) => order.id);
  const itemRows = (await db.query(
    `
      SELECT order_id, product_id, product_name, quantity, unit_price
      FROM order_items
      WHERE order_id = ANY($1::bigint[])
      ORDER BY order_id DESC, id ASC
    `,
    [orderIds]
  )).rows;

  const itemsByOrder = new Map<number, Array<{ productId: number; name: string; quantity: number; unitPrice: number }>>();
  for (const row of itemRows) {
    const orderId = toNumber(row.order_id);
    if (!itemsByOrder.has(orderId)) itemsByOrder.set(orderId, []);
    itemsByOrder.get(orderId)!.push({
      productId: toNumber(row.product_id),
      name: String(row.product_name),
      quantity: toNumber(row.quantity),
      unitPrice: Number(row.unit_price)
    });
  }

  return res.json({
    orders: orders.map((order) => ({
      ...order,
      items: itemsByOrder.get(order.id) || []
    }))
  });
});

app.get('/api/orders/assigned', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courier) return res.json({ orders: [] });

  const rows = (await db.query(
    `
      SELECT o.*,
             u.full_name AS customer_full_name,
             u.phone AS customer_phone,
             pts.pick_task_status,
             pts.picker_id,
             pts.picker_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN LATERAL (
        SELECT pt.status AS pick_task_status,
               pt.assigned_to AS picker_id,
               pu.full_name AS picker_name
        FROM pick_tasks pt
        LEFT JOIN users pu ON pu.id = pt.assigned_to
        WHERE pt.order_id = o.id
        ORDER BY pt.id DESC
        LIMIT 1
      ) pts ON TRUE
      WHERE o.assigned_courier_id = $1
        AND o.status IN ('courier_assigned', 'courier_picked', 'on_the_way', 'arrived')
      ORDER BY o.id DESC
    `,
    [toNumber(courier.id)]
  )).rows;

  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.get('/api/couriers/me/route', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courier) return res.status(404).json({ message: 'Профиль курьера не найден' });
  const courierId = toNumber(courier.id);
  const currentLat = courier.current_lat === null ? null : Number(courier.current_lat);
  const currentLng = courier.current_lng === null ? null : Number(courier.current_lng);
  const rows = (
    await db.query(
      `
        SELECT id, delivery_lat, delivery_lng, delivery_address, status, created_at
        FROM orders
        WHERE assigned_courier_id = $1
          AND status IN ('courier_assigned', 'courier_picked', 'on_the_way', 'arrived')
        ORDER BY
          CASE status
            WHEN 'on_the_way' THEN 1
            WHEN 'courier_picked' THEN 2
            WHEN 'arrived' THEN 3
            ELSE 4
          END ASC,
          created_at ASC
      `,
      [courierId]
    )
  ).rows;

  const waypoints = rows
    .filter((row: any) => row.delivery_lat !== null && row.delivery_lng !== null)
    .map((row: any) => ({
      orderId: toNumber(row.id),
      status: String(row.status),
      lat: Number(row.delivery_lat),
      lng: Number(row.delivery_lng),
      address: String(row.delivery_address || '')
    }));

  const destination = waypoints[0] || null;
  let routeUrl: string | null = null;
  if (destination) {
    const originPart = currentLat !== null && currentLng !== null ? `&origin=${currentLat},${currentLng}` : '';
    routeUrl = `https://www.google.com/maps/dir/?api=1${originPart}&destination=${destination.lat},${destination.lng}&travelmode=driving`;
  }

  return res.json({
    courierId,
    currentLocation:
      currentLat === null || currentLng === null
        ? null
        : {
            lat: currentLat,
            lng: currentLng,
            updatedAt: courier.current_location_updated_at ? toDateString(courier.current_location_updated_at) : null
          },
    waypoints,
    routeUrl
  });
});

app.get('/api/orders/open', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
  if (!courier) return res.json({ orders: [] });

  const rows = (await db.query(
    `
      SELECT o.*,
             u.full_name AS customer_full_name,
             u.phone AS customer_phone,
             pts.pick_task_status,
             pts.picker_id,
             pts.picker_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN LATERAL (
        SELECT pt.status AS pick_task_status,
               pt.assigned_to AS picker_id,
               pu.full_name AS picker_name
        FROM pick_tasks pt
        LEFT JOIN users pu ON pu.id = pt.assigned_to
        WHERE pt.order_id = o.id
        ORDER BY pt.id DESC
        LIMIT 1
      ) pts ON TRUE
      WHERE o.status = 'assembling'
        AND o.assigned_courier_id IS NULL
      ORDER BY o.id ASC
      LIMIT 100
    `
  )).rows;

  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.get('/api/orders/history', authRequired(JWT_SECRET), roleRequired('courier', 'admin'), async (req, res) => {
  const delivered = [ORDER_STATUS.received, ORDER_STATUS.paid];

  const baseSelect = `
      SELECT o.*,
             u.full_name AS customer_full_name,
             u.phone AS customer_phone,
             pts.pick_task_status,
             pts.picker_id,
             pts.picker_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN LATERAL (
        SELECT pt.status AS pick_task_status,
               pt.assigned_to AS picker_id,
               pu.full_name AS picker_name
        FROM pick_tasks pt
        LEFT JOIN users pu ON pu.id = pt.assigned_to
        WHERE pt.order_id = o.id
        ORDER BY pt.id DESC
        LIMIT 1
      ) pts ON TRUE
  `;

  let rows: any[] = [];
  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    if (!courier) return res.json({ orders: [] });
    rows = (
      await db.query(
        `
          ${baseSelect}
          WHERE o.assigned_courier_id = $1
            AND o.status = ANY($2)
          ORDER BY o.updated_at DESC
          LIMIT 200
        `,
        [toNumber(courier.id), delivered]
      )
    ).rows;
  } else {
    rows = (
      await db.query(
        `
          ${baseSelect}
          WHERE o.status = ANY($1)
          ORDER BY o.updated_at DESC
          LIMIT 500
        `,
        [delivered]
      )
    ).rows;
  }
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_orders'))) return;
  }

  return res.json({ orders: rows.map((row: any) => orderView(normalizeOrderRow(row))) });
});

app.post('/api/orders/:orderId/claim', authRequired(JWT_SECRET), roleRequired('courier'), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const client = await db.connect();
  let claimed: any;
  try {
    await client.query('BEGIN');
    const courierRow = (
      await client.query(
        `
          SELECT *
          FROM couriers
          WHERE user_id = $1
          FOR UPDATE
          LIMIT 1
        `,
        [req.user!.id]
      )
    ).rows[0];
    if (!courierRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Профиль курьера не найден' });
    }
    if (!courierEligible(courierRow)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Курьер не верифицирован. Добавьте данные транспорта и фото техпаспорта.' });
    }

    const courierId = toNumber(courierRow.id);
    const maxActive = toNumber(courierRow.max_active_orders);
    const activeCount = await getActiveOrderCountForCourier(courierId, client);
    if (activeCount >= maxActive) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Достигнут лимит активных заказов курьера' });
    }

    await client.query('UPDATE couriers SET last_seen_at = NOW() WHERE id = $1', [courierId]);
    claimed = (
      await client.query(
        `
          UPDATE orders
          SET assigned_courier_id = $1, status = $2, updated_at = NOW()
          WHERE id = $3
            AND status = $4
            AND assigned_courier_id IS NULL
          RETURNING *
        `,
        [courierId, ORDER_STATUS.courierAssigned, orderId, ORDER_STATUS.assembling]
      )
    ).rows[0];
    if (!claimed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Заказ уже назначен курьеру или недоступен' });
    }

    await client.query(
      'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
      [orderId, ORDER_STATUS.courierAssigned, 'Курьер принял заказ вручную', req.user!.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await createNotification({
    userId: toNumber(claimed.user_id),
    level: 'info',
    title: `Курьер назначен на заказ #${orderId}`,
    body: 'Заказ передан в доставку',
    entityType: 'order',
    entityId: orderId
  });
  notifyOrderUpdated(orderId, 'courier_assigned');

  return res.json({ order: orderView(normalizeOrderRow(claimed)) });
});

app.get('/api/orders/all', authRequired(JWT_SECRET), roleRequired('admin'), async (_req, res) => {
  if (!(await requireAdminPermission(_req, res, 'view_orders'))) return;
  const rows = (
    await db.query(
      `
        SELECT o.*,
               u.full_name AS customer_full_name,
               u.phone AS customer_phone,
               pts.pick_task_status,
               pts.picker_id,
               pts.picker_name
        FROM orders o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN LATERAL (
          SELECT pt.status AS pick_task_status,
                 pt.assigned_to AS picker_id,
                 pu.full_name AS picker_name
          FROM pick_tasks pt
          LEFT JOIN users pu ON pu.id = pt.assigned_to
          WHERE pt.order_id = o.id
          ORDER BY pt.id DESC
          LIMIT 1
        ) pts ON TRUE
        WHERE o.archived_at IS NULL
        ORDER BY o.id DESC
        LIMIT 200
      `
    )
  ).rows;
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

app.get('/api/orders/:orderId/tracking', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });
  const row = (
    await db.query(
      `
        SELECT o.*,
               c.current_lat,
               c.current_lng,
               c.current_location_updated_at,
               c.last_seen_at,
               cu.full_name AS courier_name,
               cu.phone AS courier_phone
        FROM orders o
        LEFT JOIN couriers c ON c.id = o.assigned_courier_id
        LEFT JOIN users cu ON cu.id = c.user_id
        WHERE o.id = $1
        LIMIT 1
      `,
      [orderId]
    )
  ).rows[0];
  if (!row) return res.status(404).json({ message: 'Заказ не найден' });

  const order = normalizeOrderRow(row);
  if (req.user!.role === 'customer' && order.user_id !== req.user!.id) {
    return res.status(403).json({ message: 'Нет доступа к заказу' });
  }
  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    if (!courier || order.assigned_courier_id !== toNumber(courier.id)) return res.status(403).json({ message: 'Нет доступа к заказу' });
  }
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'view_orders'))) return;
  }

  const hasCourierLocation = row.current_lat !== null && row.current_lng !== null;
  const hasDeliveryPoint = order.delivery_lat !== null && order.delivery_lng !== null;
  let liveDistanceKm: number | null = null;
  let etaLiveMin: number | null = order.delivery_eta_min;
  if (hasCourierLocation && hasDeliveryPoint) {
    liveDistanceKm = haversineKm(Number(row.current_lat), Number(row.current_lng), Number(order.delivery_lat), Number(order.delivery_lng));
    const speedKmPerHour = 25;
    etaLiveMin = Math.max(Math.round((liveDistanceKm / speedKmPerHour) * 60) + 2, 1);
  }

  return res.json({
    orderId: order.id,
    status: order.status,
    etaBaseMin: order.delivery_eta_min,
    etaLiveMin,
    liveDistanceKm: liveDistanceKm === null ? null : round2(liveDistanceKm),
    routeUrl:
      order.delivery_lat !== null && order.delivery_lng !== null
        ? `https://www.google.com/maps/dir/?api=1&destination=${order.delivery_lat},${order.delivery_lng}`
        : null,
    courier: row.assigned_courier_id
      ? {
          id: toNumber(row.assigned_courier_id),
          name: row.courier_name || null,
          phone: row.courier_phone || null,
          isOnline: row.last_seen_at ? courierIsOnline({ last_seen_at: row.last_seen_at }) : false,
          location: hasCourierLocation
            ? {
                lat: Number(row.current_lat),
                lng: Number(row.current_lng),
                updatedAt: row.current_location_updated_at ? toDateString(row.current_location_updated_at) : null
              }
            : null
        }
      : null
  });
});

app.get('/api/orders/:orderId/stream', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const orderRow = (await db.query('SELECT id, user_id, assigned_courier_id FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });

  const ownerId = toNumber(orderRow.user_id);
  if (req.user!.role === 'customer' && ownerId !== req.user!.id) {
    return res.status(403).json({ message: 'Нет доступа к заказу' });
  }
  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    if (!courier || toNumber(orderRow.assigned_courier_id ?? 0) !== toNumber(courier.id)) {
      return res.status(403).json({ message: 'Нет доступа к заказу' });
    }
  }
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'view_orders'))) return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let streamClosed = false;
  let snapshotInFlight = false;

  const sendEvent = (event: string, payload: unknown) => {
    if (streamClosed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendSnapshot = async (reason: OrderUpdateReason = 'updated') => {
    if (streamClosed || snapshotInFlight) return;
    snapshotInFlight = true;
    try {
      const details = await fetchOrderDetailsPayload(orderId);
      if (!details) {
        sendEvent('error', { message: 'Заказ больше не доступен' });
        return;
      }
      sendEvent('order_details', { ...details, reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка обновления заказа';
      sendEvent('error', { message });
    } finally {
      snapshotInFlight = false;
    }
  };

  const unsubscribe = subscribeOrderUpdates(orderId, (reason) => {
    void sendSnapshot(reason);
  });
  await sendSnapshot('updated');
  const keepAliveInterval = setInterval(() => {
    if (!streamClosed) res.write(': keepalive\n\n');
  }, 25_000);

  req.on('close', () => {
    streamClosed = true;
    unsubscribe();
    clearInterval(keepAliveInterval);
    res.end();
  });
});

app.get('/api/orders/:orderId/items-status', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });
  const orderRow = (await db.query('SELECT id, user_id, assigned_courier_id FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });
  const ownerId = toNumber(orderRow.user_id);
  if (req.user!.role === 'customer' && ownerId !== req.user!.id) return res.status(403).json({ message: 'Нет доступа к заказу' });
  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT id FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    if (!courier || toNumber(orderRow.assigned_courier_id ?? 0) !== toNumber(courier.id)) return res.status(403).json({ message: 'Нет доступа к заказу' });
  }
  if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'view_orders'))) return;
  }

  const items = await fetchOrderItemsStatus(orderId);
  return res.json({ items });
});

app.post('/api/orders/:orderId/pay', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const idempotencyKey = String(req.headers['x-idempotency-key'] || '').trim() || null;
  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });
  const order = normalizeOrderRow(orderRow);

  if (req.user!.role !== 'customer' || order.user_id !== req.user!.id) {
    return res.status(403).json({ message: 'Оплату может инициировать только владелец заказа' });
  }

  if (order.status === ORDER_STATUS.paid) {
    return res.json({ ok: true, message: 'Заказ уже оплачен', order: orderView(order), payment: null });
  }

  if (order.status !== ORDER_STATUS.received) {
    return res.status(409).json({ message: 'Оплата доступна только после статуса "Получен"' });
  }

  if (String(order.payment_method || 'cash') !== 'wallet') {
    return res.status(409).json({ message: 'Онлайн-оплата доступна только для способа оплаты "Кошелёк"' });
  }

  const amount = round2(Number(order.total) + Number(order.delivery_fee || 0));
  if (amount <= 0) return res.status(400).json({ message: 'Некорректная сумма оплаты' });

  if (idempotencyKey) {
    const existing = (await db.query(
      `
        SELECT *
        FROM payment_transactions
        WHERE idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey]
    )).rows[0];
    if (existing) {
      if (toNumber(existing.order_id) !== orderId || toNumber(existing.user_id) !== req.user!.id) {
        return res.status(409).json({ message: 'x-idempotency-key уже использован для другого платежа' });
      }
      return res.json({
        ok: true,
        reused: true,
        payment: {
          provider: existing.provider,
          providerPaymentId: existing.provider_payment_id,
          status: existing.status,
          amount: Number(existing.amount),
          currency: existing.currency
        }
      });
    }
  }

  const existingPending = (await db.query(
    `
      SELECT *
      FROM payment_transactions
      WHERE order_id = $1
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [orderId]
  )).rows[0];
  if (existingPending) {
    return res.json({
      ok: true,
      reused: true,
      payment: {
        provider: existingPending.provider,
        providerPaymentId: existingPending.provider_payment_id,
        status: existingPending.status,
        amount: Number(existingPending.amount),
        currency: existingPending.currency
      }
    });
  }

  const providerPaymentId = `${PAYMENT_PROVIDER}_${randomUUID()}`;
  const payload = {
    orderId,
    userId: req.user!.id,
    amount,
    currency: 'USD',
    providerPaymentId
  };

  try {
    const inserted = (await db.query(
      `
        INSERT INTO payment_transactions (
          order_id, user_id, amount, currency, provider, provider_payment_id, idempotency_key, status, provider_payload
        )
        VALUES ($1, $2, $3, 'USD', $4, $5, $6, 'pending', $7::jsonb)
        RETURNING *
      `,
      [orderId, req.user!.id, amount, PAYMENT_PROVIDER, providerPaymentId, idempotencyKey, JSON.stringify(payload)]
    )).rows[0];

    const webhookBody = {
      providerPaymentId,
      status: 'succeeded',
      amount,
      currency: 'USD'
    };
    const webhookJson = JSON.stringify(webhookBody);

    const responseBody: Record<string, unknown> = {
      ok: true,
      payment: {
        provider: PAYMENT_PROVIDER,
        providerPaymentId,
        status: inserted.status,
        amount: Number(inserted.amount),
        currency: inserted.currency
      }
    };
    if (NODE_ENV !== 'production') {
      responseBody.webhookTest = {
        method: 'POST',
        url: '/api/payments/webhook',
        headers: {
          'x-webhook-signature': signWebhookPayload(webhookJson)
        },
        body: webhookBody
      };
    }
    return res.status(201).json(responseBody);
  } catch (error: any) {
    if (error?.code === '23505' && idempotencyKey) {
      const existing = (await db.query(
        `
          SELECT *
          FROM payment_transactions
          WHERE idempotency_key = $1
          LIMIT 1
        `,
        [idempotencyKey]
      )).rows[0];
      if (existing) {
        if (toNumber(existing.order_id) !== orderId || toNumber(existing.user_id) !== req.user!.id) {
          return res.status(409).json({ message: 'x-idempotency-key уже использован для другого платежа' });
        }
        return res.json({
          ok: true,
          reused: true,
          payment: {
            provider: existing.provider,
            providerPaymentId: existing.provider_payment_id,
            status: existing.status,
            amount: Number(existing.amount),
            currency: existing.currency
          }
        });
      }
    }
    console.error('Create payment intent failed:', error);
    return res.status(500).json({ message: 'Не удалось создать платеж' });
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  const signature = String(req.headers['x-webhook-signature'] || '').trim().toLowerCase();
  const rawBody = String(req.rawBody || '');
  const body = req.body as {
    providerPaymentId?: string;
    status?: string;
    amount?: number;
    currency?: string;
    reason?: string;
    payload?: unknown;
  };

  if (!signature) return res.status(401).json({ message: 'Missing webhook signature' });
  if (!rawBody.length) return res.status(400).json({ message: 'Invalid webhook payload' });
  const expectedSignature = signWebhookPayload(rawBody);
  if (!safeEqualHex(signature, expectedSignature)) {
    return res.status(401).json({ message: 'Invalid webhook signature' });
  }

  const providerPaymentId = String(body.providerPaymentId || '').trim();
  if (!providerPaymentId) return res.status(400).json({ message: 'providerPaymentId обязателен' });
  const nextStatus = normalizePaymentStatus(body.status);
  let changedOrderId: number | null = null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const tx = (await client.query(
      `
        SELECT *
        FROM payment_transactions
        WHERE provider_payment_id = $1
        FOR UPDATE
        LIMIT 1
      `,
      [providerPaymentId]
    )).rows[0];
    if (!tx) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment transaction not found' });
    }

    const currentStatus = normalizePaymentStatus(tx.status);
    if (currentStatus === 'succeeded' && nextStatus === 'succeeded') {
      await client.query('COMMIT');
      return res.json({ ok: true, idempotent: true });
    }
    if (currentStatus === 'succeeded' && nextStatus !== 'succeeded') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Cannot downgrade succeeded payment' });
    }

    const paidAt = nextStatus === 'succeeded' ? new Date().toISOString() : null;
    await client.query(
      `
        UPDATE payment_transactions
        SET
          status = $1,
          failure_reason = $2,
          provider_payload = $3::jsonb,
          paid_at = COALESCE($4::timestamptz, paid_at),
          updated_at = NOW()
        WHERE id = $5
      `,
      [nextStatus, body.reason ? String(body.reason) : null, JSON.stringify(body.payload || body), paidAt, toNumber(tx.id)]
    );

    if (nextStatus === 'succeeded') {
      const orderRow = (
        await client.query(
          `
            SELECT id, status
            FROM orders
            WHERE id = $1
            FOR UPDATE
            LIMIT 1
          `,
          [toNumber(tx.order_id)]
        )
      ).rows[0];
      if (!orderRow) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Order not found for payment' });
      }

      const currentOrderStatus = String(orderRow.status);
      if (currentOrderStatus !== ORDER_STATUS.received && currentOrderStatus !== ORDER_STATUS.paid) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Order is not in payable status' });
      }

      if (currentOrderStatus !== ORDER_STATUS.paid) {
        changedOrderId = toNumber(orderRow.id);
        await client.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [ORDER_STATUS.paid, changedOrderId]);
        await client.query(
          'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, NULL)',
          [changedOrderId, ORDER_STATUS.paid, `Оплата подтверждена (${PAYMENT_PROVIDER})`]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment webhook failed:', error);
    return res.status(500).json({ message: 'Webhook processing failed' });
  } finally {
    client.release();
  }

  await tryAssignOldestPendingOrder();
  await tryAssignOldestPendingPickTask();
  if (changedOrderId) {
    notifyOrderUpdated(changedOrderId, 'payment_updated');
  }
  return res.json({ ok: true });
});

app.patch(
  '/api/orders/:orderId/status',
  authRequired(JWT_SECRET),
  validateParams(orderIdParamsSchema),
  validateBody(updateOrderStatusBodySchema),
  async (req, res) => {
  const { orderId } = req.params as unknown as { orderId: number };
  const { status, comment } = req.body as { status: OrderStatus; comment?: string | null };
  const allowed: OrderStatus[] = [
    ORDER_STATUS.assembling,
    ORDER_STATUS.courierAssigned,
    ORDER_STATUS.courierPicked,
    ORDER_STATUS.onTheWay,
    ORDER_STATUS.arrived,
    ORDER_STATUS.received,
    ORDER_STATUS.paid,
    ORDER_STATUS.cancelled
  ];

  if (!allowed.includes(status as OrderStatus)) {
    return res.status(400).json({ message: 'Некорректный статус или orderId' });
  }
  const nextStatus = status as OrderStatus;
  if (nextStatus === ORDER_STATUS.paid) {
    return res.status(403).json({ message: 'Статус "Оплачен" устанавливается только через платежный webhook' });
  }

  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });
  const order = normalizeOrderRow(orderRow);

  if (req.user!.role === 'customer') {
    if (order.user_id !== req.user!.id) {
      return res.status(403).json({ message: 'Клиент может менять только свой заказ' });
    }
    if (nextStatus === ORDER_STATUS.cancelled) {
      if (order.status === ORDER_STATUS.cancelled) {
        return res.json({ order: orderView(order), idempotent: true });
      }
      if (!CUSTOMER_EDITABLE_STATUSES.includes(order.status as OrderStatus)) {
        return res.status(403).json({ message: 'Отмена доступна только на этапах "Собирается" или "Назначен курьер"' });
      }
    } else {
      return res.status(403).json({ message: 'Клиент может только отменить заказ' });
    }
  }

  if (req.user!.role === 'admin' && !(await requireAdminPermission(req, res, 'manage_orders'))) return;

  if (req.user!.role === 'courier') {
    const courier = (await db.query('SELECT * FROM couriers WHERE user_id = $1 LIMIT 1', [req.user!.id])).rows[0];
    const courierAllowed: OrderStatus[] = [
      ORDER_STATUS.courierPicked,
      ORDER_STATUS.onTheWay,
      ORDER_STATUS.arrived,
      ORDER_STATUS.received
    ];
    if (!courier || order.assigned_courier_id !== toNumber(courier.id) || !courierAllowed.includes(nextStatus)) {
      return res.status(403).json({ message: 'Заказ не назначен этому курьеру или статус запрещен' });
    }
    if (!courierEligible(courier)) {
      return res.status(403).json({ message: 'Курьер не верифицирован. Смена статуса недоступна.' });
    }
    if (nextStatus === ORDER_STATUS.courierPicked) {
      const pickTask = (
        await db.query(
          `
            SELECT status
            FROM pick_tasks
            WHERE order_id = $1
            ORDER BY id DESC
            LIMIT 1
          `,
          [orderId]
        )
      ).rows[0];
      if (!pickTask || pickTask.status !== 'handed_to_courier') {
        return res.status(409).json({ message: 'Сборщик ещё не передал заказ курьеру' });
      }
    }
  }

  if (nextStatus === ORDER_STATUS.cancelled) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const lockedOrder = (
        await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      ).rows[0];
      if (!lockedOrder) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Заказ не найден' });
      }
      if (String(lockedOrder.status) === ORDER_STATUS.cancelled) {
        await client.query('COMMIT');
        return res.json({ order: orderView(normalizeOrderRow(lockedOrder)), idempotent: true });
      }
      const task = (
        await client.query(
          `SELECT id, status FROM pick_tasks WHERE order_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [orderId]
        )
      ).rows[0];
      if (task && ['done', 'handed_to_courier'].includes(String(task.status))) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'Товар уже физически списан. Используйте отдельную операцию возврата.' });
      }
      if (task && ['new', 'in_progress'].includes(String(task.status))) {
        await releaseOrderReservations(client, orderId, toNumber(task.id), req.user!.id);
        await client.query(
          `UPDATE pick_tasks SET status = 'cancelled', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [toNumber(task.id)]
        );
      }
      await client.query('UPDATE orders SET status = $1 WHERE id = $2', [ORDER_STATUS.cancelled, orderId]);
      await client.query(
        'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
        [orderId, ORDER_STATUS.cancelled, comment || null, req.user!.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof HttpError) return res.status(error.statusCode).json({ message: error.message });
      throw error;
    } finally {
      client.release();
    }
    const cancelledRow = (await db.query('SELECT * FROM orders WHERE id = $1', [orderId])).rows[0];
    notifyOrderUpdated(orderId, 'status_changed');
    return res.json({ order: orderView(normalizeOrderRow(cancelledRow)) });
  }

  const statusFlow: Partial<Record<OrderStatus, OrderStatus[]>> = {
    [ORDER_STATUS.courierAssigned]: [ORDER_STATUS.assembling],
    [ORDER_STATUS.courierPicked]: [ORDER_STATUS.courierAssigned],
    [ORDER_STATUS.onTheWay]: [ORDER_STATUS.courierPicked],
    [ORDER_STATUS.arrived]: [ORDER_STATUS.onTheWay],
    [ORDER_STATUS.received]: [ORDER_STATUS.arrived],
    [ORDER_STATUS.paid]: [ORDER_STATUS.received]
  };
  const allowedPrev = statusFlow[nextStatus];
  if (allowedPrev && !allowedPrev.includes(order.status as OrderStatus)) {
    return res.status(409).json({ message: 'Неверный порядок статусов заказа' });
  }

  await db.query('UPDATE orders SET status = $1 WHERE id = $2', [nextStatus, orderId]);
  await db.query(
    'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
    [orderId, nextStatus, comment || null, req.user!.id]
  );

  // Если сборщик уже передал заказ курьеру, а курьер нажал «принял»,
  // автоматически переводим заказ в «в пути»
  if (nextStatus === ORDER_STATUS.courierPicked) {
    const pickTask = (
      await db.query('SELECT status FROM pick_tasks WHERE order_id = $1 LIMIT 1', [orderId])
    ).rows[0];
    if (pickTask?.status === 'handed_to_courier') {
      await db.query('UPDATE orders SET status = $1 WHERE id = $2', [ORDER_STATUS.onTheWay, orderId]);
      await db.query(
        'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
        [orderId, ORDER_STATUS.onTheWay, 'Курьер принял заказ от сборщика', req.user!.id]
      );
    }
  }

  const updatedRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  const updatedOrder = normalizeOrderRow(updatedRow);
  await createNotification({
    userId: updatedOrder.user_id,
    level: 'info',
    title: `Статус заказа #${orderId}: ${nextStatus}`,
    body: comment ? String(comment) : null,
    entityType: 'order',
    entityId: orderId
  });
  if (updatedOrder.assigned_courier_id) {
    const courierUser = (await db.query('SELECT user_id FROM couriers WHERE id = $1 LIMIT 1', [updatedOrder.assigned_courier_id])).rows[0];
    if (courierUser?.user_id) {
      await createNotification({
        userId: toNumber(courierUser.user_id),
        level: 'info',
        title: `Обновление заказа #${orderId}: ${nextStatus}`,
        body: comment ? String(comment) : null,
        entityType: 'order',
        entityId: orderId
      });
    }
  }
  notifyOrderUpdated(orderId, 'status_changed');
  return res.json({ order: orderView(updatedOrder) });
}
);

app.patch('/api/orders/:orderId/edit', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const body = req.body as { deliveryAddress?: string; deliveryLat?: number | null; deliveryLng?: number | null };
  const orderRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!orderRow) return res.status(404).json({ message: 'Заказ не найден' });
  const order = normalizeOrderRow(orderRow);

  if (req.user!.role === 'customer') {
    if (order.user_id !== req.user!.id) {
      return res.status(403).json({ message: 'Изменять можно только свой заказ' });
    }
    if (!CUSTOMER_EDITABLE_STATUSES.includes(order.status as OrderStatus)) {
      return res.status(409).json({ message: 'Изменение доступно только на этапах "Собирается" или "Назначен курьер"' });
    }
  } else if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_orders'))) return;
  } else {
    return res.status(403).json({ message: 'Недостаточно прав для изменения заказа' });
  }

  const nextAddress = String(body.deliveryAddress || '').trim();
  if (!nextAddress) return res.status(400).json({ message: 'deliveryAddress обязателен' });
  const parsedAddress = parseDeliveryAddress(nextAddress);
  if (!parsedAddress) return res.status(400).json({ message: 'Адрес должен быть в формате: населенный пункт, улица, дом 44' });
  if (parsedAddress.locality.length < 2) return res.status(400).json({ message: 'Укажите город или населенный пункт' });
  if (!hasStreetName(parsedAddress.street)) return res.status(400).json({ message: 'Укажите корректное название улицы в адресе доставки' });

  const hasLat = body.deliveryLat !== undefined && body.deliveryLat !== null;
  const hasLng = body.deliveryLng !== undefined && body.deliveryLng !== null;
  if (hasLat !== hasLng) return res.status(400).json({ message: 'Координаты доставки должны быть переданы парой' });
  let deliveryLat = hasLat ? Number(body.deliveryLat) : null;
  let deliveryLng = hasLng ? Number(body.deliveryLng) : null;
  if (
    (deliveryLat !== null && (Number.isNaN(deliveryLat) || deliveryLat < -90 || deliveryLat > 90)) ||
    (deliveryLng !== null && (Number.isNaN(deliveryLng) || deliveryLng < -180 || deliveryLng > 180))
  ) {
    return res.status(400).json({ message: 'Некорректные координаты доставки' });
  }

  if (deliveryLat === null || deliveryLng === null) {
    const resolved = await resolveCoordinatesFromAddress(nextAddress);
    if (resolved) {
      deliveryLat = resolved.lat;
      deliveryLng = resolved.lng;
    }
  }

  if (deliveryLat === null || deliveryLng === null) {
    return res.status(409).json({ message: 'Не удалось определить координаты адреса. Укажите точку на карте.' });
  }

  const orderItemRows = (await db.query(
    `
      SELECT product_id, quantity
      FROM order_items
      WHERE order_id = $1
    `,
    [orderId]
  )).rows as Array<{ product_id: number; quantity: number }>;
  const demandByProduct = buildDemandFromRows(orderItemRows);
  const deliveryQuote = await buildDeliveryQuote(deliveryLat, deliveryLng, demandByProduct);
  if (!deliveryQuote.warehouseCode && !deliveryQuote.warehouseName) {
    return res.status(409).json({ message: 'Не удалось автоматически назначить склад сборки по расстоянию' });
  }
  if (deliveryQuote.serviceable === false) {
    return res.status(409).json({ message: deliveryQuote.reason || 'Доставка по этому адресу недоступна' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const lockedOrder = (await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    if (!lockedOrder || !CUSTOMER_EDITABLE_STATUSES.includes(String(lockedOrder.status) as OrderStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Заказ уже нельзя редактировать' });
    }
    const reservedWarehouse = (
      await client.query(
        `
          SELECT w.code
          FROM pick_tasks pt JOIN warehouses w ON w.id = pt.warehouse_id
          WHERE pt.order_id = $1 AND pt.status IN ('new', 'in_progress')
          LIMIT 1 FOR UPDATE OF pt
        `,
        [orderId]
      )
    ).rows[0];
    if (reservedWarehouse && String(reservedWarehouse.code) !== String(deliveryQuote.warehouseCode || '')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Новый адрес требует другого склада. Отмените заказ и оформите новый.' });
    }
    await client.query(
      `
        UPDATE orders
        SET delivery_address = $1, delivery_lat = $2, delivery_lng = $3, serviceable = $4,
            delivery_zone = $5, fulfillment_warehouse = $6, fulfillment_warehouse_code = $7,
            warehouse_distance_km = $8, route_distance_km = $9, delivery_eta_min = $10, delivery_fee = $11
        WHERE id = $12
      `,
      [nextAddress, deliveryLat, deliveryLng, deliveryQuote.serviceable, deliveryQuote.zoneName,
        deliveryQuote.warehouseName, deliveryQuote.warehouseCode, deliveryQuote.warehouseDistanceKm,
        deliveryQuote.routeDistanceKm, deliveryQuote.etaMin, deliveryQuote.deliveryFee, orderId]
    );
    await client.query(
      'INSERT INTO order_events (order_id, status, comment, created_by) VALUES ($1, $2, $3, $4)',
      [orderId, order.status, req.user!.role === 'admin' ? 'Администратор изменил адрес заказа' : 'Клиент изменил адрес заказа', req.user!.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const updatedRow = (await db.query('SELECT * FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  notifyOrderUpdated(orderId, 'address_changed');
  return res.json({ order: orderView(normalizeOrderRow(updatedRow)) });
});

app.delete('/api/orders/:orderId', authRequired(JWT_SECRET), async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) return res.status(400).json({ message: 'Некорректный orderId' });

  const row = (await db.query('SELECT id, user_id, status, archived_at FROM orders WHERE id = $1 LIMIT 1', [orderId])).rows[0];
  if (!row) return res.status(404).json({ message: 'Заказ не найден' });

  const ownerId = toNumber(row.user_id);
  const status = String(row.status || '');

  if (req.user!.role === 'customer') {
    if (ownerId !== req.user!.id) return res.status(403).json({ message: 'Можно удалить только свой заказ' });
    if (status !== ORDER_STATUS.cancelled && status !== ORDER_STATUS.paid) {
      return res.status(409).json({ message: 'Удаление доступно только для отмененных или завершенных заказов' });
    }
  } else if (req.user!.role === 'admin') {
    if (!(await requireAdminPermission(req, res, 'manage_orders'))) return;
  } else {
    return res.status(403).json({ message: 'Недостаточно прав для удаления заказа' });
  }

  if (status !== ORDER_STATUS.cancelled && status !== ORDER_STATUS.paid) {
    return res.status(409).json({ message: 'Физическое удаление запрещено. Сначала отмените или завершите заказ.' });
  }
  if (row.archived_at) return res.json({ message: 'Заказ уже архивирован', idempotent: true });
  await db.query('UPDATE orders SET archived_at = NOW() WHERE id = $1', [orderId]);
  notifyOrderUpdated(orderId, 'deleted');
  return res.json({ message: 'Заказ перемещен в архив' });
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
  const nextStatus = body.status === 'busy' ? 'busy' : 'available';
  if (nextStatus === 'available' && !courierEligible(courier)) {
    return res.status(403).json({ message: 'Сначала пройдите верификацию курьера: транспорт, права и фото техпаспорта' });
  }

  const updatedRow = (
    await db.query(
      `
        UPDATE couriers
        SET vehicle_type = $1,
            status = $2,
            last_seen_at = NOW(),
            max_active_orders = 1
        WHERE id = $3
        RETURNING *
      `,
      [body.vehicleType || courier.vehicle_type || 'bike', nextStatus, courier.id]
    )
  ).rows[0];
  if (nextStatus === 'available') {
    await tryAssignOldestPendingOrder();
    await tryAssignOldestPendingPickTask();
  }
  const updatedUser = await getUserById(targetUser.id);
  const isSelfUpdate = req.user!.id === targetUser.id;

  return res.json({
    message: 'Курьер подключен',
    courierId: courier.id,
    status: nextStatus,
    isOnline: courierIsOnline(updatedRow),
    lastSeenAt: updatedRow.last_seen_at ? new Date(updatedRow.last_seen_at).toISOString() : null,
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
      isOnline: courierIsOnline(row),
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
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

app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);

  const requestId = req.requestId || 'unknown';
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack || '' : '';
  console.error('[ERROR]', requestId, req.method, req.originalUrl, '-', errorMessage, errorStack);

  const sendError = (statusCode: number, message: string, details?: Record<string, unknown>) => {
    const safeStatusCode = Math.max(400, Math.min(599, Math.floor(Number(statusCode) || 500)));
    return res.status(safeStatusCode).json({
      error: {
        code: mapErrorCode(safeStatusCode),
        message,
        requestId,
        ...(details ? { details } : {})
      }
    });
  };

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return sendError(413, `Файл слишком большой. Максимум ${Math.round(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))} МБ`);
    }
    return sendError(400, 'Ошибка загрузки файла');
  }

  if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOSPC') {
    return sendError(507, 'На сервере закончилось место для загрузки файлов');
  }

  const statusCode =
    error && typeof error === 'object' && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : NaN;
  const isHttpStatus = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599;
  if (isHttpStatus) {
    const exposeMessage =
      error && typeof error === 'object' && 'exposeMessage' in error
        ? Boolean((error as { exposeMessage?: unknown }).exposeMessage)
        : statusCode < 500;
    const message =
      exposeMessage && error instanceof Error && error.message.trim() ? error.message : 'Внутренняя ошибка сервера';
    return sendError(statusCode, message);
  }

  return sendError(500, 'Внутренняя ошибка сервера');
});

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

if (!process.env.VERCEL) {
  const certsDir = path.join(process.cwd(), 'certs');
  const keyPath = path.join(certsDir, 'dev-key.pem');
  const certPath = path.join(certsDir, 'dev-cert.pem');
  let runtimeServer: NetServer | null = null;

  const startRuntimeServer = (server: NetServer, scheme: 'http' | 'https') => {
    runtimeServer = server;
    runtimeServer.on('error', (error: any) => {
      if (error?.code === 'EADDRINUSE') {
        console.error(`[FATAL] Порт ${PORT} уже занят. Остановите старый процесс и запустите снова.`);
        process.exit(1);
      }
      console.error('[FATAL] Ошибка сервера:', error);
      process.exit(1);
    });
    runtimeServer.listen(PORT, () => {
      console.log(`API запущен на ${scheme}://localhost:${PORT}`);
    });
  };

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    setImmediate(() => {
      try {
        runtimeServer?.close?.();
        (runtimeServer as any)?.closeAllConnections?.();
      } catch (e) {
        // ignore
      }
      
      try {
        db.end?.().catch(() => {});
        mapDb.end?.().catch(() => {});
        tenantDbResolver.close?.();
      } catch (e) {
        // ignore
      }
      
      // Exit on next tick
      setImmediate(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught exception:', error);
  });

  if (existsSync(keyPath) && existsSync(certPath)) {
    const httpsOptions = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath)
    };
    startRuntimeServer(https.createServer(httpsOptions, app), 'https');
  } else {
    console.warn('SSL сертификаты не найдены. Запуск в HTTP режиме.');
    startRuntimeServer(http.createServer(app), 'http');
  }
}

export default app;
