-- Complete management of the single retail network. Legacy global prices remain unchanged.

ALTER TABLE business_stores
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by BIGINT REFERENCES users(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS store_product_settings (
  store_id BIGINT NOT NULL REFERENCES business_stores(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  is_listed BOOLEAN NOT NULL DEFAULT FALSE,
  sale_price NUMERIC(14,2),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (store_id, product_id),
  CHECK (sale_price IS NULL OR sale_price >= 0)
);

CREATE INDEX IF NOT EXISTS ix_store_product_settings_product
  ON store_product_settings(product_id, store_id);

ALTER TABLE legacy_warehouse_store_mapping
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS dependency_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ux_legacy_mapping_idempotency
  ON legacy_warehouse_store_mapping(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS store_archive_checks (
  id BIGSERIAL PRIMARY KEY,
  store_id BIGINT NOT NULL REFERENCES business_stores(id) ON DELETE RESTRICT,
  checked_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  blockers JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE store_product_settings IS 'Явный ассортимент и цена магазина; NULL не означает использование глобальной цены';
COMMENT ON COLUMN products.price IS 'Legacy global price retained for compatibility; not an implicit store price';
