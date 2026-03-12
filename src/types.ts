export type UserRole = 'customer' | 'courier' | 'admin' | 'picker';

export interface JwtPayload {
  id: number;
  email: string;
  role: UserRole;
  sessionVersion: number;
}

export interface DbUser {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  address: string | null;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  session_version: number;
  permissions: string[];
  warehouse_scopes: number[] | null;
  created_at: string;
}

export interface PublicUser {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  address: string | null;
  role: UserRole;
  isActive: boolean;
  permissions: string[];
  warehouseScopes: number[] | null;
  createdAt: string;
}

export interface DbOrder {
  id: number;
  user_id: number;
  status: string;
  total: number;
  delivery_address: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
  serviceable: boolean | null;
  delivery_zone: string | null;
  fulfillment_warehouse: string | null;
  fulfillment_warehouse_code: string | null;
  warehouse_distance_km: number | null;
  route_distance_km: number | null;
  delivery_eta_min: number | null;
  delivery_fee: number | null;
  assigned_courier_id: number | null;
  created_at: string;
  updated_at: string;
  customer_full_name?: string | null;
  customer_phone?: string | null;
  pick_task_status?: string | null;
  picker_id?: number | null;
  picker_name?: string | null;
}

export interface ApiOrder {
  id: number;
  userId: number;
  status: string;
  total: number;
  deliveryAddress: string;
  deliveryLat: number | null;
  deliveryLng: number | null;
  serviceable: boolean | null;
  deliveryZone: string | null;
  fulfillmentWarehouse: string | null;
  fulfillmentWarehouseCode: string | null;
  warehouseDistanceKm: number | null;
  routeDistanceKm: number | null;
  deliveryEtaMin: number | null;
  deliveryFee: number | null;
  assignedCourierId: number | null;
  createdAt: string;
  updatedAt: string;
  customerName?: string | null;
  customerPhone?: string | null;
  pickTaskStatus?: string | null;
  pickerId?: number | null;
  pickerName?: string | null;
}
