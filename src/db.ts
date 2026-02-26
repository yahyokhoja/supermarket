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
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INTEGER NOT NULL DEFAULT 0,
      permissions TEXT[] NOT NULL DEFAULT '{}',
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
      stock_quantity INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_categories (
      id BIGSERIAL PRIMARY KEY,
      category_name TEXT NOT NULL,
      subcategory_name TEXT,
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
      verification_status TEXT NOT NULL DEFAULT 'pending',
      transport_license TEXT,
      vehicle_registration_number TEXT,
      tech_passport_image_url TEXT,
      verification_comment TEXT,
      verification_requested_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      verification_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
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

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id BIGINT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS warehouse_stock (
      id BIGSERIAL PRIMARY KEY,
      warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
      reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0),
      reorder_min INTEGER NOT NULL DEFAULT 5 CHECK(reorder_min >= 0),
      reorder_target INTEGER NOT NULL DEFAULT 20 CHECK(reorder_target >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(warehouse_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id BIGSERIAL PRIMARY KEY,
      warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      movement_type TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      reason TEXT,
      reference_type TEXT,
      reference_id BIGINT,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pick_tasks (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'new',
      assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pick_task_items (
      id BIGSERIAL PRIMARY KEY,
      pick_task_id BIGINT NOT NULL REFERENCES pick_tasks(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      product_name TEXT NOT NULL,
      requested_qty INTEGER NOT NULL CHECK(requested_qty > 0),
      picked_qty INTEGER NOT NULL DEFAULT 0 CHECK(picked_qty >= 0)
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_product_categories_name
    ON product_categories ((lower(category_name)), (lower(COALESCE(subcategory_name, ''))));
  `);

  await pool.query(`
    INSERT INTO product_categories (category_name, subcategory_name)
    SELECT DISTINCT
      TRIM(SPLIT_PART(category, '>', 1)) AS category_name,
      NULLIF(TRIM(SPLIT_PART(category, '>', 2)), '') AS subcategory_name
    FROM products
    WHERE category IS NOT NULL AND TRIM(category) <> ''
    ON CONFLICT DO NOTHING;
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';
  `);

  await pool.query(`
    ALTER TABLE couriers
      ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS transport_license TEXT,
      ADD COLUMN IF NOT EXISTS vehicle_registration_number TEXT,
      ADD COLUMN IF NOT EXISTS tech_passport_image_url TEXT,
      ADD COLUMN IF NOT EXISTS verification_comment TEXT,
      ADD COLUMN IF NOT EXISTS verification_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE couriers
      ADD COLUMN IF NOT EXISTS verification_reviewed_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
  `);

  await pool.query(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS stock_quantity INTEGER NOT NULL DEFAULT 0;
  `);

  await pool.query(`
    INSERT INTO warehouses (code, name, is_active)
    VALUES ('MAIN', 'Основной склад', TRUE)
    ON CONFLICT (code) DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, reserved_quantity, reorder_min, reorder_target)
    SELECT w.id, p.id, GREATEST(COALESCE(p.stock_quantity, 0), 0), 0, 5, 20
    FROM warehouses w
    CROSS JOIN products p
    WHERE w.code = 'MAIN'
    ON CONFLICT (warehouse_id, product_id) DO NOTHING;
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
    ['Молоко 2.5%', 'Свежайшее молоко 1 л', 1.5, 'Молочные продукты', 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=800', true, 40],
    ['Хлеб цельнозерновой', 'Мягкий хлеб 500 г', 1.2, 'Выпечка', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800', true, 35],
    ['Яйца С1', 'Упаковка 10 шт', 2.1, 'Бакалея', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc?w=800', true, 25],
    ['Куриное филе', 'Охлажденное, 1 кг', 5.8, 'Мясо', 'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800', true, 18],
    ['Яблоки', 'Сочные красные яблоки, 1 кг', 2.4, 'Фрукты', 'https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?w=800', true, 50],
    ['Томаты', 'Спелые томаты, 1 кг', 2.0, 'Овощи', 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=800', true, 32],
    ['Сыр Гауда', 'Сыр 300 г', 4.3, 'Молочные продукты', 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=800', true, 20],
    ['Паста', 'Итальянская паста 450 г', 1.7, 'Бакалея', 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=800', true, 45]
  ];

  for (const product of products) {
    await pool.query(
      `
        INSERT INTO products (name, description, price, category, image_url, in_stock, stock_quantity)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      product
    );
  }
}

export async function seedProductCategories(pool: Pool) {
  const countRow = await pool.query<{ count: string }>('SELECT COUNT(*)::text as count FROM product_categories');
  if (Number(countRow.rows[0]?.count || '0') > 0) return;

  const defaults: Array<[string, string | null]> = [
    ['Молочные продукты', 'Молоко'],
    ['Выпечка', 'Хлеб'],
    ['Бакалея', 'Яйца и крупы'],
    ['Мясо', 'Птица'],
    ['Фрукты', null],
    ['Овощи', null],
    ['Молочные продукты', 'Сыры'],
    ['Бакалея', 'Паста']
  ];

  for (const [category, subcategory] of defaults) {
    await pool.query(
      `
        INSERT INTO product_categories (category_name, subcategory_name)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
      [category, subcategory]
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
      INSERT INTO couriers (
        user_id, vehicle_type, status, verification_status, transport_license,
        vehicle_registration_number, tech_passport_image_url, verified_at, max_active_orders
      )
      VALUES ($1, 'bike', 'available', 'approved', 'AUTO-COURIER-001', 'REG-001', '/uploads/default-tech-passport.jpg', NOW(), 5)
      ON CONFLICT (user_id) DO UPDATE SET
        verification_status = 'approved',
        transport_license = COALESCE(couriers.transport_license, EXCLUDED.transport_license),
        vehicle_registration_number = COALESCE(couriers.vehicle_registration_number, EXCLUDED.vehicle_registration_number),
        tech_passport_image_url = COALESCE(couriers.tech_passport_image_url, EXCLUDED.tech_passport_image_url),
        verified_at = COALESCE(couriers.verified_at, EXCLUDED.verified_at)
    `,
    [courierUserId]
  );
}
