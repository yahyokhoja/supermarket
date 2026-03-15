import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import DeliveryMapPicker from './components/DeliveryMapPicker';
import AdminWarehouseLocationMap from './components/AdminWarehouseLocationMap';

type Role = 'customer' | 'courier' | 'admin' | 'picker';
type Status =
  | 'assembling'
  | 'courier_assigned'
  | 'courier_picked'
  | 'on_the_way'
  | 'arrived'
  | 'received'
  | 'paid'
  | 'cancelled';

type User = {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  address: string | null;
  role: Role;
  permissions: string[];
  warehouseScopes?: number[] | null;
};

type Product = {
  id: number;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category?: string | null;
  inStock?: boolean;
  stockQuantity?: number;
  homeWarehouseId?: number | null;
};

type CartItem = {
  id: number;
  productId: number;
  name: string;
  price: number;
  quantity: number;
  lineTotal: number;
};

type Order = {
  id: number;
  userId: number;
  status: Status;
  total: number;
  deliveryAddress: string;
  deliveryLat: number | null;
  deliveryLng: number | null;
  routeUrl?: string | null;
  serviceable: boolean | null;
  deliveryZone: string | null;
  fulfillmentWarehouse: string | null;
  fulfillmentWarehouseCode: string | null;
  warehouseDistanceKm: number | null;
  routeDistanceKm: number | null;
  deliveryEtaMin: number | null;
  deliveryFee: number | null;
  courierFee: number | null;
  paymentMethod: string | null;
  assignedCourierId: number | null;
  createdAt: string;
  customerName?: string | null;
  customerPhone?: string | null;
  pickTaskStatus?: string | null;
  pickerId?: number | null;
  pickerName?: string | null;
  items?: OrderItem[];
};
type OrderItem = {
  productId: number;
  name: string;
  quantity: number;
  unitPrice: number;
};

type Courier = {
  id: number;
  fullName: string;
  email: string;
  status: string;
  isOnline?: boolean;
  lastSeenAt?: string | null;
  vehicleType: string;
  verificationStatus?: string;
  transportLicense?: string | null;
  vehicleRegistrationNumber?: string | null;
  techPassportImageUrl?: string | null;
  verificationComment?: string | null;
  verificationRequestedAt?: string | null;
  verificationReviewedBy?: string | null;
  verifiedAt?: string | null;
  isEligible?: boolean;
  activeOrders: number;
  maxActiveOrders: number;
};

type AdminUser = {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  address: string | null;
  role: Role;
  isActive: boolean;
  permissions: string[];
  warehouseScopes: number[] | null;
  createdAt: string;
};

type AdminAuditLog = {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  admin: {
    id: number;
    fullName: string;
    email: string;
  } | null;
};
type AdminSearchResponse = {
  query: string;
  suggestions: string[];
  results: {
    users: Array<{ id: number; fullName: string; email: string; phone: string | null; role: Role; isActive: boolean }>;
    products: Array<{ id: number; name: string; category: string | null; price: number; inStock: boolean; stockQuantity: number }>;
    orders: Array<{ id: number; userId: number; status: Status; total: number; deliveryAddress: string; assignedCourierId: number | null }>;
    couriers: Array<{ id: number; userId: number; fullName: string; email: string; vehicleType: string | null; status: string; verificationStatus: string }>;
  };
};
type AdminAnalytics = {
  totals: {
    ordersTotal: number;
    pendingCount: number;
    assignedCount: number;
    pickedUpCount: number;
    onTheWayCount: number;
    arrivedCount: number;
    receivedCount: number;
    deliveredCount: number;
    cancelledCount: number;
    revenueTotal: number;
    deliveredRevenue: number;
    avgCheck: number;
  };
  range30d: {
    orders: number;
    revenue: number;
    avgCheck: number;
  };
  daily14d: Array<{ day: string; orders: number; revenue: number }>;
  topProducts: Array<{ productName: string; quantity: number; revenue: number }>;
  topLocalities: Array<{ locality: string; orders: number; revenue: number }>;
};
type WarehouseItem = {
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  productId: number;
  productName: string;
  category: string | null;
  imageUrl: string | null;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  reorderMin: number;
  reorderTarget: number;
  updatedAt: string;
};
type LowStockItem = WarehouseItem & { orderSuggestion: number };
type WarehouseInfo = { id: number; code: string; name: string; lat: number | null; lng: number | null; isActive: boolean };
type StockMovement = {
  id: number;
  warehouseId: number;
  productId: number;
  movementType: string;
  quantity: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: number | null;
  warehouseName: string;
  productName: string;
  createdBy: string | null;
  createdAt: string;
};
type PickTaskItem = { productId: number; productName: string; requestedQty: number; pickedQty: number };
type PickTask = {
  id: number;
  orderId: number;
  warehouseId: number;
  warehouseName: string;
  status: 'new' | 'in_progress' | 'done' | 'handed_to_courier' | 'cancelled';
  assignedTo: number | null;
  assignedToName: string | null;
  pickTaskStatus?: string | null;
  pickerName?: string | null;
  createdBy: number | null;
  createdByName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: PickTaskItem[];
};
type WarehouseOverviewResponse = {
  warehouses: WarehouseInfo[];
  stock: WarehouseItem[];
  lowStock: LowStockItem[];
  movements: StockMovement[];
};
type PickTasksResponse = { tasks: PickTask[] };

type CourierProfile = {
  id: number;
  userId: number;
  vehicleType: string | null;
  status: string;
  verificationStatus: string;
  transportLicense: string | null;
  vehicleRegistrationNumber: string | null;
  techPassportImageUrl: string | null;
  verificationComment?: string | null;
  verificationRequestedAt?: string | null;
  verificationReviewedBy?: string | null;
  verifiedAt?: string | null;
  isEligible: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
};

type SavedDelivery = {
  locality: string;
  address: string;
  houseNumber: string;
  location: { lat: number; lng: number } | null;
};

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
type AdminOrderEditState = {
  orderId: number;
  locality: string;
  address: string;
  houseNumber: string;
  location: { lat: number; lng: number } | null;
};

type AdminProduct = {
  id: number;
  name: string;
  description: string | null;
  price: number;
  category: string | null;
  imageUrl: string | null;
  inStock: boolean;
  stockQuantity: number;
  homeWarehouseId: number | null;
};
type AdminCategoryItem = {
  name: string;
  subcategories: string[];
};
type SmartProductSuggestion = {
  suggestion: {
    name: string;
    category: string;
    subcategory: string;
    description: string;
  };
};
type HeaderSection = 'catalog' | 'profile' | 'cart' | 'map';
type AdminTab = 'orders' | 'analytics' | 'products' | 'warehouse' | 'users' | 'couriers' | 'audit' | 'search';
type StockMovementType = 'receive' | 'writeoff' | 'reserve';

function stockRowKey(warehouseId: number, productId: number) {
  return `${warehouseId}:${productId}`;
}

function parseWarehouseRoute(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[0] !== 'admin' || parts[1] !== 'warehouse') return null;
  const warehouseCode = decodeURIComponent(parts[2] || 'all');
  const category = decodeURIComponent(parts.slice(3).join('/') || 'all');
  return { warehouseCode, category };
}

function buildWarehouseRoutePath(warehouseCode: string, category: string) {
  const safeWarehouse = encodeURIComponent(warehouseCode || 'all');
  const safeCategory = encodeURIComponent(category || 'all');
  return `/admin/warehouse/${safeWarehouse}/${safeCategory}`;
}

const ADMIN_PERMISSION_OPTIONS = [
  { key: 'view_orders', label: 'Просмотр заказов' },
  { key: 'view_analytics', label: 'Бизнес-аналитика' },
  { key: 'manage_products', label: 'Управление товарами' },
  { key: 'manage_warehouse', label: 'Управление складом' },
  { key: 'manage_users', label: 'Управление пользователями' },
  { key: 'manage_couriers', label: 'Управление курьерами' },
  { key: 'view_audit', label: 'Просмотр аудит-лога' },
  { key: 'search_db', label: 'Поиск по БД' }
] as const;

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '';
const STATUS_LABELS: Record<Status, string> = {
  assembling: 'Собирается',
  courier_assigned: 'Назначен курьер',
  courier_picked: 'Курьер получил',
  on_the_way: 'В пути',
  arrived: 'Прибыл',
  received: 'Получен',
  paid: 'Оплачен',
  cancelled: 'Отменен'
};

const STATUS_ACTION_LABELS: Record<Status, string> = {
  assembling: 'Собирается',
  courier_assigned: 'Назначен курьер',
  courier_picked: 'Курьер получил',
  on_the_way: 'В пути',
  arrived: 'Прибыл',
  received: 'Получен',
  paid: 'Оплачен',
  cancelled: 'Отменить'
};
const PICK_TASK_STATUS_LABELS: Record<string, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Собрана',
  handed_to_courier: 'Отдана курьеру',
  cancelled: 'Отменена'
};

const ROLE_LABELS: Record<Role, string> = {
  customer: 'Покупатель',
  courier: 'Курьер',
  admin: 'Администратор',
  picker: 'Сборщик'
};

const COURIER_STATUS_LABELS: Record<string, string> = {
  available: 'Свободен',
  busy: 'Занят',
  offline: 'Оффлайн'
};
const COURIER_VERIFICATION_LABELS: Record<string, string> = {
  pending: 'Не отправлено',
  submitted: 'На проверке',
  approved: 'Подтвержден',
  rejected: 'Отклонен'
};
const ADMIN_TAB_LABELS: Record<AdminTab, string> = {
  orders: 'Заказы',
  analytics: 'Аналитика',
  products: 'Товары',
  warehouse: 'Склад',
  users: 'Пользователи',
  couriers: 'Курьеры',
  search: 'Поиск',
  audit: 'Аудит-лог'
};
const DELIVERY_DRAFT_KEY = 'delivery_draft_v1';
const LAST_DELIVERY_KEY = 'last_delivery_v1';
const CART_HINT_KEY = 'cart_checkout_hint_shown_v1';
const MAX_UPLOAD_FILE_SIZE_BYTES = 6 * 1024 * 1024;
const MAX_UPLOAD_FILE_SIZE_MB = 6;

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

function hasLocalityName(locality: string) {
  return locality.trim().length >= 2;
}

function normalizeHouseNumber(raw: string) {
  const value = raw.trim().replace(/^дом\s*/iu, '');
  if (!value) return '';
  const tailMatch = value.match(/(\d+[A-Za-zА-Яа-я\-\/]*)$/u);
  if (tailMatch) return tailMatch[1];
  return value;
}

function isValidHouseNumber(raw: string) {
  const value = normalizeHouseNumber(raw);
  if (!value) return false;
  return /^[0-9A-Za-zА-Яа-я\-\/]{1,12}$/u.test(value);
}

function normalizeStreetInput(streetRaw: string, localityRaw: string) {
  const street = streetRaw.trim();
  if (!street) return '';
  const locality = localityRaw.trim().toLowerCase();
  if (!locality) return street;

  const normalized = street.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  if (lower === locality) return '';
  if (lower.startsWith(`${locality},`)) return normalized.slice(locality.length + 1).trim();
  return normalized;
}

function parseOrderAddressForForm(rawAddress: string) {
  const source = String(rawAddress || '').trim();
  if (!source) return { locality: '', street: '', houseNumber: '' };
  const parts = source
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const locality = parts[0] || '';
  const street = normalizeStreetInput(parts[1] || '', locality);
  let houseNumber = normalizeHouseNumber(parts.slice(2).join(' '));

  if (!houseNumber) {
    const m = source.match(/(?:дом|д\.?)\s*([0-9A-Za-zА-Яа-я\-\/]{1,12})/iu);
    if (m?.[1]) houseNumber = normalizeHouseNumber(m[1]);
  }

  return { locality, street, houseNumber };
}

function validateImageUpload(file: File, label: string) {
  if (!file.type.startsWith('image/')) {
    return `${label}: разрешены только изображения (JPG, PNG, WEBP).`;
  }
  return '';
}

function loadImageElement(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number, mime: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Не удалось обработать изображение'));
          return;
        }
        resolve(blob);
      },
      mime,
      quality
    );
  });
}

async function prepareImageForUpload(
  file: File,
  label: string,
  opts: { targetMime?: 'image/webp' | 'image/jpeg'; maxSide?: number } = {}
): Promise<{ file: File | null; error: string }> {
  const invalidReason = validateImageUpload(file, label);
  if (invalidReason) return { file: null, error: invalidReason };
  if (file.size <= MAX_UPLOAD_FILE_SIZE_BYTES) return { file, error: '' };

  try {
    const image = await loadImageElement(file);
    const maxSide = opts.maxSide || 1920;
    const scale = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file: null, error: `${label}: не удалось подготовить изображение.` };
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    const qualities = [0.78, 0.68, 0.58, 0.48, 0.38];
    let bestBlob: Blob | null = null;
    const targetMime = opts.targetMime || 'image/jpeg';
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, quality, targetMime);
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= MAX_UPLOAD_FILE_SIZE_BYTES) {
        bestBlob = blob;
        break;
      }
    }

    if (!bestBlob) {
      if (file.size <= MAX_UPLOAD_FILE_SIZE_BYTES) return { file, error: '' };
      return { file: null, error: `${label}: не удалось обработать фото.` };
    }

    if (bestBlob.size > MAX_UPLOAD_FILE_SIZE_BYTES && maxSide > 900) {
      return prepareImageForUpload(file, label, { targetMime: 'image/jpeg', maxSide: 900 });
    }
    if (bestBlob.size > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return {
        file: null,
        error: `${label}: файл слишком большой даже после сжатия. Выберите фото меньшего размера.`
      };
    }

    const ext = targetMime === 'image/webp' ? 'webp' : 'jpg';
    const prepared = new File([bestBlob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}-compressed.${ext}`, {
      type: targetMime
    });
    return { file: prepared, error: '' };
  } catch {
    if (file.size <= MAX_UPLOAD_FILE_SIZE_BYTES) return { file, error: '' };
    if (file.size <= MAX_UPLOAD_FILE_SIZE_BYTES * 1.5) {
      // последний шанс: ужать до 900px JPEG без доп. попыток
      if (opts.maxSide && opts.maxSide <= 900) {
        return { file: null, error: `${label}: не удалось обработать фото. Сделайте снимок меньшего размера.` };
      }
      return prepareImageForUpload(file, label, { targetMime: 'image/jpeg', maxSide: 900 });
    }
    return {
      file: null,
      error: `${label}: не удалось завершить обработку фото. На устройстве может не хватать памяти. Сделайте снимок меньшего размера (до ~5 МБ).`
    };
  }
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<{ items: CartItem[]; total: number }>({ items: [], total: 0 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [repeatingOrderId, setRepeatingOrderId] = useState<number | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<number | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);
  const [adminEditingOrderId, setAdminEditingOrderId] = useState<number | null>(null);
  const [adminDeletingOrderId, setAdminDeletingOrderId] = useState<number | null>(null);
  const [adminOrderEdit, setAdminOrderEdit] = useState<AdminOrderEditState | null>(null);
  const [courierOrders, setCourierOrders] = useState<Order[]>([]);
  const [openCourierOrders, setOpenCourierOrders] = useState<Order[]>([]);
  const [courierHistory, setCourierHistory] = useState<Order[]>([]);
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminAuditLogs, setAdminAuditLogs] = useState<AdminAuditLog[]>([]);
  const [adminProducts, setAdminProducts] = useState<AdminProduct[]>([]);
  const [adminCategories, setAdminCategories] = useState<AdminCategoryItem[]>([]);
  const [warehouseOverview, setWarehouseOverview] = useState<WarehouseOverviewResponse>({
    warehouses: [],
    stock: [],
    lowStock: [],
    movements: []
  });
  const [pickTasks, setPickTasks] = useState<PickTask[]>([]);
  const [adminAnalytics, setAdminAnalytics] = useState<AdminAnalytics>({
    totals: {
      ordersTotal: 0,
      pendingCount: 0,
      assignedCount: 0,
      pickedUpCount: 0,
      onTheWayCount: 0,
      arrivedCount: 0,
      receivedCount: 0,
      deliveredCount: 0,
      cancelledCount: 0,
      revenueTotal: 0,
      deliveredRevenue: 0,
      avgCheck: 0
    },
    range30d: { orders: 0, revenue: 0, avgCheck: 0 },
    daily14d: [],
    topProducts: [],
    topLocalities: []
  });
  const [adminTab, setAdminTab] = useState<AdminTab>('orders');
  const [adminSearchQuery, setAdminSearchQuery] = useState('');
  const [adminSearchLoading, setAdminSearchLoading] = useState(false);
  const [adminSearchData, setAdminSearchData] = useState<AdminSearchResponse>({
    query: '',
    suggestions: [],
    results: { users: [], products: [], orders: [], couriers: [] }
  });
  const [deliveryLocality, setDeliveryLocality] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryHouseNumber, setDeliveryHouseNumber] = useState('');
  const [deliveryLocation, setDeliveryLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [deliveryQuote, setDeliveryQuote] = useState<DeliveryQuote | null>(null);
  const [deliveryQuoteLoading, setDeliveryQuoteLoading] = useState(false);
  const [lastDelivery, setLastDelivery] = useState<SavedDelivery | null>(() => {
    try {
      const raw = localStorage.getItem(LAST_DELIVERY_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedDelivery;
      if (!parsed.address || !parsed.houseNumber || !parsed.locality) return null;
      return parsed;
    } catch {
      return null;
    }
  });
  const [toast, setToast] = useState('');

  const [loginState, setLoginState] = useState({ email: '', password: '' });
  const [registerState, setRegisterState] = useState({ fullName: '', email: '', password: '', phone: '', address: '' });
  const [profileState, setProfileState] = useState({ fullName: '', phone: '', address: '' });
  const [courierState, setCourierState] = useState({ vehicleType: 'bike', status: 'available' });
  const [courierProfile, setCourierProfile] = useState<CourierProfile | null>(null);
  const [courierVerificationForm, setCourierVerificationForm] = useState({
    vehicleType: 'bike',
    transportLicense: '',
    vehicleRegistrationNumber: '',
    techPassportImageUrl: ''
  });
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [verificationSaving, setVerificationSaving] = useState(false);
  const [techPassportUploading, setTechPassportUploading] = useState(false);
  const [adminResetUserId, setAdminResetUserId] = useState(0);
  const [adminResetPasswordValue, setAdminResetPasswordValue] = useState('');
  const [adminReviewComments, setAdminReviewComments] = useState<Record<number, string>>({});
  const [stockActionForm, setStockActionForm] = useState({
    movementType: 'receive' as StockMovementType,
    warehouseId: 0,
    productId: 0,
    quantity: '1',
    reason: ''
  });
  const [stockActionSubmitting, setStockActionSubmitting] = useState(false);
  const [quickStockSubmittingKey, setQuickStockSubmittingKey] = useState('');
  const [warehouseStockSearch, setWarehouseStockSearch] = useState('');
  const [warehouseView, setWarehouseView] = useState({
    warehouseId: 0,
    category: 'all'
  });
  const [warehouseRouteIntent, setWarehouseRouteIntent] = useState<{ warehouseCode: string; category: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    return parseWarehouseRoute(window.location.pathname);
  });
  const [selectedWarehouseStockKeys, setSelectedWarehouseStockKeys] = useState<Record<string, boolean>>({});
  const [bulkStockForm, setBulkStockForm] = useState({
    movementType: 'reserve' as StockMovementType,
    quantity: '1',
    reason: ''
  });
  const [bulkStockSubmitting, setBulkStockSubmitting] = useState(false);
  const [warehouseJournalFilters, setWarehouseJournalFilters] = useState({
    warehouseId: 0,
    movementType: 'all',
    product: '',
    dateFrom: '',
    dateTo: '',
    limit: '300'
  });
  const [warehouseJournalLoading, setWarehouseJournalLoading] = useState(false);
  const [warehouseJournal, setWarehouseJournal] = useState<StockMovement[]>([]);
  const [pickTaskCreateForm, setPickTaskCreateForm] = useState({
    orderId: '',
    warehouseId: 0
  });
  const [warehousePointForm, setWarehousePointForm] = useState({
    warehouseId: 0,
    lat: '',
    lng: ''
  });
  const [warehousePointLocating, setWarehousePointLocating] = useState(false);
  const [pickTaskStatusDrafts, setPickTaskStatusDrafts] = useState<Record<number, PickTask['status']>>({});
  const [adminUserRoleDrafts, setAdminUserRoleDrafts] = useState<Record<number, Role>>({});
  const [adminUserActiveDrafts, setAdminUserActiveDrafts] = useState<Record<number, boolean>>({});
  const [adminUserPermissionsDrafts, setAdminUserPermissionsDrafts] = useState<Record<number, string[]>>({});
  const [adminUserWarehouseScopesDrafts, setAdminUserWarehouseScopesDrafts] = useState<Record<number, number[]>>({});
  const [staffCreateForm, setStaffCreateForm] = useState({
    fullName: '',
    email: '',
    password: '',
    phone: '',
    address: '',
    role: 'picker' as Role,
    permissions: [] as string[],
    warehouseScopes: [] as number[]
  });
  const [productForm, setProductForm] = useState({
    id: 0,
    name: '',
    description: '',
    price: '',
    category: '',
    imageUrl: '',
    inStock: true,
    stockQuantity: '0',
    warehouseId: ''
  });
  const [productFormCategory, setProductFormCategory] = useState('');
  const [productFormSubcategory, setProductFormSubcategory] = useState('');
  const [categoryCreateForm, setCategoryCreateForm] = useState({ category: '', subcategory: '' });
  const [categoryEditForm, setCategoryEditForm] = useState({
    category: '',
    subcategory: '',
    newCategory: '',
    newSubcategory: ''
  });
  const [imageUploading, setImageUploading] = useState(false);
  const [smartDetecting, setSmartDetecting] = useState(false);
  const [becomingCourier, setBecomingCourier] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedSubcategory, setSelectedSubcategory] = useState('all');
  const [profileOpen, setProfileOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [deliveryMapOpen, setDeliveryMapOpen] = useState(false);
  const profileSectionRef = useRef<HTMLElement | null>(null);
  const catalogSectionRef = useRef<HTMLElement | null>(null);
  const cartSectionRef = useRef<HTMLElement | null>(null);
  const authSectionRef = useRef<HTMLElement | null>(null);
  const loginEmailInputRef = useRef<HTMLInputElement | null>(null);
  const registerNameInputRef = useRef<HTMLInputElement | null>(null);
  const adminProductFormRef = useRef<HTMLFormElement | null>(null);
  const adminProductNameInputRef = useRef<HTMLInputElement | null>(null);
  const warehouseOperationFormRef = useRef<HTMLFormElement | null>(null);
  const warehouseOperationQuantityRef = useRef<HTMLInputElement | null>(null);
  const sessionExpiredHandledRef = useRef(false);

  const loggedIn = Boolean(token && user);
  const isSystemAdmin = user?.email?.trim().toLowerCase() === 'admin@universal.local';

  const productCategoryMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const product of products) {
      const raw = String(product.category || '').trim();
      if (!raw) {
        if (!map.has('Без категории')) map.set('Без категории', new Set<string>());
        continue;
      }
      const parts = raw
        .split(/[>/]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const category = parts[0] || 'Без категории';
      const subcategory = parts[1] || '';
      if (!map.has(category)) map.set(category, new Set<string>());
      if (subcategory) map.get(category)!.add(subcategory);
    }
    return map;
  }, [products]);

  const categoryOptions = useMemo(() => Array.from(productCategoryMap.keys()).sort((a, b) => a.localeCompare(b, 'ru')), [productCategoryMap]);
  const subcategoryOptions = useMemo(() => {
    if (selectedCategory === 'all') return [] as string[];
    return Array.from(productCategoryMap.get(selectedCategory) || []).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [selectedCategory, productCategoryMap]);

  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      const raw = String(product.category || '').trim();
      const parts = raw
        .split(/[>/]/)
        .map((p) => p.trim())
        .filter(Boolean);
      const category = parts[0] || 'Без категории';
      const subcategory = parts[1] || '';
      if (selectedCategory !== 'all' && category !== selectedCategory) return false;
      if (selectedSubcategory !== 'all' && subcategory !== selectedSubcategory) return false;
      return true;
    });
  }, [products, selectedCategory, selectedSubcategory]);
  const cartItemsCount = useMemo(
    () => cart.items.reduce((sum, item) => sum + item.quantity, 0),
    [cart.items]
  );
  const cartQuantityByProduct = useMemo(() => {
    const map = new Map<number, { itemId: number; quantity: number }>();
    for (const item of cart.items) {
      map.set(item.productId, { itemId: item.id, quantity: item.quantity });
    }
    return map;
  }, [cart.items]);

  const adminCategoryMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of adminCategories) {
      const category = String(item.name || '').trim();
      if (!category) continue;
      if (!map.has(category)) map.set(category, new Set<string>());
      for (const sub of item.subcategories || []) {
        const s = String(sub || '').trim();
        if (s) map.get(category)!.add(s);
      }
    }
    return map;
  }, [adminCategories]);

  const adminCategoryOptions = useMemo(() => Array.from(adminCategoryMap.keys()).sort((a, b) => a.localeCompare(b, 'ru')), [adminCategoryMap]);
  const adminSubcategoryOptions = useMemo(() => {
    const selected = productFormCategory.trim();
    if (!selected) {
      const all = new Set<string>();
      for (const set of adminCategoryMap.values()) {
        for (const value of set) all.add(value);
      }
      return Array.from(all).sort((a, b) => a.localeCompare(b, 'ru'));
    }
    return Array.from(adminCategoryMap.get(selected) || []).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [adminCategoryMap, productFormCategory]);
  const adminDeliveredOrders = useMemo(() => allOrders.filter((o) => o.status === 'paid' || o.status === 'received'), [allOrders]);
  const warehouseNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of warehouseOverview.warehouses) {
      map.set(w.id, w.name);
    }
    return map;
  }, [warehouseOverview.warehouses]);

  const warehouseProductOptions = useMemo(() => {
    const selectedWarehouse = Number(stockActionForm.warehouseId || 0);
    const source = selectedWarehouse
      ? warehouseOverview.stock.filter((item) => item.warehouseId === selectedWarehouse)
      : warehouseOverview.stock;
    const seen = new Map<number, { id: number; name: string; available: number; total: number; reserved: number }>();
    for (const item of source) {
      if (!seen.has(item.productId)) {
        seen.set(item.productId, {
          id: item.productId,
          name: item.productName,
          available: item.availableQuantity,
          total: item.quantity,
          reserved: item.reservedQuantity
        });
      }
    }
    return Array.from(seen.values());
  }, [warehouseOverview.stock, stockActionForm.warehouseId]);
  const selectedStockItem = useMemo(
    () =>
      warehouseOverview.stock.find(
        (item) => item.warehouseId === Number(stockActionForm.warehouseId) && item.productId === Number(stockActionForm.productId)
      ) || null,
    [warehouseOverview.stock, stockActionForm.warehouseId, stockActionForm.productId]
  );
  const stockActionQuantityNumber = useMemo(() => {
    const value = Math.floor(Number(stockActionForm.quantity));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value;
  }, [stockActionForm.quantity]);
  const stockActionPreview = useMemo(() => {
    if (!selectedStockItem) {
      return { nextAvailable: 0, nextReserved: 0, note: 'Выберите товар для предпросмотра операции' };
    }
    const qty = stockActionQuantityNumber;
    const currentAvailable = Number(selectedStockItem.availableQuantity || 0);
    const currentReserved = Number(selectedStockItem.reservedQuantity || 0);
    if (qty <= 0) {
      return { nextAvailable: currentAvailable, nextReserved: currentReserved, note: 'Введите количество больше 0' };
    }

    if (stockActionForm.movementType === 'receive') {
      return {
        nextAvailable: currentAvailable + qty,
        nextReserved: currentReserved,
        note: `После приемки +${qty} шт.`
      };
    }
    if (stockActionForm.movementType === 'writeoff') {
      return {
        nextAvailable: Math.max(currentAvailable - qty, 0),
        nextReserved: currentReserved,
        note: currentAvailable < qty ? 'Недостаточно доступного остатка для полного списания' : `После списания -${qty} шт.`
      };
    }
    return {
      nextAvailable: Math.max(currentAvailable - qty, 0),
      nextReserved: currentReserved + qty,
      note: currentAvailable < qty ? 'Недостаточно доступного остатка для полного резерва' : `После резерва +${qty} шт. в резерв`
    };
  }, [selectedStockItem, stockActionQuantityNumber, stockActionForm.movementType]);
  const filteredWarehouseStock = useMemo(() => {
    const scopedByWarehouse =
      Number(warehouseView.warehouseId) > 0
        ? warehouseOverview.stock.filter((item) => item.warehouseId === Number(warehouseView.warehouseId))
        : warehouseOverview.stock;
    const scopedByCategory =
      warehouseView.category !== 'all'
        ? scopedByWarehouse.filter((item) => String(item.category || 'Без категории') === warehouseView.category)
        : scopedByWarehouse;
    const q = warehouseStockSearch.trim().toLowerCase();
    if (!q) return scopedByCategory;
    return scopedByCategory.filter((item) => {
      const text = `${item.warehouseName} ${item.warehouseCode} ${item.productName} ${item.productId}`.toLowerCase();
      return text.includes(q);
    });
  }, [warehouseOverview.stock, warehouseStockSearch, warehouseView.warehouseId, warehouseView.category]);
  const warehouseViewCategories = useMemo(() => {
    const source =
      Number(warehouseView.warehouseId) > 0
        ? warehouseOverview.stock.filter((item) => item.warehouseId === Number(warehouseView.warehouseId))
        : warehouseOverview.stock;
    const unique = new Set<string>();
    for (const item of source) unique.add(String(item.category || 'Без категории'));
    return Array.from(unique).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [warehouseOverview.stock, warehouseView.warehouseId]);
  const warehouseViewName = useMemo(() => {
    if (!Number(warehouseView.warehouseId)) return 'Все склады';
    return warehouseOverview.warehouses.find((w) => w.id === Number(warehouseView.warehouseId))?.name || 'Склад';
  }, [warehouseOverview.warehouses, warehouseView.warehouseId]);
  const warehouseMetrics = useMemo(() => {
    let totalAvailable = 0;
    let totalReserved = 0;
    for (const item of warehouseOverview.stock) {
      totalAvailable += Number(item.availableQuantity || 0);
      totalReserved += Number(item.reservedQuantity || 0);
    }
    return {
      skuCount: warehouseOverview.stock.length,
      lowStockCount: warehouseOverview.lowStock.length,
      totalAvailable,
      totalReserved
    };
  }, [warehouseOverview.stock, warehouseOverview.lowStock.length]);
  const selectedWarehouseStockItems = useMemo(
    () =>
      warehouseOverview.stock.filter((item) =>
        Boolean(selectedWarehouseStockKeys[stockRowKey(item.warehouseId, item.productId)])
      ),
    [warehouseOverview.stock, selectedWarehouseStockKeys]
  );
  const warehousePointLat = useMemo(() => {
    const raw = warehousePointForm.lat.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }, [warehousePointForm.lat]);
  const warehousePointLng = useMemo(() => {
    const raw = warehousePointForm.lng.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }, [warehousePointForm.lng]);
  const availableAdminTabs = useMemo(() => {
    if (user?.role !== 'admin') return [] as AdminTab[];
    const allowedTabs: AdminTab[] = [];
    if (hasAdminPermission('view_orders')) allowedTabs.push('orders');
    if (hasAdminPermission('view_analytics')) allowedTabs.push('analytics');
    if (hasAdminPermission('manage_products')) allowedTabs.push('products');
    if (hasAdminPermission('manage_warehouse')) allowedTabs.push('warehouse');
    if (hasAdminPermission('manage_users')) allowedTabs.push('users');
    if (hasAdminPermission('manage_couriers')) allowedTabs.push('couriers');
    if (hasAdminPermission('search_db')) allowedTabs.push('search');
    if (hasAdminPermission('view_audit')) allowedTabs.push('audit');
    return allowedTabs;
  }, [user?.role, user?.permissions, isSystemAdmin]);

  function hasAdminPermission(permission: string) {
    if (!user || user.role !== 'admin') return false;
    if (isSystemAdmin) return true;
    return (user.permissions || []).includes(permission);
  }

  function notify(message: string) {
    setToast(message);
    setTimeout(() => setToast(''), 2200);
  }

  function scrollToSection(ref: { current: HTMLElement | null }) {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openOnlySection(section: HeaderSection) {
    setCatalogOpen(section === 'catalog');
    setProfileOpen(section === 'profile');
    setCartOpen(section === 'cart' || section === 'map');
    setDeliveryMapOpen(section === 'map');
  }

  function goToCatalog() {
    if (catalogOpen) {
      setCatalogOpen(false);
      return;
    }
    openOnlySection('catalog');
    setTimeout(() => scrollToSection(catalogSectionRef), 0);
  }

  function changeHeaderCategory(nextCategory: string) {
    setSelectedCategory(nextCategory);
    setSelectedSubcategory('all');
  }

  useEffect(() => {
    if (!adminCategories.length) {
      setCategoryEditForm({ category: '', subcategory: '', newCategory: '', newSubcategory: '' });
      return;
    }
    setCategoryEditForm((prev) => {
      const firstCategory = adminCategories[0].name;
      const category = prev.category && adminCategoryMap.has(prev.category) ? prev.category : firstCategory;
      const subs = Array.from(adminCategoryMap.get(category) || []);
      const subcategory = prev.subcategory && subs.includes(prev.subcategory) ? prev.subcategory : '';
      return { ...prev, category, subcategory };
    });
  }, [adminCategories, adminCategoryMap]);

  function goToProfile() {
    if (profileOpen) {
      setProfileOpen(false);
      return;
    }
    openOnlySection('profile');
    setTimeout(() => scrollToSection(profileSectionRef), 0);
  }

  function goToMap() {
    if (cart.items.length === 0) {
      notify('Корзина пуста');
      return;
    }
    openOnlySection('map');
    setTimeout(() => scrollToSection(cartSectionRef), 0);
  }

  function toggleMapInCart() {
    if (cart.items.length === 0) {
      notify('Корзина пуста');
      return;
    }
    if (!cartOpen) {
      openOnlySection('cart');
      setTimeout(() => scrollToSection(cartSectionRef), 0);
    }
    setDeliveryMapOpen((prev) => !prev);
  }

  function goToCart() {
    if (cart.items.length === 0) {
      notify('Корзина пуста');
      return;
    }
    if (cartOpen && !deliveryMapOpen) {
      setCartOpen(false);
      setDeliveryMapOpen(false);
      return;
    }
    openOnlySection('cart');
    setTimeout(() => scrollToSection(cartSectionRef), 0);
  }

  function goToAuth(mode: 'login' | 'register') {
    setTimeout(() => {
      scrollToSection(authSectionRef);
      if (mode === 'login') loginEmailInputRef.current?.focus();
      else registerNameInputRef.current?.focus();
    }, 0);
  }

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const headers: Record<string, string> = { ...(init.headers || {}) as Record<string, string> };
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
      if (!sessionExpiredHandledRef.current) {
        sessionExpiredHandledRef.current = true;
        setToken(null);
        setUser(null);
        localStorage.removeItem('token');
        setProfileOpen(false);
        setCartOpen(false);
        setDeliveryMapOpen(false);
        notify('Сессия завершена. Войдите снова.');
        goToAuth('login');
      }
      throw new Error('Сессия завершена. Войдите снова.');
    }

    if (!res.ok) {
      throw new Error(data.message || 'Ошибка API');
    }

    return data as T;
  }

  async function loadProducts() {
    const data = await api<{ products: Product[] }>('/api/products');
    setProducts(data.products);
  }

  async function loadMe() {
    const data = await api<{ user: User }>('/api/users/me');
    setUser(data.user);
    setProfileState({
      fullName: data.user.fullName,
      phone: data.user.phone || '',
      address: data.user.address || ''
    });
    try {
      const rawDraft = localStorage.getItem(DELIVERY_DRAFT_KEY);
      if (rawDraft) {
        const draft = JSON.parse(rawDraft) as SavedDelivery;
        setDeliveryLocality(draft.locality || '');
        setDeliveryAddress(draft.address || '');
        setDeliveryHouseNumber(draft.houseNumber || '');
        setDeliveryLocation(draft.location || null);
        return;
      }
    } catch {
      // ignore broken draft
    }

    if (lastDelivery) {
      setDeliveryLocality(lastDelivery.locality);
      setDeliveryAddress(lastDelivery.address);
      setDeliveryHouseNumber(lastDelivery.houseNumber);
      setDeliveryLocation(lastDelivery.location);
      return;
    }

    setDeliveryLocality('');
    setDeliveryAddress(data.user.address || '');
    setDeliveryHouseNumber('');
    setDeliveryLocation(null);
  }

  async function loadCart() {
    if (!token) return;
    const data = await api<{ items: CartItem[]; total: number }>('/api/cart');
    setCart(data);
  }

  async function loadOrders() {
    if (!token) return;
    const data = await api<{ orders: Order[] }>('/api/orders/my');
    setOrders(data.orders);
  }

  async function loadDeliveryQuote(address: string, location: { lat: number; lng: number } | null) {
    if (!location) {
      setDeliveryQuote(null);
      return;
    }
    setDeliveryQuoteLoading(true);
    try {
      const data = await api<{ quote: DeliveryQuote }>('/api/delivery/quote', {
        method: 'POST',
        body: JSON.stringify({
          deliveryAddress: address,
          deliveryLat: location.lat,
          deliveryLng: location.lng
        })
      });
      setDeliveryQuote(data.quote);
    } catch (err) {
      setDeliveryQuote({
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
        reason: (err as Error).message
      });
    } finally {
      setDeliveryQuoteLoading(false);
    }
  }

  async function loadCourierOrders() {
    if (user?.role !== 'courier') return;
    const data = await api<{ orders: Order[] }>('/api/orders/assigned');
    setCourierOrders(data.orders);
  }

  async function loadCourierProfile() {
    if (user?.role !== 'courier') return;
    const data = await api<{ courier: CourierProfile }>('/api/couriers/me');
    setCourierProfile(data.courier);
    setCourierVerificationForm({
      vehicleType: data.courier.vehicleType || 'bike',
      transportLicense: data.courier.transportLicense || '',
      vehicleRegistrationNumber: data.courier.vehicleRegistrationNumber || '',
      techPassportImageUrl: data.courier.techPassportImageUrl || ''
    });
  }

  async function loadOpenCourierOrders() {
    if (user?.role !== 'courier') return;
    const data = await api<{ orders: Order[] }>('/api/orders/open');
    setOpenCourierOrders(data.orders);
  }

  async function loadCourierHistory() {
    if (user?.role !== 'courier') return;
    const data = await api<{ orders: Order[] }>('/api/orders/history');
    setCourierHistory(data.orders);
  }

  async function sendCourierHeartbeat(busy?: boolean) {
    if (user?.role !== 'courier') return;
    try {
      const data = await api<{ status: string; isOnline: boolean; lastSeenAt: string | null }>('/api/couriers/me/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ busy: Boolean(busy) })
      });
      setCourierProfile((prev) =>
        prev
          ? {
              ...prev,
              status: data.status,
              isOnline: data.isOnline,
              lastSeenAt: data.lastSeenAt
            }
          : prev
      );
    } catch {
      /* без шума */
    }
  }

  async function loadAdminData() {
    if (user?.role !== 'admin') return;
    const [ordersRes, analyticsRes, couriersRes, productsRes, categoriesRes, usersRes, logsRes] = await Promise.all([
      hasAdminPermission('view_orders') ? api<{ orders: Order[] }>('/api/orders/all') : Promise.resolve({ orders: [] }),
      hasAdminPermission('view_analytics')
        ? api<AdminAnalytics>('/api/admin/analytics')
        : Promise.resolve({
            totals: {
              ordersTotal: 0,
              pendingCount: 0,
              assignedCount: 0,
              pickedUpCount: 0,
              onTheWayCount: 0,
              arrivedCount: 0,
              receivedCount: 0,
              deliveredCount: 0,
              cancelledCount: 0,
              revenueTotal: 0,
              deliveredRevenue: 0,
              avgCheck: 0
            },
            range30d: { orders: 0, revenue: 0, avgCheck: 0 },
            daily14d: [],
            topProducts: [],
            topLocalities: []
          }),
      hasAdminPermission('manage_couriers') ? api<{ couriers: Courier[] }>('/api/couriers') : Promise.resolve({ couriers: [] }),
      hasAdminPermission('manage_products') ? api<{ products: AdminProduct[] }>('/api/admin/products') : Promise.resolve({ products: [] }),
      hasAdminPermission('manage_products') ? api<{ categories: AdminCategoryItem[] }>('/api/admin/categories') : Promise.resolve({ categories: [] }),
      hasAdminPermission('manage_users') ? api<{ users: AdminUser[] }>('/api/admin/users') : Promise.resolve({ users: [] }),
      hasAdminPermission('view_audit') ? api<{ logs: AdminAuditLog[] }>('/api/admin/audit-logs?limit=150') : Promise.resolve({ logs: [] })
    ]);
    setAllOrders(ordersRes.orders);
    setAdminAnalytics(analyticsRes);
    setCouriers(couriersRes.couriers);
    setAdminProducts(productsRes.products);
    setAdminCategories(categoriesRes.categories);
    setAdminUsers(usersRes.users);
    setAdminAuditLogs(logsRes.logs);
    setAdminUserRoleDrafts(Object.fromEntries(usersRes.users.map((u) => [u.id, u.role])) as Record<number, Role>);
    setAdminUserActiveDrafts(Object.fromEntries(usersRes.users.map((u) => [u.id, u.isActive])) as Record<number, boolean>);
    setAdminUserPermissionsDrafts(Object.fromEntries(usersRes.users.map((u) => [u.id, u.permissions || []])) as Record<number, string[]>);
    setAdminUserWarehouseScopesDrafts(
      Object.fromEntries(usersRes.users.map((u) => [u.id, Array.isArray(u.warehouseScopes) ? u.warehouseScopes : []])) as Record<number, number[]>
    );
  }

  async function loadPickTasksForPicker() {
    if (user?.role !== 'picker') return;
    const data = await api<PickTasksResponse>('/api/admin/pick-tasks');
    setPickTasks(data.tasks);
    setPickTaskStatusDrafts(Object.fromEntries(data.tasks.map((task) => [task.id, task.status])) as Record<number, PickTask['status']>);
  }

  async function loadWarehouseData() {
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('manage_warehouse')) return;
    const [overviewRes, tasksRes] = await Promise.all([
      api<WarehouseOverviewResponse>('/api/admin/warehouse/overview'),
      api<PickTasksResponse>('/api/admin/pick-tasks')
    ]);
    setWarehouseOverview(overviewRes);
    setWarehouseJournal(overviewRes.movements || []);
    setPickTasks(tasksRes.tasks);
    setPickTaskStatusDrafts(Object.fromEntries(tasksRes.tasks.map((task) => [task.id, task.status])) as Record<number, PickTask['status']>);

    const fallbackWarehouseId = overviewRes.warehouses[0]?.id || 0;
    setStockActionForm((prev) => ({
      ...prev,
      warehouseId: prev.warehouseId || fallbackWarehouseId,
      productId: prev.productId || overviewRes.stock[0]?.productId || 0
    }));
    setPickTaskCreateForm((prev) => ({
      ...prev,
      warehouseId: prev.warehouseId || fallbackWarehouseId
    }));
    setWarehousePointForm((prev) => {
      const selectedId = prev.warehouseId || fallbackWarehouseId;
      const selected = overviewRes.warehouses.find((w) => w.id === selectedId);
      return {
        warehouseId: selectedId,
        lat: selected?.lat !== null && selected?.lat !== undefined ? String(selected.lat) : '',
        lng: selected?.lng !== null && selected?.lng !== undefined ? String(selected.lng) : ''
      };
    });
    setWarehouseView((prev) => ({
      ...prev,
      warehouseId: prev.warehouseId || (warehouseRouteIntent ? 0 : fallbackWarehouseId)
    }));
    setWarehouseJournalFilters((prev) => ({
      ...prev,
      warehouseId: prev.warehouseId || (warehouseRouteIntent ? 0 : fallbackWarehouseId)
    }));
  }

  async function runAdminSearch(query: string) {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setAdminSearchData({
        query: normalized,
        suggestions: [],
        results: { users: [], products: [], orders: [], couriers: [] }
      });
      return;
    }
    setAdminSearchLoading(true);
    try {
      const data = await api<AdminSearchResponse>(`/api/admin/search?q=${encodeURIComponent(normalized)}&limit=10`);
      setAdminSearchData(data);
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setAdminSearchLoading(false);
    }
  }

  useEffect(() => {
    loadProducts().catch((e: Error) => notify(e.message));
  }, []);

  useEffect(() => {
    if (!token) {
      setUser(null);
      setOrders([]);
      setCart({ items: [], total: 0 });
      setOpenCourierOrders([]);
      return;
    }

    sessionExpiredHandledRef.current = false;

    loadMe()
      .then(() => Promise.all([loadCart(), loadOrders(), loadPickTasksForPicker()]))
      .catch(() => {
        setToken(null);
        localStorage.removeItem('token');
      });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const interval = window.setInterval(() => {
      if (user?.role === 'customer') {
        loadOrders().catch(() => undefined);
      }
      if (user?.role === 'courier') {
        Promise.all([loadCourierOrders(), loadOpenCourierOrders(), loadCourierHistory()]).catch(() => undefined);
      }
      if (user?.role === 'admin') {
        loadAdminData().catch(() => undefined);
      }
      if (user?.role === 'picker') {
        loadPickTasksForPicker().catch(() => undefined);
      }
    }, 20000);
    return () => window.clearInterval(interval);
  }, [token, user?.role]);

  useEffect(() => {
    if (!user) return;
    loadCourierOrders().catch(() => undefined);
    loadOpenCourierOrders().catch(() => undefined);
    loadCourierHistory().catch(() => undefined);
    loadCourierProfile().catch(() => undefined);
    loadAdminData().catch(() => undefined);
    loadWarehouseData().catch(() => undefined);
  }, [user]);

  useEffect(() => {
    if (user?.role !== 'courier') {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      return;
    }
    const tick = () => void sendCourierHeartbeat(courierProfile?.status === 'busy');
    tick();
    heartbeatRef.current = setInterval(tick, 60_000);
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [user?.role, courierProfile?.status]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('search_db')) return;
    const timer = setTimeout(() => {
      runAdminSearch(adminSearchQuery).catch(() => undefined);
    }, 220);
    return () => clearTimeout(timer);
  }, [adminSearchQuery, user?.role, user?.permissions]);

  useEffect(() => {
    if (!availableAdminTabs.length) return;
    if (!availableAdminTabs.includes(adminTab)) {
      setAdminTab(availableAdminTabs[0]);
    }
  }, [availableAdminTabs, adminTab]);

  useEffect(() => {
    if (!warehouseRouteIntent) return;
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('manage_warehouse')) return;
    setAdminTab('warehouse');
  }, [warehouseRouteIntent, user?.role, user?.permissions]);

  useEffect(() => {
    if (!warehouseRouteIntent) return;
    if (!warehouseOverview.warehouses.length) return;

    const targetWarehouseId =
      warehouseRouteIntent.warehouseCode.toLowerCase() === 'all'
        ? 0
        : warehouseOverview.warehouses.find((w) => w.code.trim().toLowerCase() === warehouseRouteIntent.warehouseCode.trim().toLowerCase())?.id || 0;

    const categories = new Set<string>();
    const source =
      targetWarehouseId > 0
        ? warehouseOverview.stock.filter((item) => item.warehouseId === targetWarehouseId)
        : warehouseOverview.stock;
    for (const item of source) categories.add(String(item.category || 'Без категории'));

    const requestedCategory = warehouseRouteIntent.category || 'all';
    const nextCategory = requestedCategory === 'all' || categories.has(requestedCategory) ? requestedCategory : 'all';

    setWarehouseView({ warehouseId: targetWarehouseId, category: nextCategory });
    setWarehouseJournalFilters((prev) => ({ ...prev, warehouseId: targetWarehouseId }));
    setWarehouseRouteIntent(null);
  }, [warehouseRouteIntent, warehouseOverview.warehouses, warehouseOverview.stock]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('manage_warehouse')) return;
    if (adminTab !== 'warehouse') return;

    const selected = warehouseOverview.warehouses.find((w) => w.id === Number(warehouseView.warehouseId));
    const warehouseCode = selected?.code || 'all';
    const category = warehouseView.category || 'all';
    const nextPath = buildWarehouseRoutePath(warehouseCode, category);
    if (window.location.pathname !== nextPath) {
      window.history.replaceState({}, '', nextPath);
    }
  }, [adminTab, user?.role, user?.permissions, warehouseView.warehouseId, warehouseView.category, warehouseOverview.warehouses]);

  useEffect(() => {
    if (!warehouseOverview.stock.length) {
      setSelectedWarehouseStockKeys({});
      return;
    }
    const allowed = new Set(warehouseOverview.stock.map((item) => stockRowKey(item.warehouseId, item.productId)));
    setSelectedWarehouseStockKeys((prev) => {
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (value && allowed.has(key)) next[key] = true;
      }
      return next;
    });
  }, [warehouseOverview.stock]);

  function visibleOrderActions(order: Order) {
    if (!user) return [] as Status[];
    if (order.status === 'paid' || order.status === 'cancelled') return [] as Status[];
    if (user.role === 'customer') {
      return order.status === 'assembling' || order.status === 'courier_assigned'
        ? (['cancelled'] as Status[])
        : ([] as Status[]);
    }
    if (user.role === 'courier') {
      if (order.status === 'courier_assigned') return ['courier_picked'] as Status[];
      if (order.status === 'courier_picked') return ['on_the_way'] as Status[];
      if (order.status === 'on_the_way') return ['arrived'] as Status[];
      if (order.status === 'arrived') return ['received'] as Status[];
      return [] as Status[];
    }
    if (order.status === 'assembling') return ['courier_assigned', 'cancelled'] as Status[];
    return ['cancelled'] as Status[];
  }

  function logout() {
    if (!window.confirm('Выйти из аккаунта?')) return;
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    notify('Вы вышли');
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    try {
      const data = await api<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginState)
      });
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('token', data.token);
      notify('Вход выполнен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function onRegister(e: FormEvent) {
    e.preventDefault();
    try {
      const data = await api<{ token: string; user: User }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(registerState)
      });
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('token', data.token);
      notify('Аккаунт создан');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function addToCart(productId: number) {
    if (!loggedIn) {
      notify('Сначала войдите');
      return;
    }
    await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity: 1 }) });
    await loadCart();
    notify('Товар добавлен');
    if (!localStorage.getItem(CART_HINT_KEY)) {
      window.alert('После выбора перейдите в Мои заказы и оформите заказ');
      localStorage.setItem(CART_HINT_KEY, '1');
    }
  }

  async function adjustProductQty(productId: number, delta: number) {
    if (!loggedIn) {
      notify('Сначала войдите');
      return;
    }
    if (!delta) return;

    const current = cartQuantityByProduct.get(productId);
    const currentQty = current?.quantity || 0;
    const nextQty = currentQty + delta;

    if (nextQty <= 0) {
      if (current) {
        await api(`/api/cart/items/${current.itemId}`, { method: 'DELETE' });
      }
      await loadCart();
      return;
    }

    if (!current) {
      await api('/api/cart/items', { method: 'POST', body: JSON.stringify({ productId, quantity: nextQty }) });
      await loadCart();
      return;
    }

    await api(`/api/cart/items/${current.itemId}`, { method: 'PUT', body: JSON.stringify({ quantity: nextQty }) });
    await loadCart();
  }

  async function updateCart(itemId: number, quantity: number) {
    if (quantity <= 0) {
      await api(`/api/cart/items/${itemId}`, { method: 'DELETE' });
    } else {
      await api(`/api/cart/items/${itemId}`, { method: 'PUT', body: JSON.stringify({ quantity }) });
    }
    await loadCart();
  }

  async function checkout() {
    await createOrderAndRefresh({
      locality: deliveryLocality,
      address: deliveryAddress,
      houseNumber: deliveryHouseNumber,
      location: deliveryLocation
    });
  }

  async function checkoutLastAddress() {
    if (!lastDelivery) return;
    await createOrderAndRefresh(lastDelivery);
  }

  async function createOrderAndRefresh(payload: SavedDelivery) {
    const normalizedLocality = payload.locality.trim();
    const normalizedAddress = normalizeStreetInput(payload.address, normalizedLocality);
    const normalizedHouse = normalizeHouseNumber(payload.houseNumber);
    const fullAddress = `${normalizedLocality}, ${normalizedAddress}, дом ${normalizedHouse}`.trim();
    if (!hasLocalityName(normalizedLocality)) {
      notify('Укажите город или населенный пункт');
      return;
    }
    if (!hasStreetName(normalizedAddress)) {
      notify('Введите адрес с корректным названием улицы (например: ул. Ленина)');
      return;
    }
    if (!isValidHouseNumber(normalizedHouse)) {
      notify('Укажите номер дома в формате: 44, 44А, 12/1');
      return;
    }
    if (deliveryQuote?.serviceable === false) {
      notify(deliveryQuote.reason || 'Доставка по этому адресу недоступна');
      return;
    }
    await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        deliveryAddress: fullAddress,
        deliveryLat: payload.location?.lat ?? null,
        deliveryLng: payload.location?.lng ?? null
      })
    });
    await Promise.all([loadCart(), loadOrders(), loadCourierOrders(), loadAdminData()]);
    const saved: SavedDelivery = {
      locality: normalizedLocality,
      address: normalizedAddress,
      houseNumber: normalizedHouse,
      location: payload.location
    };
    setLastDelivery(saved);
    localStorage.setItem(LAST_DELIVERY_KEY, JSON.stringify(saved));
    localStorage.removeItem(DELIVERY_DRAFT_KEY);
    setDeliveryLocation(saved.location);
    setDeliveryLocality(saved.locality);
    setDeliveryAddress(saved.address);
    setDeliveryHouseNumber(saved.houseNumber);
    notify('Заказ оформлен');
  }

  const quickAddress = useMemo(() => {
    const locality = deliveryLocality.trim();
    const street = normalizeStreetInput(deliveryAddress, locality);
    const house = normalizeHouseNumber(deliveryHouseNumber);
    if (!locality || !street || !house) return '';
    return `${locality}, ${street}, дом ${house}`;
  }, [deliveryLocality, deliveryAddress, deliveryHouseNumber]);

  useEffect(() => {
    if (!token) return;
    const draft: SavedDelivery = {
      locality: deliveryLocality.trim(),
      address: normalizeStreetInput(deliveryAddress, deliveryLocality),
      houseNumber: normalizeHouseNumber(deliveryHouseNumber),
      location: deliveryLocation
    };
    if (!draft.locality && !draft.address && !draft.houseNumber && !draft.location) {
      localStorage.removeItem(DELIVERY_DRAFT_KEY);
      return;
    }
    localStorage.setItem(DELIVERY_DRAFT_KEY, JSON.stringify(draft));
  }, [token, deliveryLocality, deliveryAddress, deliveryHouseNumber, deliveryLocation]);

  useEffect(() => {
    if (!token || !quickAddress || !deliveryLocation) {
      setDeliveryQuote(null);
      setDeliveryQuoteLoading(false);
      return;
    }
    const t = window.setTimeout(() => {
      void loadDeliveryQuote(quickAddress, deliveryLocation);
    }, 350);
    return () => window.clearTimeout(t);
  }, [token, quickAddress, deliveryLocation]);

  async function updateProfile(e: FormEvent) {
    e.preventDefault();
    const data = await api<{ user: User }>('/api/users/me', {
      method: 'PUT',
      body: JSON.stringify(profileState)
    });
    setUser(data.user);
    notify('Профиль обновлен');
  }

  async function connectCourier(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/couriers/connect', {
        method: 'POST',
        body: JSON.stringify(courierState)
      });
      await Promise.all([loadCourierOrders(), loadOpenCourierOrders(), loadCourierProfile(), loadAdminData()]);
      notify('Курьер подключен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function becomeCourier() {
    if (!user) return;
    setBecomingCourier(true);
    try {
      const data = await api<{ message: string; token?: string; user?: User; courierId?: number; status?: string }>('/api/couriers/connect', {
        method: 'POST',
        body: JSON.stringify({ vehicleType: 'bike', status: 'available' })
      });
      if (data.token) {
        setToken(data.token);
        localStorage.setItem('token', data.token);
      }
      if (data.user) {
        setUser(data.user);
      } else {
        await loadMe();
      }
      await Promise.all([loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Теперь вы курьер');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBecomingCourier(false);
    }
  }

  async function setOrderStatus(orderId: number, status: Status) {
    try {
      await api(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await Promise.all([loadOrders(), loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Статус обновлен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function claimOrder(orderId: number) {
    try {
      await api(`/api/orders/${orderId}/claim`, { method: 'POST' });
      await Promise.all([loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Заказ назначен вам');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function repeatOrderForEditing(orderId: number) {
    setRepeatingOrderId(orderId);
    try {
      const data = await api<{ items: OrderItem[] }>(`/api/orders/${orderId}`);
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) {
        notify('В выбранном заказе нет товаров');
        return;
      }

      if (cart.items.length) {
        await Promise.all(
          cart.items.map((item) => api(`/api/cart/items/${item.id}`, { method: 'DELETE' }))
        );
      }

      let restored = 0;
      let skipped = 0;
      for (const item of items) {
        if (!item.productId || item.quantity <= 0) continue;
        try {
          await api('/api/cart/items', {
            method: 'POST',
            body: JSON.stringify({ productId: item.productId, quantity: item.quantity })
          });
          restored += 1;
        } catch {
          skipped += 1;
        }
      }

      await loadCart();
      openOnlySection('cart');
      setTimeout(() => scrollToSection(cartSectionRef), 0);

      if (restored === 0) {
        notify('Не удалось добавить товары из этого заказа');
        return;
      }
      notify(skipped > 0 ? 'Заказ перенесен в корзину частично. Проверьте и отредактируйте.' : 'Заказ перенесен в корзину. Можете отредактировать его перед оформлением.');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setRepeatingOrderId(null);
    }
  }

  async function cancelMyOrder(orderId: number) {
    setCancellingOrderId(orderId);
    try {
      await api(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' as Status })
      });
      await Promise.all([loadOrders(), loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Заказ отменен');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setCancellingOrderId(null);
    }
  }

  async function editMyOrder(order: Order) {
    if (order.status !== 'assembling' && order.status !== 'courier_assigned') {
      notify('Изменение доступно только на этапах "Собирается" или "Назначен курьер"');
      return;
    }
    const nextAddress = window.prompt('Новый адрес (формат: Город, улица, дом 44):', order.deliveryAddress);
    if (!nextAddress) return;
    setEditingOrderId(order.id);
    try {
      await api(`/api/orders/${order.id}/edit`, {
        method: 'PATCH',
        body: JSON.stringify({
          deliveryAddress: nextAddress.trim(),
          deliveryLat: order.deliveryLat,
          deliveryLng: order.deliveryLng
        })
      });
      await Promise.all([loadOrders(), loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Заказ обновлен');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setEditingOrderId(null);
    }
  }

  async function deleteMyOrder(orderId: number) {
    if (!window.confirm('Удалить заказ из истории?')) return;
    setDeletingOrderId(orderId);
    try {
      await api(`/api/orders/${orderId}`, { method: 'DELETE' });
      await Promise.all([loadOrders(), loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
      notify('Заказ удален');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setDeletingOrderId(null);
    }
  }

  function toggleAdminOrderEditor(order: Order) {
    if (adminOrderEdit?.orderId === order.id) {
      setAdminOrderEdit(null);
      return;
    }
    const parsed = parseOrderAddressForForm(order.deliveryAddress);
    setAdminOrderEdit({
      orderId: order.id,
      locality: parsed.locality,
      address: parsed.street,
      houseNumber: parsed.houseNumber,
      location: order.deliveryLat !== null && order.deliveryLng !== null ? { lat: order.deliveryLat, lng: order.deliveryLng } : null
    });
  }

  async function saveAdminOrderEdit(orderId: number) {
    if (!adminOrderEdit || adminOrderEdit.orderId !== orderId) return;
    const normalizedLocality = adminOrderEdit.locality.trim();
    const normalizedAddress = normalizeStreetInput(adminOrderEdit.address, normalizedLocality);
    const normalizedHouse = normalizeHouseNumber(adminOrderEdit.houseNumber);
    const fullAddress = `${normalizedLocality}, ${normalizedAddress}, дом ${normalizedHouse}`.trim();
    if (!hasLocalityName(normalizedLocality)) {
      notify('Укажите город или населенный пункт');
      return;
    }
    if (!hasStreetName(normalizedAddress)) {
      notify('Введите адрес с корректным названием улицы (например: ул. Ленина)');
      return;
    }
    if (!isValidHouseNumber(normalizedHouse)) {
      notify('Укажите номер дома в формате: 44, 44А, 12/1');
      return;
    }

    setAdminEditingOrderId(orderId);
    try {
      await api(`/api/orders/${orderId}/edit`, {
        method: 'PATCH',
        body: JSON.stringify({
          deliveryAddress: fullAddress,
          deliveryLat: adminOrderEdit.location?.lat ?? null,
          deliveryLng: adminOrderEdit.location?.lng ?? null
        })
      });
      await loadAdminData();
      setAdminOrderEdit(null);
      notify('Заказ обновлен администратором');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setAdminEditingOrderId(null);
    }
  }

  async function adminDeleteOrder(orderId: number) {
    if (!window.confirm('Удалить заказ? Это действие необратимо.')) return;
    setAdminDeletingOrderId(orderId);
    try {
      await api(`/api/orders/${orderId}`, { method: 'DELETE' });
      if (adminOrderEdit?.orderId === orderId) setAdminOrderEdit(null);
      await Promise.all([loadAdminData(), loadOrders(), loadCourierOrders(), loadOpenCourierOrders()]);
      notify('Заказ удален администратором');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setAdminDeletingOrderId(null);
    }
  }

  async function uploadTechPassport(file: File) {
    const prepared = await prepareImageForUpload(file, 'Фото техпаспорта', { targetMime: 'image/jpeg', maxSide: 1600 });
    if (!prepared.file) {
      notify(prepared.error);
      return;
    }
    setTechPassportUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', prepared.file);
      const data = await api<{ imageUrl: string }>('/api/couriers/uploads/tech-passport', {
        method: 'POST',
        body: formData
      });
      setCourierVerificationForm((prev) => ({ ...prev, techPassportImageUrl: data.imageUrl }));
      notify('Фото техпаспорта загружено');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setTechPassportUploading(false);
    }
  }

  async function submitCourierVerification(e: FormEvent) {
    e.preventDefault();
    setVerificationSaving(true);
    try {
      await api<{ courier: CourierProfile }>('/api/couriers/me/verification', {
        method: 'PATCH',
        body: JSON.stringify(courierVerificationForm)
      });
      await Promise.all([loadCourierProfile(), loadCourierOrders(), loadOpenCourierOrders()]);
      notify('Данные отправлены на проверку администратору');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setVerificationSaving(false);
    }
  }

  async function adminResetUserPassword(e: FormEvent) {
    e.preventDefault();
    if (!adminResetUserId || adminResetPasswordValue.length < 8) {
      notify('Выберите пользователя и укажите пароль минимум 8 символов');
      return;
    }
    try {
      await api(`/api/admin/users/${adminResetUserId}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: adminResetPasswordValue })
      });
      setAdminResetPasswordValue('');
      notify('Пароль пользователя сброшен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function adminReviewCourier(courierId: number, status: 'approved' | 'rejected') {
    try {
      const comment = (adminReviewComments[courierId] || '').trim();
      await api(`/api/admin/couriers/${courierId}/verification`, {
        method: 'PATCH',
        body: JSON.stringify({ status, comment: comment || null })
      });
      await loadAdminData();
      setAdminReviewComments((prev) => ({ ...prev, [courierId]: '' }));
      notify(status === 'approved' ? 'Курьер подтвержден админом' : 'Верификация отклонена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function adminSaveUser(userId: number) {
    const role = adminUserRoleDrafts[userId];
    const isActive = adminUserActiveDrafts[userId];
    if (!role || typeof isActive !== 'boolean') {
      notify('Выберите параметры пользователя');
      return;
    }
    try {
      const payload: { role: Role; isActive: boolean; permissions?: string[]; warehouseScopes?: number[] | null } = { role, isActive };
      if (isSystemAdmin) {
        payload.permissions = adminUserPermissionsDrafts[userId] || [];
        payload.warehouseScopes = role === 'admin' ? (adminUserWarehouseScopesDrafts[userId] || []) : null;
      }
      await api<{ user: User }>(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      await Promise.all([loadAdminData(), loadProducts(), loadOrders(), loadCourierOrders(), loadOpenCourierOrders()]);
      notify('Пользователь обновлен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function adminForceLogoutUser(userId: number) {
    try {
      await api(`/api/admin/users/${userId}/force-logout`, { method: 'POST' });
      await loadAdminData();
      notify('Сессии пользователя завершены');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function adminDeleteUser(userId: number) {
    if (!window.confirm('Удалить пользователя? Это действие необратимо.')) return;
    try {
      await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (adminResetUserId === userId) {
        setAdminResetUserId(0);
        setAdminResetPasswordValue('');
      }
      await Promise.all([loadAdminData(), loadOrders(), loadCourierOrders(), loadOpenCourierOrders()]);
      notify('Пользователь удален');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function createStaffUser(e: FormEvent) {
    e.preventDefault();
    if (!isSystemAdmin) {
      notify('Только системный администратор может создавать сотрудников');
      return;
    }
    try {
      await api('/api/admin/staff', {
        method: 'POST',
        body: JSON.stringify(staffCreateForm)
      });
      setStaffCreateForm({
        fullName: '',
        email: '',
        password: '',
        phone: '',
        address: '',
        role: 'picker',
        permissions: [],
        warehouseScopes: []
      });
      await loadAdminData();
      notify('Сотрудник создан');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function createCategory(e: FormEvent) {
    e.preventDefault();
    const category = categoryCreateForm.category.trim();
    if (!category) {
      notify('Введите название категории');
      return;
    }
    try {
      await api('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({
          category,
          subcategory: categoryCreateForm.subcategory.trim() || null
        })
      });
      setCategoryCreateForm({ category: '', subcategory: '' });
      await Promise.all([loadAdminData(), loadProducts()]);
      notify('Категория сохранена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function renameCategory() {
    const oldCategory = categoryEditForm.category.trim();
    const oldSubcategory = categoryEditForm.subcategory.trim();
    const newCategory = categoryEditForm.newCategory.trim() || oldCategory;
    const newSubcategory = categoryEditForm.newSubcategory.trim();
    if (!oldCategory) {
      notify('Выберите категорию');
      return;
    }
    try {
      await api('/api/admin/categories/rename', {
        method: 'PATCH',
        body: JSON.stringify({
          oldCategory,
          oldSubcategory: oldSubcategory || null,
          newCategory,
          newSubcategory: oldSubcategory ? newSubcategory || null : null
        })
      });
      setCategoryEditForm({
        category: newCategory,
        subcategory: oldSubcategory ? newSubcategory : '',
        newCategory: '',
        newSubcategory: ''
      });
      await Promise.all([loadAdminData(), loadProducts()]);
      notify('Категория обновлена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function deleteCategory() {
    const category = categoryEditForm.category.trim();
    const subcategory = categoryEditForm.subcategory.trim();
    if (!category) {
      notify('Выберите категорию');
      return;
    }
    if (!window.confirm(subcategory ? 'Удалить подкатегорию?' : 'Удалить категорию целиком?')) return;
    try {
      await api('/api/admin/categories', {
        method: 'DELETE',
        body: JSON.stringify({ category, subcategory: subcategory || null })
      });
      await Promise.all([loadAdminData(), loadProducts()]);
      notify(subcategory ? 'Подкатегория удалена' : 'Категория удалена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function saveProduct(e: FormEvent) {
    e.preventDefault();
    try {
      const normalizedCategory = productFormCategory.trim();
      const normalizedSubcategory = productFormSubcategory.trim();
      const combinedCategory = normalizedCategory
        ? normalizedSubcategory
          ? `${normalizedCategory} > ${normalizedSubcategory}`
          : normalizedCategory
        : '';
      const payload = {
        name: productForm.name,
        description: productForm.description,
        price: Number(productForm.price),
        category: combinedCategory,
        imageUrl: productForm.imageUrl,
        inStock: productForm.inStock,
        stockQuantity: Number(productForm.stockQuantity),
        warehouseId: Number(productForm.warehouseId)
      };
      if (!payload.warehouseId || !Number.isFinite(payload.warehouseId)) {
        notify('Выберите склад для товара');
        return;
      }

      if (productForm.id) {
        await api(`/api/admin/products/${productForm.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
        notify('Товар обновлен');
      } else {
        await api('/api/admin/products', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        notify('Товар добавлен');
      }

      setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0', warehouseId: '' });
      setProductFormCategory('');
      setProductFormSubcategory('');
      await Promise.all([loadAdminData(), loadProducts()]);
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function uploadProductImage(file: File) {
    // Временно грузим оригинал без сжатия, чтобы избежать ошибок памяти на телефонах.
    const prepared = { file, error: '' };
    setImageUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', prepared.file);
      const data = await api<{ imageUrl: string }>('/api/admin/uploads/image', {
        method: 'POST',
        body: formData
      });
      setProductForm((prev) => ({ ...prev, imageUrl: data.imageUrl }));
      notify('Фото загружено');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setImageUploading(false);
    }
  }

  async function smartDetectProductByImage() {
    const imageUrl = String(productForm.imageUrl || '').trim();
    if (!imageUrl) {
      notify('Сначала загрузите фото товара');
      return;
    }
    setSmartDetecting(true);
    try {
      const data = await api<SmartProductSuggestion>('/api/admin/products/smart-detect', {
        method: 'POST',
        body: JSON.stringify({ imageUrl })
      });

      const suggestion = data.suggestion;
      if (!adminCategoryMap.has(suggestion.category)) {
        await api('/api/admin/categories', {
          method: 'POST',
          body: JSON.stringify({ category: suggestion.category, subcategory: suggestion.subcategory || null })
        });
        await loadAdminData();
      } else if (suggestion.subcategory && !Array.from(adminCategoryMap.get(suggestion.category) || []).includes(suggestion.subcategory)) {
        await api('/api/admin/categories', {
          method: 'POST',
          body: JSON.stringify({ category: suggestion.category, subcategory: suggestion.subcategory })
        });
        await loadAdminData();
      }

      setProductForm((prev) => ({
        ...prev,
        name: suggestion.name || prev.name,
        description: suggestion.description || prev.description
      }));
      setProductFormCategory(suggestion.category || '');
      setProductFormSubcategory(suggestion.subcategory || '');
      notify('Поля товара заполнены автоматически');
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setSmartDetecting(false);
    }
  }

  function editProduct(product: AdminProduct) {
    const parts = String(product.category || '')
      .split(/[>/]/)
      .map((p) => p.trim())
      .filter(Boolean);
    setProductForm({
      id: product.id,
      name: product.name,
      description: product.description || '',
      price: String(product.price),
      category: product.category || '',
      imageUrl: product.imageUrl || '',
      inStock: product.inStock,
      stockQuantity: String(product.stockQuantity ?? 0),
      warehouseId: product.homeWarehouseId ? String(product.homeWarehouseId) : ''
    });
    setProductFormCategory(parts[0] || '');
    setProductFormSubcategory(parts[1] || '');
    setTimeout(() => {
      adminProductFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      adminProductNameInputRef.current?.focus();
      adminProductNameInputRef.current?.select();
    }, 0);
  }

  async function deleteProduct(productId: number) {
    try {
      await api(`/api/admin/products/${productId}`, { method: 'DELETE' });
      if (productForm.id === productId) {
      setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0', warehouseId: '' });
        setProductFormCategory('');
        setProductFormSubcategory('');
      }
      await Promise.all([loadAdminData(), loadProducts()]);
      notify('Товар удален');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function setProductAvailability(product: AdminProduct, inStock: boolean) {
    try {
      if (inStock && Number(product.stockQuantity || 0) <= 0) {
        await api(`/api/admin/products/${product.id}`, {
          method: 'PUT',
          body: JSON.stringify({ stockQuantity: 1, inStock: true })
        });
        await Promise.all([loadAdminData(), loadProducts()]);
        notify('Товар возвращен в наличие (остаток: 1 шт.)');
        return;
      }
      await api(`/api/admin/products/${product.id}`, {
        method: 'PUT',
        body: JSON.stringify({ inStock })
      });
      await Promise.all([loadAdminData(), loadProducts()]);
      notify(inStock ? 'Товар возвращен в наличие' : 'Товар помечен как нет в наличии');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function submitStockMovement(e: FormEvent) {
    e.preventDefault();
    const warehouseId = Number(stockActionForm.warehouseId);
    const productId = Number(stockActionForm.productId);
    const quantity = Math.floor(Number(stockActionForm.quantity));
    if (!warehouseId || !productId || !Number.isFinite(quantity) || quantity <= 0) {
      notify('Выберите склад, товар и корректное количество');
      return;
    }
    const path = getStockMovementPath(stockActionForm.movementType);
    setStockActionSubmitting(true);
    try {
      await api(path, {
        method: 'POST',
        body: JSON.stringify({
          warehouseId,
          productId,
          quantity,
          reason: stockActionForm.reason
        })
      });
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData()]);
      notify(
        stockActionForm.movementType === 'receive'
          ? 'Приемка проведена'
          : stockActionForm.movementType === 'writeoff'
            ? 'Списание проведено'
            : 'Резерв создан'
      );
      setStockActionForm((prev) => ({ ...prev, quantity: '1', reason: '' }));
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setStockActionSubmitting(false);
    }
  }

  function getStockMovementPath(movementType: StockMovementType) {
    return movementType === 'receive'
      ? '/api/admin/stock/receive'
      : movementType === 'writeoff'
        ? '/api/admin/stock/writeoff'
        : '/api/admin/stock/reserve';
  }

  function getStockMovementLabel(movementType: StockMovementType) {
    return movementType === 'receive' ? 'приемку' : movementType === 'writeoff' ? 'списание' : 'резерв';
  }

  function stockMovementHumanLabel(type: string) {
    if (type === 'receive') return 'Приемка';
    if (type === 'writeoff') return 'Списание';
    if (type === 'reserve') return 'Резерв';
    if (type === 'release') return 'Снятие резерва';
    return type;
  }

  async function loadWarehouseJournal(
    activeFilters: {
      warehouseId: number;
      movementType: string;
      product: string;
      dateFrom: string;
      dateTo: string;
      limit: string;
    } = warehouseJournalFilters
  ) {
    setWarehouseJournalLoading(true);
    try {
      const params = new URLSearchParams();
      if (Number(activeFilters.warehouseId) > 0) params.set('warehouseId', String(Number(activeFilters.warehouseId)));
      if (activeFilters.movementType !== 'all') params.set('movementType', activeFilters.movementType);
      if (activeFilters.product.trim()) params.set('product', activeFilters.product.trim());
      if (activeFilters.dateFrom) params.set('dateFrom', activeFilters.dateFrom);
      if (activeFilters.dateTo) params.set('dateTo', activeFilters.dateTo);
      const limit = Math.min(Math.max(Number(activeFilters.limit) || 300, 50), 1000);
      params.set('limit', String(limit));
      const data = await api<{ movements: StockMovement[] }>(`/api/admin/stock/movements?${params.toString()}`);
      setWarehouseJournal(data.movements || []);
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setWarehouseJournalLoading(false);
    }
  }

  function exportWarehouseJournalCsv() {
    if (!warehouseJournal.length) {
      notify('Журнал пуст, экспортировать нечего');
      return;
    }
    const esc = (value: unknown) => {
      const text = String(value ?? '');
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = [
      'id',
      'createdAt',
      'movementType',
      'warehouseId',
      'warehouseName',
      'productId',
      'productName',
      'quantity',
      'reason',
      'createdBy',
      'referenceType',
      'referenceId'
    ];
    const lines = [
      header.join(','),
      ...warehouseJournal.map((m) =>
        [
          m.id,
          new Date(m.createdAt).toISOString(),
          stockMovementHumanLabel(m.movementType),
          m.warehouseId,
          m.warehouseName,
          m.productId,
          m.productName,
          m.quantity,
          m.reason || '',
          m.createdBy || '',
          m.referenceType || '',
          m.referenceId ?? ''
        ].map(esc).join(',')
      )
    ];
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `warehouse-journal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function quickStockMovement(item: WarehouseItem, movementType: StockMovementType, quantity: number) {
    if (!Number.isFinite(quantity) || quantity <= 0) {
      notify('Количество должно быть больше 0');
      return;
    }
    const submitKey = `${stockRowKey(item.warehouseId, item.productId)}:${movementType}:${quantity}`;
    setQuickStockSubmittingKey(submitKey);
    try {
      await api(getStockMovementPath(movementType), {
        method: 'POST',
        body: JSON.stringify({
          warehouseId: item.warehouseId,
          productId: item.productId,
          quantity,
          reason: `Быстрая операция из списка остатков (${getStockMovementLabel(movementType)})`
        })
      });
      setStockActionForm((prev) => ({
        ...prev,
        movementType,
        warehouseId: item.warehouseId,
        productId: item.productId,
        quantity: String(quantity)
      }));
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData()]);
      notify(
        movementType === 'receive'
          ? 'Приемка проведена'
          : movementType === 'writeoff'
            ? 'Списание проведено'
            : 'Резерв создан'
      );
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setQuickStockSubmittingKey('');
    }
  }

  function openStockActionFormForItem(item: WarehouseItem) {
    setStockActionForm((prev) => ({
      ...prev,
      warehouseId: item.warehouseId,
      productId: item.productId,
      quantity: prev.quantity || '1'
    }));
    setTimeout(() => {
      warehouseOperationFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      warehouseOperationQuantityRef.current?.focus();
      warehouseOperationQuantityRef.current?.select();
    }, 0);
  }

  async function applyBulkStockMovement() {
    const quantity = Math.floor(Number(bulkStockForm.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      notify('Для массовой операции укажите количество больше 0');
      return;
    }
    if (!selectedWarehouseStockItems.length) {
      notify('Сначала выберите товары в остатках');
      return;
    }

    const path = getStockMovementPath(bulkStockForm.movementType);
    const reason =
      bulkStockForm.reason.trim() ||
      `Массовая операция (${getStockMovementLabel(bulkStockForm.movementType)})`;

    if (!window.confirm(`Провести ${getStockMovementLabel(bulkStockForm.movementType)} для ${selectedWarehouseStockItems.length} выбранных позиций?`)) {
      return;
    }

    setBulkStockSubmitting(true);
    const results = await Promise.allSettled(
      selectedWarehouseStockItems.map((item) =>
        api(path, {
          method: 'POST',
          body: JSON.stringify({
            warehouseId: item.warehouseId,
            productId: item.productId,
            quantity,
            reason
          })
        })
      )
    );

    const success = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - success;

    if (success > 0) {
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData()]);
    }

    if (failed === 0) {
      notify(`Готово: ${success} операций выполнено`);
      setBulkStockForm((prev) => ({ ...prev, quantity: '1', reason: '' }));
      setSelectedWarehouseStockKeys({});
      setBulkStockSubmitting(false);
      return;
    }

    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    const reasonText = firstError?.reason instanceof Error ? firstError.reason.message : 'Часть операций не выполнена';
    notify(`Выполнено: ${success}, ошибок: ${failed}. ${reasonText}`);
    setBulkStockSubmitting(false);
  }

  async function createPickTaskFromOrder(e: FormEvent) {
    e.preventDefault();
    const orderId = Number(pickTaskCreateForm.orderId);
    const warehouseId = Number(pickTaskCreateForm.warehouseId);
    if (!orderId || !warehouseId) {
      notify('Укажите ID заказа и склад');
      return;
    }
    try {
      await api('/api/admin/pick-tasks/from-order', {
        method: 'POST',
        body: JSON.stringify({ orderId, warehouseId })
      });
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData()]);
      setPickTaskCreateForm((prev) => ({ ...prev, orderId: '' }));
      notify('Задача сборки создана');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function saveWarehouseLocation(e: FormEvent) {
    e.preventDefault();
    const warehouseId = Number(warehousePointForm.warehouseId);
    const lat = Number(warehousePointForm.lat);
    const lng = Number(warehousePointForm.lng);
    if (!warehouseId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      notify('Выберите склад и укажите корректные lat/lng');
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      notify('Координаты вне диапазона');
      return;
    }

    try {
      await api(`/api/admin/warehouses/${warehouseId}/location`, {
        method: 'PATCH',
        body: JSON.stringify({ lat, lng })
      });
      await loadWarehouseData();
      notify('Точка склада обновлена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function deleteWarehouseLocation() {
    const warehouseId = Number(warehousePointForm.warehouseId);
    if (!warehouseId) {
      notify('Сначала выберите склад');
      return;
    }
    if (!window.confirm('Удалить точку у выбранного склада?')) return;
    try {
      await api(`/api/admin/warehouses/${warehouseId}/location`, { method: 'DELETE' });
      setWarehousePointForm((prev) => ({ ...prev, lat: '', lng: '' }));
      await loadWarehouseData();
      notify('Точка склада удалена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  function detectWarehousePointByGeolocation() {
    if (!navigator.geolocation) {
      notify('Браузер не поддерживает геолокацию');
      return;
    }
    if (!window.isSecureContext) {
      notify('Для геолокации нужен HTTPS или localhost');
      return;
    }

    setWarehousePointLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setWarehousePointForm((prev) => ({
          ...prev,
          lat: lat.toFixed(6),
          lng: lng.toFixed(6)
        }));
        setWarehousePointLocating(false);
        notify(`Геопозиция определена (точность ~${Math.round(pos.coords.accuracy)} м)`);
      },
      (error) => {
        setWarehousePointLocating(false);
        if (error.code === 1) notify('Разрешите доступ к геолокации в браузере');
        else if (error.code === 2) notify('Не удалось определить местоположение');
        else if (error.code === 3) notify('Таймаут геолокации');
        else notify('Ошибка геолокации');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  async function savePickTaskStatus(taskId: number) {
    const status = pickTaskStatusDrafts[taskId];
    if (!status) return;
    try {
      await api(`/api/admin/pick-tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData(), loadPickTasksForPicker()]);
      notify('Статус задачи сборки обновлен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function updatePickTask(taskId: number, status: PickTask['status']) {
    try {
      await api(`/api/admin/pick-tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, assignedTo: user?.id ?? null })
      });
      await loadPickTasksForPicker();
      notify('Задача обновлена');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  return (
    <>
      <header className={`topbar${!loggedIn ? ' topbar-guest' : ''}`}>
        <h1>Universal Market Delivery</h1>
        <div className="topbar-actions">
          {loggedIn ? <button type="button" onClick={goToCatalog}>Товары</button> : null}
          {loggedIn && user?.role !== 'courier' ? (
            <div className="topbar-filters">
              <select value={selectedCategory} onChange={(e) => changeHeaderCategory(e.target.value)}>
                <option value="all">Категории</option>
                {categoryOptions.map((category) => (
                  <option key={`category-${category}`} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select
                value={selectedSubcategory}
                onChange={(e) => setSelectedSubcategory(e.target.value)}
                disabled={selectedCategory === 'all' || subcategoryOptions.length === 0}
              >
                <option value="all">Подкатегории</option>
                {subcategoryOptions.map((subcategory) => (
                  <option key={`subcategory-${subcategory}`} value={subcategory}>
                    {subcategory}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
            {loggedIn ? (
              <button type="button" onClick={goToProfile} title="Редактировать профиль">☰ Кабинет</button>
            ) : null}
          {loggedIn && cart.items.length > 0 ? (
            <button type="button" onClick={goToCart}>☰ Корзина ({cartItemsCount})</button>
          ) : null}
          {loggedIn && cart.items.length > 0 ? <button type="button" onClick={goToMap}>Карта</button> : null}
            {!loggedIn ? (
              <>
                <button type="button" onClick={() => goToAuth('login')}>Войти</button>
                <button type="button" onClick={() => goToAuth('register')}>Регистрация</button>
              </>
            ) : null}
            <span>{user ? `${user.fullName} (${ROLE_LABELS[user.role]})` : 'Гость'}</span>
          </div>
        </header>

      <main className="layout">
        {!loggedIn && (
          <section className="panel" ref={authSectionRef}>
            <h2>Вход / Регистрация</h2>
            <div className="auth-grid">
              <form id="login-form" onSubmit={onLogin}>
                <h3>Вход</h3>
                <input ref={loginEmailInputRef} placeholder="Email" type="email" value={loginState.email} onChange={(e) => setLoginState({ ...loginState, email: e.target.value })} required />
                <input placeholder="Пароль" type="password" value={loginState.password} onChange={(e) => setLoginState({ ...loginState, password: e.target.value })} required />
                <button type="submit">Войти</button>
              </form>
              <form id="register-form" onSubmit={onRegister}>
                <h3>Регистрация</h3>
                <input ref={registerNameInputRef} placeholder="ФИО" value={registerState.fullName} onChange={(e) => setRegisterState({ ...registerState, fullName: e.target.value })} required />
                <input placeholder="Email" type="email" value={registerState.email} onChange={(e) => setRegisterState({ ...registerState, email: e.target.value })} required />
                <input placeholder="Пароль" type="password" value={registerState.password} onChange={(e) => setRegisterState({ ...registerState, password: e.target.value })} required />
                <input placeholder="Телефон" value={registerState.phone} onChange={(e) => setRegisterState({ ...registerState, phone: e.target.value })} />
                <input placeholder="Адрес" value={registerState.address} onChange={(e) => setRegisterState({ ...registerState, address: e.target.value })} />
                <button type="submit">Регистрация</button>
              </form>
            </div>
          </section>
        )}

        {loggedIn && user?.role !== 'courier' && profileOpen && (
          <section className="panel" ref={profileSectionRef}>
            <h2 style={{ marginTop: 0 }}>Редактировать профиль</h2>
            <form onSubmit={updateProfile}>
              <input placeholder="ФИО" value={profileState.fullName} onChange={(e) => setProfileState({ ...profileState, fullName: e.target.value })} required />
              <input placeholder="Телефон" value={profileState.phone} onChange={(e) => setProfileState({ ...profileState, phone: e.target.value })} />
              <input placeholder="Адрес" value={profileState.address} onChange={(e) => setProfileState({ ...profileState, address: e.target.value })} />
              <button type="submit">Сохранить профиль</button>
            </form>
            {user?.role === 'customer' ? (
              <div className="inline-actions" style={{ marginTop: '10px' }}>
                <button type="button" onClick={becomeCourier} disabled={becomingCourier}>
                  {becomingCourier ? 'Подключаем...' : 'Стать курьером'}
                </button>
              </div>
            ) : null}
          </section>
        )}

        {!loggedIn ? (
          <section className="panel" ref={catalogSectionRef}>
            <h2>Каталог</h2>
            <div className="cards">
              {filteredProducts.map((p) => (
                <article className="card" key={p.id}>
                  <img src={p.imageUrl} alt={p.name} />
                  <div className="card-content">
                    <h3>{p.name}</h3>
                    <p className="muted card-desc">{p.description}</p>
                    <div className="price">${p.price.toFixed(2)}</div>
                    <button onClick={() => addToCart(p.id)}>В корзину</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="panel" ref={catalogSectionRef}>
            {user?.role === 'customer' ? (
              <div className="inline-actions" style={{ marginBottom: '8px' }}>
                <button type="button" onClick={goToCatalog}>
                  {catalogOpen ? 'Товары открыты' : 'Показать товары'}
                </button>
              </div>
            ) : null}
            {catalogOpen ? (
              <div className="cards">
                {filteredProducts.map((p) => (
                  <article className="card" key={p.id}>
                  <img src={p.imageUrl} alt={p.name} />
                  <div className="card-content">
                    <h3>{p.name}</h3>
                    <p className="muted card-desc">{p.description}</p>
                    <div className="price">${p.price.toFixed(2)}</div>
                    <div className="card-actions">
                      <button onClick={() => addToCart(p.id)}>В корзину</button>
                      <div className="card-qty">
                        <button type="button" onClick={() => adjustProductQty(p.id, -1)}>-</button>
                        <span>{cartQuantityByProduct.get(p.id)?.quantity || 0}</span>
                        <button type="button" onClick={() => adjustProductQty(p.id, 1)}>+</button>
                      </div>
                    </div>
                  </div>
                </article>
                ))}
              </div>
            ) : null}
          </section>
        )}

        {loggedIn && cart.items.length > 0 && (
          <section className="panel" ref={cartSectionRef}>
              <div className="inline-actions" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
                <h2 style={{ margin: 0 }}>Корзина</h2>
              </div>
              {cartOpen ? (
                <>
                  {cart.items.map((item) => (
                    <div className="row" key={item.id}>
                      <strong>{item.name}</strong>
                      <div>Цена: ${item.price.toFixed(2)} | Кол-во: {item.quantity} | Итого: ${item.lineTotal.toFixed(2)}</div>
                      <div className="inline-actions">
                        <button onClick={() => updateCart(item.id, item.quantity + 1)}>+1</button>
                        <button onClick={() => updateCart(item.id, item.quantity - 1)}>-1</button>
                        <button className="danger" onClick={() => updateCart(item.id, 0)}>Удалить</button>
                      </div>
                    </div>
                  ))}
                  <h3>Сумма: ${cart.total.toFixed(2)}</h3>
                  <div className="row">
                    <strong>Быстрое оформление</strong>
                    <div className="muted">
                      {quickAddress
                        ? `Адрес: ${quickAddress}`
                        : lastDelivery
                          ? `Последний адрес: ${lastDelivery.locality}, ${lastDelivery.address}, дом ${lastDelivery.houseNumber}`
                          : 'Укажите улицу и номер дома в форме ниже, затем нажмите одну кнопку.'}
                    </div>
                    {deliveryQuoteLoading ? <div className="muted">Считаем доставку...</div> : null}
                    {deliveryQuote ? (
                      <div className="muted">
                        {deliveryQuote.serviceable === false ? (
                          <>Недоступно: {deliveryQuote.reason || 'вне зоны доставки'}</>
                        ) : (
                          <>
                            {deliveryQuote.zoneName ? `Зона: ${deliveryQuote.zoneName}. ` : ''}
                            {deliveryQuote.warehouseName ? `Склад: ${deliveryQuote.warehouseName}. ` : ''}
                            {deliveryQuote.warehouseDistanceKm !== null ? `Расстояние: ${deliveryQuote.warehouseDistanceKm.toFixed(2)} км. ` : ''}
                            {deliveryQuote.routeDistanceKm !== null ? `Маршрут: ${deliveryQuote.routeDistanceKm.toFixed(2)} км. ` : ''}
                            {deliveryQuote.etaMin !== null ? `ETA: ~${deliveryQuote.etaMin} мин. ` : ''}
                            {deliveryQuote.deliveryFee !== null ? `Доставка: $${deliveryQuote.deliveryFee.toFixed(2)}.` : ''}
                            {deliveryQuote.reason ? ` ${deliveryQuote.reason}` : ''}
                          </>
                        )}
                      </div>
                    ) : null}
                    <div className="inline-actions" style={{ marginTop: '8px' }}>
                      <button onClick={checkout} disabled={!quickAddress || deliveryQuoteLoading || deliveryQuote?.serviceable === false}>
                        Оформить за 1 клик
                      </button>
                      <button onClick={checkoutLastAddress} disabled={!lastDelivery}>
                        Повторить прошлый адрес
                      </button>
                    </div>
                  </div>
                  <div className="inline-actions" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
                    <strong>Карта доставки</strong>
                    {user?.role !== 'courier' ? (
                      <button type="button" onClick={toggleMapInCart}>
                        {deliveryMapOpen ? 'Скрыть карту' : 'Показать карту'}
                      </button>
                    ) : null}
                  </div>
                  {deliveryMapOpen ? (
                    <div className="checkout">
                      <DeliveryMapPicker
                        locality={deliveryLocality}
                        onLocalityChange={setDeliveryLocality}
                        address={deliveryAddress}
                        onAddressChange={setDeliveryAddress}
                        houseNumber={deliveryHouseNumber}
                        onHouseNumberChange={setDeliveryHouseNumber}
                        location={deliveryLocation}
                        onLocationChange={setDeliveryLocation}
                      />
                      <div className="muted">Если адрес и точка уже выбраны, используйте кнопку "Оформить за 1 клик" выше.</div>
                    </div>
                  ) : null}
                </>
              ) : null}
          </section>
        )}

        {loggedIn && user?.role === 'customer' && orders.length > 0 ? (
            <section className="panel">
              <h2>Мои заказы</h2>
              {orders.map((order) => (
                <div className="row" key={order.id}>
                  <div><strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span></div>
                  <div>Сумма: ${order.total.toFixed(2)} | Адрес: {order.deliveryAddress}</div>
                  <div className="muted">
                    Склад сборки: {order.fulfillmentWarehouse || order.fulfillmentWarehouseCode || 'подбирается'}
                  </div>
                  <div className="muted">
                    Сборщик: {order.pickerName || (order.pickerId ? `#${order.pickerId}` : '—')}; Статус сборки: {order.pickTaskStatus ? PICK_TASK_STATUS_LABELS[order.pickTaskStatus] || order.pickTaskStatus : '—'}
                  </div>
                  {order.fulfillmentWarehouse || order.deliveryEtaMin !== null || order.deliveryFee !== null ? (
                    <div className="muted">
                      {order.deliveryZone ? `Зона: ${order.deliveryZone}. ` : ''}
                      {order.fulfillmentWarehouse ? `Склад: ${order.fulfillmentWarehouse}. ` : ''}
                      {order.warehouseDistanceKm !== null ? `Расстояние: ${order.warehouseDistanceKm.toFixed(2)} км. ` : ''}
                      {order.routeDistanceKm !== null ? `Маршрут: ${order.routeDistanceKm.toFixed(2)} км. ` : ''}
                      {order.deliveryEtaMin !== null ? `ETA: ~${order.deliveryEtaMin} мин. ` : ''}
                      {order.deliveryFee !== null ? `Доставка: $${order.deliveryFee.toFixed(2)}.` : ''}
                    </div>
                  ) : null}
                  {Array.isArray(order.items) && order.items.length > 0 ? (
                    <div className="muted">
                      Товары: {order.items.map((item) => `${item.name} x${item.quantity} ($${item.unitPrice.toFixed(2)})`).join(' | ')}
                    </div>
                  ) : null}
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() => repeatOrderForEditing(order.id)}
                      disabled={repeatingOrderId === order.id}
                    >
                      {repeatingOrderId === order.id ? 'Переносим...' : 'Повторить и редактировать'}
                    </button>
                    {order.status === 'assembling' || order.status === 'courier_assigned' ? (
                      <button
                        type="button"
                        onClick={() => editMyOrder(order)}
                        disabled={editingOrderId === order.id}
                      >
                        {editingOrderId === order.id ? 'Сохраняем...' : 'Изменить'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => notify('Изменение доступно только для заказов в статусе "Собирается" или "Назначен курьер"')}
                      >
                        Изменить
                      </button>
                    )}
                    {order.status === 'assembling' || order.status === 'courier_assigned' ? (
                      <button
                        type="button"
                        onClick={() => cancelMyOrder(order.id)}
                        disabled={cancellingOrderId === order.id}
                      >
                        {cancellingOrderId === order.id ? 'Отменяем...' : 'Отменить'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => notify('Отмена доступна только для заказов в статусе "Собирается" или "Назначен курьер"')}
                      >
                        Отменить
                      </button>
                    )}
                    {order.status === 'cancelled' || order.status === 'paid' ? (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => deleteMyOrder(order.id)}
                        disabled={deletingOrderId === order.id}
                      >
                        {deletingOrderId === order.id ? 'Удаляем...' : 'Удалить'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => notify('Удаление доступно только для отмененных или завершенных заказов')}
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
        ) : null}

        {user?.role === 'courier' && (
          <section className="panel">
            <div className="row">
              <strong>Верификация курьера</strong>
              <div>
                Статус: {COURIER_VERIFICATION_LABELS[courierProfile?.verificationStatus || 'pending'] || courierProfile?.verificationStatus}
              </div>
              {!courierProfile?.isEligible ? (
                <div className="muted" style={{ color: '#d83434' }}>
                  Для получения заказов заполните данные транспорта, права/лицензию и загрузите фото техпаспорта.
                </div>
              ) : null}
              <form onSubmit={submitCourierVerification}>
                <input
                  placeholder="Тип транспорта"
                  value={courierVerificationForm.vehicleType}
                  onChange={(e) => setCourierVerificationForm((prev) => ({ ...prev, vehicleType: e.target.value }))}
                  required
                />
                <input
                  placeholder="Номер прав / лицензии"
                  value={courierVerificationForm.transportLicense}
                  onChange={(e) => setCourierVerificationForm((prev) => ({ ...prev, transportLicense: e.target.value }))}
                  required
                />
                <input
                  placeholder="Госномер транспорта"
                  value={courierVerificationForm.vehicleRegistrationNumber}
                  onChange={(e) => setCourierVerificationForm((prev) => ({ ...prev, vehicleRegistrationNumber: e.target.value }))}
                  required
                />
                <label>
                  Фото техпаспорта
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      void uploadTechPassport(file);
                      e.currentTarget.value = '';
                    }}
                    disabled={techPassportUploading}
                  />
                </label>
                {techPassportUploading ? <div className="muted">Загрузка фото...</div> : null}
                {courierVerificationForm.techPassportImageUrl ? (
                  <img src={courierVerificationForm.techPassportImageUrl} alt="Техпаспорт" style={{ width: '140px', borderRadius: '8px' }} />
                ) : null}
                <button type="submit" disabled={verificationSaving || !courierVerificationForm.techPassportImageUrl}>
                  {verificationSaving ? 'Сохраняем...' : 'Отправить на проверку администратору'}
                </button>
              </form>
            </div>

            <form onSubmit={connectCourier}>
              <input placeholder="Тип транспорта" value={courierState.vehicleType} onChange={(e) => setCourierState({ ...courierState, vehicleType: e.target.value })} />
              <select value={courierState.status} onChange={(e) => setCourierState({ ...courierState, status: e.target.value })}>
                <option value="available">Свободен</option>
                <option value="busy">Занят</option>
              </select>
              <button type="submit" disabled={courierState.status === 'available' && !courierProfile?.isEligible}>Подключиться</button>
            </form>

            <h3>Свободные заказы</h3>
            {openCourierOrders.length === 0 && <p className="muted">Свободных заказов нет.</p>}
                {openCourierOrders.map((order) => (
                    <div className="row" key={`open-${order.id}`}>
                      <strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                      <div>Сумма: ${order.total.toFixed(2)}</div>
                      <div>Адрес: {order.deliveryAddress}</div>
                      <div className="muted">Склад сборки: {order.fulfillmentWarehouse || order.fulfillmentWarehouseCode || 'подбирается'}</div>
                      <div className="muted">
                        Сборщик: {order.pickerName || (order.pickerId ? `#${order.pickerId}` : '—')}; Статус сборки: {order.pickTaskStatus ? PICK_TASK_STATUS_LABELS[order.pickTaskStatus] || order.pickTaskStatus : '—'}
                      </div>
                      <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                      <div className="inline-actions">
                        <button type="button" onClick={() => claimOrder(order.id)}>Взять заказ</button>
                      </div>
                    </div>
            ))}

            <h3>Назначенные мне</h3>
            {courierOrders.length === 0 && <p className="muted">Назначенных заказов нет.</p>}
            {courierOrders.map((order) => (
              <div className="row" key={order.id}>
                <strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                <div>Адрес: {order.deliveryAddress}</div>
                <div className="muted">Склад сборки: {order.fulfillmentWarehouse || order.fulfillmentWarehouseCode || 'подбирается'}</div>
                <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                <div className="inline-actions">
                  {courierProfile?.isEligible ? (
                    (['courier_picked', 'on_the_way', 'arrived', 'received'] as Status[]).map((status) => {
                      const current = order.status;
                      const deps: Record<Status, Status[]> = {
                        courier_picked: ['courier_assigned'],
                        on_the_way: ['courier_picked'],
                        arrived: ['on_the_way'],
                        received: ['arrived'],
                        assembling: [],
                        courier_assigned: [],
                        cancelled: [],
                        paid: []
                      };
                      const hasPickHanded = order.pickTaskStatus === 'handed_to_courier';
                      const allowed = deps[status].includes(current);
                      const disabled =
                        !allowed ||
                        (status === 'courier_picked' && !hasPickHanded) ||
                        (status === 'on_the_way' && current !== 'courier_picked') ||
                        (status === 'arrived' && current !== 'on_the_way') ||
                        (status === 'received' && current !== 'arrived');
                      return (
                        <button key={status} onClick={() => setOrderStatus(order.id, status)} disabled={disabled}>
                          {STATUS_ACTION_LABELS[status]}
                        </button>
                      );
                    })
                  ) : (
                    <span className="muted">Смена статуса доступна после верификации</span>
                  )}
                </div>
                {order.routeUrl ? (
                  <div className="muted">
                    <a href={order.routeUrl} target="_blank" rel="noreferrer">Маршрут</a>
                  </div>
                ) : null}
              </div>
            ))}

            <h3>История доставок</h3>
            {courierHistory.length === 0 && <p className="muted">Пока нет доставленных заказов.</p>}
            {courierHistory.map((order) => (
              <div className="row" key={`hist-${order.id}`}>
                <strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                <div>Адрес: {order.deliveryAddress}</div>
                <div>Сумма: ${order.total.toFixed(2)}</div>
                <div className="muted">Оплата: {order.paymentMethod === 'wallet' ? 'Кошелёк' : 'Наличные'}; Оплата курьеру: {order.courierFee ? `$${order.courierFee.toFixed(2)}` : '—'}</div>
                <div className="muted">Маршрут: {order.routeDistanceKm ? `${order.routeDistanceKm.toFixed(2)} км` : '—'}</div>
                <div className="muted">Обновлён: {new Date(order.updatedAt).toLocaleString()}</div>
                {order.routeUrl ? (
                  <div className="muted">
                    <a href={order.routeUrl} target="_blank" rel="noreferrer">Маршрут</a>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        )}

        {user?.role === 'picker' && (
          <section className="panel">
            <h2>Задачи сборки</h2>
            {pickTasks.length === 0 && <p className="muted">Нет задач доступных для сборки.</p>}
            {pickTasks.map((task) => (
              <div className="row" key={`pick-${task.id}`}>
                <strong>Задача #{task.id}</strong> <span className={`badge ${task.status}`}>{task.status}</span>
                <div>Заказ: #{task.orderId} | Склад: {task.warehouseName}</div>
                <div>Назначен: {task.assignedToName || (task.assignedTo ? `#${task.assignedTo}` : 'никому')}</div>
                <div className="muted">Статус: {PICK_TASK_STATUS_LABELS[task.status] || task.status}</div>
                <div className="muted">
                  Товары: {task.items.map((i) => `${i.productName} x${i.requestedQty}`).join(' | ')}
                </div>
                <div className="inline-actions">
                  {task.assignedTo === null ? (
                    <button onClick={() => updatePickTask(task.id, 'in_progress')}>Взять в работу</button>
                  ) : null}
                  {task.assignedTo === user?.id && task.status === 'new' ? (
                    <button onClick={() => updatePickTask(task.id, 'in_progress')}>Начать</button>
                  ) : null}
                  {task.assignedTo === user?.id && task.status === 'in_progress' ? (
                    <>
                      <button onClick={() => updatePickTask(task.id, 'done')}>Завершить</button>
                      <button className="danger" onClick={() => updatePickTask(task.id, 'cancelled')}>Отменить</button>
                    </>
                  ) : null}
                  {task.assignedTo === user?.id && task.status === 'done' ? (
                    <button onClick={() => updatePickTask(task.id, 'handed_to_courier')}>Отдан курьеру</button>
                  ) : null}
                </div>
                {task.assignedTo === user?.id ? (
                  <div className="inline-actions">
                    <select
                      value={pickTaskStatusDrafts[task.id] || task.status}
                      onChange={(e) =>
                        setPickTaskStatusDrafts((prev) => ({ ...prev, [task.id]: e.target.value as PickTask['status'] }))
                      }
                    >
                      <option value="new">Новая</option>
                      <option value="in_progress">В работе</option>
                      <option value="done">Собрана</option>
                      <option value="handed_to_courier">Отдана курьеру</option>
                      <option value="cancelled">Отменена</option>
                    </select>
                    <button onClick={() => updatePickTask(task.id, (pickTaskStatusDrafts[task.id] || task.status) as PickTask['status'])}>
                      Сменить статус
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        )}

        {user?.role === 'admin' && (
          <section className="panel">
            <div className="admin-head">
              <h2>Админ-панель</h2>
            </div>
            {availableAdminTabs.length > 0 ? (
              <div className="admin-tab-select">
                <label htmlFor="admin-tab-select">Раздел админ-панели</label>
                <select
                  id="admin-tab-select"
                  value={adminTab}
                  onChange={(e) => setAdminTab(e.target.value as AdminTab)}
                >
                  {availableAdminTabs.map((tab) => (
                    <option key={`admin-tab-option-${tab}`} value={tab}>
                      {ADMIN_TAB_LABELS[tab]}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {!hasAdminPermission('view_orders') &&
            !hasAdminPermission('view_analytics') &&
            !hasAdminPermission('manage_products') &&
            !hasAdminPermission('manage_warehouse') &&
            !hasAdminPermission('manage_users') &&
            !hasAdminPermission('manage_couriers') &&
            !hasAdminPermission('search_db') &&
            !hasAdminPermission('view_audit') ? (
              <p className="muted">У вашего аккаунта сотрудника пока нет назначенных прав.</p>
            ) : null}

            {adminTab === 'orders' && hasAdminPermission('view_orders') && (
              <div>
                <h3>Все заказы</h3>
                {allOrders.map((order) => (
                  <div className="row" key={order.id}>
                    <strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                    <div>Сумма: ${order.total.toFixed(2)} | Курьер: {order.assignedCourierId ?? '-'}</div>
                    <div>Адрес: {order.deliveryAddress}</div>
                    <div className="muted">Склад сборки: {order.fulfillmentWarehouse || order.fulfillmentWarehouseCode || 'подбирается'}</div>
                    <div className="muted">
                      Сборщик: {order.pickerName || (order.pickerId ? `#${order.pickerId}` : '—')}; Статус сборки: {order.pickTaskStatus ? PICK_TASK_STATUS_LABELS[order.pickTaskStatus] || order.pickTaskStatus : '—'}
                    </div>
                    <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                    <div>Покупатель: {order.customerName || '—'} | Телефон: {order.customerPhone || '—'}</div>
                    <div className="inline-actions">
                      <button
                        type="button"
                        onClick={() => toggleAdminOrderEditor(order)}
                        disabled={adminEditingOrderId === order.id}
                      >
                        {adminOrderEdit?.orderId === order.id ? 'Свернуть' : 'Редактировать'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => adminDeleteOrder(order.id)}
                        disabled={adminDeletingOrderId === order.id}
                      >
                        {adminDeletingOrderId === order.id ? 'Удаляем...' : 'Удалить'}
                      </button>
                      {order.routeUrl ? (
                        <a className="button ghost" href={order.routeUrl} target="_blank" rel="noreferrer">
                          Маршрут
                        </a>
                      ) : null}
                    </div>
                    {adminOrderEdit?.orderId === order.id ? (
                      <div className="row">
                        <strong>Редактирование заказа #{order.id}</strong>
                        <div className="checkout">
                          <DeliveryMapPicker
                            locality={adminOrderEdit.locality}
                            onLocalityChange={(value) => setAdminOrderEdit((prev) => (prev ? { ...prev, locality: value } : prev))}
                            address={adminOrderEdit.address}
                            onAddressChange={(value) => setAdminOrderEdit((prev) => (prev ? { ...prev, address: value } : prev))}
                            houseNumber={adminOrderEdit.houseNumber}
                            onHouseNumberChange={(value) => setAdminOrderEdit((prev) => (prev ? { ...prev, houseNumber: value } : prev))}
                            location={adminOrderEdit.location}
                            onLocationChange={(value) => setAdminOrderEdit((prev) => (prev ? { ...prev, location: value } : prev))}
                          />
                        </div>
                        <div className="inline-actions">
                          <button
                            type="button"
                            onClick={() => saveAdminOrderEdit(order.id)}
                            disabled={adminEditingOrderId === order.id}
                          >
                            {adminEditingOrderId === order.id ? 'Сохраняем...' : 'Сохранить'}
                          </button>
                          <button type="button" onClick={() => setAdminOrderEdit(null)} disabled={adminEditingOrderId === order.id}>
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}

                <h3>История доставленных</h3>
                {adminDeliveredOrders.length === 0 && <p className="muted">Пока нет доставленных заказов.</p>}
                {adminDeliveredOrders.map((order) => (
                  <div className="row" key={`delivered-${order.id}`}>
                    <strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span>
                    <div>Сумма: ${order.total.toFixed(2)}</div>
                    <div>Адрес: {order.deliveryAddress}</div>
                    <div className="muted">Оплата: {order.paymentMethod === 'wallet' ? 'Кошелёк' : 'Наличные'}; Оплата курьеру: {order.courierFee ? `$${order.courierFee.toFixed(2)}` : '—'}</div>
                    <div className="muted">Маршрут: {order.routeDistanceKm ? `${order.routeDistanceKm.toFixed(2)} км` : '—'}</div>
                    <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : '—'}</div>
                    <div>Покупатель: {order.customerName || '—'} | Телефон: {order.customerPhone || '—'}</div>
                    {order.routeUrl ? (
                      <a className="button ghost" href={order.routeUrl} target="_blank" rel="noreferrer">
                        Маршрут
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {adminTab === 'analytics' && hasAdminPermission('view_analytics') && (
              <div>
                <h3>Бизнес-аналитика</h3>
                <div className="admin-grid">
                  <div className="row">
                    <strong>Основные показатели</strong>
                    <div>Всего заказов: {adminAnalytics.totals.ordersTotal}</div>
                    <div>Общая выручка: ${adminAnalytics.totals.revenueTotal.toFixed(2)}</div>
                    <div>Выручка (доставлено): ${adminAnalytics.totals.deliveredRevenue.toFixed(2)}</div>
                    <div>Средний чек: ${adminAnalytics.totals.avgCheck.toFixed(2)}</div>
                  </div>
                  <div className="row">
                    <strong>За последние 30 дней</strong>
                    <div>Заказов: {adminAnalytics.range30d.orders}</div>
                    <div>Выручка: ${adminAnalytics.range30d.revenue.toFixed(2)}</div>
                    <div>Средний чек: ${adminAnalytics.range30d.avgCheck.toFixed(2)}</div>
                  </div>
                  <div className="row">
                    <strong>Статусы заказов</strong>
                    <div>Собирается: {adminAnalytics.totals.pendingCount}</div>
                    <div>Назначен курьер: {adminAnalytics.totals.assignedCount}</div>
                    <div>Курьер получил: {adminAnalytics.totals.pickedUpCount}</div>
                    <div>В пути: {adminAnalytics.totals.onTheWayCount}</div>
                    <div>Прибыл: {adminAnalytics.totals.arrivedCount}</div>
                    <div>Получен: {adminAnalytics.totals.receivedCount}</div>
                    <div>Оплачен: {adminAnalytics.totals.deliveredCount}</div>
                    <div>Отменен: {adminAnalytics.totals.cancelledCount}</div>
                  </div>
                  <div className="row">
                    <strong>Топ товаров</strong>
                    {adminAnalytics.topProducts.length === 0 && <div className="muted">Нет данных</div>}
                    {adminAnalytics.topProducts.map((p) => (
                      <div key={`analytics-product-${p.productName}`}>
                        {p.productName}: {p.quantity} шт. | ${p.revenue.toFixed(2)}
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <strong>Топ локаций доставки</strong>
                    {adminAnalytics.topLocalities.length === 0 && <div className="muted">Нет данных</div>}
                    {adminAnalytics.topLocalities.map((l) => (
                      <div key={`analytics-locality-${l.locality}`}>
                        {l.locality}: {l.orders} заказов | ${l.revenue.toFixed(2)}
                      </div>
                    ))}
                  </div>
                  <div className="row">
                    <strong>Динамика (14 дней)</strong>
                    {adminAnalytics.daily14d.length === 0 && <div className="muted">Нет данных</div>}
                    {adminAnalytics.daily14d.map((d) => (
                      <div key={`analytics-day-${d.day}`}>
                        {d.day}: {d.orders} заказов | ${d.revenue.toFixed(2)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {adminTab === 'products' && hasAdminPermission('manage_products') && (
              <div>
                <h3>{productForm.id ? 'Редактировать товар' : 'Добавить новый товар'}</h3>
                <div className="muted" style={{ marginBottom: '8px' }}>
                  {productForm.id
                    ? 'Подсказка: измените нужные поля и нажмите "Сохранить изменения".'
                    : 'Подсказка: заполните поля товара и нажмите "Добавить товар".'}
                </div>
                <div className="row">
                  <strong>Справочник категорий</strong>
                  <form onSubmit={createCategory}>
                    <input
                      placeholder="Новая категория"
                      value={categoryCreateForm.category}
                      onChange={(e) => setCategoryCreateForm((prev) => ({ ...prev, category: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Новая подкатегория (опц.)"
                      value={categoryCreateForm.subcategory}
                      onChange={(e) => setCategoryCreateForm((prev) => ({ ...prev, subcategory: e.target.value }))}
                    />
                    <button type="submit">Добавить</button>
                  </form>
                  <div className="inline-actions">
                    <select
                      value={categoryEditForm.category}
                      onChange={(e) =>
                        setCategoryEditForm((prev) => ({ ...prev, category: e.target.value, subcategory: '', newCategory: '', newSubcategory: '' }))
                      }
                    >
                      <option value="">Выберите категорию</option>
                      {adminCategoryOptions.map((category) => (
                        <option key={`edit-cat-${category}`} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                    <select
                      value={categoryEditForm.subcategory}
                      onChange={(e) => setCategoryEditForm((prev) => ({ ...prev, subcategory: e.target.value }))}
                      disabled={!categoryEditForm.category}
                    >
                      <option value="">(без подкатегории)</option>
                      {Array.from(adminCategoryMap.get(categoryEditForm.category) || []).map((subcategory) => (
                        <option key={`edit-sub-${subcategory}`} value={subcategory}>
                          {subcategory}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    placeholder="Новое имя категории"
                    value={categoryEditForm.newCategory}
                    onChange={(e) => setCategoryEditForm((prev) => ({ ...prev, newCategory: e.target.value }))}
                  />
                  <input
                    placeholder="Новое имя подкатегории"
                    value={categoryEditForm.newSubcategory}
                    onChange={(e) => setCategoryEditForm((prev) => ({ ...prev, newSubcategory: e.target.value }))}
                    disabled={!categoryEditForm.subcategory}
                  />
                  <div className="inline-actions">
                    <button type="button" onClick={renameCategory} disabled={!categoryEditForm.category}>
                      Переименовать
                    </button>
                    <button type="button" className="danger" onClick={deleteCategory} disabled={!categoryEditForm.category}>
                      Удалить
                    </button>
                  </div>
                </div>
                <form onSubmit={saveProduct} ref={adminProductFormRef}>
                  <input
                    ref={adminProductNameInputRef}
                    placeholder="Название товара"
                    value={productForm.name}
                    onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                    required
                  />
                  <input placeholder="Описание" value={productForm.description} onChange={(e) => setProductForm({ ...productForm, description: e.target.value })} />
                  <input placeholder="Цена" type="number" step="0.01" min="0.01" value={productForm.price} onChange={(e) => setProductForm({ ...productForm, price: e.target.value })} required />
                  <input
                    placeholder="Количество в наличии"
                    type="number"
                    step="1"
                    min="0"
                    value={productForm.stockQuantity}
                    onChange={(e) => {
                      const nextQty = Number(e.target.value);
                      setProductForm({
                        ...productForm,
                        stockQuantity: e.target.value,
                        inStock: Number.isFinite(nextQty) && nextQty <= 0 ? false : productForm.inStock
                      });
                    }}
                    required
                  />
                  <select
                    value={productFormCategory}
                    onChange={(e) => {
                      setProductFormCategory(e.target.value);
                      setProductFormSubcategory('');
                    }}
                    required
                  >
                    <option value="">Выберите категорию</option>
                    {adminCategoryOptions.map((category) => (
                      <option key={`admin-category-${category}`} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <select
                    value={productFormSubcategory}
                    onChange={(e) => setProductFormSubcategory(e.target.value)}
                    disabled={!productFormCategory || adminSubcategoryOptions.length === 0}
                  >
                    <option value="">Подкатегория (опц.)</option>
                    {adminSubcategoryOptions.map((subcategory) => (
                      <option key={`admin-subcategory-${subcategory}`} value={subcategory}>
                        {subcategory}
                      </option>
                    ))}
                  </select>
                  <select value={productForm.warehouseId} onChange={(e) => setProductForm({ ...productForm, warehouseId: e.target.value })} required>
                    <option value="">Выберите склад</option>
                    {warehouseOverview.warehouses.map((w) => (
                      <option key={`wh-${w.id}`} value={w.id}>
                        {w.name} ({w.code})
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="URL изображения"
                    value={productForm.imageUrl}
                    onChange={(e) => setProductForm({ ...productForm, imageUrl: toSecureUrl(e.target.value) })}
                  />
                  <label>
                    Фото товара (с камеры или из галереи)
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void uploadProductImage(file);
                        e.currentTarget.value = '';
                      }}
                      disabled={imageUploading}
                    />
                  </label>
                  {imageUploading ? <div className="muted">Загрузка фото...</div> : null}
                  {productForm.imageUrl ? (
                    <img src={toSecureUrl(productForm.imageUrl)} alt="Предпросмотр товара" style={{ width: '140px', borderRadius: '8px' }} />
                  ) : null}
                  <button
                    type="button"
                    onClick={smartDetectProductByImage}
                    disabled={smartDetecting || !productForm.imageUrl}
                  >
                    {smartDetecting ? 'Распознаем...' : 'Умно заполнить по фото'}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={productForm.inStock}
                      disabled={Number(productForm.stockQuantity || 0) <= 0}
                      onChange={(e) => setProductForm({ ...productForm, inStock: e.target.checked })}
                    />
                    В наличии
                  </label>
                  <div className="inline-actions">
                    <button type="submit">{productForm.id ? 'Сохранить изменения' : 'Добавить товар'}</button>
                    {productForm.id ? (
                      <button
                        type="button"
                        onClick={() => {
        setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0', warehouseId: '' });
                          setProductFormCategory('');
                          setProductFormSubcategory('');
                        }}
                      >
                        Отменить редактирование
                      </button>
                    ) : null}
                  </div>
                </form>
                {adminProducts.map((product) => (
                  <div className="row" key={product.id}>
                    {(() => {
                      const effectiveInStock = Boolean(product.inStock) && Number(product.stockQuantity || 0) > 0;
                      return (
                        <>
                    <strong>{product.name}</strong>
                    <div>Цена: ${product.price.toFixed(2)} | Остаток: {product.stockQuantity ?? 0} шт. | {effectiveInStock ? 'В наличии' : 'Скрыт'}</div>
                    <div className="muted">
                      Склад: {product.homeWarehouseId ? warehouseNameById.get(product.homeWarehouseId) || `#${product.homeWarehouseId}` : '—'}
                    </div>
                    <div className="muted">{product.category || 'Без категории'}</div>
                    <div className="inline-actions">
                      <button type="button" onClick={() => editProduct(product)}>Редактировать</button>
                      <button type="button" onClick={() => setProductAvailability(product, !effectiveInStock)}>
                        {effectiveInStock ? 'Нет в наличии' : 'Вернуть в наличие'}
                      </button>
                      <button type="button" className="danger" onClick={() => deleteProduct(product.id)}>Удалить</button>
                    </div>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}

            {adminTab === 'warehouse' && hasAdminPermission('manage_warehouse') && (
              <div>
                <h3>Склад</h3>
                <div className="cards">
                  <div className="card">
                    <div className="card-content">
                      <h3>SKU</h3>
                      <div className="price">{warehouseMetrics.skuCount}</div>
                      <div className="muted">Товарных позиций в остатках</div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-content">
                      <h3>Низкий Остаток</h3>
                      <div className="price">{warehouseMetrics.lowStockCount}</div>
                      <div className="muted">Позиции ниже минимума</div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-content">
                      <h3>Доступно</h3>
                      <div className="price">{warehouseMetrics.totalAvailable}</div>
                      <div className="muted">Штук доступно к продаже</div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-content">
                      <h3>В Резерве</h3>
                      <div className="price">{warehouseMetrics.totalReserved}</div>
                      <div className="muted">Штук зарезервировано</div>
                    </div>
                  </div>
                </div>
                <div className="row">
                  <strong>Точка склада на карте</strong>
                  <form onSubmit={saveWarehouseLocation}>
                    <select
                      value={warehousePointForm.warehouseId}
                      onChange={(e) => {
                        const warehouseId = Number(e.target.value);
                        const selected = warehouseOverview.warehouses.find((w) => w.id === warehouseId);
                        setWarehousePointForm({
                          warehouseId,
                          lat: selected?.lat !== null && selected?.lat !== undefined ? String(selected.lat) : '',
                          lng: selected?.lng !== null && selected?.lng !== undefined ? String(selected.lng) : ''
                        });
                      }}
                      required
                    >
                      {warehouseOverview.warehouses.map((w) => (
                        <option key={`warehouse-loc-${w.id}`} value={w.id}>
                          {w.name} ({w.code})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.000001"
                      placeholder="lat"
                      value={warehousePointForm.lat}
                      onChange={(e) => setWarehousePointForm((prev) => ({ ...prev, lat: e.target.value }))}
                      required
                    />
                    <input
                      type="number"
                      step="0.000001"
                      placeholder="lng"
                      value={warehousePointForm.lng}
                      onChange={(e) => setWarehousePointForm((prev) => ({ ...prev, lng: e.target.value }))}
                      required
                    />
                    <button type="submit">Сохранить точку</button>
                    <button type="button" onClick={detectWarehousePointByGeolocation} disabled={warehousePointLocating}>
                      {warehousePointLocating ? 'Определяем GPS...' : 'Взять мою геопозицию'}
                    </button>
                    <button type="button" className="danger" onClick={deleteWarehouseLocation}>
                      Удалить точку
                    </button>
                  </form>
                  <AdminWarehouseLocationMap
                    warehouses={warehouseOverview.warehouses}
                    selectedWarehouseId={warehousePointForm.warehouseId}
                    lat={warehousePointLat}
                    lng={warehousePointLng}
                    onPick={(lat, lng) => {
                      setWarehousePointForm((prev) => ({
                        ...prev,
                        lat: lat.toFixed(6),
                        lng: lng.toFixed(6)
                      }));
                    }}
                  />
                  <div className="muted">
                    Координаты синхронизируются в обе БД: складская логика и карта.
                  </div>
                </div>

                <div className="row">
                  <strong>Складская операция</strong>
                  <form onSubmit={submitStockMovement} ref={warehouseOperationFormRef}>
                    <select
                      value={stockActionForm.movementType}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, movementType: e.target.value as StockMovementType }))}
                    >
                      <option value="receive">Приемка</option>
                      <option value="writeoff">Списание</option>
                      <option value="reserve">Резерв</option>
                    </select>
                    <select
                      value={stockActionForm.warehouseId}
                      onChange={(e) => {
                        const nextWarehouseId = Number(e.target.value);
                        const firstProduct = warehouseOverview.stock.find((item) => item.warehouseId === nextWarehouseId);
                        setStockActionForm((prev) => ({
                          ...prev,
                          warehouseId: nextWarehouseId,
                          productId: firstProduct?.productId || 0
                        }));
                      }}
                      required
                    >
                      {warehouseOverview.warehouses.map((w) => (
                        <option key={`warehouse-opt-${w.id}`} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={stockActionForm.productId}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, productId: Number(e.target.value) }))}
                      required
                    >
                      <option value={0}>Выберите товар</option>
                      {warehouseProductOptions.map((p) => (
                        <option key={`stock-product-${p.id}`} value={p.id}>
                          #{p.id} {p.name} (доступно {p.available}, всего {p.total}, резерв {p.reserved})
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      ref={warehouseOperationQuantityRef}
                      value={stockActionForm.quantity}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, quantity: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Причина (опц.)"
                      value={stockActionForm.reason}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, reason: e.target.value }))}
                    />
                    <div className="inline-actions">
                      <button type="button" onClick={() => setStockActionForm((prev) => ({ ...prev, quantity: '1' }))}>1 шт</button>
                      <button type="button" onClick={() => setStockActionForm((prev) => ({ ...prev, quantity: '5' }))}>5 шт</button>
                      <button type="button" onClick={() => setStockActionForm((prev) => ({ ...prev, quantity: '10' }))}>10 шт</button>
                      <button type="button" onClick={() => setStockActionForm((prev) => ({ ...prev, quantity: '20' }))}>20 шт</button>
                    </div>
                        {selectedStockItem ? (
                          <div className="card">
                            {selectedStockItem.imageUrl ? (
                              <img
                                src={toSecureUrl(selectedStockItem.imageUrl)}
                                alt={selectedStockItem.productName}
                                style={{ height: '130px', objectFit: 'cover' }}
                              />
                            ) : null}
                        <div className="card-content">
                          <h3>
                            #{selectedStockItem.productId} {selectedStockItem.productName}
                          </h3>
                          <div className="muted">
                            Склад: {selectedStockItem.warehouseName} ({selectedStockItem.warehouseCode})
                          </div>
                          <div className="muted">
                            Категория: {selectedStockItem.category || 'Без категории'}
                          </div>
                          <div>
                            Сейчас: доступно {selectedStockItem.availableQuantity} шт., в резерве {selectedStockItem.reservedQuantity} шт., всего {selectedStockItem.quantity} шт.
                          </div>
                          <div>
                            После операции: доступно {stockActionPreview.nextAvailable} шт., в резерве {stockActionPreview.nextReserved} шт.
                          </div>
                          <div className="muted">{stockActionPreview.note}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="muted">Выберите склад и товар для операции.</div>
                    )}
                    <button type="submit" disabled={stockActionSubmitting}>
                      {stockActionSubmitting ? 'Проводим...' : 'Провести'}
                    </button>
                  </form>
                </div>

                <div className="row">
                  <strong>Автопополнение (ниже минимума)</strong>
                  {warehouseOverview.lowStock.length === 0 ? (
                    <div className="muted">Все товары выше минимального остатка.</div>
                  ) : (
                    warehouseOverview.lowStock.map((item) => (
                      <div key={`low-stock-${item.warehouseId}-${item.productId}`}>
                        {item.warehouseName}: {item.productName} | доступно {item.availableQuantity} шт. | min {item.reorderMin} | рекомендовано заказать {item.orderSuggestion} шт.
                      </div>
                    ))
                  )}
                </div>

                <div className="row">
                  <strong>Задачи сборки</strong>
                  <form onSubmit={createPickTaskFromOrder}>
                    <input
                      placeholder="ID заказа"
                      type="number"
                      min="1"
                      value={pickTaskCreateForm.orderId}
                      onChange={(e) => setPickTaskCreateForm((prev) => ({ ...prev, orderId: e.target.value }))}
                      required
                    />
                    <select
                      value={pickTaskCreateForm.warehouseId}
                      onChange={(e) => setPickTaskCreateForm((prev) => ({ ...prev, warehouseId: Number(e.target.value) }))}
                      required
                    >
                      {warehouseOverview.warehouses.map((w) => (
                        <option key={`pick-warehouse-${w.id}`} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Создать задачу из заказа</button>
                  </form>
                  {pickTasks.length === 0 ? <div className="muted">Задач сборки пока нет.</div> : null}
                  {pickTasks.map((task) => (
                    <div className="row" key={`pick-task-${task.id}`}>
                      <strong>Задача #{task.id}</strong>
                      <div>Заказ #{task.orderId} | Склад: {task.warehouseName}</div>
                      <div>
                        Статус: {PICK_TASK_STATUS_LABELS[task.status] || task.status} | Создал: {task.createdByName || '-'} | Обновлено: {new Date(task.updatedAt).toLocaleString()}
                      </div>
                      <div className="muted">
                        {task.items.map((item) => `${item.productName}: ${item.pickedQty}/${item.requestedQty}`).join(' | ')}
                      </div>
                      <div className="inline-actions">
                        <select
                          value={pickTaskStatusDrafts[task.id] || task.status}
                          onChange={(e) =>
                            setPickTaskStatusDrafts((prev) => ({ ...prev, [task.id]: e.target.value as PickTask['status'] }))
                          }
                        >
                          <option value="new">new</option>
                          <option value="in_progress">in_progress</option>
                          <option value="done">done</option>
                          <option value="handed_to_courier">handed_to_courier</option>
                          <option value="cancelled">cancelled</option>
                        </select>
                        <button type="button" onClick={() => savePickTaskStatus(task.id)}>
                          Сохранить статус
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="row">
                  <strong>Остатки по складу</strong>
                  <div className="muted">
                    Путь: Склад {'>'} {warehouseViewName} {'>'} {warehouseView.category === 'all' ? 'Все товары' : warehouseView.category}
                  </div>
                  <div className="inline-actions">
                    <select
                      value={warehouseView.warehouseId}
                      onChange={(e) =>
                        setWarehouseView((prev) => ({
                          ...prev,
                          warehouseId: Number(e.target.value),
                          category: 'all'
                        }))
                      }
                    >
                      <option value={0}>Все склады</option>
                      {warehouseOverview.warehouses.map((w) => (
                        <option key={`warehouse-view-${w.id}`} value={w.id}>
                          {w.name} ({w.code})
                        </option>
                      ))}
                    </select>
                    <select
                      value={warehouseView.category}
                      onChange={(e) => setWarehouseView((prev) => ({ ...prev, category: e.target.value }))}
                    >
                      <option value="all">Все категории</option>
                      {warehouseViewCategories.map((category) => (
                        <option key={`warehouse-category-${category}`} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    placeholder="Поиск по складу или товару (например: рис, MAIN, 12)"
                    value={warehouseStockSearch}
                    onChange={(e) => setWarehouseStockSearch(e.target.value)}
                  />
                  <div className="inline-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedWarehouseStockKeys((prev) => {
                          const next = { ...prev };
                          for (const item of filteredWarehouseStock) {
                            next[stockRowKey(item.warehouseId, item.productId)] = true;
                          }
                          return next;
                        })
                      }
                    >
                      Выбрать все в фильтре ({filteredWarehouseStock.length})
                    </button>
                    <button type="button" onClick={() => setSelectedWarehouseStockKeys({})}>
                      Снять выбор
                    </button>
                    <div className="muted">
                      Выбрано: {selectedWarehouseStockItems.length}
                    </div>
                  </div>
                  <div className="row">
                    <strong>Массовая операция</strong>
                    <select
                      value={bulkStockForm.movementType}
                      onChange={(e) => setBulkStockForm((prev) => ({ ...prev, movementType: e.target.value as StockMovementType }))}
                    >
                      <option value="receive">Приемка</option>
                      <option value="writeoff">Списание</option>
                      <option value="reserve">Резерв</option>
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={bulkStockForm.quantity}
                      onChange={(e) => setBulkStockForm((prev) => ({ ...prev, quantity: e.target.value }))}
                    />
                    <input
                      placeholder="Причина для всех (опц.)"
                      value={bulkStockForm.reason}
                      onChange={(e) => setBulkStockForm((prev) => ({ ...prev, reason: e.target.value }))}
                    />
                    <button type="button" onClick={applyBulkStockMovement} disabled={selectedWarehouseStockItems.length === 0 || bulkStockSubmitting}>
                      {bulkStockSubmitting ? 'Выполняем...' : 'Выполнить для выбранных'}
                    </button>
                  </div>
                        {filteredWarehouseStock.length === 0 ? (
                          <div className="muted">Данных по складу пока нет.</div>
                        ) : (
                          filteredWarehouseStock.map((item) => (
                            <div key={`stock-row-${item.warehouseId}-${item.productId}`} className="row">
                              {item.imageUrl ? (
                                <img
                                  src={toSecureUrl(item.imageUrl)}
                                  alt={item.productName}
                                  style={{ width: '88px', height: '88px', objectFit: 'cover', borderRadius: '10px', marginBottom: '8px' }}
                                />
                              ) : null}
                        <strong>{item.warehouseName} | #{item.productId} {item.productName}</strong>
                        <div>Всего {item.quantity} шт., резерв {item.reservedQuantity} шт., доступно {item.availableQuantity} шт.</div>
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(selectedWarehouseStockKeys[stockRowKey(item.warehouseId, item.productId)])}
                            onChange={(e) =>
                              setSelectedWarehouseStockKeys((prev) => ({
                                ...prev,
                                [stockRowKey(item.warehouseId, item.productId)]: e.target.checked
                              }))
                            }
                          />
                          Выбрать для массовой операции
                        </label>
                        <div className="inline-actions">
                          <button
                            type="button"
                            disabled={quickStockSubmittingKey !== ''}
                            onClick={() => quickStockMovement(item, 'receive', 10)}
                          >
                            +10 приемка
                          </button>
                          <button
                            type="button"
                            disabled={quickStockSubmittingKey !== ''}
                            onClick={() => quickStockMovement(item, 'writeoff', 1)}
                          >
                            Списать 1
                          </button>
                          <button
                            type="button"
                            disabled={quickStockSubmittingKey !== ''}
                            onClick={() => quickStockMovement(item, 'reserve', 1)}
                          >
                            Резерв 1
                          </button>
                          <button
                            type="button"
                            onClick={() => openStockActionFormForItem(item)}
                          >
                            В форму
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="row">
                  <strong>Операционный журнал</strong>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void loadWarehouseJournal();
                    }}
                  >
                    <select
                      value={warehouseJournalFilters.warehouseId}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, warehouseId: Number(e.target.value) }))}
                    >
                      <option value={0}>Все склады</option>
                      {warehouseOverview.warehouses.map((w) => (
                        <option key={`journal-warehouse-${w.id}`} value={w.id}>
                          {w.name} ({w.code})
                        </option>
                      ))}
                    </select>
                    <select
                      value={warehouseJournalFilters.movementType}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, movementType: e.target.value }))}
                    >
                      <option value="all">Все типы</option>
                      <option value="receive">Приемка</option>
                      <option value="writeoff">Списание</option>
                      <option value="reserve">Резерв</option>
                      <option value="release">Снятие резерва</option>
                    </select>
                    <input
                      placeholder="Товар или ID товара"
                      value={warehouseJournalFilters.product}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, product: e.target.value }))}
                    />
                    <input
                      type="datetime-local"
                      value={warehouseJournalFilters.dateFrom}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, dateFrom: e.target.value }))}
                    />
                    <input
                      type="datetime-local"
                      value={warehouseJournalFilters.dateTo}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, dateTo: e.target.value }))}
                    />
                    <input
                      type="number"
                      min="50"
                      max="1000"
                      step="50"
                      value={warehouseJournalFilters.limit}
                      onChange={(e) => setWarehouseJournalFilters((prev) => ({ ...prev, limit: e.target.value }))}
                    />
                    <div className="inline-actions">
                      <button type="submit" disabled={warehouseJournalLoading}>
                        {warehouseJournalLoading ? 'Загружаем...' : 'Применить фильтры'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const nextFilters = {
                            warehouseId: 0,
                            movementType: 'all',
                            product: '',
                            dateFrom: '',
                            dateTo: '',
                            limit: '300'
                          };
                          setWarehouseJournalFilters(nextFilters);
                          void loadWarehouseJournal(nextFilters);
                        }}
                      >
                        Сброс
                      </button>
                      <button type="button" onClick={exportWarehouseJournalCsv}>
                        Экспорт CSV
                      </button>
                    </div>
                  </form>
                  {warehouseJournal.length === 0 ? (
                    <div className="muted">Движений пока нет.</div>
                  ) : (
                    warehouseJournal.map((m) => (
                      <div key={`movement-${m.id}`} className="row">
                        <strong>
                          #{m.id} | {stockMovementHumanLabel(m.movementType)} | {m.quantity} шт.
                        </strong>
                        <div>
                          Склад: {m.warehouseName} (#{m.warehouseId}) | Товар: {m.productName} (#{m.productId})
                        </div>
                        <div className="muted">
                          {new Date(m.createdAt).toLocaleString()} | Оператор: {m.createdBy || '-'}
                          {m.reason ? ` | Причина: ${m.reason}` : ''}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {adminTab === 'users' && hasAdminPermission('manage_users') && (
              <div>
                <h3>Пользователи</h3>
                {isSystemAdmin ? (
                  <form onSubmit={createStaffUser} className="row">
                    <strong>Создать сотрудника (админ)</strong>
                    <input
                      placeholder="ФИО"
                      value={staffCreateForm.fullName}
                      onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, fullName: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Email"
                      type="email"
                      value={staffCreateForm.email}
                      onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, email: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Пароль (мин. 8 символов)"
                      type="password"
                      minLength={8}
                      value={staffCreateForm.password}
                      onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, password: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Телефон (опц.)"
                      value={staffCreateForm.phone}
                      onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, phone: e.target.value }))}
                    />
                  <input
                    placeholder="Адрес (опц.)"
                    value={staffCreateForm.address}
                    onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, address: e.target.value }))}
                  />
                  <select
                    value={staffCreateForm.role}
                    onChange={(e) => setStaffCreateForm((prev) => ({ ...prev, role: e.target.value as Role }))}
                  >
                    <option value="admin">Администратор</option>
                    <option value="picker">Сборщик</option>
                    <option value="courier">Курьер</option>
                  </select>
                  <div className="inline-actions">
                    {ADMIN_PERMISSION_OPTIONS.map((perm) => (
                      <label key={`staff-perm-${perm.key}`}>
                          <input
                            type="checkbox"
                            checked={staffCreateForm.permissions.includes(perm.key)}
                            onChange={(e) => {
                              setStaffCreateForm((prev) => ({
                                ...prev,
                                permissions: e.target.checked
                                  ? Array.from(new Set([...prev.permissions, perm.key]))
                                  : prev.permissions.filter((p) => p !== perm.key),
                                warehouseScopes:
                                  perm.key === 'manage_warehouse' && !e.target.checked ? [] : prev.warehouseScopes
                              }));
                            }}
                          />
                          {perm.label}
                        </label>
                      ))}
                    </div>
                    {staffCreateForm.permissions.includes('manage_warehouse') ? (
                      <div className="row">
                        <strong>Доступ к складам сотрудника</strong>
                        <div className="muted">Выберите один или несколько складов. Если не выбирать, будет доступ ко всем складам.</div>
                        <div className="inline-actions">
                          {warehouseOverview.warehouses.map((w) => (
                            <label key={`staff-warehouse-${w.id}`}>
                              <input
                                type="checkbox"
                                checked={staffCreateForm.warehouseScopes.includes(w.id)}
                                onChange={(e) =>
                                  setStaffCreateForm((prev) => ({
                                    ...prev,
                                    warehouseScopes: e.target.checked
                                      ? Array.from(new Set([...prev.warehouseScopes, w.id]))
                                      : prev.warehouseScopes.filter((id) => id !== w.id)
                                  }))
                                }
                              />
                              {w.name}
                            </label>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <button type="submit">Создать сотрудника</button>
                  </form>
                ) : null}
                <form onSubmit={adminResetUserPassword}>
                  <select value={adminResetUserId || ''} onChange={(e) => setAdminResetUserId(Number(e.target.value))} required>
                    <option value="">Выберите пользователя</option>
                    {adminUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        #{u.id} {u.fullName} ({u.email}) [{ROLE_LABELS[u.role]}]
                      </option>
                    ))}
                  </select>
                  <input type="password" placeholder="Новый пароль (мин. 8 символов)" value={adminResetPasswordValue} onChange={(e) => setAdminResetPasswordValue(e.target.value)} minLength={8} required />
                  <button type="submit">Сбросить пароль</button>
                </form>
                {adminUsers.map((u) => {
                  const isProtectedSystemAdmin = u.email.trim().toLowerCase() === 'admin@universal.local';
                  return (
                    <div className="row" key={`admin-user-${u.id}`}>
                      <strong>#{u.id} {u.fullName}</strong>
                      <div>{u.email}</div>
                      <div className="muted">
                        Роль сейчас: {ROLE_LABELS[u.role]} | Статус: {u.isActive ? 'Активен' : 'Заблокирован'}
                        {isProtectedSystemAdmin ? ' | Системный администратор (защищен)' : ''}
                      </div>
                    {u.role === 'admin' ? (
                      <div className="muted">
                        Права: {(u.permissions || []).length ? u.permissions.join(', ') : 'не назначены'}
                        <br />
                        Склады: {(u.warehouseScopes || []).length
                          ? (u.warehouseScopes || [])
                            .map((id) => warehouseOverview.warehouses.find((w) => w.id === id)?.name || `#${id}`)
                            .join(', ')
                          : 'все склады'}
                      </div>
                    ) : null}
                    <div className="inline-actions">
                        <select
                          value={adminUserRoleDrafts[u.id] || u.role}
                          onChange={(e) => setAdminUserRoleDrafts((prev) => ({ ...prev, [u.id]: e.target.value as Role }))}
                          disabled={isProtectedSystemAdmin}
                        >
                          <option value="customer">Покупатель</option>
                          <option value="courier">Курьер</option>
                          <option value="admin">Администратор</option>
                          <option value="picker">Сборщик</option>
                        </select>
                        <select
                          value={(adminUserActiveDrafts[u.id] ?? u.isActive) ? 'active' : 'blocked'}
                          onChange={(e) => setAdminUserActiveDrafts((prev) => ({ ...prev, [u.id]: e.target.value === 'active' }))}
                          disabled={isProtectedSystemAdmin}
                        >
                          <option value="active">Активен</option>
                          <option value="blocked">Заблокирован</option>
                        </select>
                        <button type="button" onClick={() => adminSaveUser(u.id)} disabled={isProtectedSystemAdmin}>Сохранить</button>
                        <button type="button" onClick={() => adminForceLogoutUser(u.id)} disabled={isProtectedSystemAdmin}>Завершить сессии</button>
                        <button type="button" className="danger" onClick={() => adminDeleteUser(u.id)} disabled={isProtectedSystemAdmin}>Удалить</button>
                      </div>
                      {isSystemAdmin && u.role === 'admin' ? (
                        <div className="inline-actions">
                          {ADMIN_PERMISSION_OPTIONS.map((perm) => (
                            <label key={`user-${u.id}-perm-${perm.key}`}>
                              <input
                                type="checkbox"
                                checked={(adminUserPermissionsDrafts[u.id] || []).includes(perm.key)}
                                disabled={isProtectedSystemAdmin}
                                onChange={(e) =>
                                  setAdminUserPermissionsDrafts((prev) => {
                                    const current = prev[u.id] || [];
                                    const next = e.target.checked
                                      ? Array.from(new Set([...current, perm.key]))
                                      : current.filter((p) => p !== perm.key);
                                    if (perm.key === 'manage_warehouse' && !e.target.checked) {
                                      setAdminUserWarehouseScopesDrafts((drafts) => ({ ...drafts, [u.id]: [] }));
                                    }
                                    return { ...prev, [u.id]: next };
                                  })
                                }
                              />
                              {perm.label}
                            </label>
                          ))}
                        </div>
                      ) : null}
                      {isSystemAdmin && u.role === 'admin' && (adminUserPermissionsDrafts[u.id] || []).includes('manage_warehouse') ? (
                        <div className="inline-actions">
                          {warehouseOverview.warehouses.map((w) => (
                            <label key={`user-${u.id}-warehouse-${w.id}`}>
                              <input
                                type="checkbox"
                                checked={(adminUserWarehouseScopesDrafts[u.id] || []).includes(w.id)}
                                disabled={isProtectedSystemAdmin}
                                onChange={(e) =>
                                  setAdminUserWarehouseScopesDrafts((prev) => ({
                                    ...prev,
                                    [u.id]: e.target.checked
                                      ? Array.from(new Set([...(prev[u.id] || []), w.id]))
                                      : (prev[u.id] || []).filter((id) => id !== w.id)
                                  }))
                                }
                              />
                              {w.name}
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {adminTab === 'couriers' && hasAdminPermission('manage_couriers') && (
              <div>
                <h3>Курьеры</h3>
                {couriers.map((courier) => (
                  <div className="row" key={courier.id}>
                    <strong>{courier.fullName}</strong>
                    <div>{courier.email}</div>
                    <div>{courier.vehicleType} | {COURIER_STATUS_LABELS[courier.status] || courier.status}</div>
                    <div>Нагрузка: {courier.activeOrders}/{courier.maxActiveOrders}</div>
                    <div>Верификация: {COURIER_VERIFICATION_LABELS[courier.verificationStatus || 'pending'] || courier.verificationStatus}</div>
                    <div>Права/лицензия: {courier.transportLicense || '-'}</div>
                    <div>Госномер: {courier.vehicleRegistrationNumber || '-'}</div>
                    {courier.techPassportImageUrl ? <a href={courier.techPassportImageUrl} target="_blank" rel="noreferrer">Фото техпаспорта</a> : <div className="muted">Фото техпаспорта: нет</div>}
                    <div>Запрошено: {courier.verificationRequestedAt ? new Date(courier.verificationRequestedAt).toLocaleString() : '-'}</div>
                    <div>Проверено админом: {courier.verifiedAt ? new Date(courier.verifiedAt).toLocaleString() : '-'}</div>
                    <div>Проверил: {courier.verificationReviewedBy || '-'}</div>
                    <div>Комментарий: {courier.verificationComment || '-'}</div>
                    <input
                      placeholder="Комментарий проверки (опц.)"
                      value={adminReviewComments[courier.id] || ''}
                      onChange={(e) => setAdminReviewComments((prev) => ({ ...prev, [courier.id]: e.target.value }))}
                    />
                    <div className="inline-actions">
                      <button type="button" onClick={() => adminReviewCourier(courier.id, 'approved')}>Подтвердить</button>
                      <button type="button" className="danger" onClick={() => adminReviewCourier(courier.id, 'rejected')}>Отклонить</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {adminTab === 'search' && hasAdminPermission('search_db') && (
              <div>
                <h3>Поиск по всей базе</h3>
                <input
                  placeholder="Ключевое слово: email, улица, номер заказа, товар..."
                  value={adminSearchQuery}
                  onChange={(e) => setAdminSearchQuery(e.target.value)}
                />
                {adminSearchLoading ? <div className="muted">Идет поиск...</div> : null}

                {adminSearchData.suggestions.length > 0 ? (
                  <div className="search-results">
                    {adminSearchData.suggestions.map((suggestion) => (
                      <button
                        type="button"
                        key={suggestion}
                        className="search-result"
                        onClick={() => setAdminSearchQuery(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="admin-grid">
                  <div>
                    <h4>Пользователи ({adminSearchData.results.users.length})</h4>
                    {adminSearchData.results.users.map((u) => (
                      <div className="row" key={`search-user-${u.id}`}>
                        <strong>#{u.id} {u.fullName}</strong>
                        <div>{u.email}</div>
                        <div>{ROLE_LABELS[u.role]} | {u.isActive ? 'Активен' : 'Заблокирован'}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4>Товары ({adminSearchData.results.products.length})</h4>
                    {adminSearchData.results.products.map((p) => (
                      <div className="row" key={`search-product-${p.id}`}>
                        {(() => {
                          const effectiveInStock = Boolean(p.inStock) && Number(p.stockQuantity || 0) > 0;
                          return (
                            <>
                        <strong>#{p.id} {p.name}</strong>
                        <div>{p.category || 'Без категории'}</div>
                        <div>${p.price.toFixed(2)} | Остаток: {p.stockQuantity ?? 0} шт. | {effectiveInStock ? 'В наличии' : 'Нет в наличии'}</div>
                            </>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4>Заказы ({adminSearchData.results.orders.length})</h4>
                    {adminSearchData.results.orders.map((o) => (
                      <div className="row" key={`search-order-${o.id}`}>
                        <strong>Заказ #{o.id}</strong>
                        <div>{STATUS_LABELS[o.status]}</div>
                        <div>${o.total.toFixed(2)} | user #{o.userId} | courier {o.assignedCourierId ?? '-'}</div>
                        <div className="muted">{o.deliveryAddress}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h4>Курьеры ({adminSearchData.results.couriers.length})</h4>
                    {adminSearchData.results.couriers.map((c) => (
                      <div className="row" key={`search-courier-${c.id}`}>
                        <strong>#{c.id} {c.fullName}</strong>
                        <div>{c.email}</div>
                        <div>{c.vehicleType || '-'} | {COURIER_STATUS_LABELS[c.status] || c.status}</div>
                        <div>Верификация: {COURIER_VERIFICATION_LABELS[c.verificationStatus] || c.verificationStatus}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {adminTab === 'audit' && hasAdminPermission('view_audit') && (
              <div>
                <h3>Аудит-лог действий администратора</h3>
                {adminAuditLogs.length === 0 && <p className="muted">Записей пока нет.</p>}
                {adminAuditLogs.map((log) => (
                  <div className="row" key={log.id}>
                    <strong>#{log.id} {log.action}</strong>
                    <div>Сущность: {log.entityType} {log.entityId ? `#${log.entityId}` : ''}</div>
                    <div>Админ: {log.admin ? `${log.admin.fullName} (${log.admin.email})` : 'неизвестно'}</div>
                    <div>Время: {new Date(log.createdAt).toLocaleString()}</div>
                    <div className="muted">{log.details ? JSON.stringify(log.details) : 'Без деталей'}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {loggedIn ? (
        <nav className="mobile-dock" aria-label="Мобильная навигация">
          <button type="button" className={catalogOpen ? 'active' : ''} onClick={goToCatalog}>Товары</button>
          {user?.role !== 'courier' ? (
            <button type="button" className={profileOpen ? 'active' : ''} onClick={goToProfile}>Кабинет</button>
          ) : null}
          <button type="button" className={cartOpen ? 'active' : ''} onClick={goToCart}>
            Корзина{cartItemsCount > 0 ? ` (${cartItemsCount})` : ''}
          </button>
          {user?.role !== 'courier' ? (
            <button type="button" className={deliveryMapOpen ? 'active' : ''} onClick={goToMap}>Карта</button>
          ) : null}
        </nav>
      ) : null}

      <footer className="app-footer">
        {loggedIn ? (
          <button type="button" className="danger" onClick={logout}>Выйти</button>
        ) : (
          <span className="muted">Вы не авторизованы</span>
        )}
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
function toSecureUrl(url: string) {
  const value = String(url || '').trim();
  if (!value) return '';
  // Нормализуем локальные ссылки на uploads к относительному пути (уйдёт через прокси Vite, без mixed-content).
  const origins = [
    'http://localhost:4000',
    'https://localhost:4000',
    'http://127.0.0.1:4000',
    'https://127.0.0.1:4000'
  ];
  for (const origin of origins) {
    if (value.startsWith(origin)) {
      return value.replace(origin, '');
    }
  }
  if (value.startsWith('//localhost:4000')) return value.replace('//localhost:4000', '');
  if (value.startsWith('//127.0.0.1:4000')) return value.replace('//127.0.0.1:4000', '');
  return value;
}
