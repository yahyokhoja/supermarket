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
};

type Product = {
  id: number;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category?: string | null;
  inStock?: boolean;
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
  activeOrders: number;
  maxActiveOrders: number;
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
};
type HeaderSection = 'catalog' | 'profile' | 'cart' | 'map';

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
  const [adminProducts, setAdminProducts] = useState<AdminProduct[]>([]);
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
  const [productForm, setProductForm] = useState({
    id: 0,
    name: '',
    description: '',
    price: '',
    category: '',
    imageUrl: '',
    inStock: true
  });
  const [imageUploading, setImageUploading] = useState(false);
  const [becomingCourier, setBecomingCourier] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [deliveryMapOpen, setDeliveryMapOpen] = useState(false);
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const profileSectionRef = useRef<HTMLElement | null>(null);
  const catalogSectionRef = useRef<HTMLElement | null>(null);
  const cartSectionRef = useRef<HTMLElement | null>(null);

  const loggedIn = Boolean(token && user);

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
    openOnlySection('catalog');
    setTimeout(() => scrollToSection(catalogSectionRef), 0);
  }

  function goToProfile() {
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

  async function loadOpenCourierOrders() {
    if (user?.role !== 'courier') return;
    const data = await api<{ orders: Order[] }>('/api/orders/open');
    setOpenCourierOrders(data.orders);
  }

  async function loadAdminData() {
    if (user?.role !== 'admin') return;
    const [ordersRes, couriersRes, productsRes] = await Promise.all([
      api<{ orders: Order[] }>('/api/orders/all'),
      api<{ couriers: Courier[] }>('/api/couriers'),
      api<{ products: AdminProduct[] }>('/api/admin/products')
    ]);
    setAllOrders(ordersRes.orders);
    setCouriers(couriersRes.couriers);
    setAdminProducts(productsRes.products);
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
    loadAdminData().catch(() => undefined);
  }, [user]);

  const orderStatusActions = useMemo(() => {
    if (!user) return [] as Status[];
    if (user.role === 'customer') return ['cancelled'] as Status[];
    if (user.role === 'courier') return ['picked_up', 'on_the_way', 'delivered'] as Status[];
    return ['assigned', 'cancelled'] as Status[];
  }, [user]);

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
    await api('/api/couriers/connect', {
      method: 'POST',
      body: JSON.stringify(courierState)
    });
    await Promise.all([loadCourierOrders(), loadOpenCourierOrders(), loadAdminData()]);
    notify('Курьер подключен');
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

  async function saveProduct(e: FormEvent) {
    e.preventDefault();
    try {
      const payload = {
        name: productForm.name,
        description: productForm.description,
        price: Number(productForm.price),
        category: productForm.category,
        imageUrl: productForm.imageUrl,
        inStock: productForm.inStock
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

      setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true });
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

  function editProduct(product: AdminProduct) {
    setProductForm({
      id: product.id,
      name: product.name,
      description: product.description || '',
      price: String(product.price),
      category: product.category || '',
      imageUrl: product.imageUrl || '',
      inStock: product.inStock
    });
  }

  async function deleteProduct(productId: number) {
    try {
      await api(`/api/admin/products/${productId}`, { method: 'DELETE' });
      if (productForm.id === productId) {
        setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true });
      }
      await Promise.all([loadAdminData(), loadProducts()]);
      notify('Товар удален');
    } catch (err) {
      notify((err as Error).message);
    }
  }

  async function setProductAvailability(product: AdminProduct, inStock: boolean) {
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

  return (
    <>
      <header className="topbar">
        <h1>Universal Market Delivery</h1>
        <div className="topbar-actions">
          {loggedIn ? (
            <div className="header-dropdown">
              <button type="button" onClick={() => setNavMenuOpen((v) => !v)}>
                Меню
              </button>
              {navMenuOpen ? (
                <div className="header-dropdown-menu">
                  <button
                    type="button"
                    onClick={() => {
                      goToCatalog();
                      setNavMenuOpen(false);
                    }}
                  >
                    Товары
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      goToProfile();
                      setNavMenuOpen(false);
                    }}
                  >
                    Кабинет
                  </button>
                  {cart.items.length > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          goToCart();
                          setNavMenuOpen(false);
                        }}
                      >
                        Корзина
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          goToMap();
                          setNavMenuOpen(false);
                        }}
                      >
                        Карта
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
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

        {loggedIn && (
          <section className="panel" ref={profileSectionRef}>
            <div className="inline-actions" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
              <h2 style={{ margin: 0 }}>Кабинет пользователя</h2>
              {user?.role !== 'courier' ? (
                <button type="button" onClick={goToProfile}>
                  {profileOpen ? 'Кабинет открыт' : 'Показать кабинет'}
                </button>
              ) : null}
            </div>
            {profileOpen ? (
              <>
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
              </>
            ) : null}
          </section>
        )}

        {!loggedIn ? (
          <section className="panel" ref={catalogSectionRef}>
            <h2>Каталог</h2>
            <div className="cards">
              {products.map((p) => (
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
            <div className="inline-actions" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
              <h2 style={{ margin: 0 }}>Каталог</h2>
              {user?.role !== 'courier' ? (
                <button type="button" onClick={goToCatalog}>
                  {catalogOpen ? 'Товары открыты' : 'Показать товары'}
                </button>
              ) : null}
            </div>
            {catalogOpen ? (
              <div className="cards">
                {products.map((p) => (
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

        {loggedIn && orders.length > 0 ? (
            <section className="panel">
              <h2>Мои заказы</h2>
              {orders.map((order) => (
                <div className="row" key={order.id}>
                  <div><strong>Заказ #{order.id}</strong> <span className={`badge ${order.status}`}>{STATUS_LABELS[order.status]}</span></div>
                  <div>Сумма: ${order.total.toFixed(2)} | Адрес: {order.deliveryAddress}</div>
                  <div>Координаты: {order.deliveryLat !== null && order.deliveryLng !== null ? `${order.deliveryLat.toFixed(6)}, ${order.deliveryLng.toFixed(6)}` : 'не указаны'}</div>
                  <div>Курьер ID: {order.assignedCourierId ?? '-'}</div>
                  <div className="inline-actions">
                    {user && orderStatusActions.map((status) => (
                      <button key={status} onClick={() => setOrderStatus(order.id, status)}>{STATUS_ACTION_LABELS[status]}</button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
        ) : null}

        {user?.role === 'courier' && (
          <section className="panel">
            <h2>Панель курьера</h2>
            <form onSubmit={connectCourier}>
              <input placeholder="Тип транспорта" value={courierState.vehicleType} onChange={(e) => setCourierState({ ...courierState, vehicleType: e.target.value })} />
              <select value={courierState.status} onChange={(e) => setCourierState({ ...courierState, status: e.target.value })}>
                <option value="available">Свободен</option>
                <option value="busy">Занят</option>
                <option value="offline">Оффлайн</option>
              </select>
              <button type="submit">Подключиться</button>
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
                  {(['picked_up', 'on_the_way', 'delivered'] as Status[]).map((status) => (
                    <button key={status} onClick={() => setOrderStatus(order.id, status)}>{STATUS_ACTION_LABELS[status]}</button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {user?.role === 'admin' && (
          <section className="panel">
            <h2>Админ-панель</h2>
            <div>
              <h3>{productForm.id ? 'Редактировать товар' : 'Добавить новый товар'}</h3>
              <form onSubmit={saveProduct}>
                <input
                  placeholder="Название товара"
                  value={productForm.name}
                  onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                  required
                />
                <input
                  placeholder="Описание"
                  value={productForm.description}
                  onChange={(e) => setProductForm({ ...productForm, description: e.target.value })}
                />
                <input
                  placeholder="Цена"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={productForm.price}
                  onChange={(e) => setProductForm({ ...productForm, price: e.target.value })}
                  required
                />
                <input
                  placeholder="Категория"
                  value={productForm.category}
                  onChange={(e) => setProductForm({ ...productForm, category: e.target.value })}
                />
                <input
                  placeholder="URL изображения"
                  value={productForm.imageUrl}
                  onChange={(e) => setProductForm({ ...productForm, imageUrl: e.target.value })}
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
                  <img src={productForm.imageUrl} alt="Предпросмотр товара" style={{ width: '140px', borderRadius: '8px' }} />
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    checked={productForm.inStock}
                    onChange={(e) => setProductForm({ ...productForm, inStock: e.target.checked })}
                  />
                  В наличии
                </label>
                <div className="inline-actions">
                  <button type="submit">{productForm.id ? 'Сохранить изменения' : 'Добавить товар'}</button>
                  {productForm.id ? (
                    <button
                      type="button"
                      onClick={() => setProductForm({ id: 0, name: '', description: '', price: '', category: '', imageUrl: '', inStock: true })}
                    >
                      Отменить редактирование
                    </button>
                  ) : null}
                </div>
              </form>
              <div>
                {adminProducts.map((product) => (
                  <div className="row" key={product.id}>
                    <strong>{product.name}</strong>
                    <div>Цена: ${product.price.toFixed(2)} | {product.inStock ? 'В наличии' : 'Скрыт'}</div>
                    <div className="muted">{product.category || 'Без категории'}</div>
                    <div className="inline-actions">
                      <button type="button" onClick={() => editProduct(product)}>Редактировать</button>
                      <button
                        type="button"
                        onClick={() => setProductAvailability(product, !product.inStock)}
                      >
                        {product.inStock ? 'Нет в наличии' : 'Вернуть в наличие'}
                      </button>
                      <button type="button" className="danger" onClick={() => deleteProduct(product.id)}>Удалить</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="admin-grid">
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
              <div>
                <h3>Курьеры</h3>
                {couriers.map((courier) => (
                  <div className="row" key={courier.id}>
                    <strong>{courier.fullName}</strong>
                    <div>{courier.email}</div>
                    <div>{courier.vehicleType} | {COURIER_STATUS_LABELS[courier.status] || courier.status}</div>
                    <div>Нагрузка: {courier.activeOrders}/{courier.maxActiveOrders}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
