import bcrypt from 'bcryptjs';
import { Pool } from 'pg';

export function connectDb(connectionString: string) {
  return new Pool({ connectionString });
}

export async function initDb(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC(12,2) NOT NULL,
      category TEXT,
      image_url TEXT,
      in_stock BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS couriers (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vehicle_type TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      max_active_orders INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      total NUMERIC(12,2) NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_lat DOUBLE PRECISION,
      delivery_lng DOUBLE PRECISION,
      assigned_courier_id BIGINT REFERENCES couriers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      comment TEXT,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION set_orders_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
    CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION set_orders_updated_at();
  `);
}

export async function seedProducts(pool: Pool) {
  const countRow = await pool.query<{ count: string }>('SELECT COUNT(*)::text as count FROM products');
  if (Number(countRow.rows[0]?.count || '0') > 0) return;

  const products = [
    ['Молоко 2.5%', 'Свежайшее молоко 1 л', 1.5, 'Молочные продукты', 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=800', true],
    ['Хлеб цельнозерновой', 'Мягкий хлеб 500 г', 1.2, 'Выпечка', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800', true],
    ['Яйца С1', 'Упаковка 10 шт', 2.1, 'Бакалея', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc?w=800', true],
    ['Куриное филе', 'Охлажденное, 1 кг', 5.8, 'Мясо', 'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800', true],
    ['Яблоки', 'Сочные красные яблоки, 1 кг', 2.4, 'Фрукты', 'https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?w=800', true],
    ['Томаты', 'Спелые томаты, 1 кг', 2.0, 'Овощи', 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=800', true],
    ['Сыр Гауда', 'Сыр 300 г', 4.3, 'Молочные продукты', 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=800', true],
    ['Паста', 'Итальянская паста 450 г', 1.7, 'Бакалея', 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=800', true]
  ];

  for (const product of products) {
    await pool.query(
      `
        INSERT INTO products (name, description, price, category, image_url, in_stock)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      product
    );
  }
}

export async function seedUsers(pool: Pool) {
  const defaultPasswordHash = bcrypt.hashSync('Password123!', 10);

  await pool.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, 'admin')
      ON CONFLICT (email) DO NOTHING
    `,
    ['System Admin', 'admin@universal.local', '+10000000001', 'HQ', defaultPasswordHash]
  );

  await pool.query(
    `
      INSERT INTO users (full_name, email, phone, address, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, 'courier')
      ON CONFLICT (email) DO NOTHING
    `,
    ['Default Courier', 'courier@universal.local', '+10000000002', 'City Hub', defaultPasswordHash]
  );

  await pool.query("UPDATE users SET role = 'courier' WHERE email = 'courier@universal.local'");

  const courierUser = await pool.query<{ id: string }>("SELECT id::text as id FROM users WHERE email = 'courier@universal.local' LIMIT 1");
  const courierUserId = Number(courierUser.rows[0]?.id || 0);
  if (!courierUserId) return;

  await pool.query(
    `
      INSERT INTO couriers (user_id, vehicle_type, status, max_active_orders)
      VALUES ($1, 'bike', 'available', 5)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [courierUserId]
  );
}
