import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createDatabase } from '../lib/database';
import { Repository } from '../lib/repository';
import { localActor } from '../lib/auth';
import { stableStringify } from '../lib/document';
import { verifyRestoredTables } from './restore-verification';
const source=new URL(process.env.HS_TEST_POSTGRES_URL??'');
assert.ok(['127.0.0.1','localhost'].includes(source.hostname));
assert.equal(source.pathname,'/holy_sheet_acceptance');
const restored=new URL(source),restoreDatabase=process.env.HS_TEST_RESTORE_DATABASE??'holy_sheet_restore_acceptance';
assert.match(restoreDatabase,/^holy_sheet_restore_acceptance(?:_[a-f0-9]{8})?$/,'Use a dedicated synthetic restore database.');
restored.pathname='/'+restoreDatabase;
const a=new Pool({connectionString:source.href}),b=new Pool({connectionString:restored.href});
try{
 const results=await verifyRestoredTables(a,b);
 process.env.DATABASE_URL=source.href;const sourceDb=await createDatabase();process.env.DATABASE_URL=restored.href;const restoredDb=await createDatabase();
 try{const originalRepo=new Repository(sourceDb),restoredRepo=new Repository(restoredDb),pages=(await a.query<{id:string}>('SELECT id FROM hs_pages WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY id',[localActor.id])).rows;assert.ok(pages.length>0,'Source must contain reopenable owner page fixtures.');for(const {id} of pages){assert.equal(stableStringify(await restoredRepo.get(id,localActor)),stableStringify(await originalRepo.get(id,localActor)),`Restored document mismatch: ${id}`);}console.log(JSON.stringify({kind:'isolated-postgresql-restore',tablesVerified:results.length,pagesVerified:pages.length,tables:results,scope:'Synthetic SQL database only; private cloud objects and suite identity are not qualified.'},null,2));}finally{await sourceDb.close();await restoredDb.close();}
}finally{await a.end();await b.end();}
