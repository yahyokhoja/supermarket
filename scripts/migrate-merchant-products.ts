import 'dotenv/config';
import { Pool } from 'pg';
import { migrateMerchantProducts, normalizeTenantEnvKey, type MerchantProductsMigrationStage } from '../src/merchant-product-migration';

type CliOptions = {
  storeId: number;
  dsnKey: string;
  dedicatedUrl: string | null;
  stage: MerchantProductsMigrationStage;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const getValue = (name: string) => {
    const withEq = argv.find((arg) => arg.startsWith(`--${name}=`));
    if (withEq) return withEq.slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    if (idx >= 0) return argv[idx + 1] || '';
    return '';
  };
  const hasFlag = (name: string) => argv.includes(`--${name}`);

  const storeId = Number(getValue('store-id'));
  const dsnKey = String(getValue('dsn-key')).trim();
  const stageRaw = String(getValue('stage') || 'all').trim().toLowerCase();
  const stage: MerchantProductsMigrationStage =
    stageRaw === 'copy' || stageRaw === 'verify' || stageRaw === 'cutover' ? stageRaw : 'all';
  const dedicatedUrlArg = String(getValue('dedicated-url')).trim();
  const dryRun = hasFlag('dry-run');

  if (!Number.isFinite(storeId) || storeId <= 0) throw new Error('Укажите корректный --store-id');
  if (!dsnKey) throw new Error('Укажите --dsn-key (например STORE_42)');

  const envKey = `TENANT_DB_URL_${normalizeTenantEnvKey(dsnKey)}`;
  const dedicatedUrl = dedicatedUrlArg || String(process.env[envKey] || '').trim() || null;
  if ((stage === 'all' || stage === 'copy' || stage === 'verify') && !dedicatedUrl) {
    throw new Error(`Не найден dedicated DSN. Передайте --dedicated-url или env ${envKey}`);
  }

  return { storeId: Math.floor(storeId), dsnKey, dedicatedUrl, stage, dryRun };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sharedUrl = String(process.env.DATABASE_URL || '').trim();
  if (!sharedUrl) throw new Error('Не задан DATABASE_URL');

  const sharedPool = new Pool({ connectionString: sharedUrl });
  try {
    const result = await migrateMerchantProducts({
      sharedPool,
      storeId: opts.storeId,
      dsnKey: opts.dsnKey,
      dedicatedUrl: opts.dedicatedUrl,
      stage: opts.stage,
      dryRun: opts.dryRun
    });
    console.log('[migrate-merchant-products] result:', JSON.stringify(result, null, 2));
  } finally {
    await sharedPool.end();
  }
}

main().catch((error) => {
  console.error('[migrate-merchant-products] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
