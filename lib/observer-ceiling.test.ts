import {beforeAll,afterAll,it,expect} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository,type DocumentPage} from './repository';
import {localActor} from './auth';
import {changeSharing} from './sharing';
import {changeTemplate,readTemplate,listTemplates} from './templates';
import {prepareImport,changeImport,readImport,type ImportPreview} from './document-imports';
import {changeDiscussion,discussions} from './discussions';
import {reserveMedia} from './media';
import {previewPageDeletion,deletePageTree,previewTrashRestore,restoreTrashBatch,type RestorePreview} from './trash';
import {spaceAccess,previewSpaceMemberChange,changeSpaceMember} from './space-administration';
import {hierarchyRole,type HierarchyNode,type HierarchyGrant,type HierarchyMember} from './page-organisation';
import type {PageRole} from './types';

const ws='ws-aplyd',subject={id:'ceiling-subject'},recipient={id:'ceiling-recipient'},normal={id:'ceiling-normal-member'};
let db:Database,r:Repository,owned:DocumentPage,direct:DocumentPage,inherited:DocumentPage,spaceGranted:DocumentPage,unreadable:DocumentPage;
let templateId:string,templateRevision:number,imported:ImportPreview,commentId:string,trashId:string,trashedPageId:string,restore:RestorePreview;
let originalOwnership:unknown[],originalGrants:unknown[];
beforeAll(async()=>{
 db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();
 await db.query("UPDATE hs_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[ws,localActor.id]);
 for(const [actor,role] of [[subject,'admin'],[recipient,'member'],[normal,'member']] as const){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[actor.id]);await db.query('INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[ws,actor.id,role]);}
 owned=await r.create(subject,'Owned before demotion','space-product');
 direct=await r.create(localActor,'Direct grant before demotion','space-product');
 await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor'),($1,$3,'editor')",[direct.id,subject.id,normal.id]);
 const parent=await r.create(localActor,'Inherited grant before demotion','space-product');
 await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')",[parent.id,subject.id]);
 inherited=await r.create(localActor,'Inherited child','space-product',parent.id);
 spaceGranted=await r.create(localActor,'Space grant before demotion','space-private');
 await db.query("UPDATE hs_pages SET visibility='space' WHERE id=$1",[spaceGranted.id]);
 await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,'space','editor')",[spaceGranted.id]);
 unreadable=await r.create(localActor,'No read grant','space-private');
 await db.query("INSERT INTO hs_space_members(space_id,user_id,role,granted_by) VALUES('space-product',$1,'leader',$2),('space-private',$1,'editor',$2)",[subject.id,localActor.id]);
 const saved=await changeTemplate(r,subject,ws,{kind:'save',operationId:crypto.randomUUID(),name:'Owned template',description:'Synthetic',sourcePageId:owned.id,sourcePageVersion:owned.version});templateId=String(saved.id);
 const published=await changeTemplate(r,subject,ws,{kind:'publish-space',operationId:crypto.randomUUID(),id:templateId,expectedDraftVersion:1,spaceId:'space-product',reviewed:true});templateRevision=Number(published.publishedVersion);
 await db.query('INSERT INTO hs_space_template_managers(workspace_id,space_id,user_id) VALUES($1,$2,$3)',[ws,'space-product',subject.id]);
 imported=await prepareImport(r,subject,{id:crypto.randomUUID(),spaceId:'space-product',title:'Preview before demotion',filename:'before.txt'},Buffer.from('Retained import text'));
 const comment=await changeDiscussion(r,subject,owned.id,{kind:'create',operationId:crypto.randomUUID(),body:'Original comment',mentionIds:[],baseVersion:owned.version,anchors:[]});commentId=comment.commentId!;
 const trashPage=await r.create(subject,'Trashed before demotion','space-product');trashedPageId=trashPage.id;
 const deletion=await previewPageDeletion(r,subject,ws,trashPage.id),ack=await deletePageTree(r,subject,ws,trashPage.id,{operationId:crypto.randomUUID(),expectedTreeVersion:deletion.treeVersion,previewDigest:deletion.digest});trashId=String(ack.batchId);
 restore=await previewTrashRestore(r,subject,ws,trashId,{spaceId:'space-private',parentId:null});
 originalOwnership=(await db.query('SELECT id,owner_id FROM hs_pages WHERE workspace_id=$1 ORDER BY id',[ws])).rows;
 originalGrants=(await db.query('SELECT page_id,subject,role FROM hs_grants ORDER BY page_id,subject')).rows;
 await db.query("UPDATE hs_members SET role='observer' WHERE workspace_id=$1 AND user_id=$2",[ws,subject.id]);
});
afterAll(async()=>db.close());

it('clamps owned, direct, inherited and space-granted pages to authorized read-only access',async()=>{
 for(const page of [owned,direct,inherited,spaceGranted]){const current=await r.get(page.id,subject);expect(current.role).toBe('viewer');expect(current.document).toEqual(page.document);await expect(r.save(page.id,subject,{operationId:crypto.randomUUID(),baseVersion:current.version,title:'Forbidden edit',document:current.document})).rejects.toMatchObject({status:403,code:'read_only'});}
 await expect(r.get(unreadable.id,subject)).rejects.toMatchObject({status:404});
 await expect(changeSharing(r,subject,owned.id,{operationId:crypto.randomUUID(),expectedVersion:1,recipientId:recipient.id,role:'editor'})).rejects.toMatchObject({status:403});
 await expect(reserveMedia(r,subject,owned.id,{operationId:crypto.randomUUID(),name:'forbidden.txt',size:4})).rejects.toMatchObject({status:403});
 expect((await db.query('SELECT id,owner_id FROM hs_pages WHERE workspace_id=$1 ORDER BY id',[ws])).rows).toEqual(originalOwnership);
 expect((await db.query('SELECT page_id,subject,role FROM hs_grants ORDER BY page_id,subject')).rows).toEqual(originalGrants);
});
it('denies fresh page, subpage and space creation while preserving readable committed creation results',async()=>{
 await expect(r.create(subject,'Forbidden new page','space-product')).rejects.toMatchObject({status:403,code:'read_only'});
 await expect(r.create(subject,'Forbidden child','space-product',owned.id)).rejects.toMatchObject({status:403,code:'read_only'});
 await expect(r.createSpace(subject,'Forbidden new space',ws)).rejects.toMatchObject({status:403,code:'read_only'});
 expect((await db.query("SELECT id FROM hs_pages WHERE title LIKE 'Forbidden%'")).rows).toEqual([]);
 expect((await db.query("SELECT id FROM hs_spaces WHERE name='Forbidden new space'")).rows).toEqual([]);
});
it('denies template ownership, stale delegated template management and import commit bypasses',async()=>{
 expect((await readTemplate(r,subject,ws,templateId,true)).name).toBe('Owned template');expect((await listTemplates(r,subject,ws)).templates.some(t=>t.id===templateId)).toBe(true);
 for(const command of [
  {kind:'save' as const,operationId:crypto.randomUUID(),name:'Forbidden snapshot',description:'',sourcePageId:owned.id,sourcePageVersion:owned.version},
  {kind:'publish' as const,operationId:crypto.randomUUID(),id:templateId,expectedDraftVersion:1},
  {kind:'instantiate' as const,operationId:crypto.randomUUID(),id:templateId,revision:templateRevision,spaceId:'space-product',title:'Forbidden template page'},
  {kind:'duplicate' as const,operationId:crypto.randomUUID(),id:templateId,revision:templateRevision,name:'Forbidden duplicate'}
 ])await expect(changeTemplate(r,subject,ws,command)).rejects.toMatchObject({status:403,code:'read_only'});
 expect((await readImport(r,subject,imported.id)).state).toBe('preview');
 await expect(changeImport(r,subject,imported.id,{action:'commit',reviewHash:imported.reviewHash})).rejects.toMatchObject({status:403,code:'read_only'});
 await expect(prepareImport(r,subject,{id:crypto.randomUUID(),spaceId:'space-product',title:'Forbidden import',filename:'after.txt'},Buffer.from('New import'))).rejects.toMatchObject({status:403,code:'read_only'});
 expect((await readImport(r,subject,imported.id)).state).toBe('preview');
});
it('does not permit editing an authored comment or managing space grants through stale Leader authority',async()=>{
 await expect(changeDiscussion(r,subject,owned.id,{kind:'edit',operationId:crypto.randomUUID(),commentId,expectedVersion:1,body:'Forbidden comment edit',mentionIds:[]})).rejects.toMatchObject({status:403});
 expect(JSON.stringify(await discussions(r,subject,owned.id))).toContain('Original comment');
 const access=await spaceAccess(r,subject,'space-product');expect(access.canManage).toBe(false);expect(access.members.map(m=>m.id)).toEqual([subject.id]);
 await expect(previewSpaceMemberChange(r,subject,'space-product',{subjectId:recipient.id,role:'editor'})).rejects.toMatchObject({status:403});
 await expect(changeSpaceMember(r,subject,'space-product',{subjectId:recipient.id,role:'editor',operationId:crypto.randomUUID(),expectedVersion:access.version,previewDigest:'a'.repeat(64)})).rejects.toMatchObject({status:403});
 const reviewed=await previewSpaceMemberChange(r,localActor,'space-product',{subjectId:subject.id,role:'editor'});expect(reviewed.capabilitiesBefore).toEqual(['view']);expect(reviewed.capabilitiesAfter).toEqual(['view']);
});
it('denies restoration in both legacy and model-v2 workspaces despite raw ownership and stale space Editor grants',async()=>{
 for(const model of [1,2]){await db.query('UPDATE hs_workspaces SET access_model_version=$2 WHERE id=$1',[ws,model]);await expect(previewTrashRestore(r,subject,ws,trashId,{spaceId:'space-private',parentId:null})).rejects.toMatchObject({status:403,code:'read_only'});await expect(restoreTrashBatch(r,subject,ws,trashId,{spaceId:'space-private',parentId:null,operationId:crypto.randomUUID(),expectedTreeVersion:restore.treeVersion,previewDigest:restore.digest,reviewed:true})).rejects.toMatchObject({status:403,code:'read_only'});}
 await db.query('UPDATE hs_workspaces SET access_model_version=1 WHERE id=$1',[ws]);expect((await db.query('SELECT deleted_at IS NOT NULL AS deleted FROM hs_pages WHERE id=$1',[trashedPageId])).rows).toEqual([{deleted:true}]);
});
it('applies the same ceiling to hierarchy previews and does not reuse an inactive or demoted cached authority',async()=>{
 const rows=(await db.query<HierarchyNode>('SELECT * FROM hs_pages WHERE workspace_id=$1',[ws])).rows,nodes=new Map(rows.map(p=>[p.id,p])),grants=new Map<string,HierarchyGrant[]>();
 for(const grant of (await db.query<HierarchyGrant>('SELECT page_id,subject,role FROM hs_grants')).rows)grants.set(grant.page_id,[...(grants.get(grant.page_id)??[]),grant]);
 const member:HierarchyMember={id:subject.id,name:'Subject',role:'observer',active:true};
 for(const page of [owned,direct,inherited,spaceGranted])expect(hierarchyRole(nodes,grants,member,page.id,new Map())).toBe('viewer');
 expect(hierarchyRole(nodes,grants,member,unreadable.id,new Map())).toBe(null);
 const cached=new Map<string,PageRole|null>([[owned.id,'owner']]);expect(hierarchyRole(nodes,grants,member,owned.id,cached)).toBe('viewer');expect(hierarchyRole(nodes,grants,{...member,active:false},owned.id,cached)).toBe(null);
});
it('denies inactive membership even through owned resources and leaves other active native roles unchanged',async()=>{
 await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ws,subject.id]);try{await expect(r.get(owned.id,subject)).rejects.toMatchObject({status:404});await expect(r.create(subject,'Inactive new page','space-product')).rejects.toMatchObject({status:404});await expect(r.createSpace(subject,'Inactive new space',ws)).rejects.toMatchObject({status:404});await expect(spaceAccess(r,subject,'space-product')).rejects.toMatchObject({status:404});}finally{await db.query('UPDATE hs_members SET active=true WHERE workspace_id=$1 AND user_id=$2',[ws,subject.id]);}
 const page=await r.create(normal,'Normal Member creation','space-product');expect(page.role).toBe('owner');expect((await r.createSpace(normal,'Normal Member space',ws)).name).toBe('Normal Member space');
 const edited=await r.get(direct.id,normal);await expect(r.save(direct.id,normal,{operationId:crypto.randomUUID(),baseVersion:edited.version,title:'Normal Member edit',document:edited.document})).resolves.toMatchObject({page:{title:'Normal Member edit'}});
 expect((await r.get(owned.id,localActor)).role).toBe('editor');
});
