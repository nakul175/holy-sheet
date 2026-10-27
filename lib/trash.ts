import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from './auth';import type {Sql} from './database';import type {Repository} from './repository';import type {PageRole} from './types';
import {DocumentError,stableStringify} from './document';
import {pageSubtree,hierarchyRole,type HierarchyNode,type HierarchyMember,type HierarchyGrant,type LocationIntent} from './page-organisation';
type Node=HierarchyNode&{deletion_batch_id:string|null};
type Batch={id:string;workspace_id:string;root_id:string;deleted_by:string;deleted_at:string;expires_at:string;page_count:number;restored_at:string|null};
export type TrashEntry={id:string;rootId:string;title:string;deletedBy:string;deletedAt:string;expiresAt:string;pageCount:number;spaceId:string;parentId:string|null};
export type DeletePreview={rootId:string;title:string;pageCount:number;alreadyTrashedDescendants:number;treeVersion:number;digest:string};
export type RestorePreview={batchId:string;rootId:string;title:string;pageCount:number;expiresAt:string;treeVersion:number;destination:string;changes:{pageId:string;pageTitle:string;recipientId:string;recipientName:string;role:PageRole}[];warnings:string[];digest:string};
const hash=(v:unknown)=>createHash('sha256').update(stableStringify(v)).digest('hex'),unavailable=()=>new DocumentError('Trash item is restricted or unavailable','not_found',404);
const iso=(v:string|Date)=>new Date(v).toISOString();
async function workspace(tx:Sql,actor:Actor,id:string){const q=await tx.query<{id:string;role:string;tree_version:number;access_version:number}>(`SELECT w.id,w.tree_version,w.access_version,m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1 FOR UPDATE OF w,m`,[id,actor.id]);if(!q.rows.length)throw unavailable();if(!['member','admin'].includes(q.rows[0].role))throw new DocumentError('Native role is unavailable','role_unavailable',503);return q.rows[0];}
async function root(tx:Sql,actor:Actor,workspaceId:string,id:string){const q=await tx.query<Node>('SELECT * FROM hs_pages WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 FOR UPDATE',[id,workspaceId,actor.id]);if(!q.rows.length)throw unavailable();return q.rows[0];}
async function inventory(tx:Sql,id:string){
 const pages=(await tx.query<Node>('SELECT id,workspace_id,space_id,parent_id,owner_id,visibility,title,version,acl_version,position,deleted_at,deletion_batch_id FROM hs_pages WHERE workspace_id=$1 ORDER BY id LIMIT 1001',[id])).rows;
 const members=(await tx.query<HierarchyMember>('SELECT u.id,u.name,m.role,m.active FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.id LIMIT 501',[id])).rows;
 if(pages.length>1000||members.length>500)throw new DocumentError('This release supports Trash operations in workspaces with up to 1,000 pages and 500 members. No pages were changed.','trash_limit',422);
 const grants=(await tx.query<HierarchyGrant>('SELECT g.page_id,g.subject,g.role FROM hs_grants g JOIN hs_pages p ON p.id=g.page_id WHERE p.workspace_id=$1 ORDER BY g.page_id,g.subject',[id])).rows;
 return {pages,members,grants};
}
async function deletionReview(tx:Sql,actor:Actor,workspaceId:string,id:string){
 const w=await workspace(tx,actor,workspaceId);if(w.role!=='admin')throw new DocumentError('Workspace management authority required to delete this tree','management_required',403);
 const p=await root(tx,actor,workspaceId,id);if(p.deleted_at)throw new DocumentError('This page is already in Trash','already_trashed',409);
 const state=await inventory(tx,workspaceId),ids=pageSubtree(state.pages,id),active=state.pages.filter(p=>ids.has(p.id)&&!p.deleted_at);
 const data={rootId:id,title:p.title,pageCount:active.length,alreadyTrashedDescendants:ids.size-active.length,treeVersion:w.tree_version};
 return {w,p,active,preview:{...data,digest:hash({data,state,accessVersion:w.access_version})}};
}
export async function previewPageDeletion(r:Repository,actor:Actor,workspaceId:string,id:string):Promise<DeletePreview>{return r.db.transaction(async tx=>(await deletionReview(tx,actor,workspaceId,id)).preview);}
type DeleteAck={batchId:string;rootId:string;pageCount:number;expiresAt:string};
type RestoreAck={batchId:string;rootId:string;pageCount:number};
async function previous<T>(tx:Sql,actor:Actor,workspaceId:string,rootId:string,kind:string,operationId:string,requestHash:string){const q=await tx.query<{actor_id:string;root_id:string;kind:string;request_hash:string;result:T}>('SELECT * FROM hs_trash_operations WHERE workspace_id=$1 AND operation_id=$2',[workspaceId,operationId]);if(!q.rows.length)return;const p=q.rows[0];if(p.actor_id!==actor.id||p.root_id!==rootId||p.kind!==kind||p.request_hash!==requestHash)throw new DocumentError('Trash operation was reused with different fields','operation_mismatch',409);return p.result;}
async function remember(tx:Sql,actor:Actor,workspaceId:string,rootId:string,kind:string,operationId:string,requestHash:string,result:unknown){await tx.query('INSERT INTO hs_trash_operations(workspace_id,operation_id,actor_id,root_id,kind,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)',[workspaceId,operationId,actor.id,rootId,kind,requestHash,JSON.stringify(result)]);}
export async function deletePageTree(r:Repository,actor:Actor,workspaceId:string,id:string,input:{operationId:string;expectedTreeVersion:number;previewDigest:string}){
 return r.db.transaction(async tx=>{
  const w=await workspace(tx,actor,workspaceId);if(w.role!=='admin')throw new DocumentError('Workspace management authority required','management_required',403);const p=await root(tx,actor,workspaceId,id),requestHash=hash({...input,rootId:id});
  const old=await previous<DeleteAck>(tx,actor,workspaceId,id,'delete',input.operationId,requestHash);if(old)return {...old,replayed:true,stateNow:p.deleted_at&&p.deletion_batch_id===old.batchId?'trashed':p.deleted_at?'changed':'available'};
  const review=await deletionReview(tx,actor,workspaceId,id);if(w.tree_version!==input.expectedTreeVersion||review.preview.digest!==input.previewDigest)throw new DocumentError('The page tree or access changed. Review deletion again.','trash_conflict',409);
  const batchId=randomUUID(),created=await tx.query<{deleted_at:string;expires_at:string}>(`WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO hs_deletion_batches(id,workspace_id,root_id,deleted_by,deleted_at,expires_at,page_count) SELECT $1,$2,$3,$4,moment.at,moment.at+interval '30 days',$5 FROM moment RETURNING deleted_at,expires_at`,[batchId,workspaceId,id,actor.id,review.active.length]);
  await tx.query('UPDATE hs_pages SET deleted_at=$2,deletion_batch_id=$3,acl_version=acl_version+1 WHERE id=ANY($1::text[])',[review.active.map(p=>p.id),created.rows[0].deleted_at,batchId]);
  await tx.query('UPDATE hs_workspaces SET tree_version=tree_version+1 WHERE id=$1',[workspaceId]);
  const ack={batchId,rootId:id,pageCount:review.active.length,expiresAt:iso(created.rows[0].expires_at)};
  await remember(tx,actor,workspaceId,id,'delete',input.operationId,requestHash,ack);
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'page.trash',id,JSON.stringify(ack),input.operationId]);return {...ack,replayed:false,stateNow:'trashed'};
 });
}
export async function listTrash(r:Repository,actor:Actor,workspaceId:string,after?:string){return r.db.transaction(async tx=>{
 await workspace(tx,actor,workspaceId);let cursor:{deleted_at:string;id:string}|undefined;
 if(after){const c=await tx.query<{id:string;deleted_at:string}>('SELECT b.id,b.deleted_at FROM hs_deletion_batches b JOIN hs_pages p ON p.id=b.root_id WHERE b.id=$1 AND b.workspace_id=$2 AND p.owner_id=$3',[after,workspaceId,actor.id]);if(!c.rows.length)throw unavailable();cursor=c.rows[0];}
 const q=await tx.query<{id:string;root_id:string;title:string;name:string;deleted_at:string;expires_at:string;page_count:number;space_id:string;parent_id:string|null}>(`SELECT b.id,b.root_id,p.title,u.name,b.deleted_at,b.expires_at,b.page_count,p.space_id,p.parent_id FROM hs_deletion_batches b JOIN hs_pages p ON p.id=b.root_id JOIN hs_users u ON u.id=b.deleted_by WHERE b.workspace_id=$1 AND p.owner_id=$2 AND p.deleted_at IS NOT NULL AND p.deletion_batch_id=b.id AND b.restored_at IS NULL AND b.expires_at>clock_timestamp() AND ($3::timestamptz IS NULL OR (b.deleted_at,b.id)<($3::timestamptz,$4::uuid)) ORDER BY b.deleted_at DESC,b.id DESC LIMIT 21`,[workspaceId,actor.id,cursor?.deleted_at??null,cursor?.id??null]);
 const entries:TrashEntry[]=q.rows.slice(0,20).map(p=>({id:p.id,rootId:p.root_id,title:p.title,deletedBy:p.name,deletedAt:iso(p.deleted_at),expiresAt:iso(p.expires_at),pageCount:p.page_count,spaceId:p.space_id,parentId:p.parent_id}));return {entries,nextCursor:q.rows.length>20?entries.at(-1)!.id:null};
});}
async function batch(tx:Sql,workspaceId:string,id:string){const q=await tx.query<Batch>('SELECT * FROM hs_deletion_batches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,workspaceId]);if(!q.rows.length)throw unavailable();return q.rows[0];}
async function restoreReview(r:Repository,tx:Sql,actor:Actor,workspaceId:string,batchId:string,input:Pick<LocationIntent,'spaceId'|'parentId'>){
 const w=await workspace(tx,actor,workspaceId),b=await batch(tx,workspaceId,batchId),p=await root(tx,actor,workspaceId,b.root_id);
 const valid=await tx.query('SELECT id FROM hs_deletion_batches WHERE id=$1 AND restored_at IS NULL AND expires_at>clock_timestamp()',[batchId]);if(!valid.rows.length)throw new DocumentError('The recovery window expired or this batch was already restored','trash_expired',409);
 if(!p.deleted_at||p.deletion_batch_id!==batchId)throw new DocumentError('The deletion batch changed. Refresh Trash.','trash_conflict',409);
 const target=(await tx.query<{id:string;name:string}>('SELECT id,name FROM hs_spaces WHERE id=$1 AND workspace_id=$2',[input.spaceId,workspaceId])).rows[0];if(!target)throw new DocumentError('Destination space is unavailable','destination_unavailable',404);
 const state=await inventory(tx,workspaceId),items=state.pages.filter(p=>p.deletion_batch_id===batchId&&p.deleted_at),ids=new Set(items.map(p=>p.id));if(items.length!==b.page_count)throw new DocumentError('The deletion batch changed. No pages were restored.','trash_conflict',409);
 if(input.parentId){if(ids.has(input.parentId)||pageSubtree(state.pages,p.id).has(input.parentId))throw new DocumentError('Choose a destination outside the deleted subtree','restore_cycle',422);const parent=await r.access(tx,input.parentId,actor,true);if(parent.workspace_id!==workspaceId||parent.space_id!==input.spaceId)throw new DocumentError('Destination parent is unavailable','destination_unavailable',404);}
 for(const item of items)if(item.id!==p.id&&item.parent_id&&!ids.has(item.parent_id)){const parent=state.pages.find(p=>p.id===item.parent_id);if(!parent||parent.deleted_at)throw new DocumentError('A descendant has an unavailable parent. Recover its earlier batch first.','restore_parent_unavailable',409);}
 const after=new Map(state.pages.map(n=>[n.id,{...n,...(ids.has(n.id)?{deleted_at:null,space_id:input.spaceId}:{}),...(n.id===p.id?{parent_id:input.parentId}:{})}])),grants=new Map<string,HierarchyGrant[]>();for(const grant of state.grants)grants.set(grant.page_id,[...(grants.get(grant.page_id)??[]),grant]);
 const changes:RestorePreview['changes']=[];for(const member of state.members){const cache=new Map<string,PageRole|null>();for(const item of items){const role=hierarchyRole(after,grants,member,item.id,cache);if(role)changes.push({pageId:item.id,pageTitle:item.title,recipientId:member.id,recipientName:member.name,role});if(changes.length>5000)throw new DocumentError('This release supports up to 5,000 access entries per recovery. No pages were restored.','trash_limit',422);}}
 const media=(await tx.query<{id:string;state:string;sha256:string|null}>(`SELECT DISTINCT b.node->'attrs'->>'attachmentId' AS id,COALESCE(m.state,'missing') AS state,m.sha256 FROM hs_blocks b LEFT JOIN hs_media m ON m.id::text=b.node->'attrs'->>'attachmentId' AND m.page_id=b.page_id WHERE b.page_id=ANY($1::text[]) AND b.type IN ('image','file') ORDER BY id`,[[...ids]])).rows,unavailableFiles=media.filter(m=>m.state!=='ready').length;
 const data={batchId,rootId:p.id,title:p.title,pageCount:items.length,expiresAt:iso(b.expires_at),treeVersion:w.tree_version,destination:target.name+(input.parentId?' / '+after.get(input.parentId)!.title:''),changes,warnings:unavailableFiles?[`${unavailableFiles} file upload(s) are unavailable. Recovery never revives rejected, purging or missing file bytes.`]:[]};
 return {w,b,p,ids,preview:{...data,digest:hash({data,state,media,intent:{spaceId:input.spaceId,parentId:input.parentId},accessVersion:w.access_version})}};
}
export async function previewTrashRestore(r:Repository,actor:Actor,workspaceId:string,batchId:string,input:Pick<LocationIntent,'spaceId'|'parentId'>):Promise<RestorePreview>{return r.db.transaction(async tx=>(await restoreReview(r,tx,actor,workspaceId,batchId,input)).preview);}
export async function restoreTrashBatch(r:Repository,actor:Actor,workspaceId:string,batchId:string,input:Pick<LocationIntent,'spaceId'|'parentId'>&{operationId:string;expectedTreeVersion:number;previewDigest:string;reviewed:boolean}){
 return r.db.transaction(async tx=>{
  await workspace(tx,actor,workspaceId);const b=await batch(tx,workspaceId,batchId),p=await root(tx,actor,workspaceId,b.root_id),requestHash=hash({...input,batchId});
  const old=await previous<RestoreAck>(tx,actor,workspaceId,p.id,'restore',input.operationId,requestHash);if(old)return {...old,replayed:true,stateNow:p.deleted_at?'changed':'available'};
  if(!input.reviewed)throw new DocumentError('Review destination, current access and file warnings before recovery','review_required',422);
  const rview=await restoreReview(r,tx,actor,workspaceId,batchId,input);if(rview.w.tree_version!==input.expectedTreeVersion||rview.preview.digest!==input.previewDigest)throw new DocumentError('The batch, destination or current access changed. Review recovery again.','trash_conflict',409);
  const claim=await tx.query('UPDATE hs_deletion_batches SET restored_at=clock_timestamp(),restored_by=$2 WHERE id=$1 AND restored_at IS NULL AND expires_at>clock_timestamp() RETURNING id',[batchId,actor.id]);if(!claim.rows.length)throw new DocumentError('The 30-day recovery window expired','trash_expired',409);
  await tx.query('UPDATE hs_pages SET deleted_at=NULL,deletion_batch_id=NULL,space_id=$2,acl_version=acl_version+1 WHERE id=ANY($1::text[])',[[...rview.ids],input.spaceId]);await tx.query('UPDATE hs_pages SET parent_id=$2 WHERE id=$1',[p.id,input.parentId]);await tx.query('UPDATE hs_workspaces SET tree_version=tree_version+1 WHERE id=$1',[workspaceId]);
  const ack={rootId:p.id,batchId,pageCount:rview.ids.size};await remember(tx,actor,workspaceId,p.id,'restore',input.operationId,requestHash,ack);await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'page.restore',p.id,JSON.stringify({batchId,pageCount:rview.ids.size,spaceId:input.spaceId,parentId:input.parentId}),input.operationId]);return {...ack,replayed:false,stateNow:'available'};
 });
}
