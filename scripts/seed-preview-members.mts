// Explicit synthetic fixtures for local browser checks. Never touches an external database.
import { createDatabase } from '../lib/database';
import { Repository } from '../lib/repository';
if(process.env.NODE_ENV==='production'||process.env.DATABASE_URL)throw new Error('Preview fixtures require the isolated local development database');
const db=await createDatabase();
try{
  await new Repository(db).seedLocal();
  for(const [id,name] of [['00000000-0000-4000-8000-000000000002','Preview editor'],['00000000-0000-4000-8000-000000000003','Preview viewer']]){
    await db.query('INSERT INTO hs_users(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,name]);
    await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1) ON CONFLICT DO NOTHING",[id]);
  }
  console.log('Synthetic preview members added locally. No page grants were created.');
}finally{await db.close();}
