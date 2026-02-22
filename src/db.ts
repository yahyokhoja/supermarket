import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

export function connectDb(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function ensureColumn(db: any, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = columns.some((col) => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initDb(db: any) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      category TEXT,
      image_url TEXT,
      in_stock INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, product_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS couriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      vehicle_type TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      max_active_orders INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total REAL NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_lat REAL,
      delivery_lng REAL,
      assigned_courier_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(assigned_courier_id) REFERENCES couriers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      comment TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TRIGGER IF NOT EXISTS update_orders_timestamp
    AFTER UPDATE ON orders
    FOR EACH ROW
    BEGIN
      UPDATE orders SET updated_at = datetime('now') WHERE id = OLD.id;
    END;
  `);

  ensureColumn(db, 'orders', 'delivery_lat', 'REAL');
  ensureColumn(db, 'orders', 'delivery_lng', 'REAL');
}

export function seedProducts(db: any) {
  const count = db.prepare('SELECT COUNT(*) as count FROM products').get() as { count: number };
  if (count.count > 0) return;

  const insert = db.prepare(`
    INSERT INTO products (name, description, price, category, image_url, in_stock)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const products = [
    ['Молоко 2.5%', 'Свежайшее молоко 1 л', 1.5, 'Молочные продукты', 'https://images.unsplash.com/photo-1563636619-e9143da7973b?w=800', 1],
    ['Хлеб цельнозерновой', 'Мягкий хлеб 500 г', 1.2, 'Выпечка', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800', 1],
    ['Яйца С1', 'Упаковка 10 шт', 2.1, 'Бакалея', 'https://images.unsplash.com/photo-1587486913049-53fc88980cfc?w=800', 1],
    ['Куриное филе', 'Охлажденное, 1 кг', 5.8, 'Мясо', 'https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800', 1],
    ['Яблоки', 'Сочные красные яблоки, 1 кг', 2.4, 'Фрукты', 'https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?w=800', 1],
    ['Томаты', 'Спелые томаты, 1 кг', 2.0, 'Овощи', 'https://images.unsplash.com/photo-1592924357228-91a4daadcfea?w=800', 1],
    ['Сыр Гауда', 'Сыр 300 г', 4.3, 'Молочные продукты', 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=800', 1],
    ['Паста', 'Итальянская паста 450 г', 1.7, 'Бакалея', 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=800', 1]
  ];

  const tx = db.transaction(() => {
    for (const product of products) insert.run(...product);
  });

  tx();
}

export function seedUsers(db: any) {
  const defaultPasswordHash = bcrypt.hashSync('Password123!', 10);

  const adminExists = db.prepare("SELECT id FROM users WHERE email = 'admin@universal.local'").get();
  if (!adminExists) {
    db.prepare(`
      INSERT INTO users (full_name, email, phone, address, password_hash, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('System Admin', 'admin@universal.local', '+10000000001', 'HQ', defaultPasswordHash, 'admin');
  }

  const courierUser = db.prepare("SELECT id, role FROM users WHERE email = 'courier@universal.local'").get() as { id: number; role: string } | undefined;
  let courierUserId = courierUser?.id;

  if (!courierUserId) {
    const result = db.prepare(`
      INSERT INTO users (full_name, email, phone, address, password_hash, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('Default Courier', 'courier@universal.local', '+10000000002', 'City Hub', defaultPasswordHash, 'courier');
    courierUserId = Number(result.lastInsertRowid);
  } else if (courierUser && courierUser.role !== 'courier') {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('courier', courierUserId);
  }

  const courierExists = db.prepare('SELECT id FROM couriers WHERE user_id = ?').get(courierUserId);
  if (!courierExists) {
    db.prepare(`
      INSERT INTO couriers (user_id, vehicle_type, status, max_active_orders)
      VALUES (?, ?, ?, ?)
    `).run(courierUserId, 'bike', 'available', 5);
  }
}
