import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
const id=process.env.HS_BOOTSTRAP_USER_ID;
if(!id||!process.env.DATABASE_URL)throw new Error('Set the exact suite subject and staging database connection before provisioning');
const directory=new URL('../db/',import.meta.url);
const files=(await readdir(directory)).filter(name=>/^\d{3}_.+\.sql$/.test(name)&&name>='002_').sort();
const migrations=(await Promise.all(files.map(name=>readFile(new URL(name,directory),'utf8')))).join('\n');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(730217439)');
  await client.query(migrations);
  await client.query('INSERT INTO hs_users(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,process.env.HS_BOOTSTRAP_USER_NAME??'Staging owner']);
  await client.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-staging','Holy Sheet staging') ON CONFLICT DO NOTHING");
  await client.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-staging',$1) ON CONFLICT DO NOTHING",[id]);
  await client.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-staging','ws-staging','Product') ON CONFLICT DO NOTHING");
  await client.query('COMMIT');
  console.log('Staging workspace provisioned for the configured suite subject; no existing grants changed.');
}catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}
