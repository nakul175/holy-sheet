import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { ensureIds } from './document';
import { backlinks } from './page-references';
import { personalNavigation, updatePersonalNavigation } from './personal-navigation';
import { searchPages } from './search';

let db:Database,r:Repository;
const admin={id:'native-admin'},member={id:'ordinary-member'};
beforeAll(async()=>{
  db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();
  for(const actor of [admin,member]){
    await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[actor.id]);
    await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[actor.id]);
  }
  await db.query("UPDATE hs_members SET role='admin' WHERE user_id=$1",[admin.id]);
});
afterAll(async()=>{await db.close();});

it('does not promote existing members or infer an admin from identity claims',async()=>{
  expect((await db.query<{role:string}>('SELECT role FROM hs_members WHERE user_id=$1',[member.id])).rows[0].role).toBe('member');
  await expect(r.get('welcome',{...member,role:'admin'} as typeof member)).rejects.toMatchObject({status:404});
});
it('allows a native admin to discover and edit a private page without taking ownership',async()=>{
  const p=await r.create(localActor,'Private admin discovery','space-product');
  expect((await r.get(p.id,admin)).role).toBe('editor');
  const child=await r.create(localActor,'Nested private','space-product',p.id);
  expect((await r.get(child.id,admin)).parentTitle).toBe(p.title);
  expect(searchPages(await r.list(admin),'Private admin discovery').some(x=>x.id===p.id)).toBe(true);
  await r.save(p.id,admin,{operationId:crypto.randomUUID(),baseVersion:p.version,title:'Admin edited',document:p.document});
  expect((await r.get(p.id,localActor)).role).toBe('owner');
  await expect(r.get(p.id,member)).rejects.toMatchObject({status:404});
});
it('uses admin access consistently for backlinks and personal navigation',async()=>{
  const target=await r.create(localActor,'Private target','space-product');
  const source=await r.create(localActor,'Private source','space-product');
  const document=ensureIds({type:'doc',content:[{type:'pageLink',attrs:{pageId:target.id}}]});
  await r.save(source.id,localActor,{operationId:crypto.randomUUID(),baseVersion:source.version,title:source.title,document});
  expect((await backlinks(r,admin,target.id)).items.map(x=>x.id)).toContain(source.id);
  await updatePersonalNavigation(r,admin,{action:'opened',pageId:source.id});
  expect((await personalNavigation(r,admin)).recents.map(x=>x.id)).toContain(source.id);
});
it('removes implicit access immediately on demotion, including saved navigation',async()=>{
  await db.query("UPDATE hs_members SET role='member' WHERE user_id=$1",[admin.id]);
  await expect(r.get('welcome',admin)).rejects.toMatchObject({status:404});
  expect((await personalNavigation(r,admin)).recents).toEqual([]);
  await db.query("UPDATE hs_members SET role='admin' WHERE user_id=$1",[admin.id]);
});
it('requires active membership and never expands the role into another workspace',async()=>{
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('other','Other')");
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('other-space','other','Other')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('other',$1)",[localActor.id]);
  const other=await r.create(localActor,'Other private','other-space');
  await expect(r.get(other.id,admin)).rejects.toMatchObject({status:404});
  await db.query("UPDATE hs_members SET active=false WHERE user_id=$1",[admin.id]);
  await expect(r.get('welcome',admin)).rejects.toMatchObject({status:404});
  expect(await r.list(admin)).toEqual([]);
  await db.query("UPDATE hs_members SET active=true WHERE user_id=$1",[admin.id]);
});
it('does not expose trashed content through ordinary admin reads',async()=>{
  const p=await r.create(localActor,'Trashed private','space-product');
  await db.query('UPDATE hs_pages SET deleted_at=now() WHERE id=$1',[p.id]);
  await expect(r.get(p.id,admin)).rejects.toMatchObject({status:404});
  expect((await r.list(admin)).some(x=>x.id===p.id)).toBe(false);
});
