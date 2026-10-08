import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http-error';

export type InventoryOperationType =
  | 'initial_balance'
  | 'receive'
  | 'writeoff'
  | 'manual_reserve'
  | 'order_reserve'
  | 'order_release'
  | 'pick_consume'
  | 'manual_release'
  | 'document_opening_balance'
  | 'document_receipt'
  | 'document_transfer'
  | 'document_writeoff'
  | 'document_stocktake'
  | 'document_reversal';

export type InventoryOperationLine = {
  warehouseId: number;
  productId: number;
  physicalDelta: number | string;
  reservedDelta: number | string;
  valueDelta?: string | null;
  stockVersionBefore?: number | null;
  stockVersionAfter?: number | null;
};

export type OperationIdentity = {
  operationType: InventoryOperationType;
  idempotencyKey: string;
  payload: unknown;
  referenceType?: string | null;
  referenceId?: number | null;
  createdBy?: number | null;
  companyId?: number | null;
  storeId?: number | null;
};

type OperationRecord = {
  operationId: string;
  reused: boolean;
  result: Record<string, unknown>;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

export function inventoryPayloadHash(operationType: InventoryOperationType, payload: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({ operationType, payload })))
    .digest('hex');
}

function assertIdempotencyKey(value: string) {
  const key = value.trim();
  if (key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'x-idempotency-key должен содержать от 8 до 200 символов');
  }
  return key;
}

export async function beginOperation(client: PoolClient, identity: OperationIdentity): Promise<OperationRecord> {
  const idempotencyKey = assertIdempotencyKey(identity.idempotencyKey);
  const payloadHash = inventoryPayloadHash(identity.operationType, identity.payload);
  const operationId = randomUUID();
  const inserted = await client.query(
    `
      INSERT INTO inventory_operations (
        id, operation_type, status, idempotency_key, payload_hash,
        reference_type, reference_id, company_id, store_id, created_by
      )
      VALUES ($1, $2, 'posted', $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id, result_json
    `,
    [
      operationId,
      identity.operationType,
      idempotencyKey,
      payloadHash,
      identity.referenceType ?? null,
      identity.referenceId ?? null,
      identity.companyId ?? null,
      identity.storeId ?? null,
      identity.createdBy ?? null
    ]
  );
  if (inserted.rows[0]) return { operationId, reused: false, result: {} };

  const existing = (
    await client.query(
      `SELECT id, payload_hash, result_json FROM inventory_operations WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    )
  ).rows[0];
  if (!existing) throw new HttpError(409, 'Не удалось получить существующую складскую операцию');
  if (String(existing.payload_hash) !== payloadHash) {
    throw new HttpError(409, 'x-idempotency-key уже использован с другим содержимым');
  }
  return {
    operationId: String(existing.id),
    reused: true,
    result: existing.result_json && typeof existing.result_json === 'object' ? existing.result_json : {}
  };
}

export async function finishOperation(client: PoolClient, operationId: string, result: Record<string, unknown>) {
  await client.query('UPDATE inventory_operations SET result_json = $1::jsonb WHERE id = $2', [JSON.stringify(result), operationId]);
}

export async function recordLines(client: PoolClient, operationId: string, lines: InventoryOperationLine[]) {
  for (const line of lines) {
    await client.query(
      `
        INSERT INTO inventory_operation_lines (
          operation_id, warehouse_id, product_id, physical_delta, reserved_delta,
          value_delta, stock_version_before, stock_version_after
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [operationId, line.warehouseId, line.productId, line.physicalDelta, line.reservedDelta,
        line.valueDelta ?? null, line.stockVersionBefore ?? null, line.stockVersionAfter ?? null]
    );
  }
}

export async function ensureWarehouseStockRow(client: PoolClient, warehouseId: number, productId: number) {
  await client.query(
    `
      INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, reserved_quantity, reorder_min, reorder_target)
      VALUES ($1, $2, 0, 0, 5, 20)
      ON CONFLICT (warehouse_id, product_id) DO NOTHING
    `,
    [warehouseId, productId]
  );
}

export async function lockStockRows(client: PoolClient, keys: Array<{ warehouseId: number; productId: number }>) {
  const unique = Array.from(new Map(keys.map((key) => [`${key.warehouseId}:${key.productId}`, key])).values()).sort(
    (a, b) => a.warehouseId - b.warehouseId || a.productId - b.productId
  );
  for (const key of unique) await ensureWarehouseStockRow(client, key.warehouseId, key.productId);
  const locked = new Map<string, { quantity: number; reservedQuantity: number }>();
  for (const key of unique) {
    const row = (
      await client.query(
        `SELECT quantity, reserved_quantity FROM warehouse_stock WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE`,
        [key.warehouseId, key.productId]
      )
    ).rows[0];
    locked.set(`${key.warehouseId}:${key.productId}`, {
      quantity: Number(row.quantity),
      reservedQuantity: Number(row.reserved_quantity)
    });
  }
  return locked;
}

export async function syncProductAvailability(client: PoolClient, productId: number) {
  const row = (
    await client.query(
      `
        SELECT COALESCE(SUM(quantity - reserved_quantity), 0)::text AS available
        FROM warehouse_stock WHERE product_id = $1
      `,
      [productId]
    )
  ).rows[0];
  const available = String(row?.available || '0');
  await client.query(
    `UPDATE products SET stock_quantity = GREATEST($1::numeric, 0), in_stock = CASE WHEN $1::numeric <= 0 THEN FALSE ELSE in_stock END WHERE id = $2`,
    [available, productId]
  );
}

export async function emitStockOutbox(client: PoolClient, operationId: string, lines: InventoryOperationLine[]) {
  const scoped = await client.query(
    `
      SELECT DISTINCT c.id AS connection_id
      FROM harid24_connections c
      WHERE c.status = 'active'
        AND EXISTS (
          SELECT 1 FROM inventory_operations io
          WHERE io.id = $1 AND io.company_id = c.company_id AND io.store_id = c.store_id
        )
    `,
    [operationId]
  );
  for (const row of scoped.rows) {
    await client.query(
      `
        INSERT INTO integration_outbox (
          id, connection_id, event_type, aggregate_type, aggregate_id, payload
        ) VALUES ($1, $2, 'inventory.changed', 'inventory_operation', $3, $4::jsonb)
      `,
      [randomUUID(), Number(row.connection_id), operationId, JSON.stringify({ operationId, lines })]
    );
  }
}

export async function executeInventoryOperation(
  pool: Pool,
  identity: OperationIdentity,
  mutate: (client: PoolClient, operationId: string) => Promise<{ lines: InventoryOperationLine[]; result: Record<string, unknown> }>
): Promise<OperationRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const operation = await executeInventoryOperationInTransaction(client, identity, mutate);
    await client.query('COMMIT');
    return operation;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function executeInventoryOperationInTransaction(
  client: PoolClient,
  identity: OperationIdentity,
  mutate: (client: PoolClient, operationId: string) => Promise<{ lines: InventoryOperationLine[]; result: Record<string, unknown> }>
): Promise<OperationRecord> {
  const operation = await beginOperation(client, identity);
  if (operation.reused) return operation;
  const outcome = await mutate(client, operation.operationId);
  await recordLines(client, operation.operationId, outcome.lines);
  await emitStockOutbox(client, operation.operationId, outcome.lines);
  await finishOperation(client, operation.operationId, outcome.result);
  return { ...operation, result: outcome.result };
}

export async function releaseManualReservation(
  pool: Pool,
  input: { reservationId: number; quantity: string; reason: string; idempotencyKey: string; createdBy: number }
) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(input.quantity.trim())) {
    throw new HttpError(400, 'Количество снятия должно быть десятичным числом с точностью до 6 знаков');
  }
  return executeInventoryOperation(pool, {
    operationType: 'manual_release',
    idempotencyKey: input.idempotencyKey,
    payload: { reservationId: input.reservationId, quantity: input.quantity, reason: input.reason },
    referenceType: 'inventory_reservation',
    referenceId: input.reservationId,
    createdBy: input.createdBy
  }, async (client, operationId) => {
    const reservation = (await client.query(
      `SELECT r.id, r.warehouse_id, r.product_id, r.quantity, r.status, r.order_id, r.pick_task_id, p.quantity_step
       FROM inventory_reservations r JOIN products p ON p.id=r.product_id WHERE r.id = $1 FOR UPDATE OF r`, [input.reservationId]
    )).rows[0];
    if (!reservation) throw new HttpError(404, 'Резерв не найден');
    if (reservation.order_id !== null || reservation.pick_task_id !== null) {
      throw new HttpError(409, 'Резерв заказа снимается только через отмену заказа или задачи сборки');
    }
    if (reservation.status !== 'active') throw new HttpError(409, 'Закрытый или израсходованный резерв нельзя снять');
    const valid = (await client.query(
      `SELECT $1::numeric > 0 AND $1::numeric <= $2::numeric AND mod($1::numeric,$3::numeric)=0 AS ok`, [input.quantity, reservation.quantity, reservation.quantity_step]
    )).rows[0]?.ok;
    if (!valid) throw new HttpError(409, 'Количество снятия превышает активный резерв или некорректно');
    const warehouseId = Number(reservation.warehouse_id);
    const productId = Number(reservation.product_id);
    await ensureWarehouseStockRow(client, warehouseId, productId);
    const stock = (await client.query(
      `SELECT reserved_quantity FROM warehouse_stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,
      [warehouseId, productId]
    )).rows[0];
    const enough = (await client.query(`SELECT $1::numeric >= $2::numeric AS ok`, [stock.reserved_quantity, input.quantity])).rows[0]?.ok;
    if (!enough) throw new HttpError(409, 'Проекция резерва не согласована; требуется сверка');
    await client.query(
      `UPDATE warehouse_stock SET reserved_quantity=reserved_quantity-$1::numeric, updated_at=NOW()
       WHERE warehouse_id=$2 AND product_id=$3`, [input.quantity, warehouseId, productId]
    );
    await client.query(
      `UPDATE inventory_reservations
       SET quantity=quantity-$1::numeric,
           status=CASE WHEN quantity-$1::numeric=0 THEN 'released' ELSE 'active' END,
           closed_by_operation_id=CASE WHEN quantity-$1::numeric=0 THEN $2::uuid ELSE NULL END,
           closed_at=CASE WHEN quantity-$1::numeric=0 THEN NOW() ELSE NULL END,
           reason=$3
       WHERE id=$4`, [input.quantity, operationId, input.reason, input.reservationId]
    );
    await client.query(
      `INSERT INTO stock_movements
       (warehouse_id,product_id,movement_type,quantity,reason,reference_type,reference_id,created_by,operation_id)
       VALUES($1,$2,'release',$3::numeric,$4,'inventory_reservation',$5,$6,$7)`,
      [warehouseId, productId, input.quantity, input.reason, input.reservationId, input.createdBy, operationId]
    );
    await syncProductAvailability(client, productId);
    return {
      lines: [{ warehouseId, productId, physicalDelta: '0', reservedDelta: `-${input.quantity}` }],
      result: { reservationId: input.reservationId, releasedQuantity: input.quantity }
    };
  });
}

export async function postSingleStockOperation(
  pool: Pool,
  input: OperationIdentity & {
    warehouseId: number;
    productId: number;
    quantity: number;
    reason?: string | null;
  }
) {
  return executeInventoryOperation(pool, input, async (client, operationId) => {
    const stocks = await lockStockRows(client, [input]);
    const stock = stocks.get(`${input.warehouseId}:${input.productId}`)!;
    let physicalDelta = 0;
    let reservedDelta = 0;
    let movementType: string = input.operationType;
    if (input.operationType === 'receive' || input.operationType === 'initial_balance') {
      physicalDelta = input.quantity;
    } else if (input.operationType === 'writeoff') {
      if (stock.quantity - stock.reservedQuantity < input.quantity) {
        throw new HttpError(409, `Недостаточно свободного остатка. Доступно: ${stock.quantity - stock.reservedQuantity}`);
      }
      physicalDelta = -input.quantity;
    } else if (input.operationType === 'manual_reserve') {
      if (stock.quantity - stock.reservedQuantity < input.quantity) {
        throw new HttpError(409, `Недостаточно остатка для резерва. Доступно: ${stock.quantity - stock.reservedQuantity}`);
      }
      reservedDelta = input.quantity;
      movementType = 'reserve';
    } else {
      throw new HttpError(400, 'Неподдерживаемый тип одиночной складской операции');
    }

    await client.query(
      `
        UPDATE warehouse_stock
        SET quantity = quantity + $1, reserved_quantity = reserved_quantity + $2, updated_at = NOW()
        WHERE warehouse_id = $3 AND product_id = $4
      `,
      [physicalDelta, reservedDelta, input.warehouseId, input.productId]
    );
    await client.query(
      `
        INSERT INTO stock_movements (
          warehouse_id, product_id, movement_type, quantity, reason,
          reference_type, reference_id, created_by
        ) VALUES ($1, $2, $3, $4, $5, 'inventory_operation', NULL, $6)
      `,
      [input.warehouseId, input.productId, movementType, input.quantity, input.reason ?? null, input.createdBy ?? null]
    );
    if (input.operationType === 'manual_reserve') {
      await client.query(
        `
          INSERT INTO inventory_reservations (
            operation_id, warehouse_id, product_id, quantity, original_quantity, status, reason
          ) VALUES ($1, $2, $3, $4, $4, 'active', $5)
        `,
        [operationId, input.warehouseId, input.productId, input.quantity, input.reason ?? null]
      );
    }
    await syncProductAvailability(client, input.productId);
    return {
      lines: [{ warehouseId: input.warehouseId, productId: input.productId, physicalDelta, reservedDelta }],
      result: { message: 'Складская операция проведена' }
    };
  });
}

export async function recordOrderReservation(
  client: PoolClient,
  input: {
    orderId: number;
    taskId: number;
    warehouseId: number;
    createdBy: number;
    items: Array<{ productId: number; productName: string; quantity: number }>;
  }
) {
  const identity: OperationIdentity = {
    operationType: 'order_reserve',
    idempotencyKey: `order-reserve:${input.orderId}`,
    payload: input,
    referenceType: 'order',
    referenceId: input.orderId,
    createdBy: input.createdBy
  };
  const operation = await beginOperation(client, identity);
  if (operation.reused) return operation;
  const sorted = [...input.items].sort((a, b) => a.productId - b.productId);
  const stocks = await lockStockRows(
    client,
    sorted.map((item) => ({ warehouseId: input.warehouseId, productId: item.productId }))
  );
  const lines: InventoryOperationLine[] = [];
  for (const item of sorted) {
    const stock = stocks.get(`${input.warehouseId}:${item.productId}`)!;
    const available = stock.quantity - stock.reservedQuantity;
    if (available < item.quantity) {
      throw new HttpError(409, `Недостаточно остатка для товара "${item.productName}". Нужно: ${item.quantity}, доступно: ${available}`);
    }
    await client.query(
      `UPDATE warehouse_stock SET reserved_quantity = reserved_quantity + $1, updated_at = NOW() WHERE warehouse_id = $2 AND product_id = $3`,
      [item.quantity, input.warehouseId, item.productId]
    );
    await client.query(
      `
        INSERT INTO inventory_reservations (
          operation_id, warehouse_id, product_id, order_id, pick_task_id, quantity, original_quantity, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'active')
      `,
      [operation.operationId, input.warehouseId, item.productId, input.orderId, input.taskId, item.quantity]
    );
    await client.query(
      `
        INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
        VALUES ($1, $2, 'reserve', $3, $4, 'pick_task', $5, $6)
      `,
      [input.warehouseId, item.productId, item.quantity, `Резерв под задачу сборки #${input.taskId}`, input.taskId, input.createdBy]
    );
    await syncProductAvailability(client, item.productId);
    lines.push({ warehouseId: input.warehouseId, productId: item.productId, physicalDelta: 0, reservedDelta: item.quantity });
  }
  await recordLines(client, operation.operationId, lines);
  await emitStockOutbox(client, operation.operationId, lines);
  const result = { taskId: input.taskId };
  await finishOperation(client, operation.operationId, result);
  return { ...operation, result };
}

async function closeReservations(
  client: PoolClient,
  input: { orderId: number; taskId: number; createdBy: number; mode: 'release' | 'consume' }
) {
  const operationType = input.mode === 'release' ? 'order_release' : 'pick_consume';
  const identity: OperationIdentity = {
    operationType,
    idempotencyKey: `${operationType}:${input.taskId}`,
    payload: input,
    referenceType: 'pick_task',
    referenceId: input.taskId,
    createdBy: input.createdBy
  };
  const operation = await beginOperation(client, identity);
  if (operation.reused) return operation;
  const reservations = (
    await client.query(
      `
        SELECT id, warehouse_id, product_id, quantity
        FROM inventory_reservations
        WHERE pick_task_id = $1 AND order_id = $2 AND status = 'active'
        ORDER BY warehouse_id, product_id
        FOR UPDATE
      `,
      [input.taskId, input.orderId]
    )
  ).rows;
  if (!reservations.length) {
    const historical = await client.query('SELECT 1 FROM inventory_reservations WHERE pick_task_id = $1 LIMIT 1', [input.taskId]);
    if (!historical.rowCount) throw new HttpError(409, 'У задачи нет идентифицированного активного резерва; требуется ручная сверка');
  }
  const stocks = await lockStockRows(
    client,
    reservations.map((row) => ({ warehouseId: Number(row.warehouse_id), productId: Number(row.product_id) }))
  );
  const lines: InventoryOperationLine[] = [];
  for (const reservation of reservations) {
    const warehouseId = Number(reservation.warehouse_id);
    const productId = Number(reservation.product_id);
    const quantity = Number(reservation.quantity);
    const stock = stocks.get(`${warehouseId}:${productId}`)!;
    if (stock.reservedQuantity < quantity) throw new HttpError(409, `Резерв productId=${productId} не согласован; требуется сверка`);
    if (input.mode === 'consume' && stock.quantity < quantity) {
      throw new HttpError(409, `Недостаточно физического остатка productId=${productId}`);
    }
    const physicalDelta = input.mode === 'consume' ? -quantity : 0;
    await client.query(
      `
        UPDATE warehouse_stock
        SET quantity = quantity + $1, reserved_quantity = reserved_quantity - $2, updated_at = NOW()
        WHERE warehouse_id = $3 AND product_id = $4
      `,
      [physicalDelta, quantity, warehouseId, productId]
    );
    await client.query(
      `
        UPDATE inventory_reservations
        SET status = $1, closed_by_operation_id = $2, closed_at = NOW()
        WHERE id = $3 AND status = 'active'
      `,
      [input.mode === 'consume' ? 'consumed' : 'released', operation.operationId, Number(reservation.id)]
    );
    await client.query(
      `
        INSERT INTO stock_movements (warehouse_id, product_id, movement_type, quantity, reason, reference_type, reference_id, created_by)
        VALUES ($1, $2, $3, $4, $5, 'pick_task', $6, $7)
      `,
      [
        warehouseId,
        productId,
        input.mode === 'consume' ? 'pick' : 'release',
        quantity,
        input.mode === 'consume' ? `Списано по задаче сборки #${input.taskId}` : `Резерв снят по задаче #${input.taskId}`,
        input.taskId,
        input.createdBy
      ]
    );
    await syncProductAvailability(client, productId);
    lines.push({ warehouseId, productId, physicalDelta, reservedDelta: -quantity });
  }
  await recordLines(client, operation.operationId, lines);
  await emitStockOutbox(client, operation.operationId, lines);
  const result = { reservationCount: reservations.length };
  await finishOperation(client, operation.operationId, result);
  return { ...operation, result };
}

export async function releaseOrderReservations(client: PoolClient, orderId: number, taskId: number, createdBy: number) {
  return closeReservations(client, { orderId, taskId, createdBy, mode: 'release' });
}

export async function consumePickTaskReservations(client: PoolClient, orderId: number, taskId: number, createdBy: number) {
  return closeReservations(client, { orderId, taskId, createdBy, mode: 'consume' });
}

export async function inventoryConsistencyReport(pool: Pool) {
  const rows = await pool.query(
    `
      SELECT ws.warehouse_id, ws.product_id, ws.quantity, ws.reserved_quantity,
             COALESCE(r.active_reserved, 0) AS identified_reserved,
             COALESCE(r.active_reservation_count, 0) AS active_reservation_count,
             COALESCE(r.order_ids, ARRAY[]::bigint[]) AS order_ids,
             COALESCE(r.pick_task_ids, ARRAY[]::bigint[]) AS pick_task_ids,
             (ws.quantity - ws.reserved_quantity) AS available_quantity,
             p.stock_quantity AS catalog_available_quantity,
             totals.total_available_quantity,
             COALESCE(ops.physical_delta, 0) AS tracked_physical_delta,
             COALESCE(ops.reserved_delta, 0) AS tracked_reserved_delta,
             COALESCE(opening.established_quantity, 0) AS established_quantity,
             costs.inventory_value,
             COALESCE(costs.cost_known, FALSE) AS cost_known,
             ops.value_delta AS tracked_value_delta,
             ws.quantity = COALESCE(opening.established_quantity,0) + COALESCE(ops.physical_delta,0) AS quantity_journal_consistent,
             (NOT COALESCE(costs.cost_known,FALSE) OR costs.inventory_value = COALESCE(ops.value_delta,0)) AS value_journal_consistent
      FROM warehouse_stock ws
      JOIN products p ON p.id = ws.product_id
      LEFT JOIN (
        SELECT warehouse_id, product_id, SUM(quantity) AS active_reserved,
               COUNT(*) AS active_reservation_count,
               ARRAY_AGG(DISTINCT order_id) FILTER (WHERE order_id IS NOT NULL) AS order_ids,
               ARRAY_AGG(DISTINCT pick_task_id) FILTER (WHERE pick_task_id IS NOT NULL) AS pick_task_ids
        FROM inventory_reservations WHERE status = 'active'
        GROUP BY warehouse_id, product_id
      ) r ON r.warehouse_id = ws.warehouse_id AND r.product_id = ws.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity - reserved_quantity) AS total_available_quantity
        FROM warehouse_stock GROUP BY product_id
      ) totals ON totals.product_id = ws.product_id
      LEFT JOIN (
        SELECT warehouse_id, product_id,
               SUM(physical_delta) AS physical_delta,
               SUM(reserved_delta) AS reserved_delta,
               SUM(value_delta) AS value_delta
        FROM inventory_operation_lines GROUP BY warehouse_id, product_id
      ) ops ON ops.warehouse_id = ws.warehouse_id AND ops.product_id = ws.product_id
      LEFT JOIN warehouse_stock_costs costs ON costs.warehouse_id=ws.warehouse_id AND costs.product_id=ws.product_id
      LEFT JOIN (
        SELECT d.source_warehouse_id AS warehouse_id,l.product_id,SUM(l.quantity) AS established_quantity
        FROM inventory_documents d JOIN inventory_document_lines l ON l.document_id=d.id
        WHERE d.document_type='opening_balance' AND d.opening_mode='establish' AND d.status='posted'
        GROUP BY d.source_warehouse_id,l.product_id
      ) opening ON opening.warehouse_id=ws.warehouse_id AND opening.product_id=ws.product_id
      ORDER BY ws.warehouse_id, ws.product_id
    `
  );
  return rows.rows.map((row) => ({
    warehouseId: Number(row.warehouse_id),
    productId: Number(row.product_id),
    physicalQuantity: Number(row.quantity),
    reservedQuantity: Number(row.reserved_quantity),
    identifiedReservedQuantity: Number(row.identified_reserved),
    activeReservationCount: Number(row.active_reservation_count),
    relatedOrderIds: (row.order_ids || []).map(Number),
    relatedPickTaskIds: (row.pick_task_ids || []).map(Number),
    availableQuantity: Number(row.available_quantity),
    catalogAvailableQuantity: Number(row.catalog_available_quantity),
    totalAvailableQuantity: Number(row.total_available_quantity),
    trackedPhysicalDelta: Number(row.tracked_physical_delta),
    trackedReservedDelta: Number(row.tracked_reserved_delta),
    establishedQuantity: String(row.established_quantity),
    quantityJournalConsistent: Boolean(row.quantity_journal_consistent),
    inventoryValue: row.inventory_value === null ? null : String(row.inventory_value),
    trackedValueDelta: row.tracked_value_delta === null ? null : String(row.tracked_value_delta),
    costKnown: Boolean(row.cost_known),
    valueJournalConsistent: Boolean(row.value_journal_consistent),
    consistent:
      Number(row.quantity) >= 0 &&
      Number(row.reserved_quantity) >= 0 &&
      Number(row.reserved_quantity) <= Number(row.quantity) &&
      Number(row.reserved_quantity) === Number(row.identified_reserved) &&
      Number(row.catalog_available_quantity) === Number(row.total_available_quantity),
    historicalJournalComplete: false
  }));
}
