// Disposable local-only fixtures for SC/TC/MS-HOLY-1-001/002.
import {createDatabase} from '../lib/database';
import {Repository} from '../lib/repository';
import {localActor} from '../lib/auth';
if(process.env.HS_ACCEPTANCE_SEED!=='1'||process.env.NODE_ENV==='production'||process.env.DATABASE_URL||process.env.HS_LOCAL_PREVIEW!=='1'||process.env.HS_LOCAL_DATABASE_DIR!=='.holy-sheet/browser-acceptance')throw Error('Explicit isolated browser acceptance configuration required');
const db=await createDatabase();try{
 await new Repository(db).seedLocal();
 await db.query("INSERT INTO hs_workspaces(id,name) VALUES('holy1-empty-workspace','HOLY-1 empty workspace') ON CONFLICT DO NOTHING");
 await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('holy1-empty-workspace',$1,'admin') ON CONFLICT(workspace_id,user_id) DO NOTHING",[localActor.id]);
 await db.query("INSERT INTO hs_workspaces(id,name) VALUES('holy1-owner-source','HOLY-1 Owner source') ON CONFLICT DO NOTHING");
 await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('holy1-owner-source',$1,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING",[localActor.id]);
 const owner=await db.query<{role:string;active:boolean}>("SELECT role,active FROM hs_members WHERE workspace_id='holy1-owner-source' AND user_id=$1",[localActor.id]);
 if(owner.rows[0]?.role!=='owner'||!owner.rows[0]?.active)throw Error('Existing local Owner fixture needs review; no membership was elevated');
 console.log('Local disposable empty-workspace and Owner-source fixtures prepared. No external service or identity changed.');
}finally{await db.close();}
