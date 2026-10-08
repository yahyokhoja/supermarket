-- Stage 1: reliable inventory operations and integration-ready identifiers.
-- The pre-existing schema in src/db.ts is the baseline and must already exist.

CREATE TABLE IF NOT EXISTS inventory_operations (
  id UUID PRIMARY KEY,
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  reference_type TEXT,
  reference_id BIGINT,
  company_id BIGINT,
  store_id BIGINT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS inventory_operation_lines (
  id BIGSERIAL PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  physical_delta INTEGER NOT NULL DEFAULT 0,
  reserved_delta INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (physical_delta <> 0 OR reserved_delta <> 0)
);

CREATE INDEX IF NOT EXISTS ix_inventory_operation_lines_stock
  ON inventory_operation_lines (warehouse_id, product_id, id);
CREATE INDEX IF NOT EXISTS ix_inventory_operations_reference
  ON inventory_operations (reference_type, reference_id);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id BIGSERIAL PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id BIGINT REFERENCES orders(id) ON DELETE RESTRICT,
  pick_task_id BIGINT REFERENCES pick_tasks(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released')),
  closed_by_operation_id UUID REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE (pick_task_id, product_id)
);

CREATE INDEX IF NOT EXISTS ix_inventory_reservations_active_order
  ON inventory_reservations (order_id, product_id)
  WHERE status = 'active';

-- Preserve ownership only where the legacy journal itself proves a positive active reserve.
-- No stock value is changed and no missing historical movement is invented.
INSERT INTO inventory_operations (
  id, operation_type, status, idempotency_key, payload_hash,
  reference_type, reference_id, created_by, result_json, created_at
)
SELECT
  md5('legacy-order-reserve:' || pt.id::text)::uuid,
  'order_reserve',
  'posted',
  'legacy-order-reserve:' || pt.order_id::text,
  'legacy-derived-from-stock-movements',
  'pick_task',
  pt.id,
  pt.created_by,
  jsonb_build_object('legacyImported', true, 'journalComplete', false),
  pt.created_at
FROM pick_tasks pt
WHERE pt.status IN ('new', 'in_progress')
  AND EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_type = 'pick_task' AND sm.reference_id = pt.id AND sm.movement_type = 'reserve'
  )
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO inventory_reservations (
  operation_id, warehouse_id, product_id, order_id, pick_task_id, quantity, status, created_at
)
SELECT
  md5('legacy-order-reserve:' || pt.id::text)::uuid,
  pt.warehouse_id,
  sm.product_id,
  pt.order_id,
  pt.id,
  SUM(CASE
    WHEN sm.movement_type = 'reserve' THEN sm.quantity
    WHEN sm.movement_type IN ('release', 'pick') THEN -sm.quantity
    ELSE 0
  END)::integer AS quantity,
  'active',
  MIN(sm.created_at)
FROM pick_tasks pt
JOIN stock_movements sm
  ON sm.reference_type = 'pick_task' AND sm.reference_id = pt.id
WHERE pt.status IN ('new', 'in_progress')
GROUP BY pt.id, pt.warehouse_id, pt.order_id, sm.product_id
HAVING SUM(CASE
  WHEN sm.movement_type = 'reserve' THEN sm.quantity
  WHEN sm.movement_type IN ('release', 'pick') THEN -sm.quantity
  ELSE 0
END) > 0
ON CONFLICT (pick_task_id, product_id) DO NOTHING;

-- One order has one accounting picking lifecycle. This closes the check-then-insert race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pick_tasks_order
  ON pick_tasks (order_id);

-- Existing rows are intentionally not rewritten. New and updated rows are protected.
ALTER TABLE warehouse_stock
  DROP CONSTRAINT IF EXISTS ck_warehouse_stock_reserved_not_over_quantity;
ALTER TABLE warehouse_stock
  ADD CONSTRAINT ck_warehouse_stock_reserved_not_over_quantity
  CHECK (reserved_quantity <= quantity) NOT VALID;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_stores (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS harid24_connections (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  store_id BIGINT NOT NULL REFERENCES business_stores(id) ON DELETE RESTRICT,
  sales_point_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'active', 'error')),
  field_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sales_point_id),
  UNIQUE (company_id, store_id)
);

CREATE TABLE IF NOT EXISTS harid24_product_links (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES harid24_connections(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  external_product_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connection_id, external_product_id),
  UNIQUE (connection_id, product_id)
);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id UUID PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES harid24_connections(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_integration_outbox_delivery
  ON integration_outbox (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS integration_inbox (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES harid24_connections(id) ON DELETE CASCADE,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('processed', 'failed')),
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (connection_id, external_event_id)
);
