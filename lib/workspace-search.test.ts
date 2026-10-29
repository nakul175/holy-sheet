import {beforeAll,afterAll,it,expect} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner} from './auth';
import {workspaceSearch} from './workspace-search';
import {fromLegacy} from './document';
let db:Database,r:Repository;
const viewer={id:'holy2-viewer'},other={id:'holy2-other'};
const search=(query:string,patch:Record<string,string>={},actor=viewer)=>workspaceSearch(r,actor,{query,workspaceId:'ws-aplyd',...patch});
async function page(title:string,text:string,space='space-product',grant=true){const p=await r.create(owner,title,space);await db.transaction(tx=>r.writeDocument(tx,p.id,fromLegacy([{id:crypto.randomUUID(),pageId:p.id,parentBlockId:null,type:'paragraph',text,position:0}]),2,title,owner.id));if(grant)await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')",[p.id,viewer.id]);return p;}
beforeAll(async()=>{db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();for(const a of [viewer,other]){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[a.id]);await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[a.id]);}await db.query("INSERT INTO hs_workspaces(id,name) VALUES('w2','Decoy')");await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('w2',$1)",[owner.id]);await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('s2','w2','Other')");});
afterAll(async()=>db.close());
it('matches terms across saved title/content, respects phrases and filters W2 and private content',async()=>{
 const p=await page('Crosslaunch','budget approved');await page('Crosslaunch budget secret','restricted',undefined,false);await page('Crosslaunch budget','decoy','s2');
 const result=await search('Crosslaunch budg');expect(result.results.map(x=>x.id)).toEqual([p.id]);expect(result.results[0].preview).toContain('budget');
 expect((await search('"crosslaunch budget"')).results).toHaveLength(0);
 expect((await search('crosslaunch',{spaceId:'space-private'})).results).toHaveLength(0);
 await expect(search('crosslaunch',{spaceId:'s2'})).rejects.toMatchObject({status:404});
});
it('reads nested list/checklist text and updates the projection inside the same save transaction',async()=>{
 const p=await page('Nested fixture','before');
 await db.query("UPDATE hs_blocks SET node=$2 WHERE page_id=$1 AND parent_id IS NULL",[p.id,JSON.stringify({type:'taskList',content:[{type:'taskItem',content:[{type:'paragraph',content:[{type:'text',text:'needlechecklist'}]}]}]})]);
 expect((await search('needlecheck')).results.map(x=>x.id)).toEqual([p.id]);expect((await search('before')).results.some(x=>x.id===p.id)).toBe(false);
 await db.query('DELETE FROM hs_blocks WHERE page_id=$1',[p.id]);expect((await search('needlecheck')).results).toHaveLength(0);
});
it('keeps a stable 20-result snapshot and rechecks revoke/delete/rename before another page',async()=>{
 for(let i=0;i<45;i++)await page('paginationholy '+i,'saved content');
 const first=await search('paginationholy');expect(first.results).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
 const second=await search('paginationholy',{cursor:first.nextCursor!});expect(second.results).toHaveLength(20);
 const third=await search('paginationholy',{cursor:second.nextCursor!});expect(third.results).toHaveLength(5);expect(third.nextCursor).toBeNull();expect(new Set([...first.results,...second.results,...third.results].map(x=>x.id)).size).toBe(45);
 const [revoked,deleted]=second.results;await db.query('DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2',[revoked.id,viewer.id]);await db.query('UPDATE hs_pages SET deleted_at=now() WHERE id=$1',[deleted.id]);
 const late=await page('paginationholy newlycreated','new');
 const replay=await search('paginationholy',{cursor:first.nextCursor!});expect(replay.results).toHaveLength(20);expect(replay.results.some(x=>[late.id,revoked.id,deleted.id].includes(x.id))).toBe(false);
 await expect(search('otherquery',{cursor:first.nextCursor!})).rejects.toMatchObject({code:'search_cursor_invalid'});
 await expect(search('paginationholy',{cursor:first.nextCursor!},other)).rejects.toMatchObject({code:'search_cursor_invalid'});
});
it('tracks renames, moves, trash/restore and transaction rollback without stale text or reference labels',async()=>{
 const p=await page('freshnessold','freshnessbody');await db.query('UPDATE hs_pages SET title=$2,space_id=$3 WHERE id=$1',[p.id,'freshnessnew','space-private']);
 expect((await search('freshnessold')).results).toHaveLength(0);expect((await search('freshnessnew',{spaceId:'space-private'})).results.map(x=>x.id)).toEqual([p.id]);
 await expect(db.transaction(async tx=>{await tx.query('UPDATE hs_blocks SET node=$2 WHERE page_id=$1',[p.id,JSON.stringify({type:'paragraph',content:[{type:'text',text:'uncommittedneedle'}]})]);throw new Error('rollback');})).rejects.toThrow('rollback');
 expect((await search('uncommittedneedle')).results).toHaveLength(0);expect((await search('freshnessbody')).results.map(x=>x.id)).toEqual([p.id]);
 await db.query('UPDATE hs_blocks SET node=$2 WHERE page_id=$1',[p.id,JSON.stringify({type:'pageLink',content:[{type:'text',text:'restrictedreferencelabel'}]})]);
 expect((await search('restrictedreferencelabel')).results).toHaveLength(0);expect((await db.query<{body:string}>('SELECT body FROM hs_workspace_search WHERE page_id=$1',[p.id])).rows[0].body).toBe('');
 await db.query('UPDATE hs_pages SET deleted_at=now() WHERE id=$1',[p.id]);expect((await search('freshnessnew')).results).toHaveLength(0);
 await db.query('UPDATE hs_pages SET deleted_at=NULL WHERE id=$1',[p.id]);expect((await search('freshnessnew')).results.map(x=>x.id)).toEqual([p.id]);
});
it('omits restricted parent metadata while including inherited accessible ancestry',async()=>{
 const parent=await page('HIDDEN PARENT','private',undefined,false),child=await r.create(owner,'visiblechildneedle','space-product',parent.id);await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')",[child.id,viewer.id]);
 const result=await search('visiblechildneedle');expect(result.results[0].path).toEqual(['Product']);expect(JSON.stringify(result)).not.toContain('HIDDEN');
 await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')",[parent.id,viewer.id]);expect((await search('visiblechildneedle')).results[0].path).toEqual(['Product','HIDDEN PARENT']);
});
