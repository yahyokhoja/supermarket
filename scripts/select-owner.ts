import 'dotenv/config';
import { connectDb } from '../src/db';
const userId=Number(process.argv[2]);
if(!Number.isInteger(userId)||userId<=0)throw new Error('Usage: npm run network:select-owner -- <user-id>');
const url=String(process.env.DATABASE_URL||'').trim();if(!url)throw new Error('DATABASE_URL is required');
const db=connectDb(url);
async function main(){const client=await db.connect();try{await client.query('BEGIN');const existing=(await client.query(`SELECT id FROM users WHERE role='owner' AND is_active FOR UPDATE`)).rows;if(existing.length&&Number(existing[0].id)!==userId)throw new Error(`An active owner is already selected (user id ${existing[0].id})`);const target=(await client.query(`SELECT id,role,is_active FROM users WHERE id=$1 FOR UPDATE`,[userId])).rows[0];if(!target)throw new Error('User not found');if(!target.is_active)throw new Error('Owner must be active');if(!['admin','owner'].includes(String(target.role)))throw new Error('Owner must be selected from an existing administrator');await client.query(`UPDATE users SET role='owner',session_version=session_version+1 WHERE id=$1`,[userId]);await client.query(`INSERT INTO admin_audit_logs(admin_user_id,action,entity_type,entity_id,details) VALUES($1,'network.owner_selected','user',$1,'{}')`,[userId]);await client.query('COMMIT');console.log(`Owner selected: user id ${userId}. Existing sessions were revoked.`);}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}
main().finally(()=>db.end()).catch(e=>{console.error(e instanceof Error?e.message:e);process.exitCode=1});
