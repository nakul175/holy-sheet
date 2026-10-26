import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createDatabase } from '../lib/database';
import { Repository } from '../lib/repository';
import { localActor } from '../lib/auth';
import { stableStringify } from '../lib/document';
const source=new URL(process.env.HS_TEST_POSTGRES_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(source.hostname));
assert.equal(source.pathname,'/holy_sheet_acceptance');
const restored=new URL(source);restored.pathname='/holy_sheet_restore_acceptance';
const a=new Pool({connectionString:source.href}),b=new Pool({connectionString:restored.href});
try{
 const tables=(await a.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'hs_%' ORDER BY tablename")).rows;
 const results=[];
 for(const {tablename} of tables){assert.match(tablename,/^hs_[a-z_]+$/);const sql=`SELECT count(*)::integer AS rows,md5(COALESCE(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS digest FROM "${tablename}" t`;const left=(await a.query(sql)).rows[0],right=(await b.query(sql)).rows[0];assert.deepEqual(right,left,`${tablename}: restored rows differ`);results.push({table:tablename,...left});}
 process.env.DATABASE_URL=source.href;const sourceDb=await createDatabase();process.env.DATABASE_URL=restored.href;const restoredDb=await createDatabase();
 try{const originalRepo=new Repository(sourceDb),restoredRepo=new Repository(restoredDb),pages=(await a.query<{id:string}>('SELECT id FROM hs_pages WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 50',[localActor.id])).rows;for(const {id} of pages){assert.equal(stableStringify(await restoredRepo.get(id,localActor)),stableStringify(await originalRepo.get(id,localActor)),`Restored document mismatch: ${id}`);}console.log(JSON.stringify({kind:'isolated-postgresql-restore',tablesVerified:results.length,pagesVerified:pages.length,tables:results,scope:'Synthetic SQL database only; private cloud objects and suite identity are not qualified.'},null,2));}finally{await sourceDb.close();await restoredDb.close();}
}finally{await a.end();await b.end();}
