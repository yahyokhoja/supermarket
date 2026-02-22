export type UserRole = 'customer' | 'courier' | 'admin';

export interface JwtPayload {
  id: number;
  email: string;
  role: UserRole;
}

export interface DbUser {
  id: number;
  full_name: string;
  email: string;
  phone: string | null;
  address: string | null;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export interface PublicUser {
  id: number;
  fullName: string;
  email: string;
  phone: string | null;
  address: string | null;
  role: UserRole;
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
  assigned_courier_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ApiOrder {
  id: number;
  userId: number;
  status: string;
  total: number;
  deliveryAddress: string;
  deliveryLat: number | null;
  deliveryLng: number | null;
  assignedCourierId: number | null;
  createdAt: string;
  updatedAt: string;
}
