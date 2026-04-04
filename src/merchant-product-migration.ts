import { Pool, PoolClient } from 'pg';

export type MerchantProductsMigrationStage = 'all' | 'copy' | 'verify' | 'cutover';

export type MerchantProductsMigrationInput = {
  sharedPool: Pool;
  storeId: number;
  dsnKey: string;
  dedicatedUrl?: string | null;
  stage?: MerchantProductsMigrationStage;
  dryRun?: boolean;
  onCutover?: () => void | Promise<void>;
};

export type MerchantProductsMigrationResult = {
  storeId: number;
  dsnKey: string;
  stage: MerchantProductsMigrationStage;
  dryRun: boolean;
  dedicatedUrlSet: boolean;
  copiedRows: number;
  verifiedRows: number;
  cutoverApplied: boolean;
};

type ProductRow = {
  id: number;
  store_id: number;
  name: string;
  description: string | null;
  price: string;
  image_url: string | null;
  in_stock: boolean;
  stock_quantity: number;
  created_at: string;
  updated_at: string;
};

export function normalizeTenantEnvKey(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function resolveDedicatedUrl(dsnKey: string, dedicatedUrl?: string | null) {
  const direct = String(dedicatedUrl || '').trim();
  if (direct) return direct;
  const envKey = `TENANT_DB_URL_${normalizeTenantEnvKey(dsnKey)}`;
  return String(process.env[envKey] || '').trim() || null;
}

async function ensureSharedSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_db_routing (
      id BIGSERIAL PRIMARY KEY,
      store_id BIGINT NOT NULL UNIQUE REFERENCES merchant_stores(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared', 'dedicated')),
      dsn_key TEXT,
      dedicated_database_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureDedicatedSchema(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_products (
      id BIGSERIAL PRIMARY KEY,
      store_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price NUMERIC(12,2) NOT NULL,
      image_url TEXT,
      in_stock BOOLEAN NOT NULL DEFAULT TRUE,
      stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ix_merchant_products_store
    ON merchant_products (store_id);
  `);
}

async function assertStoreExists(shared: PoolClient, storeId: number) {
  const row = (await shared.query('SELECT id FROM merchant_stores WHERE id = $1 LIMIT 1', [storeId])).rows[0];
  if (!row) throw new Error(`Точка store_id=${storeId} не найдена в shared БД`);
}

async function fetchProducts(client: Pool | PoolClient, storeId: number): Promise<ProductRow[]> {
  return (
    await client.query(
      `
        SELECT
          id,
          store_id,
          name,
          description,
          price::text AS price,
          image_url,
          in_stock,
          stock_quantity,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM merchant_products
        WHERE store_id = $1
        ORDER BY id ASC
      `,
      [storeId]
    )
  ).rows as ProductRow[];
}

async function copyProducts(shared: PoolClient, dedicated: PoolClient, storeId: number) {
  const rows = await fetchProducts(shared, storeId);
  for (const row of rows) {
    await dedicated.query(
      `
        INSERT INTO merchant_products (
          id, store_id, name, description, price, image_url, in_stock, stock_quantity, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          store_id = EXCLUDED.store_id,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          price = EXCLUDED.price,
          image_url = EXCLUDED.image_url,
          in_stock = EXCLUDED.in_stock,
          stock_quantity = EXCLUDED.stock_quantity,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.store_id,
        row.name,
        row.description,
        row.price,
        row.image_url,
        row.in_stock,
        row.stock_quantity,
        row.created_at,
        row.updated_at
      ]
    );
  }

  await dedicated.query(
    `
      SELECT setval(
        pg_get_serial_sequence('merchant_products', 'id'),
        GREATEST((SELECT COALESCE(MAX(id), 0) FROM merchant_products), 1),
        TRUE
      )
    `
  );

  return rows.length;
}

function equalProducts(a: ProductRow, b: ProductRow) {
  return (
    a.id === b.id &&
    a.store_id === b.store_id &&
    a.name === b.name &&
    a.description === b.description &&
    a.price === b.price &&
    a.image_url === b.image_url &&
    a.in_stock === b.in_stock &&
    a.stock_quantity === b.stock_quantity &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at
  );
}

async function verifyProducts(shared: PoolClient, dedicated: PoolClient, storeId: number) {
  const sharedRows = await fetchProducts(shared, storeId);
  const dedicatedRows = await fetchProducts(dedicated, storeId);
  if (sharedRows.length !== dedicatedRows.length) {
    throw new Error(`Verify failed: разное число строк shared=${sharedRows.length}, dedicated=${dedicatedRows.length}`);
  }

  for (let i = 0; i < sharedRows.length; i += 1) {
    if (!equalProducts(sharedRows[i], dedicatedRows[i])) {
      throw new Error(`Verify failed: несовпадение данных на позиции ${i} (product_id=${sharedRows[i].id})`);
    }
  }
  return sharedRows.length;
}

async function cutover(shared: PoolClient, storeId: number, dsnKey: string, dedicatedUrl: string | null) {
  await shared.query(
    `
      INSERT INTO tenant_db_routing (store_id, mode, dsn_key, dedicated_database_url)
      VALUES ($1, 'dedicated', $2, $3)
      ON CONFLICT (store_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        dsn_key = EXCLUDED.dsn_key,
        dedicated_database_url = EXCLUDED.dedicated_database_url
    `,
    [storeId, dsnKey, dedicatedUrl]
  );
}

export async function migrateMerchantProducts(input: MerchantProductsMigrationInput): Promise<MerchantProductsMigrationResult> {
  const storeId = Math.floor(Number(input.storeId));
  if (!Number.isFinite(storeId) || storeId <= 0) throw new Error('Некорректный storeId');
  const dsnKey = String(input.dsnKey || '').trim();
  if (!dsnKey) throw new Error('dsnKey обязателен');

  const stage: MerchantProductsMigrationStage = input.stage || 'all';
  const dryRun = Boolean(input.dryRun);
  const dedicatedUrl = resolveDedicatedUrl(dsnKey, input.dedicatedUrl);
  if ((stage === 'all' || stage === 'copy' || stage === 'verify') && !dedicatedUrl) {
    const envKey = `TENANT_DB_URL_${normalizeTenantEnvKey(dsnKey)}`;
    throw new Error(`Не найден dedicated DSN. Передайте dedicatedUrl или env ${envKey}`);
  }

  const sharedClient = await input.sharedPool.connect();
  const dedicatedPool =
    dedicatedUrl && (stage === 'all' || stage === 'copy' || stage === 'verify')
      ? new Pool({ connectionString: dedicatedUrl })
      : null;
  const dedicatedClient = dedicatedPool ? await dedicatedPool.connect() : null;

  let copiedRows = 0;
  let verifiedRows = 0;
  let cutoverApplied = false;

  try {
    await ensureSharedSchema(sharedClient);
    await assertStoreExists(sharedClient, storeId);
    await sharedClient.query(
      `
        INSERT INTO tenant_db_routing (store_id, mode)
        VALUES ($1, 'shared')
        ON CONFLICT (store_id) DO NOTHING
      `,
      [storeId]
    );

    if (stage === 'all' || stage === 'copy' || stage === 'verify') {
      if (!dedicatedClient) throw new Error('Dedicated connection is required for copy/verify');
      await ensureDedicatedSchema(dedicatedClient);
    }

    if (dryRun) {
      return {
        storeId,
        dsnKey,
        stage,
        dryRun: true,
        dedicatedUrlSet: Boolean(dedicatedUrl),
        copiedRows: 0,
        verifiedRows: 0,
        cutoverApplied: false
      };
    }

    if (stage === 'all' || stage === 'copy') {
      if (!dedicatedClient) throw new Error('Dedicated connection is required for copy');
      await dedicatedClient.query('BEGIN');
      copiedRows = await copyProducts(sharedClient, dedicatedClient, storeId);
      await dedicatedClient.query('COMMIT');
    }

    if (stage === 'all' || stage === 'verify') {
      if (!dedicatedClient) throw new Error('Dedicated connection is required for verify');
      verifiedRows = await verifyProducts(sharedClient, dedicatedClient, storeId);
    }

    if (stage === 'all' || stage === 'cutover') {
      await sharedClient.query('BEGIN');
      await cutover(sharedClient, storeId, dsnKey, dedicatedUrl);
      await sharedClient.query('COMMIT');
      cutoverApplied = true;
      await input.onCutover?.();
    }

    return {
      storeId,
      dsnKey,
      stage,
      dryRun: false,
      dedicatedUrlSet: Boolean(dedicatedUrl),
      copiedRows,
      verifiedRows,
      cutoverApplied
    };
  } catch (error) {
    try {
      await sharedClient.query('ROLLBACK');
    } catch {}
    if (dedicatedClient) {
      try {
        await dedicatedClient.query('ROLLBACK');
      } catch {}
    }
    throw error;
  } finally {
    sharedClient.release();
    dedicatedClient?.release();
    await Promise.all([dedicatedPool?.end()]);
  }
}
