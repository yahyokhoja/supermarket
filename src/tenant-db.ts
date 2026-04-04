import { Pool } from 'pg';

export type TenantDbMode = 'shared' | 'dedicated';

type RoutingRow = {
  mode: TenantDbMode;
  dsn_key: string | null;
  dedicated_database_url: string | null;
};

type CacheEntry = {
  expiresAt: number;
  row: RoutingRow;
};

type ResolveStorePoolResult = {
  mode: TenantDbMode;
  dsnKey: string | null;
  pool: Pool;
};

function normalizeMode(value: unknown): TenantDbMode {
  return String(value || '').trim().toLowerCase() === 'dedicated' ? 'dedicated' : 'shared';
}

export class TenantDbResolver {
  private readonly sharedPool: Pool;
  private readonly cacheTtlMs: number;
  private readonly rowCache = new Map<number, CacheEntry>();
  private readonly dedicatedPools = new Map<string, Pool>();

  constructor(sharedPool: Pool, opts?: { cacheTtlMs?: number }) {
    this.sharedPool = sharedPool;
    this.cacheTtlMs = Math.max(500, Number(opts?.cacheTtlMs || 30_000));
  }

  async ensureStoreRouting(storeId: number) {
    await this.sharedPool.query(
      `
        INSERT INTO tenant_db_routing (store_id, mode)
        VALUES ($1, 'shared')
        ON CONFLICT (store_id) DO NOTHING
      `,
      [storeId]
    );
    this.rowCache.delete(storeId);
  }

  async resolveStorePool(storeId: number): Promise<ResolveStorePoolResult> {
    const row = await this.getRoutingRow(storeId);
    if (row.mode !== 'dedicated') {
      return { mode: 'shared', dsnKey: null, pool: this.sharedPool };
    }

    const dsnKey = String(row.dsn_key || '').trim();
    if (!dsnKey) {
      throw new Error(`Для store_id=${storeId} режим dedicated включен, но dsn_key не задан`);
    }

    const connectionString = this.resolveDedicatedConnectionString(dsnKey, row.dedicated_database_url);
    if (!connectionString) {
      throw new Error(
        `Для store_id=${storeId} не найден DSN. Укажите dedicated_database_url или env TENANT_DB_URL_${this.normalizeEnvKey(
          dsnKey
        )}`
      );
    }

    const existingPool = this.dedicatedPools.get(dsnKey);
    if (existingPool) {
      return { mode: 'dedicated', dsnKey, pool: existingPool };
    }

    const pool = new Pool({ connectionString });
    this.dedicatedPools.set(dsnKey, pool);
    return { mode: 'dedicated', dsnKey, pool };
  }

  invalidate(storeId?: number) {
    if (typeof storeId === 'number' && Number.isFinite(storeId) && storeId > 0) {
      this.rowCache.delete(Math.floor(storeId));
      return;
    }
    this.rowCache.clear();
  }

  async close() {
    const pools = Array.from(this.dedicatedPools.values());
    this.dedicatedPools.clear();
    await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  }

  private async getRoutingRow(storeId: number): Promise<RoutingRow> {
    const safeStoreId = Math.floor(Number(storeId));
    if (!Number.isFinite(safeStoreId) || safeStoreId <= 0) {
      return { mode: 'shared', dsn_key: null, dedicated_database_url: null };
    }

    const now = Date.now();
    const cached = this.rowCache.get(safeStoreId);
    if (cached && cached.expiresAt > now) return cached.row;

    const row = (
      await this.sharedPool.query(
        `
          SELECT mode, dsn_key, dedicated_database_url
          FROM tenant_db_routing
          WHERE store_id = $1
          LIMIT 1
        `,
        [safeStoreId]
      )
    ).rows[0];

    const normalized: RoutingRow = row
      ? {
          mode: normalizeMode(row.mode),
          dsn_key: row.dsn_key ?? null,
          dedicated_database_url: row.dedicated_database_url ?? null
        }
      : { mode: 'shared', dsn_key: null, dedicated_database_url: null };

    this.rowCache.set(safeStoreId, { row: normalized, expiresAt: now + this.cacheTtlMs });
    return normalized;
  }

  private resolveDedicatedConnectionString(dsnKey: string, explicitUrl: string | null) {
    const fromRow = String(explicitUrl || '').trim();
    if (fromRow) return fromRow;
    const envKey = `TENANT_DB_URL_${this.normalizeEnvKey(dsnKey)}`;
    return String(process.env[envKey] || '').trim() || null;
  }

  private normalizeEnvKey(value: string) {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
  }
}
