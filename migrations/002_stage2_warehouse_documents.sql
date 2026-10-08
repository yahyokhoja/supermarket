-- Stage 2: document-based warehouse accounting and exact quantity/value storage.
-- Existing quantities are preserved. Their historical value is deliberately unknown.

ALTER TABLE products
  ALTER COLUMN stock_quantity TYPE NUMERIC(20,6) USING stock_quantity::numeric;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS quantity_precision SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_step NUMERIC(20,6) NOT NULL DEFAULT 1;
ALTER TABLE products DROP CONSTRAINT IF EXISTS ck_products_quantity_precision;
ALTER TABLE products ADD CONSTRAINT ck_products_quantity_precision CHECK (quantity_precision BETWEEN 0 AND 6);
ALTER TABLE products DROP CONSTRAINT IF EXISTS ck_products_quantity_step;
ALTER TABLE products ADD CONSTRAINT ck_products_quantity_step CHECK (quantity_step > 0);

ALTER TABLE warehouse_stock
  ALTER COLUMN quantity TYPE NUMERIC(20,6) USING quantity::numeric,
  ALTER COLUMN reserved_quantity TYPE NUMERIC(20,6) USING reserved_quantity::numeric,
  ALTER COLUMN reorder_min TYPE NUMERIC(20,6) USING reorder_min::numeric,
  ALTER COLUMN reorder_target TYPE NUMERIC(20,6) USING reorder_target::numeric;
ALTER TABLE warehouse_stock ADD COLUMN IF NOT EXISTS stock_version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE stock_movements ALTER COLUMN quantity TYPE NUMERIC(20,6) USING quantity::numeric;
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS operation_id UUID REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS document_id UUID,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(24,8),
  ADD COLUMN IF NOT EXISTS value_delta NUMERIC(24,8);

ALTER TABLE inventory_operation_lines
  ALTER COLUMN physical_delta TYPE NUMERIC(20,6) USING physical_delta::numeric,
  ALTER COLUMN reserved_delta TYPE NUMERIC(20,6) USING reserved_delta::numeric;
ALTER TABLE inventory_operation_lines
  ADD COLUMN IF NOT EXISTS value_delta NUMERIC(24,8),
  ADD COLUMN IF NOT EXISTS stock_version_before BIGINT,
  ADD COLUMN IF NOT EXISTS stock_version_after BIGINT;
ALTER TABLE inventory_operation_lines DROP CONSTRAINT IF EXISTS inventory_operation_lines_check;
ALTER TABLE inventory_operation_lines DROP CONSTRAINT IF EXISTS ck_inventory_operation_lines_effect;
ALTER TABLE inventory_operation_lines ADD CONSTRAINT ck_inventory_operation_lines_effect CHECK (
  physical_delta <> 0 OR reserved_delta <> 0 OR value_delta IS NOT NULL OR stock_version_before IS NOT NULL
);

ALTER TABLE inventory_reservations ALTER COLUMN quantity TYPE NUMERIC(20,6) USING quantity::numeric;
ALTER TABLE inventory_reservations
  ADD COLUMN IF NOT EXISTS original_quantity NUMERIC(20,6),
  ADD COLUMN IF NOT EXISTS reason TEXT;
UPDATE inventory_reservations SET original_quantity = quantity WHERE original_quantity IS NULL;
ALTER TABLE inventory_reservations ALTER COLUMN original_quantity SET NOT NULL;
ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_quantity_check;
ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS ck_inventory_reservations_remaining;
ALTER TABLE inventory_reservations ADD CONSTRAINT ck_inventory_reservations_remaining CHECK (
  quantity >= 0 AND (status <> 'active' OR quantity > 0)
);

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS business_store_id BIGINT REFERENCES business_stores(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  tax_id TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  comment TEXT,
  archived_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_suppliers_company ON suppliers(company_id, archived_at, name);

CREATE TABLE IF NOT EXISTS warehouse_stock_costs (
  warehouse_id BIGINT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  inventory_value NUMERIC(24,8),
  cost_known BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (warehouse_id, product_id),
  CHECK ((cost_known AND inventory_value IS NOT NULL AND inventory_value >= 0)
      OR (NOT cost_known AND inventory_value IS NULL))
);
INSERT INTO warehouse_stock_costs (warehouse_id, product_id, inventory_value, cost_known)
SELECT warehouse_id, product_id, NULL, FALSE FROM warehouse_stock
ON CONFLICT (warehouse_id, product_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory_documents (
  id UUID PRIMARY KEY,
  document_type TEXT NOT NULL CHECK (document_type IN ('opening_balance','receipt','transfer','writeoff','stocktake','correction')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  document_number TEXT NOT NULL,
  accounting_date DATE NOT NULL DEFAULT CURRENT_DATE,
  company_id BIGINT REFERENCES companies(id) ON DELETE RESTRICT,
  source_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE RESTRICT,
  destination_warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE RESTRICT,
  supplier_id BIGINT REFERENCES suppliers(id) ON DELETE RESTRICT,
  opening_mode TEXT CHECK (opening_mode IS NULL OR opening_mode IN ('establish','add_empty')),
  reason TEXT,
  comment TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  posting_idempotency_key TEXT UNIQUE,
  posting_payload_hash TEXT,
  inventory_operation_id UUID UNIQUE REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  reverses_document_id UUID REFERENCES inventory_documents(id) ON DELETE RESTRICT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  posted_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  posted_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  UNIQUE NULLS NOT DISTINCT (company_id, document_type, document_number),
  CHECK (source_warehouse_id IS NOT NULL OR destination_warehouse_id IS NOT NULL),
  CHECK (document_type <> 'transfer' OR (source_warehouse_id IS NOT NULL AND destination_warehouse_id IS NOT NULL AND source_warehouse_id <> destination_warehouse_id))
);

CREATE TABLE IF NOT EXISTS inventory_document_lines (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES inventory_documents(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity NUMERIC(20,6),
  unit_cost NUMERIC(24,8),
  actual_quantity NUMERIC(20,6),
  snapshot_quantity NUMERIC(20,6),
  snapshot_reserved_quantity NUMERIC(20,6),
  snapshot_stock_version BIGINT,
  note TEXT,
  CHECK (quantity IS NULL OR quantity > 0),
  CHECK (unit_cost IS NULL OR unit_cost >= 0),
  CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  UNIQUE(document_id, line_no),
  UNIQUE(document_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_inventory_documents_status ON inventory_documents(status, document_type, accounting_date DESC);
CREATE INDEX IF NOT EXISTS ix_inventory_document_lines_product ON inventory_document_lines(product_id, document_id);

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_document_id_fkey;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES inventory_documents(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION protect_posted_inventory_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc_status TEXT;
BEGIN
  SELECT status INTO doc_status FROM inventory_documents WHERE id = COALESCE(OLD.document_id, NEW.document_id);
  IF doc_status IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'posted inventory document lines are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_protect_posted_inventory_document_line ON inventory_document_lines;
CREATE TRIGGER trg_protect_posted_inventory_document_line
BEFORE UPDATE OR DELETE ON inventory_document_lines
FOR EACH ROW EXECUTE FUNCTION protect_posted_inventory_document();

CREATE OR REPLACE FUNCTION prevent_posted_inventory_document_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted','cancelled') THEN
    RAISE EXCEPTION 'posted inventory documents cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_prevent_posted_inventory_document_delete ON inventory_documents;
CREATE TRIGGER trg_prevent_posted_inventory_document_delete
BEFORE DELETE ON inventory_documents
FOR EACH ROW EXECUTE FUNCTION prevent_posted_inventory_document_delete();

CREATE TABLE IF NOT EXISTS inventory_reversal_links (
  original_operation_id UUID PRIMARY KEY REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  reversal_operation_id UUID NOT NULL UNIQUE REFERENCES inventory_operations(id) ON DELETE RESTRICT,
  original_document_id UUID NOT NULL REFERENCES inventory_documents(id) ON DELETE RESTRICT,
  reversal_document_id UUID NOT NULL UNIQUE REFERENCES inventory_documents(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
