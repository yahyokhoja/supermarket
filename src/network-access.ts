import type { Pool } from 'pg';

export type NetworkActor = { id:number; role:string; isActive:boolean; permissions:string[] };

export async function getNetworkActor(db:Pool,userId:number):Promise<NetworkActor|null>{
  const row=(await db.query(`SELECT id,role,is_active,permissions FROM users WHERE id=$1`,[userId])).rows[0];
  return row?{id:Number(row.id),role:String(row.role),isActive:row.is_active!==false,permissions:Array.isArray(row.permissions)?row.permissions.map(String):[]}:null;
}

export async function accessibleStoreIds(db:Pool,userId:number):Promise<number[]|null>{
  const actor=await getNetworkActor(db,userId);
  if(!actor||!actor.isActive)return [];
  if(actor.role==='owner')return null;
  if(actor.role!=='admin'&&actor.role!=='picker')return [];
  const rows=(await db.query(`SELECT a.store_id FROM store_user_assignments a JOIN business_stores s ON s.id=a.store_id WHERE a.user_id=$1 AND a.is_active=TRUE AND s.is_active=TRUE AND s.archived_at IS NULL ORDER BY a.store_id`,[userId])).rows;
  return rows.map(r=>Number(r.store_id));
}

export async function accessibleWarehouseIds(db:Pool,userId:number):Promise<number[]|null>{
  const stores=await accessibleStoreIds(db,userId);
  if(stores===null)return null;
  if(!stores.length)return [];
  const rows=(await db.query(`SELECT id FROM warehouses WHERE business_store_id=ANY($1::bigint[]) ORDER BY id`,[stores])).rows;
  return rows.map(r=>Number(r.id));
}

export async function hasStoreAccess(db:Pool,userId:number,storeId:number){
  const stores=await accessibleStoreIds(db,userId);
  return stores===null||stores.includes(storeId);
}

export async function warehouseOperational(db:Pool,warehouseId:number){
  const row=(await db.query(`SELECT w.business_store_id,s.is_active,s.archived_at,m.status mapping_status FROM warehouses w LEFT JOIN business_stores s ON s.id=w.business_store_id LEFT JOIN legacy_warehouse_store_mapping m ON m.warehouse_id=w.id WHERE w.id=$1`,[warehouseId])).rows[0];
  return Boolean(row&&row.business_store_id&&(row.mapping_status===null||row.mapping_status==='confirmed')&&row.is_active&&row.archived_at===null);
}
