import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDb } from '../src/db';
import { accessibleStoreIds,accessibleWarehouseIds,hasStoreAccess } from '../src/network-access';

const url=String(process.env.TEST_DATABASE_URL||'');
if(!url)throw new Error('TEST_DATABASE_URL is required for integration tests');
const db=connectDb(url);

test('owner sees network; assignments are many-to-many and revocation is immediate',async()=>{
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const suffix=Date.now().toString(36);
  const existingOwner=(await client.query(`SELECT id FROM users WHERE role='owner' AND is_active ORDER BY id LIMIT 1`)).rows[0];
  const owner=existingOwner?Number(existingOwner.id):Number((await client.query(`INSERT INTO users(full_name,email,password_hash,role,permissions) VALUES('Owner',$1,'x','owner','{}') RETURNING id`,[`owner-${suffix}@test.local`])).rows[0].id);
  const admin=Number((await client.query(`INSERT INTO users(full_name,email,password_hash,role,permissions) VALUES('Admin',$1,'x','admin',ARRAY['manage_warehouse']) RETURNING id`,[`admin-${suffix}@test.local`])).rows[0].id);
  const company=Number((await client.query(`INSERT INTO companies(name) VALUES($1) RETURNING id`,[`Network ${suffix}`])).rows[0].id);
  const storeA=Number((await client.query(`INSERT INTO business_stores(company_id,name,code) VALUES($1,'A',$2) RETURNING id`,[company,`A-${suffix}`])).rows[0].id);
  const storeB=Number((await client.query(`INSERT INTO business_stores(company_id,name,code) VALUES($1,'B',$2) RETURNING id`,[company,`B-${suffix}`])).rows[0].id);
  const warehouseA=Number((await client.query(`INSERT INTO warehouses(code,name,created_by_admin_id,business_store_id) VALUES($1,'WA',$2,$3) RETURNING id`,[`WA-${suffix}`,owner,storeA])).rows[0].id);
  const warehouseB=Number((await client.query(`INSERT INTO warehouses(code,name,created_by_admin_id,business_store_id) VALUES($1,'WB',$2,$3) RETURNING id`,[`WB-${suffix}`,owner,storeB])).rows[0].id);
  assert.equal(await accessibleStoreIds(client as any,owner),null);
  assert.deepEqual(await accessibleStoreIds(client as any,admin),[]);
  const first=Number((await client.query(`INSERT INTO store_user_assignments(user_id,store_id,assigned_by) VALUES($1,$2,$3) RETURNING id`,[admin,storeA,owner])).rows[0].id);
  await client.query(`INSERT INTO store_user_assignments(user_id,store_id,assigned_by) VALUES($1,$2,$3)`,[admin,storeB,owner]);
  assert.deepEqual(await accessibleStoreIds(client as any,admin),[storeA,storeB]);
  assert.deepEqual(await accessibleWarehouseIds(client as any,admin),[warehouseA,warehouseB]);
  await client.query('SAVEPOINT duplicate_assignment');
  await assert.rejects(client.query(`INSERT INTO store_user_assignments(user_id,store_id,assigned_by) VALUES($1,$2,$3)`,[admin,storeA,owner]),(e:any)=>e.code==='23505');
  await client.query('ROLLBACK TO SAVEPOINT duplicate_assignment');
  await client.query(`UPDATE store_user_assignments SET is_active=FALSE,revoked_by=$1,revoked_at=NOW() WHERE id=$2`,[owner,first]);
  assert.equal(await hasStoreAccess(client as any,admin,storeA),false);
  assert.equal(await hasStoreAccess(client as any,admin,storeB),true);
  await client.query('ROLLBACK');
 }finally{client.release()}
});

test.after(async()=>{await db.end()});
