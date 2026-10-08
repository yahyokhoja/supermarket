import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { HttpError } from './http-error';
import {
  ensureWarehouseStockRow,
  executeInventoryOperationInTransaction,
  syncProductAvailability,
  type InventoryOperationLine,
  type InventoryOperationType
} from './inventory-service';

export type DocumentType = 'opening_balance' | 'receipt' | 'transfer' | 'writeoff' | 'stocktake';
export type DraftLine = { productId: number; quantity?: string | null; unitCost?: string | null; actualQuantity?: string | null; note?: string | null };
export type DraftInput = {
  documentType: DocumentType;
  accountingDate: string;
  sourceWarehouseId?: number | null;
  destinationWarehouseId?: number | null;
  supplierId?: number | null;
  openingMode?: 'establish' | 'add_empty' | null;
  reason?: string | null;
  comment?: string | null;
  lines: DraftLine[];
};

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/;
function decimal(value: unknown, field: string, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const text = String(value ?? '').trim();
  if (!decimalPattern.test(text)) throw new HttpError(400, `${field}: нужно неотрицательное десятичное число без скрытого округления`);
  return text;
}
function positive(value: unknown, field: string) {
  const text = decimal(value, field)!;
  if (/^0(?:\.0+)?$/.test(text)) throw new HttpError(400, `${field}: значение должно быть больше нуля`);
  return text;
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function deriveScope(client: PoolClient, input: DraftInput) {
  const ids = Array.from(new Set([input.sourceWarehouseId, input.destinationWarehouseId].filter(Boolean))) as number[];
  if (!ids.length) throw new HttpError(400, 'Нужно указать склад документа');
  const rows = (await client.query(
    `SELECT id, company_id, business_store_id FROM warehouses WHERE id=ANY($1::bigint[]) AND is_active=TRUE ORDER BY id`, [ids]
  )).rows;
  if (rows.length !== ids.length) throw new HttpError(404, 'Один из складов не найден или отключён');
  const companyIds = new Set(rows.map((r) => r.company_id === null ? 'legacy' : String(r.company_id)));
  if (companyIds.size !== 1) throw new HttpError(409, 'Склады разных компаний нельзя использовать в одном документе');
  return { companyId: rows[0].company_id === null ? null : Number(rows[0].company_id), storeId: rows[0].business_store_id === null ? null : Number(rows[0].business_store_id) };
}

async function validateLines(client: PoolClient, lines: DraftLine[], type: DocumentType) {
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, 'Документ должен содержать строки');
  const seen = new Set<number>();
  const normalized = [];
  for (const [index, line] of lines.entries()) {
    const productId = Number(line.productId);
    if (!Number.isSafeInteger(productId) || productId <= 0 || seen.has(productId)) throw new HttpError(400, `Строка ${index + 1}: некорректный или повторяющийся товар`);
    seen.add(productId);
    const quantity = type === 'stocktake' ? (line.quantity ? positive(line.quantity, `Строка ${index + 1}, количество`) : null) : positive(line.quantity, `Строка ${index + 1}, количество`);
    const actualQuantity = type === 'stocktake' ? decimal(line.actualQuantity, `Строка ${index + 1}, фактическое количество`)! : null;
    const unitCost = decimal(line.unitCost, `Строка ${index + 1}, себестоимость`, true);
    normalized.push({ productId, quantity, actualQuantity, unitCost, note: String(line.note || '').trim() || null });
  }
  const productRows = (await client.query(
    `SELECT id, quantity_step FROM products WHERE id=ANY($1::bigint[])`, [normalized.map((l) => l.productId)]
  )).rows;
  if (productRows.length !== normalized.length) throw new HttpError(404, 'Один из товаров не найден');
  for (const line of normalized) {
    const step = productRows.find((r) => Number(r.id) === line.productId)!.quantity_step;
    for (const qty of [line.quantity, line.actualQuantity].filter((v): v is string => v !== null)) {
      const ok = (await client.query(`SELECT mod($1::numeric,$2::numeric)=0 AS ok`, [qty, step])).rows[0].ok;
      if (!ok) throw new HttpError(400, `Количество товара #${line.productId} не кратно шагу ${step}`);
    }
  }
  return normalized;
}

export async function createInventoryDraft(pool: Pool, input: DraftInput, userId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.documentType === 'transfer' && input.sourceWarehouseId === input.destinationWarehouseId) throw new HttpError(400, 'Склады перемещения должны отличаться');
    const scope = await deriveScope(client, input);
    const lines = await validateLines(client, input.lines, input.documentType);
    if (input.documentType === 'receipt' && !input.supplierId) throw new HttpError(400, 'Для приёмки нужен поставщик');
    if (input.documentType === 'opening_balance' && !input.openingMode) throw new HttpError(400, 'Для начальных остатков нужен режим establish или add_empty');
    if (input.supplierId) {
      const supplier = (await client.query(`SELECT id,company_id,archived_at FROM suppliers WHERE id=$1`, [input.supplierId])).rows[0];
      if (!supplier || supplier.archived_at) throw new HttpError(409, 'Поставщик не найден или архивирован');
      if (supplier.company_id !== null && scope.companyId !== null && Number(supplier.company_id) !== scope.companyId) throw new HttpError(403, 'Поставщик относится к другой компании');
    }
    const id = randomUUID();
    const number = `${input.documentType.toUpperCase()}-${Date.now()}-${id.slice(0, 6)}`;
    await client.query(
      `INSERT INTO inventory_documents(id,document_type,document_number,accounting_date,company_id,source_warehouse_id,destination_warehouse_id,supplier_id,opening_mode,reason,comment,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id,input.documentType,number,input.accountingDate,scope.companyId,input.sourceWarehouseId ?? null,input.destinationWarehouseId ?? null,input.supplierId ?? null,input.openingMode ?? null,input.reason ?? null,input.comment ?? null,userId]
    );
    for (const [i,line] of lines.entries()) {
      let snapshot: any = null;
      if (input.documentType === 'stocktake') {
        const warehouseId = input.sourceWarehouseId!;
        await ensureWarehouseStockRow(client, warehouseId, line.productId);
        snapshot = (await client.query(`SELECT quantity,reserved_quantity,stock_version FROM warehouse_stock WHERE warehouse_id=$1 AND product_id=$2`,[warehouseId,line.productId])).rows[0];
      }
      await client.query(
        `INSERT INTO inventory_document_lines(document_id,line_no,product_id,quantity,unit_cost,actual_quantity,snapshot_quantity,snapshot_reserved_quantity,snapshot_stock_version,note)
         VALUES($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9,$10)`,
        [id,i+1,line.productId,line.quantity,line.unitCost,line.actualQuantity,snapshot?.quantity ?? null,snapshot?.reserved_quantity ?? null,snapshot?.stock_version ?? null,line.note]
      );
    }
    await client.query('COMMIT');
    return { id, documentNumber: number, version: 1 };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function updateInventoryDraft(pool: Pool, id: string, expectedVersion: number, input: DraftInput, userId: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const doc = (await client.query(`SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if (!doc) throw new HttpError(404,'Документ не найден');
    if (doc.status !== 'draft') throw new HttpError(409,'Проведённый документ изменять нельзя');
    if (Number(doc.version) !== expectedVersion) throw new HttpError(409,'Документ уже изменён другим пользователем');
    if (doc.document_type !== input.documentType) throw new HttpError(400,'Тип документа изменять нельзя');
    await deriveScope(client,input);
    const lines = await validateLines(client,input.lines,input.documentType);
    await client.query(`DELETE FROM inventory_document_lines WHERE document_id=$1`,[id]);
    for (const [i,line] of lines.entries()) {
      let snapshot:any=null;
      if(input.documentType==='stocktake'){
        await ensureWarehouseStockRow(client,input.sourceWarehouseId!,line.productId);
        snapshot=(await client.query(`SELECT quantity,reserved_quantity,stock_version FROM warehouse_stock WHERE warehouse_id=$1 AND product_id=$2`,[input.sourceWarehouseId,line.productId])).rows[0];
      }
      await client.query(`INSERT INTO inventory_document_lines(document_id,line_no,product_id,quantity,unit_cost,actual_quantity,snapshot_quantity,snapshot_reserved_quantity,snapshot_stock_version,note)
        VALUES($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9,$10)`,[id,i+1,line.productId,line.quantity,line.unitCost,line.actualQuantity,snapshot?.quantity??null,snapshot?.reserved_quantity??null,snapshot?.stock_version??null,line.note]);
    }
    await client.query(`UPDATE inventory_documents SET accounting_date=$1,source_warehouse_id=$2,destination_warehouse_id=$3,supplier_id=$4,opening_mode=$5,reason=$6,comment=$7,version=version+1,updated_at=NOW(),created_by=COALESCE(created_by,$8) WHERE id=$9`,
      [input.accountingDate,input.sourceWarehouseId??null,input.destinationWarehouseId??null,input.supplierId??null,input.openingMode??null,input.reason??null,input.comment??null,userId,id]);
    await client.query('COMMIT'); return {id,version:expectedVersion+1};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

type LockedStock={warehouseId:number;productId:number;quantity:string;reserved:string;version:number;value:string|null;costKnown:boolean};
async function lockStocks(client:PoolClient,keys:Array<{warehouseId:number;productId:number}>){
  const unique=Array.from(new Map(keys.map(k=>[`${k.warehouseId}:${k.productId}`,k])).values()).sort((a,b)=>a.warehouseId-b.warehouseId||a.productId-b.productId);
  const result=new Map<string,LockedStock>();
  for(const key of unique){
    await ensureWarehouseStockRow(client,key.warehouseId,key.productId);
    await client.query(`INSERT INTO warehouse_stock_costs(warehouse_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[key.warehouseId,key.productId]);
    const r=(await client.query(`SELECT ws.quantity::text quantity,ws.reserved_quantity::text reserved,ws.stock_version,c.inventory_value::text value,c.cost_known
      FROM warehouse_stock ws JOIN warehouse_stock_costs c USING(warehouse_id,product_id) WHERE ws.warehouse_id=$1 AND ws.product_id=$2 FOR UPDATE OF ws,c`,[key.warehouseId,key.productId])).rows[0];
    result.set(`${key.warehouseId}:${key.productId}`,{warehouseId:key.warehouseId,productId:key.productId,quantity:r.quantity,reserved:r.reserved,version:Number(r.stock_version),value:r.value,costKnown:Boolean(r.cost_known)});
  }return result;
}
async function numeric(client:PoolClient,sql:string,params:any[]=[]){return (await client.query(`SELECT (${sql})::text value`,params)).rows[0].value as string;}
async function truth(client:PoolClient,sql:string,params:any[]=[]){return Boolean((await client.query(`SELECT (${sql}) AS value`,params)).rows[0].value);}

export async function postInventoryDocument(pool:Pool,id:string,idempotencyKey:string,userId:number){
  if(idempotencyKey.trim().length<8)throw new HttpError(400,'x-idempotency-key должен содержать минимум 8 символов');
  const client=await pool.connect();
  try{await client.query('BEGIN');
    const doc=(await client.query(`SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!doc)throw new HttpError(404,'Документ не найден');
    const lines=(await client.query(`SELECT * FROM inventory_document_lines WHERE document_id=$1 ORDER BY line_no`,[id])).rows;
    const payloadHash=hash({id,version:Number(doc.version),lines:lines.map(l=>({productId:String(l.product_id),quantity:l.quantity,unitCost:l.unit_cost,actualQuantity:l.actual_quantity,snapshotVersion:l.snapshot_stock_version}))});
    if(doc.status==='posted'){
      if(doc.posting_idempotency_key===idempotencyKey&&doc.posting_payload_hash===payloadHash){await client.query('COMMIT');return{operationId:String(doc.inventory_operation_id),reused:true};}
      throw new HttpError(409,'Документ уже проведён с другим ключом или содержимым');
    }
    if(doc.status!=='draft')throw new HttpError(409,'Документ нельзя провести');
    const source=doc.source_warehouse_id===null?null:Number(doc.source_warehouse_id),dest=doc.destination_warehouse_id===null?null:Number(doc.destination_warehouse_id);
    const keys=lines.flatMap(l=>doc.document_type==='transfer'?[{warehouseId:source!,productId:Number(l.product_id)},{warehouseId:dest!,productId:Number(l.product_id)}]:[{warehouseId:(source??dest)!,productId:Number(l.product_id)}]);
    const stocks=await lockStocks(client,keys); const opLines:InventoryOperationLine[]=[];
    const opType=(`document_${doc.document_type}`) as InventoryOperationType;
    const scope=await deriveScope(client,{documentType:doc.document_type,accountingDate:String(doc.accounting_date),sourceWarehouseId:source,destinationWarehouseId:dest,lines:[]} as DraftInput);
    const operation=await executeInventoryOperationInTransaction(client,{operationType:opType,idempotencyKey:`document:${id}:${idempotencyKey}`,payload:{id,payloadHash},referenceType:'inventory_document',createdBy:userId,companyId:scope.companyId,storeId:scope.storeId},async(_c,operationId)=>{
      for(const l of lines){
        const productId=Number(l.product_id),qty=l.quantity===null?null:String(l.quantity),cost=l.unit_cost===null?null:String(l.unit_cost),warehouseId=(source??dest)!;
        const apply=async(wid:number,physical:string,valueDelta:string|null,newKnown:boolean)=>{
          const s=stocks.get(`${wid}:${productId}`)!; const before=s.version,after=before+(await truth(client,`$1::numeric<>0`,[physical])?1:0);
          await client.query(`UPDATE warehouse_stock SET quantity=quantity+$1::numeric,stock_version=$2,updated_at=NOW() WHERE warehouse_id=$3 AND product_id=$4`,[physical,after,wid,productId]);
          await client.query(`UPDATE warehouse_stock_costs SET inventory_value=CASE WHEN $1::boolean THEN COALESCE(inventory_value,0)+$2::numeric ELSE NULL END,cost_known=$1,updated_at=NOW() WHERE warehouse_id=$3 AND product_id=$4`,[newKnown,valueDelta??'0',wid,productId]);
          if(await truth(client,`$1::numeric<>0`,[physical]))await client.query(`INSERT INTO stock_movements(warehouse_id,product_id,movement_type,quantity,reason,reference_type,created_by,operation_id,document_id,unit_cost,value_delta)
            VALUES($1,$2,$3,abs($4::numeric),$5,'inventory_document',$6,$7,$8,$9::numeric,$10::numeric)`,[wid,productId,doc.document_type,physical,doc.reason,userId,operationId,id,cost,valueDelta]);
          opLines.push({warehouseId:wid,productId,physicalDelta:physical,reservedDelta:'0',valueDelta,stockVersionBefore:before,stockVersionAfter:after});
        };
        if(doc.document_type==='receipt'){
          if(!cost)throw new HttpError(409,`Для приёмки товара #${productId} нужна себестоимость`); const s=stocks.get(`${dest??source}:${productId}`)!;
          if(!s.costKnown&&await truth(client,`$1::numeric>0`,[s.quantity]))throw new HttpError(409,`У товара #${productId} неизвестна стоимость существующего остатка; сначала введите начальный баланс`);
          const vd=await numeric(client,`$1::numeric*$2::numeric`,[qty,cost]);await apply((dest??source)!,qty!,vd,true);
        }else if(doc.document_type==='opening_balance'){
          const s=stocks.get(`${warehouseId}:${productId}`)!;
          if(doc.opening_mode==='establish'){
            if(!(await truth(client,`$1::numeric=$2::numeric`,[s.quantity,qty])))throw new HttpError(409,`Начальный баланс #${productId} должен подтверждать существующее количество, а не добавлять его`);
            if(s.costKnown)throw new HttpError(409,`Начальная стоимость товара #${productId} уже установлена; используйте корректирующий документ`);
            const val=cost?await numeric(client,`$1::numeric*$2::numeric`,[qty,cost]):null;
            await client.query(`UPDATE warehouse_stock_costs SET inventory_value=$1::numeric,cost_known=$2,updated_at=NOW() WHERE warehouse_id=$3 AND product_id=$4`,[val,Boolean(cost),warehouseId,productId]);
            opLines.push({warehouseId,productId,physicalDelta:'0',reservedDelta:'0',valueDelta:val,stockVersionBefore:s.version,stockVersionAfter:s.version});
          }else{
            if(!(await truth(client,`$1::numeric=0 AND $2::numeric=0`,[s.quantity,s.reserved])))throw new HttpError(409,`Режим добавления начального остатка допустим только для пустого склада (#${productId})`);
            const val=cost?await numeric(client,`$1::numeric*$2::numeric`,[qty,cost]):null;await apply(warehouseId,qty!,val,Boolean(cost));
          }
        }else if(doc.document_type==='writeoff'){
          const s=stocks.get(`${source}:${productId}`)!;if(!s.costKnown)throw new HttpError(409,`Неизвестна себестоимость товара #${productId}`);
          if(!(await truth(client,`$1::numeric-$2::numeric >= $3::numeric`,[s.quantity,s.reserved,qty])))throw new HttpError(409,`Недостаточно свободного остатка товара #${productId}`);
          const vd=await numeric(client,`-($1::numeric/$2::numeric*$3::numeric)`,[s.value,s.quantity,qty]);await apply(source!,`-${qty}`,vd,true);
        }else if(doc.document_type==='transfer'){
          const a=stocks.get(`${source}:${productId}`)!,b=stocks.get(`${dest}:${productId}`)!;if(!a.costKnown)throw new HttpError(409,`Неизвестна себестоимость товара #${productId} на складе-источнике`);
          if(!b.costKnown&&await truth(client,`$1::numeric>0`,[b.quantity]))throw new HttpError(409,`Неизвестна стоимость существующего остатка товара #${productId} на складе-получателе`);
          if(!(await truth(client,`$1::numeric-$2::numeric >= $3::numeric`,[a.quantity,a.reserved,qty])))throw new HttpError(409,`Недостаточно свободного остатка товара #${productId}`);
          const carried=await numeric(client,`$1::numeric/$2::numeric*$3::numeric`,[a.value,a.quantity,qty]);await apply(source!,`-${qty}`,`-${carried}`,true);await apply(dest!,qty!,carried,true);
        }else if(doc.document_type==='stocktake'){
          const s=stocks.get(`${source}:${productId}`)!,actual=String(l.actual_quantity);
          if(s.version!==Number(l.snapshot_stock_version))throw new HttpError(409,`Остаток товара #${productId} изменился после снимка; пересоздайте инвентаризацию`);
          if(!(await truth(client,`$1::numeric >= $2::numeric`,[actual,s.reserved])))throw new HttpError(409,`Фактический остаток товара #${productId} ниже активного резерва`);
          const delta=await numeric(client,`$1::numeric-$2::numeric`,[actual,s.quantity]);
          if(await truth(client,`$1::numeric>0`,[delta])){if(!cost)throw new HttpError(409,`Для излишка товара #${productId} нужна подтверждённая стоимость`);const vd=await numeric(client,`$1::numeric*$2::numeric`,[delta,cost]);await apply(source!,delta,vd,s.costKnown||await truth(client,`$1::numeric=0`,[s.quantity]));}
          else if(await truth(client,`$1::numeric<0`,[delta])){if(!s.costKnown)throw new HttpError(409,`Неизвестна стоимость недостачи товара #${productId}`);const vd=await numeric(client,`$1::numeric/$2::numeric*$3::numeric`,[s.value,s.quantity,delta]);await apply(source!,delta,vd,true);}
        }
        await syncProductAvailability(client,productId);
      }return{lines:opLines,result:{documentId:id}};
    });
    await client.query(`UPDATE inventory_documents SET status='posted',posting_idempotency_key=$1,posting_payload_hash=$2,inventory_operation_id=$3,posted_by=$4,posted_at=NOW(),updated_at=NOW() WHERE id=$5`,[idempotencyKey,payloadHash,operation.operationId,userId,id]);
    await client.query('COMMIT');return{operationId:operation.operationId,reused:false};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export async function listInventoryDocuments(pool:Pool,warehouseIds:number[]|null){
  const params:any[]=[];const scope=warehouseIds===null?'':(params.push(warehouseIds),`WHERE (d.source_warehouse_id=ANY($1::bigint[]) OR d.destination_warehouse_id=ANY($1::bigint[]))`);
  const docs=(await pool.query(`SELECT d.*,s.name supplier_name,sw.name source_warehouse_name,dw.name destination_warehouse_name FROM inventory_documents d LEFT JOIN suppliers s ON s.id=d.supplier_id LEFT JOIN warehouses sw ON sw.id=d.source_warehouse_id LEFT JOIN warehouses dw ON dw.id=d.destination_warehouse_id ${scope} ORDER BY d.created_at DESC LIMIT 200`,params)).rows;
  return docs;
}

export async function getInventoryDocument(pool:Pool,id:string){
  const doc=(await pool.query(`SELECT * FROM inventory_documents WHERE id=$1`,[id])).rows[0];if(!doc)throw new HttpError(404,'Документ не найден');
  const lines=(await pool.query(`SELECT l.*,p.name product_name,p.unit FROM inventory_document_lines l JOIN products p ON p.id=l.product_id WHERE document_id=$1 ORDER BY line_no`,[id])).rows;return{...doc,lines};
}

export async function cancelInventoryDocument(pool:Pool,id:string,key:string,userId:number){
  if(key.trim().length<8)throw new HttpError(400,'x-idempotency-key должен содержать минимум 8 символов');const client=await pool.connect();
  try{await client.query('BEGIN');const doc=(await client.query(`SELECT * FROM inventory_documents WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!doc)throw new HttpError(404,'Документ не найден');
    if(doc.status==='cancelled'){await client.query('COMMIT');return{reused:true,reversalDocumentId:null};}if(doc.status!=='posted')throw new HttpError(409,'Отменить можно только проведённый документ');
    const lines=(await client.query(`SELECT * FROM inventory_operation_lines WHERE operation_id=$1 ORDER BY warehouse_id,product_id FOR UPDATE`,[doc.inventory_operation_id])).rows;
    for(const l of lines){const current=(await client.query(`SELECT stock_version,quantity,reserved_quantity FROM warehouse_stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,[l.warehouse_id,l.product_id])).rows[0];if(Number(current.stock_version)!==Number(l.stock_version_after))throw new HttpError(409,'Есть более поздние зависимые движения; автоматическая отмена запрещена');if(!(await truth(client,`$3::numeric<=0 OR $1::numeric-$2::numeric >= $3::numeric`,[current.quantity,current.reserved_quantity,l.physical_delta])))throw new HttpError(409,'Недостаточно свободного остатка для обратного движения');}
    const reversalId=randomUUID();await client.query(`INSERT INTO inventory_documents(id,document_type,status,document_number,accounting_date,company_id,source_warehouse_id,destination_warehouse_id,reason,comment,version,posting_idempotency_key,posting_payload_hash,reverses_document_id,created_by,posted_by,created_at,posted_at)
      VALUES($1,'correction','draft',$2,CURRENT_DATE,$3,$4,$5,'Отмена проведённого документа',$6,1,$7,$8,$9,$10,$10,NOW(),NOW())`,[reversalId,`REV-${doc.document_number}`,doc.company_id,doc.source_warehouse_id,doc.destination_warehouse_id,`Автоматическая коррекция документа ${doc.document_number}`,key,hash({id,key}),id,userId]);
    for(const [index,l] of lines.entries())await client.query(`INSERT INTO inventory_document_lines(document_id,line_no,product_id,quantity,note) VALUES($1,$2,$3,NULL,$4)`,[reversalId,index+1,l.product_id,`Обратная проводка ${doc.document_number}`]);
    const operation=await executeInventoryOperationInTransaction(client,{operationType:'document_reversal',idempotencyKey:`document-reversal:${id}:${key}`,payload:{id,key},referenceType:'inventory_document',createdBy:userId,companyId:doc.company_id===null?null:Number(doc.company_id)},async(_c,operationId)=>{const result:InventoryOperationLine[]=[];for(const l of lines){const physical=await numeric(client,`-($1::numeric)`,[l.physical_delta]),value=l.value_delta===null?null:await numeric(client,`-($1::numeric)`,[l.value_delta]);const ws=(await client.query(`UPDATE warehouse_stock SET quantity=quantity+$1::numeric,stock_version=stock_version+CASE WHEN $1::numeric<>0 THEN 1 ELSE 0 END,updated_at=NOW() WHERE warehouse_id=$2 AND product_id=$3 RETURNING stock_version`,[physical,l.warehouse_id,l.product_id])).rows[0];if(doc.document_type==='opening_balance'&&doc.opening_mode==='establish')await client.query(`UPDATE warehouse_stock_costs SET inventory_value=NULL,cost_known=FALSE,updated_at=NOW() WHERE warehouse_id=$1 AND product_id=$2`,[l.warehouse_id,l.product_id]);else if(value!==null)await client.query(`UPDATE warehouse_stock_costs SET inventory_value=inventory_value+$1::numeric,updated_at=NOW() WHERE warehouse_id=$2 AND product_id=$3`,[value,l.warehouse_id,l.product_id]);if(await truth(client,`$1::numeric<>0`,[physical]))await client.query(`INSERT INTO stock_movements(warehouse_id,product_id,movement_type,quantity,reason,reference_type,created_by,operation_id,document_id,value_delta) VALUES($1,$2,'reversal',abs($3::numeric),$4,'inventory_document',$5,$6,$7,$8::numeric)`,[l.warehouse_id,l.product_id,physical,`Отмена ${doc.document_number}`,userId,operationId,reversalId,value]);result.push({warehouseId:Number(l.warehouse_id),productId:Number(l.product_id),physicalDelta:physical,reservedDelta:'0',valueDelta:value,stockVersionBefore:Number(l.stock_version_after),stockVersionAfter:Number(ws.stock_version)});await syncProductAvailability(client,Number(l.product_id));}return{lines:result,result:{reversesDocumentId:id,reversalDocumentId:reversalId}};});
    await client.query(`UPDATE inventory_documents SET status='posted',inventory_operation_id=$1 WHERE id=$2`,[operation.operationId,reversalId]);await client.query(`INSERT INTO inventory_reversal_links(original_operation_id,reversal_operation_id,original_document_id,reversal_document_id) VALUES($1,$2,$3,$4)`,[doc.inventory_operation_id,operation.operationId,id,reversalId]);await client.query(`UPDATE inventory_documents SET status='cancelled',cancelled_by=$1,cancelled_at=NOW(),updated_at=NOW() WHERE id=$2`,[userId,id]);await client.query('COMMIT');return{reused:false,reversalDocumentId:reversalId};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export async function inventoryValuationReport(pool:Pool,warehouseIds:number[]|null){
  const params:any[]=[];const where=warehouseIds===null?'':(params.push(warehouseIds),`WHERE ws.warehouse_id=ANY($1::bigint[])`);return (await pool.query(`SELECT ws.warehouse_id,w.name warehouse_name,ws.product_id,p.name product_name,ws.quantity::text physical_quantity,ws.reserved_quantity::text reserved_quantity,(ws.quantity-ws.reserved_quantity)::text available_quantity,c.inventory_value::text inventory_value,c.cost_known,CASE WHEN c.cost_known AND ws.quantity>0 THEN (c.inventory_value/ws.quantity)::text ELSE NULL END average_cost,ws.stock_version FROM warehouse_stock ws JOIN warehouses w ON w.id=ws.warehouse_id JOIN products p ON p.id=ws.product_id LEFT JOIN warehouse_stock_costs c USING(warehouse_id,product_id) ${where} ORDER BY w.name,p.name`,params)).rows;
}
