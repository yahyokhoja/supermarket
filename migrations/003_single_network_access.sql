-- Single retail network access model. No legacy warehouse/store association is guessed.

ALTER TABLE business_stores
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS ux_business_stores_code
  ON business_stores (code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS store_user_assignments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES business_stores(id) ON DELETE RESTRICT,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  CHECK ((is_active AND revoked_at IS NULL AND revoked_by IS NULL) OR NOT is_active)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_store_user_assignments_active
  ON store_user_assignments (user_id, store_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_store_user_assignments_store
  ON store_user_assignments (store_id, user_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS store_assignment_audit (
  id BIGSERIAL PRIMARY KEY,
  assignment_id BIGINT REFERENCES store_user_assignments(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES business_stores(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('assigned','permissions_changed','revoked')),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  actor_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One owner per installation. The owner is deliberately not selected by this migration.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_owner
  ON users ((role)) WHERE role = 'owner' AND is_active;

CREATE TABLE IF NOT EXISTS legacy_warehouse_store_mapping (
  warehouse_id BIGINT PRIMARY KEY REFERENCES warehouses(id) ON DELETE RESTRICT,
  proposed_store_id BIGINT REFERENCES business_stores(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','proposed','confirmed','ambiguous')),
  reason TEXT,
  decided_by BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO legacy_warehouse_store_mapping (warehouse_id, proposed_store_id, status, reason)
SELECT w.id, w.business_store_id,
       CASE WHEN w.business_store_id IS NULL THEN 'unresolved' ELSE 'confirmed' END,
       CASE WHEN w.business_store_id IS NULL THEN 'Требуется ручное сопоставление; названия не использовались' ELSE 'Связь существовала до миграции' END
FROM warehouses w
ON CONFLICT (warehouse_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS disabled_legacy_features (
  feature_key TEXT PRIMARY KEY,
  disabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL
);

INSERT INTO disabled_legacy_features(feature_key, reason) VALUES
 ('customer_registration','Самостоятельная регистрация покупателей исключена из целевой модели'),
 ('customer_cart','Покупательская корзина исключена из целевой модели'),
 ('public_delivery','Публичная доставка выполняется HARID24'),
 ('courier_operations','Роль и активные процессы курьера отключены'),
 ('merchant_self_service','Сторонние продавцы исключены из целевой модели')
ON CONFLICT (feature_key) DO NOTHING;

COMMENT ON TABLE legacy_warehouse_store_mapping IS 'Ручное сопоставление старых складов магазинам; миграция не угадывает связь по названию';
COMMENT ON TABLE store_user_assignments IS 'Актуальная серверная область доступа администраторов к магазинам';
