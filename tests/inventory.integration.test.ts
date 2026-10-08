import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { connectDb, initDb } from '../src/db';
import {
  executeInventoryOperation,
  postSingleStockOperation,
  recordOrderReservation
} from '../src/inventory-service';
import { runMigrations } from '../src/migrations';
import {
  cancelInventoryDocument,
  createInventoryDraft,
  postInventoryDocument,
  updateInventoryDraft
} from '../src/inventory-documents';
import { releaseManualReservation } from '../src/inventory-service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');

const jwtSecret = 'stage1-integration-test-secret';
process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET = jwtSecret;
process.env.PAYMENT_WEBHOOK_SECRET = 'stage1-payment-test-secret';
process.env.VERIFICATION_CODE_SECRET = 'stage1-verification-test-secret';
process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.MAP_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';

let pool: Pool;
let server: http.Server;
let baseUrl = '';
let adminId = 0;
let customerId = 0;
let warehouseId = 0;
let productId = 0;

function token(userId: number, email: string, role: 'owner' | 'admin' | 'customer' | 'picker') {
  return jwt.sign({ id: userId, email, role, sessionVersion: 0 }, jwtSecret, { expiresIn: '1h' });
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function resetFixture(quantity = 1) {
  await pool.query(`
    TRUNCATE TABLE
      integration_inbox, integration_outbox, harid24_product_links, harid24_connections,
      inventory_reversal_links, inventory_document_lines, inventory_documents, warehouse_stock_costs, suppliers,
      inventory_reservations, inventory_operation_lines, inventory_operations,
      notifications, payment_transactions, pick_task_items, pick_tasks,
      stock_movements, warehouse_stock, order_events, order_items, orders,
      cart_items, couriers, merchant_store_courier_links, merchant_products,
      tenant_db_routing, merchant_stores, products, product_categories,
      warehouses, users, business_stores, companies
    RESTART IDENTITY CASCADE
  `);
  const admin = (
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, permissions) VALUES ('Test Owner', 'admin@universal.local', 'x', 'owner', ARRAY['manage_warehouse','manage_orders','manage_products']) RETURNING id`
    )
  ).rows[0];
  const customer = (
    await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role) VALUES ('Test Customer', 'customer@test.local', 'x', 'customer') RETURNING id`
    )
  ).rows[0];
  adminId = Number(admin.id);
  customerId = Number(customer.id);
  warehouseId = Number(
    (
      await pool.query(
        `INSERT INTO warehouses (code, name, created_by_admin_id) VALUES ('TEST', 'Test warehouse', $1) RETURNING id`,
        [adminId]
      )
    ).rows[0].id
  );
  productId = Number(
    (
      await pool.query(
        `INSERT INTO products (name, price, stock_quantity, home_warehouse_id) VALUES ('Test product', 10, $1, $2) RETURNING id`,
        [quantity, warehouseId]
      )
    ).rows[0].id
  );
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, reserved_quantity) VALUES ($1, $2, $3, 0)`,
    [warehouseId, productId, quantity]
  );
}

async function createReservedOrder(label: string) {
  const orderId = Number(
    (
      await pool.query(
        `INSERT INTO orders (user_id, status, total, delivery_address) VALUES ($1, 'assembling', 10, $2) RETURNING id`,
        [customerId, `${label}, Test street, дом 1`]
      )
    ).rows[0].id
  );
  await pool.query(
    `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES ($1, $2, 'Test product', 1, 10)`,
    [orderId, productId]
  );
  const taskId = Number(
    (
      await pool.query(
        `INSERT INTO pick_tasks (order_id, warehouse_id, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orderId, warehouseId, adminId]
      )
    ).rows[0].id
  );
  await pool.query(
    `INSERT INTO pick_task_items (pick_task_id, product_id, product_name, requested_qty) VALUES ($1, $2, 'Test product', 1)`,
    [taskId, productId]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await recordOrderReservation(client, {
      orderId,
      taskId,
      warehouseId,
      createdBy: adminId,
      items: [{ productId, productName: 'Test product', quantity: 1 }]
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { orderId, taskId };
}

before(async () => {
  pool = connectDb(testDatabaseUrl);
  await initDb(pool);
  await runMigrations(pool);
  const { default: app } = await import('../src/server');
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => resetFixture());

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});

test('two concurrent reservations cannot sell the last unit', async () => {
  const pairs: Array<{ orderId: number; taskId: number }> = [];
  for (const label of ['First', 'Second']) {
    const orderId = Number((await pool.query(`INSERT INTO orders (user_id, status, total, delivery_address) VALUES ($1, 'assembling', 10, $2) RETURNING id`, [customerId, `${label}, Test street, дом 1`])).rows[0].id);
    await pool.query(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price) VALUES ($1, $2, 'Test product', 1, 10)`, [orderId, productId]);
    const taskId = Number((await pool.query(`INSERT INTO pick_tasks (order_id, warehouse_id, created_by) VALUES ($1, $2, $3) RETURNING id`, [orderId, warehouseId, adminId])).rows[0].id);
    await pool.query(`INSERT INTO pick_task_items (pick_task_id, product_id, product_name, requested_qty) VALUES ($1, $2, 'Test product', 1)`, [taskId, productId]);
    pairs.push({ orderId, taskId });
  }
  const attempts = await Promise.allSettled(
    pairs.map(async ({ orderId, taskId }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await recordOrderReservation(client, {
          orderId, taskId, warehouseId, createdBy: adminId,
          items: [{ productId, productName: 'Test product', quantity: 1 }]
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    })
  );
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
  const stock = (await pool.query('SELECT quantity, reserved_quantity FROM warehouse_stock')).rows[0];
  assert.equal(Number(stock.quantity), 1);
  assert.equal(Number(stock.reserved_quantity), 1);
});

test('legacy customer cancellation route is disabled and cannot mutate reservations', async () => {
  const { orderId } = await createReservedOrder('Cancel');
  const auth = token(customerId, 'customer@test.local', 'customer');
  const first = await request(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' })
  });
  assert.equal(first.response.status, 410);
  const second = await request(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' })
  });
  assert.equal(second.response.status, 410);
  const stock = (await pool.query('SELECT reserved_quantity FROM warehouse_stock')).rows[0];
  assert.equal(Number(stock.reserved_quantity), 1);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM inventory_operations WHERE operation_type = 'order_release'")).rows[0].count), 0);
});

test('disabled delivery cancellation cannot race the protected picking API', async () => {
  const { orderId, taskId } = await createReservedOrder('Race');
  const customerAuth = token(customerId, 'customer@test.local', 'customer');
  const adminAuth = token(adminId, 'admin@universal.local', 'owner');
  const [cancel, complete] = await Promise.all([
    request(`/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${customerAuth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' })
    }),
    request(`/api/admin/pick-tasks/${taskId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' })
    })
  ]);
  assert.equal(cancel.response.status,410);
  assert.ok([200,400,409].includes(complete.response.status));
  const stock = (await pool.query('SELECT quantity, reserved_quantity FROM warehouse_stock')).rows[0];
  assert.equal(Number(stock.reserved_quantity), 0);
  assert.ok([0, 1].includes(Number(stock.quantity)));
  const active = Number((await pool.query("SELECT COUNT(*) AS count FROM inventory_reservations WHERE status = 'active'")).rows[0].count);
  assert.equal(active, 0);
});

test('legacy customer order deletion and mutation routes are read-only disabled', async () => {
  const { orderId } = await createReservedOrder('Archive');
  const auth = token(customerId, 'customer@test.local', 'customer');
  const activeDelete = await request(`/api/orders/${orderId}`, { method: 'DELETE', headers: { authorization: `Bearer ${auth}` } });
  assert.equal(activeDelete.response.status, 410);
  await request(`/api/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'cancelled' })
  });
  const archived = await request(`/api/orders/${orderId}`, { method: 'DELETE', headers: { authorization: `Bearer ${auth}` } });
  assert.equal(archived.response.status, 410);
  const row = (await pool.query('SELECT archived_at FROM orders WHERE id = $1', [orderId])).rows[0];
  assert.equal(row?.archived_at,null);
});

test('editing product cannot change inventory', async () => {
  const auth = token(adminId, 'admin@universal.local', 'owner');
  const result = await request(`/api/admin/products/${productId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ stockQuantity: 99 })
  });
  assert.equal(result.response.status, 400);
  const stock = (await pool.query('SELECT quantity FROM warehouse_stock')).rows[0];
  assert.equal(Number(stock.quantity), 1);
});

test('legacy direct receipt API is disabled so clients cannot bypass documents', async () => {
  const auth = token(adminId, 'admin@universal.local', 'admin');
  const headers = { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'x-idempotency-key': 'receipt-concurrent-0001' };
  const body = JSON.stringify({ warehouseId, productId, quantity: 2, reason: 'test receipt' });
  const [a, b] = await Promise.all([
    request('/api/admin/stock/receive', { method: 'POST', headers, body }),
    request('/api/admin/stock/receive', { method: 'POST', headers, body })
  ]);
  assert.equal(a.response.status, 410);
  assert.equal(b.response.status, 410);
  const stock = (await pool.query('SELECT quantity FROM warehouse_stock')).rows[0];
  assert.equal(Number(stock.quantity), 1);
});

test('same key with different payload conflicts; writeoff retry posts once', async () => {
  await postSingleStockOperation(pool, {
    operationType: 'writeoff', idempotencyKey: 'writeoff-repeat-0001', payload: { warehouseId, productId, quantity: 1 },
    warehouseId, productId, quantity: 1, createdBy: adminId
  });
  const reused = await postSingleStockOperation(pool, {
    operationType: 'writeoff', idempotencyKey: 'writeoff-repeat-0001', payload: { warehouseId, productId, quantity: 1 },
    warehouseId, productId, quantity: 1, createdBy: adminId
  });
  assert.equal(reused.reused, true);
  await assert.rejects(
    postSingleStockOperation(pool, {
      operationType: 'writeoff', idempotencyKey: 'writeoff-repeat-0001', payload: { warehouseId, productId, quantity: 2 },
      warehouseId, productId, quantity: 2, createdBy: adminId
    }),
    /другим содержимым/
  );
  assert.equal(Number((await pool.query('SELECT quantity FROM warehouse_stock')).rows[0].quantity), 0);
});

test('operation failure rolls back stock, lines, and operation header', async () => {
  await assert.rejects(
    executeInventoryOperation(
      pool,
      { operationType: 'receive', idempotencyKey: 'rollback-operation-0001', payload: { productId } },
      async (client) => {
        await client.query('UPDATE warehouse_stock SET quantity = quantity + 5 WHERE warehouse_id = $1 AND product_id = $2', [warehouseId, productId]);
        throw new Error('forced failure');
      }
    ),
    /forced failure/
  );
  assert.equal(Number((await pool.query('SELECT quantity FROM warehouse_stock')).rows[0].quantity), 1);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM inventory_operations WHERE idempotency_key = 'rollback-operation-0001'")).rows[0].count), 0);
});

test('database constraint rejects duplicate picking task for an order', async () => {
  const { orderId } = await createReservedOrder('Duplicate');
  await assert.rejects(
    pool.query(`INSERT INTO pick_tasks (order_id, warehouse_id, created_by) VALUES ($1, $2, $3)`, [orderId, warehouseId, adminId]),
    (error: any) => error?.code === '23505'
  );
});

test('customer has no server permission for inventory operation', async () => {
  const auth = token(customerId, 'customer@test.local', 'customer');
  const result = await request('/api/admin/stock/receive', {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', 'x-idempotency-key': 'forbidden-receipt-0001' },
    body: JSON.stringify({ warehouseId, productId, quantity: 1 })
  });
  assert.equal(result.response.status, 403);
  assert.equal(Number((await pool.query('SELECT quantity FROM warehouse_stock')).rows[0].quantity), 1);
});

async function supplier() {
  return Number((await pool.query(`INSERT INTO suppliers(name,created_by) VALUES('Test supplier',$1) RETURNING id`,[adminId])).rows[0].id);
}

test('document receipts calculate moving weighted average exactly and retry posts once', async () => {
  await resetFixture(0);
  const supplierId=await supplier();
  const first=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'10',unitCost:'20'}]},adminId);
  const [a,b]=await Promise.all([postInventoryDocument(pool,first.id,'receipt-post-0001',adminId),postInventoryDocument(pool,first.id,'receipt-post-0001',adminId)]);
  assert.equal([a.reused,b.reused].filter(Boolean).length,1);
  const second=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'10',unitCost:'30'}]},adminId);
  await postInventoryDocument(pool,second.id,'receipt-post-0002',adminId);
  const row=(await pool.query(`SELECT ws.quantity::text,c.inventory_value::text,(c.inventory_value/ws.quantity)::text avg FROM warehouse_stock ws JOIN warehouse_stock_costs c USING(warehouse_id,product_id)`)).rows[0];
  assert.equal(Number(row.quantity),20);assert.equal(Number(row.inventory_value),500);assert.equal(Number(row.avg),25);
  assert.equal(Number((await pool.query(`SELECT count(*) n FROM stock_movements WHERE document_id=$1`,[first.id])).rows[0].n),1);
});

test('draft has no movements, optimistic version is enforced, and same key with different content conflicts', async()=>{
  await resetFixture(0);const supplierId=await supplier();const input={documentType:'receipt' as const,accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'2',unitCost:'5'}]};
  const draft=await createInventoryDraft(pool,input,adminId);assert.equal(Number((await pool.query(`SELECT count(*) n FROM stock_movements`)).rows[0].n),0);
  await updateInventoryDraft(pool,draft.id,1,{...input,comment:'v2'},adminId);
  await assert.rejects(updateInventoryDraft(pool,draft.id,1,{...input,comment:'stale'},adminId),/другим пользователем/);
  await postInventoryDocument(pool,draft.id,'document-key-0001',adminId);
  await assert.rejects(postInventoryDocument(pool,draft.id,'document-key-0002',adminId),/другим ключом/);
});

test('transfer is atomic, preserves total value and cannot spend reserved stock',async()=>{
  await resetFixture(0);const supplierId=await supplier();const receipt=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'10',unitCost:'7.25'}]},adminId);await postInventoryDocument(pool,receipt.id,'transfer-seed-0001',adminId);
  const secondWarehouse=Number((await pool.query(`INSERT INTO warehouses(code,name,created_by_admin_id) VALUES('SECOND','Second',$1) RETURNING id`,[adminId])).rows[0].id);
  await postSingleStockOperation(pool,{operationType:'manual_reserve',idempotencyKey:'transfer-reserve-0001',payload:{warehouseId,productId,quantity:3},warehouseId,productId,quantity:3,createdBy:adminId});
  const blocked=await createInventoryDraft(pool,{documentType:'transfer',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,destinationWarehouseId:secondWarehouse,lines:[{productId,quantity:'8'}]},adminId);
  await assert.rejects(postInventoryDocument(pool,blocked.id,'transfer-block-0001',adminId),/Недостаточно свободного/);
  const transfer=await createInventoryDraft(pool,{documentType:'transfer',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,destinationWarehouseId:secondWarehouse,lines:[{productId,quantity:'7'}]},adminId);await postInventoryDocument(pool,transfer.id,'transfer-post-0001',adminId);
  const total=(await pool.query(`SELECT sum(quantity)::text qty,sum(inventory_value)::text value FROM warehouse_stock JOIN warehouse_stock_costs USING(warehouse_id,product_id) WHERE product_id=$1`,[productId])).rows[0];assert.equal(Number(total.qty),10);assert.equal(Number(total.value),72.5);
});

test('manual reservation supports partial, repeated and full release without changing physical stock',async()=>{
  await resetFixture(10);const reserve=await postSingleStockOperation(pool,{operationType:'manual_reserve',idempotencyKey:'manual-reserve-0001',payload:{warehouseId,productId,quantity:5},warehouseId,productId,quantity:5,reason:'Проверка',createdBy:adminId});
  const id=Number((await pool.query(`SELECT id FROM inventory_reservations WHERE operation_id=$1`,[reserve.operationId])).rows[0].id);
  const first=await releaseManualReservation(pool,{reservationId:id,quantity:'2',reason:'Частичное снятие',idempotencyKey:'manual-release-0001',createdBy:adminId});const retry=await releaseManualReservation(pool,{reservationId:id,quantity:'2',reason:'Частичное снятие',idempotencyKey:'manual-release-0001',createdBy:adminId});assert.equal(retry.reused,true);
  await releaseManualReservation(pool,{reservationId:id,quantity:'3',reason:'Полное снятие',idempotencyKey:'manual-release-0002',createdBy:adminId});
  const row=(await pool.query(`SELECT ws.quantity,ws.reserved_quantity,r.status FROM warehouse_stock ws JOIN inventory_reservations r ON r.warehouse_id=ws.warehouse_id AND r.product_id=ws.product_id WHERE r.id=$1`,[id])).rows[0];assert.equal(Number(row.quantity),10);assert.equal(Number(row.reserved_quantity),0);assert.equal(row.status,'released');assert.ok(first.operationId);
});

test('stocktake applies surplus and rejects stale snapshot and actual below reserve',async()=>{
  await resetFixture(0);const opening=await createInventoryDraft(pool,{documentType:'opening_balance',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,openingMode:'add_empty',lines:[{productId,quantity:'5',unitCost:'4'}]},adminId);await postInventoryDocument(pool,opening.id,'opening-add-0001',adminId);
  const stocktake=await createInventoryDraft(pool,{documentType:'stocktake',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,lines:[{productId,actualQuantity:'7',unitCost:'4'}]},adminId);await postInventoryDocument(pool,stocktake.id,'stocktake-post-0001',adminId);assert.equal(Number((await pool.query(`SELECT quantity FROM warehouse_stock`)).rows[0].quantity),7);
  const stale=await createInventoryDraft(pool,{documentType:'stocktake',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,lines:[{productId,actualQuantity:'6'}]},adminId);const supplierId=await supplier();const receipt=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'1',unitCost:'4'}]},adminId);await postInventoryDocument(pool,receipt.id,'stale-change-0001',adminId);await assert.rejects(postInventoryDocument(pool,stale.id,'stale-stocktake-0001',adminId),/изменился после снимка/);
  await postSingleStockOperation(pool,{operationType:'manual_reserve',idempotencyKey:'stocktake-reserve-0001',payload:{warehouseId,productId,quantity:3},warehouseId,productId,quantity:3,createdBy:adminId});const below=await createInventoryDraft(pool,{documentType:'stocktake',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,lines:[{productId,actualQuantity:'2'}]},adminId);await assert.rejects(postInventoryDocument(pool,below.id,'below-reserve-0001',adminId),/ниже активного резерва/);
});

test('opening balance establish does not double quantity, unknown cost blocks writeoff, and reversal is linked',async()=>{
  await resetFixture(5);const establish=await createInventoryDraft(pool,{documentType:'opening_balance',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,openingMode:'establish',lines:[{productId,quantity:'5'}]},adminId);await postInventoryDocument(pool,establish.id,'opening-establish-0001',adminId);assert.equal(Number((await pool.query(`SELECT quantity FROM warehouse_stock`)).rows[0].quantity),5);
  const writeoff=await createInventoryDraft(pool,{documentType:'writeoff',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,reason:'Порча',lines:[{productId,quantity:'1'}]},adminId);await assert.rejects(postInventoryDocument(pool,writeoff.id,'unknown-writeoff-0001',adminId),/Неизвестна себестоимость/);
  const valued=await createInventoryDraft(pool,{documentType:'opening_balance',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,openingMode:'establish',lines:[{productId,quantity:'5',unitCost:'2'}]},adminId);await postInventoryDocument(pool,valued.id,'opening-valued-0001',adminId);const result=await cancelInventoryDocument(pool,valued.id,'reverse-opening-0001',adminId);assert.ok(result.reversalDocumentId);assert.equal(Number((await pool.query(`SELECT count(*) n FROM inventory_reversal_links`)).rows[0].n),1);
});

test('fractional quantity follows product step and PostgreSQL value precision',async()=>{
  await resetFixture(0);await pool.query(`UPDATE products SET quantity_precision=3,quantity_step=0.001 WHERE id=$1`,[productId]);const supplierId=await supplier();
  const draft=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'0.125',unitCost:'0.33333333'}]},adminId);await postInventoryDocument(pool,draft.id,'fractional-post-0001',adminId);
  const row=(await pool.query(`SELECT ws.quantity::text,c.inventory_value::text FROM warehouse_stock ws JOIN warehouse_stock_costs c USING(warehouse_id,product_id)`)).rows[0];assert.equal(row.quantity,'0.125000');assert.equal(row.inventory_value,'0.04166667');
  await assert.rejects(createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'0.0005',unitCost:'1'}]},adminId),/не кратно шагу/);
});

test('transfer endpoint requires access to both warehouses',async()=>{
  await resetFixture(1);const second=Number((await pool.query(`INSERT INTO warehouses(code,name,created_by_admin_id) VALUES('NOACCESS','No access',$1) RETURNING id`,[adminId])).rows[0].id);const scoped=Number((await pool.query(`INSERT INTO users(full_name,email,password_hash,role,permissions,warehouse_scopes) VALUES('Scoped','scoped@test.local','x','admin',ARRAY['manage_warehouse'],ARRAY[$1]::bigint[]) RETURNING id`,[warehouseId])).rows[0].id);
  const auth=token(scoped,'scoped@test.local','admin');const result=await request('/api/admin/inventory/documents',{method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify({documentType:'transfer',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,destinationWarehouseId:second,lines:[{productId,quantity:'1'}]})});assert.equal(result.response.status,403);assert.equal(Number((await pool.query(`SELECT count(*) n FROM inventory_documents`)).rows[0].n),0);
});

test('multi-line posting failure rolls back earlier line and operation header',async()=>{
  await resetFixture(0);const secondProduct=Number((await pool.query(`INSERT INTO products(name,price,stock_quantity,home_warehouse_id) VALUES('Unknown valued',1,1,$1) RETURNING id`,[warehouseId])).rows[0].id);await pool.query(`INSERT INTO warehouse_stock(warehouse_id,product_id,quantity,reserved_quantity) VALUES($1,$2,1,0)`,[warehouseId,secondProduct]);const supplierId=await supplier();
  const draft=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'2',unitCost:'3'},{productId:secondProduct,quantity:'1',unitCost:'4'}]},adminId);
  await assert.rejects(postInventoryDocument(pool,draft.id,'rollback-document-0001',adminId),/неизвестна стоимость существующего остатка/);
  assert.equal(Number((await pool.query(`SELECT quantity FROM warehouse_stock WHERE product_id=$1`,[productId])).rows[0].quantity),0);assert.equal(Number((await pool.query(`SELECT count(*) n FROM inventory_operations WHERE idempotency_key LIKE 'document:%rollback-document-0001'`)).rows[0].n),0);
});

test('stocktake shortage reduces quantity and value at current average',async()=>{
  await resetFixture(0);const opening=await createInventoryDraft(pool,{documentType:'opening_balance',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,openingMode:'add_empty',lines:[{productId,quantity:'5',unitCost:'4'}]},adminId);await postInventoryDocument(pool,opening.id,'shortage-open-0001',adminId);
  const count=await createInventoryDraft(pool,{documentType:'stocktake',accountingDate:'2026-10-04',sourceWarehouseId:warehouseId,lines:[{productId,actualQuantity:'3'}]},adminId);await postInventoryDocument(pool,count.id,'shortage-post-0001',adminId);
  const row=(await pool.query(`SELECT ws.quantity,c.inventory_value FROM warehouse_stock ws JOIN warehouse_stock_costs c USING(warehouse_id,product_id)`)).rows[0];assert.equal(Number(row.quantity),3);assert.equal(Number(row.inventory_value),12);
});

test('reversal is blocked after a later dependent physical movement',async()=>{
  await resetFixture(0);const supplierId=await supplier();const first=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'2',unitCost:'5'}]},adminId);await postInventoryDocument(pool,first.id,'dependent-first-0001',adminId);const second=await createInventoryDraft(pool,{documentType:'receipt',accountingDate:'2026-10-04',destinationWarehouseId:warehouseId,supplierId,lines:[{productId,quantity:'1',unitCost:'5'}]},adminId);await postInventoryDocument(pool,second.id,'dependent-second-0001',adminId);
  await assert.rejects(cancelInventoryDocument(pool,first.id,'dependent-cancel-0001',adminId),/зависимые движения/);assert.equal((await pool.query(`SELECT status FROM inventory_documents WHERE id=$1`,[first.id])).rows[0].status,'posted');
});
