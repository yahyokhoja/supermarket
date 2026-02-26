import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import DeliveryMapPicker from './components/DeliveryMapPicker';

type Role = 'customer' | 'courier' | 'admin';
type Status = 'pending' | 'assigned' | 'picked_up' | 'on_the_way' | 'delivered' | 'cancelled';

type User = {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  address: string | null;
  role: Role;
  permissions: string[];
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
  assignedCourierId: number | null;
  createdAt: string;
};

type Courier = {
  id: number;
  fullName: string;
  email: string;
  status: string;
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
type WarehouseInfo = { id: number; code: string; name: string; isActive: boolean };
type StockMovement = {
  id: number;
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
  status: 'new' | 'in_progress' | 'done' | 'cancelled';
  assignedTo: number | null;
  assignedToName: string | null;
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
};

type SavedDelivery = {
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
  pending: 'Ожидает обработки',
  assigned: 'Назначен курьер',
  picked_up: 'Забран',
  on_the_way: 'В пути',
  delivered: 'Доставлен',
  cancelled: 'Отменен'
};

const STATUS_ACTION_LABELS: Record<Status, string> = {
  pending: 'В ожидании',
  assigned: 'Назначить',
  picked_up: 'Забрал',
  on_the_way: 'В пути',
  delivered: 'Доставлен',
  cancelled: 'Отменить'
};

const ROLE_LABELS: Record<Role, string> = {
  customer: 'Покупатель',
  courier: 'Курьер',
  admin: 'Администратор'
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
const DELIVERY_DRAFT_KEY = 'delivery_draft_v1';
const LAST_DELIVERY_KEY = 'last_delivery_v1';

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

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<{ items: CartItem[]; total: number }>({ items: [], total: 0 });
  const [orders, setOrders] = useState<Order[]>([]);
  const [courierOrders, setCourierOrders] = useState<Order[]>([]);
  const [openCourierOrders, setOpenCourierOrders] = useState<Order[]>([]);
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
  const [verificationSaving, setVerificationSaving] = useState(false);
  const [techPassportUploading, setTechPassportUploading] = useState(false);
  const [adminResetUserId, setAdminResetUserId] = useState(0);
  const [adminResetPasswordValue, setAdminResetPasswordValue] = useState('');
  const [adminReviewComments, setAdminReviewComments] = useState<Record<number, string>>({});
  const [stockActionForm, setStockActionForm] = useState({
    movementType: 'receive' as 'receive' | 'writeoff' | 'reserve',
    warehouseId: 0,
    productId: 0,
    quantity: '1',
    reason: ''
  });
  const [pickTaskCreateForm, setPickTaskCreateForm] = useState({
    orderId: '',
    warehouseId: 0
  });
  const [pickTaskStatusDrafts, setPickTaskStatusDrafts] = useState<Record<number, PickTask['status']>>({});
  const [adminUserRoleDrafts, setAdminUserRoleDrafts] = useState<Record<number, Role>>({});
  const [adminUserActiveDrafts, setAdminUserActiveDrafts] = useState<Record<number, boolean>>({});
  const [adminUserPermissionsDrafts, setAdminUserPermissionsDrafts] = useState<Record<number, string[]>>({});
  const [staffCreateForm, setStaffCreateForm] = useState({
    fullName: '',
    email: '',
    password: '',
    phone: '',
    address: '',
    permissions: [] as string[]
  });
  const [productForm, setProductForm] = useState({
    id: 0,
    name: '',
    description: '',
    price: '',
    category: '',
    imageUrl: '',
    inStock: true,
    stockQuantity: '0'
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
  const adminProductFormRef = useRef<HTMLFormElement | null>(null);
  const adminProductNameInputRef = useRef<HTMLInputElement | null>(null);

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

  const warehouseProductOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const item of warehouseOverview.stock) {
      if (!seen.has(item.productId)) {
        seen.set(item.productId, item.productName);
      }
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [warehouseOverview.stock]);

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

  function goToCart() {
    if (cart.items.length === 0) {
      notify('Корзина пуста');
      return;
    }
    openOnlySection('cart');
    setTimeout(() => scrollToSection(cartSectionRef), 0);
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
  }

  async function loadWarehouseData() {
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('manage_warehouse')) return;
    const [overviewRes, tasksRes] = await Promise.all([
      api<WarehouseOverviewResponse>('/api/admin/warehouse/overview'),
      api<PickTasksResponse>('/api/admin/pick-tasks')
    ]);
    setWarehouseOverview(overviewRes);
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

    loadMe()
      .then(() => Promise.all([loadCart(), loadOrders()]))
      .catch(() => {
        setToken(null);
        localStorage.removeItem('token');
      });
  }, [token]);

  useEffect(() => {
    if (!user) return;
    loadCourierOrders().catch(() => undefined);
    loadOpenCourierOrders().catch(() => undefined);
    loadCourierProfile().catch(() => undefined);
    loadAdminData().catch(() => undefined);
    loadWarehouseData().catch(() => undefined);
  }, [user]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    if (!hasAdminPermission('search_db')) return;
    const timer = setTimeout(() => {
      runAdminSearch(adminSearchQuery).catch(() => undefined);
    }, 220);
    return () => clearTimeout(timer);
  }, [adminSearchQuery, user?.role, user?.permissions]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    const allowedTabs: AdminTab[] = [];
    if (hasAdminPermission('view_orders')) allowedTabs.push('orders');
    if (hasAdminPermission('view_analytics')) allowedTabs.push('analytics');
    if (hasAdminPermission('manage_products')) allowedTabs.push('products');
    if (hasAdminPermission('manage_warehouse')) allowedTabs.push('warehouse');
    if (hasAdminPermission('manage_users')) allowedTabs.push('users');
    if (hasAdminPermission('manage_couriers')) allowedTabs.push('couriers');
    if (hasAdminPermission('search_db')) allowedTabs.push('search');
    if (hasAdminPermission('view_audit')) allowedTabs.push('audit');
    if (!allowedTabs.length) return;
    if (!allowedTabs.includes(adminTab)) {
      setAdminTab(allowedTabs[0]);
    }
  }, [user?.role, user?.permissions, adminTab]);

  function visibleOrderActions(order: Order) {
    if (!user) return [] as Status[];
    if (order.status === 'delivered' || order.status === 'cancelled') return [] as Status[];
    if (user.role === 'customer') {
      return order.status === 'pending' ? (['cancelled'] as Status[]) : ([] as Status[]);
    }
    if (user.role === 'courier') {
      if (order.status === 'assigned') return ['picked_up'] as Status[];
      if (order.status === 'picked_up') return ['on_the_way'] as Status[];
      if (order.status === 'on_the_way') return ['delivered'] as Status[];
      return [] as Status[];
    }
    return ['assigned', 'cancelled'] as Status[];
  }

  function logout() {
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

  async function uploadTechPassport(file: File) {
    setTechPassportUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
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
      const payload: { role: Role; isActive: boolean; permissions?: string[] } = { role, isActive };
      if (isSystemAdmin) {
        payload.permissions = adminUserPermissionsDrafts[userId] || [];
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
        permissions: []
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
        stockQuantity: Number(productForm.stockQuantity)
      };

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

      setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0' });
      setProductFormCategory('');
      setProductFormSubcategory('');
      await Promise.all([loadAdminData(), loadProducts()]);
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function uploadProductImage(file: File) {
    setImageUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
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
      stockQuantity: String(product.stockQuantity ?? 0)
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
        setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0' });
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
    if (inStock && Number(product.stockQuantity || 0) <= 0) {
      notify('Нельзя включить наличие: остаток 0 шт.');
      return;
    }
    try {
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
    const path =
      stockActionForm.movementType === 'receive'
        ? '/api/admin/stock/receive'
        : stockActionForm.movementType === 'writeoff'
          ? '/api/admin/stock/writeoff'
          : '/api/admin/stock/reserve';
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
    }
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

  async function savePickTaskStatus(taskId: number) {
    const status = pickTaskStatusDrafts[taskId];
    if (!status) return;
    try {
      await api(`/api/admin/pick-tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
      await Promise.all([loadWarehouseData(), loadProducts(), loadAdminData()]);
      notify('Статус задачи сборки обновлен');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  return (
    <>
      <header className="topbar">
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
          {loggedIn ? <button type="button" onClick={goToProfile}>Кабинет</button> : null}
          {loggedIn && cart.items.length > 0 ? <button type="button" onClick={goToCart}>Корзина</button> : null}
          {loggedIn && cart.items.length > 0 ? <button type="button" onClick={goToMap}>Карта</button> : null}
          <span>{user ? `${user.fullName} (${ROLE_LABELS[user.role]})` : 'Гость'}</span>
          {loggedIn && <button onClick={logout}>Выйти</button>}
        </div>
      </header>

      <main className="layout">
        {!loggedIn && (
          <section className="panel">
            <h2>Вход / Регистрация</h2>
            <div className="auth-grid">
              <form onSubmit={onLogin}>
                <h3>Вход</h3>
                <input placeholder="Email" type="email" value={loginState.email} onChange={(e) => setLoginState({ ...loginState, email: e.target.value })} required />
                <input placeholder="Пароль" type="password" value={loginState.password} onChange={(e) => setLoginState({ ...loginState, password: e.target.value })} required />
                <button type="submit">Войти</button>
              </form>
              <form onSubmit={onRegister}>
                <h3>Регистрация</h3>
                <input placeholder="ФИО" value={registerState.fullName} onChange={(e) => setRegisterState({ ...registerState, fullName: e.target.value })} required />
                <input placeholder="Email" type="email" value={registerState.email} onChange={(e) => setRegisterState({ ...registerState, email: e.target.value })} required />
                <input placeholder="Пароль" type="password" value={registerState.password} onChange={(e) => setRegisterState({ ...registerState, password: e.target.value })} required />
                <input placeholder="Телефон" value={registerState.phone} onChange={(e) => setRegisterState({ ...registerState, phone: e.target.value })} />
                <input placeholder="Адрес" value={registerState.address} onChange={(e) => setRegisterState({ ...registerState, address: e.target.value })} />
                <button type="submit">Создать аккаунт</button>
              </form>
            </div>
          </section>
        )}

        {loggedIn && user?.role !== 'courier' && profileOpen && (
          <section className="panel" ref={profileSectionRef}>
            <h2 style={{ marginTop: 0 }}>Кабинет пользователя</h2>
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
                    <p className="muted">{p.description}</p>
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
                      <p className="muted">{p.description}</p>
                      <div className="price">${p.price.toFixed(2)}</div>
                      <button onClick={() => addToCart(p.id)}>В корзину</button>
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
                {user?.role !== 'courier' ? (
                  <button type="button" onClick={goToMap}>
                    {cartOpen ? 'Карта открыта' : 'Показать карту'}
                  </button>
                ) : null}
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
                    <div className="inline-actions" style={{ marginTop: '8px' }}>
                      <button onClick={checkout} disabled={!quickAddress}>
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
                      <button type="button" onClick={goToMap}>
                        {deliveryMapOpen ? 'Карта открыта' : 'Показать карту'}
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
                  <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                  <div>Курьер ID: {order.assignedCourierId ?? '-'}</div>
                  <div className="inline-actions">
                    {visibleOrderActions(order).map((status) => (
                      <button key={status} onClick={() => setOrderStatus(order.id, status)}>{STATUS_ACTION_LABELS[status]}</button>
                    ))}
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
                <option value="offline">Оффлайн</option>
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
                <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                <div className="inline-actions">
                  {courierProfile?.isEligible ? (
                    (['picked_up', 'on_the_way', 'delivered'] as Status[]).map((status) => (
                      <button key={status} onClick={() => setOrderStatus(order.id, status)}>{STATUS_ACTION_LABELS[status]}</button>
                    ))
                  ) : (
                    <span className="muted">Смена статуса доступна после верификации</span>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {user?.role === 'admin' && (
          <section className="panel">
            <h2>Админ-панель</h2>
            <div className="admin-tabs">
              {hasAdminPermission('view_orders') ? (
                <button type="button" className={adminTab === 'orders' ? 'active' : ''} onClick={() => setAdminTab('orders')}>Заказы</button>
              ) : null}
              {hasAdminPermission('view_analytics') ? (
                <button type="button" className={adminTab === 'analytics' ? 'active' : ''} onClick={() => setAdminTab('analytics')}>Аналитика</button>
              ) : null}
              {hasAdminPermission('manage_products') ? (
                <button type="button" className={adminTab === 'products' ? 'active' : ''} onClick={() => setAdminTab('products')}>Товары</button>
              ) : null}
              {hasAdminPermission('manage_warehouse') ? (
                <button type="button" className={adminTab === 'warehouse' ? 'active' : ''} onClick={() => setAdminTab('warehouse')}>Склад</button>
              ) : null}
              {hasAdminPermission('manage_users') ? (
                <button type="button" className={adminTab === 'users' ? 'active' : ''} onClick={() => setAdminTab('users')}>Пользователи</button>
              ) : null}
              {hasAdminPermission('manage_couriers') ? (
                <button type="button" className={adminTab === 'couriers' ? 'active' : ''} onClick={() => setAdminTab('couriers')}>Курьеры</button>
              ) : null}
              {hasAdminPermission('search_db') ? (
                <button type="button" className={adminTab === 'search' ? 'active' : ''} onClick={() => setAdminTab('search')}>Поиск</button>
              ) : null}
              {hasAdminPermission('view_audit') ? (
                <button type="button" className={adminTab === 'audit' ? 'active' : ''} onClick={() => setAdminTab('audit')}>Аудит-лог</button>
              ) : null}
            </div>
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
                    <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
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
                    <div>Ожидает: {adminAnalytics.totals.pendingCount}</div>
                    <div>Назначен: {adminAnalytics.totals.assignedCount}</div>
                    <div>Забран: {adminAnalytics.totals.pickedUpCount}</div>
                    <div>В пути: {adminAnalytics.totals.onTheWayCount}</div>
                    <div>Доставлен: {adminAnalytics.totals.deliveredCount}</div>
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
                  <input placeholder="URL изображения" value={productForm.imageUrl} onChange={(e) => setProductForm({ ...productForm, imageUrl: e.target.value })} />
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
                  {productForm.imageUrl ? <img src={productForm.imageUrl} alt="Предпросмотр товара" style={{ width: '140px', borderRadius: '8px' }} /> : null}
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
                          setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true, stockQuantity: '0' });
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
                <div className="row">
                  <strong>Складская операция</strong>
                  <form onSubmit={submitStockMovement}>
                    <select
                      value={stockActionForm.movementType}
                      onChange={(e) =>
                        setStockActionForm((prev) => ({ ...prev, movementType: e.target.value as 'receive' | 'writeoff' | 'reserve' }))
                      }
                    >
                      <option value="receive">Приемка</option>
                      <option value="writeoff">Списание</option>
                      <option value="reserve">Резерв</option>
                    </select>
                    <select
                      value={stockActionForm.warehouseId}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, warehouseId: Number(e.target.value) }))}
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
                          #{p.id} {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={stockActionForm.quantity}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, quantity: e.target.value }))}
                      required
                    />
                    <input
                      placeholder="Причина (опц.)"
                      value={stockActionForm.reason}
                      onChange={(e) => setStockActionForm((prev) => ({ ...prev, reason: e.target.value }))}
                    />
                    <button type="submit">Провести</button>
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
                        Статус: {task.status} | Создал: {task.createdByName || '-'} | Обновлено: {new Date(task.updatedAt).toLocaleString()}
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
                  {warehouseOverview.stock.length === 0 ? (
                    <div className="muted">Данных по складу пока нет.</div>
                  ) : (
                    warehouseOverview.stock.map((item) => (
                      <div key={`stock-row-${item.warehouseId}-${item.productId}`}>
                        {item.warehouseName} | {item.productName}: всего {item.quantity} шт., резерв {item.reservedQuantity} шт., доступно {item.availableQuantity} шт.
                      </div>
                    ))
                  )}
                </div>

                <div className="row">
                  <strong>Последние движения</strong>
                  {warehouseOverview.movements.length === 0 ? (
                    <div className="muted">Движений пока нет.</div>
                  ) : (
                    warehouseOverview.movements.slice(0, 20).map((m) => (
                      <div key={`movement-${m.id}`}>
                        #{m.id} {m.movementType} | {m.productName} | {m.quantity} шт. | {m.warehouseName} | {new Date(m.createdAt).toLocaleString()}
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
                                  : prev.permissions.filter((p) => p !== perm.key)
                              }));
                            }}
                          />
                          {perm.label}
                        </label>
                      ))}
                    </div>
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
                                    return { ...prev, [u.id]: next };
                                  })
                                }
                              />
                              {perm.label}
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

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
