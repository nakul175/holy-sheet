import {createHash,randomUUID,randomBytes} from 'node:crypto';
import type {Actor} from './auth';import type {Sql} from './database';import type {Repository} from './repository';import type {PageRole} from './types';
import {DocumentError,stableStringify} from './document';
import {pageSubtree,hierarchyRole,type HierarchyNode,type HierarchyMember,type HierarchyGrant,type LocationIntent} from './page-organisation';
import {noteRecordBacklinkPages} from './record-backlinks';
type Node=HierarchyNode&{deletion_batch_id:string|null};
type Batch={id:string;workspace_id:string;root_id:string;deleted_by:string;deleted_at:string;expires_at:string;page_count:number;restored_at:string|null};
export type TrashEntry={id:string;rootId:string;title:string;deletedBy:string;deletedAt:string;expiresAt:string;pageCount:number;spaceId:string;parentId:string|null};
export type DeletePreview={rootId:string;title:string;pageCount:number;alreadyTrashedDescendants:number;treeVersion:number;digest:string};
export type RestorePreview={batchId:string;rootId:string;title:string;pageCount:number;expiresAt:string;treeVersion:number;destination:string;changes:{pageId:string;pageTitle:string;recipientId:string;recipientName:string;role:PageRole}[];warnings:string[];digest:string};
const hash=(v:unknown)=>createHash('sha256').update(stableStringify(v)).digest('hex'),unavailable=()=>new DocumentError('Trash item is restricted or unavailable','not_found',404);
const iso=(v:string|Date)=>new Date(v).toISOString();
async function workspace(tx:Sql,actor:Actor,id:string){const q=await tx.query<{id:string;role:string;tree_version:number;access_version:number;access_model_version:number}>(`SELECT w.id,w.tree_version,w.access_version,w.access_model_version,m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1 FOR UPDATE OF w,m`,[id,actor.id]);if(!q.rows.length)throw unavailable();if(!['owner','admin','member','observer'].includes(q.rows[0].role))throw new DocumentError('Native role is unavailable','role_unavailable',503);return q.rows[0];}
async function root(tx:Sql,actor:Actor,workspaceId:string,id:string){const q=await tx.query<Node>('SELECT * FROM hs_pages WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 FOR UPDATE',[id,workspaceId,actor.id]);if(!q.rows.length)throw unavailable();return q.rows[0];}
async function inventory(tx:Sql,id:string){
 const pages=(await tx.query<Node>('SELECT id,workspace_id,space_id,parent_id,owner_id,visibility,title,version,acl_version,position,deleted_at,deletion_batch_id FROM hs_pages WHERE workspace_id=$1 ORDER BY id LIMIT 1001',[id])).rows;
 const members=(await tx.query<HierarchyMember>('SELECT u.id,u.name,m.role,m.active FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.id LIMIT 501',[id])).rows;
 if(pages.length>1000||members.length>500)throw new DocumentError('This release supports Trash operations in workspaces with up to 1,000 pages and 500 members. No pages were changed.','trash_limit',422);
 const grants=(await tx.query<HierarchyGrant>('SELECT g.page_id,g.subject,g.role FROM hs_grants g JOIN hs_pages p ON p.id=g.page_id WHERE p.workspace_id=$1 ORDER BY g.page_id,g.subject',[id])).rows;
 return {pages,members,grants};
}
async function deletionReview(tx:Sql,actor:Actor,workspaceId:string,id:string){
 const w=await workspace(tx,actor,workspaceId);if(!['owner','admin'].includes(w.role))throw new DocumentError('Workspace management authority required to delete this tree','management_required',403);
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
  const w=await workspace(tx,actor,workspaceId);if(!['owner','admin'].includes(w.role))throw new DocumentError('Workspace management authority required','management_required',403);const p=await root(tx,actor,workspaceId,id),requestHash=hash({...input,rootId:id});
  const old=await previous<DeleteAck>(tx,actor,workspaceId,id,'delete',input.operationId,requestHash);if(old)return {...old,replayed:true,stateNow:p.deleted_at&&p.deletion_batch_id===old.batchId?'trashed':p.deleted_at?'changed':'available'};
  const review=await deletionReview(tx,actor,workspaceId,id);if(w.tree_version!==input.expectedTreeVersion||review.preview.digest!==input.previewDigest)throw new DocumentError('The page tree or access changed. Review deletion again.','trash_conflict',409);
  const batchId=randomUUID(),created=await tx.query<{deleted_at:string;expires_at:string}>(`WITH moment AS (SELECT clock_timestamp() AS at) INSERT INTO hs_deletion_batches(id,workspace_id,root_id,deleted_by,deleted_at,expires_at,page_count) SELECT $1,$2,$3,$4,moment.at,moment.at+interval '30 days',$5 FROM moment RETURNING deleted_at,expires_at`,[batchId,workspaceId,id,actor.id,review.active.length]);
  await tx.query('UPDATE hs_pages SET deleted_at=$2,deletion_batch_id=$3,acl_version=acl_version+1 WHERE id=ANY($1::text[])',[review.active.map(p=>p.id),created.rows[0].deleted_at,batchId]);
  await noteRecordBacklinkPages(tx,actor,review.active.map(p=>p.id),input.operationId,'record-backlink.trash');
  await tx.query('UPDATE hs_workspaces SET tree_version=tree_version+1 WHERE id=$1',[workspaceId]);
  const ack={batchId,rootId:id,pageCount:review.active.length,expiresAt:iso(created.rows[0].expires_at)};
  await remember(tx,actor,workspaceId,id,'delete',input.operationId,requestHash,ack);
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'page.trash',id,JSON.stringify(ack),input.operationId]);return {...ack,replayed:false,stateNow:'trashed'};
 });
}
export async function listTrash(r:Repository,actor:Actor,workspaceId:string,after?:string,query=''){
 if(typeof query!=='string'||Array.from(query).length>200||/[\p{Cc}]/u.test(query)||after&&!/^[A-Za-z0-9_-]{43}$/.test(after))throw new DocumentError('Use a filter of at most200 characters and a current Trash cursor.','invalid_trash_query',422);
 query=query.trim().normalize('NFC');return r.db.transaction(async tx=>{
 const w=await workspace(tx,actor,workspaceId),queryHash=hash({query});let cursor:{last_deleted_at:string;last_id:string}|undefined;
 if(after){cursor=(await tx.query<{last_deleted_at:string;last_id:string}>('SELECT last_deleted_at,last_id FROM hs_trash_query_cursors WHERE token_hash=$1 AND workspace_id=$2 AND actor_id=$3 AND query_hash=$4 AND tree_version=$5 AND access_version=$6 AND expires_at>clock_timestamp()',[hash(after),workspaceId,actor.id,queryHash,w.tree_version,w.access_version])).rows[0];if(!cursor)throw new DocumentError('Trash or its access changed. Refresh the current filter.','trash_cursor_changed',409);}
 const q=await tx.query<{id:string;root_id:string;title:string;name:string;deleted_at:string;expires_at:string;page_count:number;space_id:string;parent_id:string|null}>(`SELECT b.id,b.root_id,p.title,u.name,b.deleted_at,b.expires_at,b.page_count,p.space_id,p.parent_id FROM hs_deletion_batches b JOIN hs_pages p ON p.id=b.root_id JOIN hs_users u ON u.id=b.deleted_by WHERE b.workspace_id=$1 AND p.owner_id=$2 AND p.deleted_at IS NOT NULL AND p.deletion_batch_id=b.id AND b.restored_at IS NULL AND b.expires_at>clock_timestamp() AND ($3::timestamptz IS NULL OR (b.deleted_at,b.id)<($3::timestamptz,$4::uuid)) AND strpos(lower(p.title),lower($5))>0 ORDER BY b.deleted_at DESC,b.id DESC LIMIT 21`,[workspaceId,actor.id,cursor?.last_deleted_at??null,cursor?.last_id??null,query]);
 const entries:TrashEntry[]=q.rows.slice(0,20).map(p=>({id:p.id,rootId:p.root_id,title:p.title,deletedBy:p.name,deletedAt:iso(p.deleted_at),expiresAt:iso(p.expires_at),pageCount:p.page_count,spaceId:p.space_id,parentId:p.parent_id}));let nextCursor:string|null=null;
 if(q.rows.length>20){nextCursor=randomBytes(32).toString('base64url');const last=q.rows[19];await tx.query('INSERT INTO hs_trash_query_cursors(token_hash,workspace_id,actor_id,query_hash,tree_version,access_version,last_deleted_at,last_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[hash(nextCursor),workspaceId,actor.id,queryHash,w.tree_version,w.access_version,iso(last.deleted_at),last.id]);}
 return {entries,nextCursor,query};
 });}

async function batch(tx:Sql,workspaceId:string,id:string){const q=await tx.query<Batch>('SELECT * FROM hs_deletion_batches WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,workspaceId]);if(!q.rows.length)throw unavailable();return q.rows[0];}
async function restoreReview(r:Repository,tx:Sql,actor:Actor,workspaceId:string,batchId:string,input:Pick<LocationIntent,'spaceId'|'parentId'>){
 const w=await workspace(tx,actor,workspaceId);if(w.role==='observer')throw new DocumentError('Observers cannot restore page trees','read_only',403);const b=await batch(tx,workspaceId,batchId),p=await root(tx,actor,workspaceId,b.root_id);
 const valid=await tx.query('SELECT id FROM hs_deletion_batches WHERE id=$1 AND restored_at IS NULL AND expires_at>clock_timestamp()',[batchId]);if(!valid.rows.length)throw new DocumentError('The recovery window expired or this batch was already restored','trash_expired',409);
 if(!p.deleted_at||p.deletion_batch_id!==batchId)throw new DocumentError('The deletion batch changed. Refresh Trash.','trash_conflict',409);
 const target=(await tx.query<{id:string;name:string;space_role:string|null}>(`SELECT s.id,s.name,sm.role AS space_role FROM hs_spaces s LEFT JOIN hs_space_members sm ON sm.space_id=s.id AND sm.user_id=$3 AND sm.active=true WHERE s.id=$1 AND s.workspace_id=$2`,[input.spaceId,workspaceId,actor.id])).rows[0];if(!target)throw new DocumentError('Destination space is unavailable','destination_unavailable',404);
 const state=await inventory(tx,workspaceId),items=state.pages.filter(p=>p.deletion_batch_id===batchId&&p.deleted_at),ids=new Set(items.map(p=>p.id));if(items.length!==b.page_count)throw new DocumentError('The deletion batch changed. No pages were restored.','trash_conflict',409);
 if(input.parentId){if(ids.has(input.parentId)||pageSubtree(state.pages,p.id).has(input.parentId))throw new DocumentError('Choose a destination outside the deleted subtree','restore_cycle',422);const parent=await r.access(tx,input.parentId,actor,true);if(parent.workspace_id!==workspaceId||parent.space_id!==input.spaceId)throw new DocumentError('Destination parent is unavailable','destination_unavailable',404);}
 else if(w.access_model_version===2&&!['owner','admin'].includes(w.role)&&!['leader','editor'].includes(target.space_role??''))throw new DocumentError('Create access in the recovery space is required','destination_create_required',403);
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
  await tx.query('UPDATE hs_pages SET deleted_at=NULL,deletion_batch_id=NULL,space_id=$2,acl_version=acl_version+1 WHERE id=ANY($1::text[])',[[...rview.ids],input.spaceId]);await tx.query('UPDATE hs_pages SET parent_id=$2 WHERE id=$1',[p.id,input.parentId]);await noteRecordBacklinkPages(tx,actor,[...rview.ids],input.operationId,'record-backlink.restore');await tx.query('UPDATE hs_workspaces SET tree_version=tree_version+1 WHERE id=$1',[workspaceId]);
  const ack={rootId:p.id,batchId,pageCount:rview.ids.size};await remember(tx,actor,workspaceId,p.id,'restore',input.operationId,requestHash,ack);await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'page.restore',p.id,JSON.stringify({batchId,pageCount:rview.ids.size,spaceId:input.spaceId,parentId:input.parentId}),input.operationId]);return {...ack,replayed:false,stateNow:'available'};
 });
}
