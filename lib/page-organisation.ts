import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from './auth';
import type {Repository} from './repository';
import type {Sql} from './database';
import type {PageRole} from './types';
import {DocumentError,stableStringify} from './document';
export type LocationIntent={spaceId:string;parentId:string|null;index:number};
type Node={id:string;workspace_id:string;space_id:string;parent_id:string|null;owner_id:string;visibility:'private'|'space';title:string;version:number;acl_version:number;position:number;deleted_at:string|null};
type Member={id:string;name:string;role:string;active:boolean};
type Grant={page_id:string;subject:string;role:Exclude<PageRole,'owner'>};
export type LocationPreview={pageId:string;title:string;descendantCount:number;treeVersion:number;sourcePath:string[];targetPath:string[];position:{index:number;afterId:string|null;afterTitle:string|null};changes:{pageId:string;pageTitle:string;recipientId:string;recipientName:string;before:PageRole|null;after:PageRole|null}[];expandsAccess:boolean;digest:string};
const hash=(v:unknown)=>createHash('sha256').update(stableStringify(v)).digest('hex');
const rank=(role:PageRole|null)=>role?({viewer:1,commenter:2,editor:3,owner:4}[role]):0;
async function scope(r:Repository,tx:Sql,pageId:string,actor:Actor){
 const root=await r.access(tx,pageId,actor,true,true);
 if(root.owner_id!==actor.id)throw new DocumentError('Only the page owner can move this page','owner_required',403);
 const member=await tx.query<{role:string}>('SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true',[root.workspace_id,actor.id]);
 if(!['owner','admin'].includes(member.rows[0]?.role??''))throw new DocumentError('Source and destination management authority is required','management_required',403);
 const w=await tx.query<{tree_version:number}>('SELECT tree_version FROM hs_workspaces WHERE id=$1',[root.workspace_id]);
 return {root,workspaceId:root.workspace_id,treeVersion:w.rows[0].tree_version};
}
function subtree(nodes:Node[],rootId:string){const ids=new Set([rootId]);let changed=true;while(changed){changed=false;for(const n of nodes)if(n.parent_id&&ids.has(n.parent_id)&&!ids.has(n.id)){ids.add(n.id);changed=true;}}return ids;}
function effective(nodes:Map<string,Node>,grants:Map<string,Grant[]>,member:Member,id:string,cache:Map<string,PageRole|null>,seen=new Set<string>()):PageRole|null{
 if(!member.active)return null;
 if(cache.has(id)){const role=cache.get(id)!;return member.role==='observer'&&role?'viewer':role;}
 const root=nodes.get(id);if(!root||root.deleted_at)return null;
 if(root.owner_id===member.id)return member.role==='observer'?'viewer':'owner';if(['owner','admin'].includes(member.role))return 'editor';
 if(seen.has(id))throw new DocumentError('The existing hierarchy contains a cycle. No pages were moved.','move_cycle',422);
 seen.add(id);let result:PageRole|null=null;
 for(const g of grants.get(id)??[])if((g.subject===member.id||(g.subject==='space'&&root.visibility==='space'))&&rank(g.role)>rank(result))result=g.role;
 if(root.parent_id){const inherited=effective(nodes,grants,member,root.parent_id,cache,seen),role=inherited==='owner'?'editor':inherited;if(rank(role)>rank(result))result=role;}
 seen.delete(id);if(member.role==='observer'&&result)result='viewer';cache.set(id,result);return result;
}
function path(nodes:Map<string,Node>,id:string|null,spaceName:string){const names:string[]=[],seen=new Set<string>();let p=id?nodes.get(id):undefined;while(p&&!seen.has(p.id)){seen.add(p.id);names.unshift(p.title);p=p.parent_id?nodes.get(p.parent_id):undefined;}return [spaceName,...names];}
async function review(r:Repository,tx:Sql,actor:Actor,pageId:string,input:LocationIntent){
 const s=await scope(r,tx,pageId,actor);
 const target=await tx.query<{id:string;name:string}>('SELECT id,name FROM hs_spaces WHERE id=$1 AND workspace_id=$2',[input.spaceId,s.workspaceId]);
 if(!target.rows.length)throw new DocumentError('Choose a space in this workspace','destination_unavailable',404);
 const q=await tx.query<Node>('SELECT id,workspace_id,space_id,parent_id,owner_id,visibility,title,version,acl_version,position,deleted_at FROM hs_pages WHERE workspace_id=$1 ORDER BY position,updated_at DESC,id LIMIT 1001',[s.workspaceId]);
 const members=await tx.query<Member>('SELECT u.id,u.name,m.role,m.active FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE workspace_id=$1 ORDER BY u.id LIMIT 501',[s.workspaceId]);
 if(q.rows.length>1000||members.rows.length>500)throw new DocumentError('This release supports moves in workspaces with up to 1,000 pages and 500 members. No pages were moved.','move_limit',422);
 const nodes=new Map(q.rows.map(p=>[p.id,p])),ids=subtree(q.rows,pageId),parent=input.parentId?nodes.get(input.parentId):null;
 if(input.parentId&&(!parent||parent.deleted_at||parent.space_id!==input.spaceId))throw new DocumentError('Destination parent is unavailable','destination_unavailable',404);
 if(input.parentId&&ids.has(input.parentId))throw new DocumentError('A page cannot move into itself or its descendants','move_cycle',422);
 const siblings=q.rows.filter(p=>!p.deleted_at&&p.id!==pageId&&p.space_id===input.spaceId&&p.parent_id===input.parentId);
 if(!Number.isInteger(input.index)||input.index<0||input.index>siblings.length)throw new DocumentError('Choose a valid sibling position','invalid_position',422);
 const grants=(await tx.query<Grant>('SELECT g.page_id,g.subject,g.role FROM hs_grants g JOIN hs_pages p ON p.id=g.page_id WHERE p.workspace_id=$1 ORDER BY g.page_id,g.subject',[s.workspaceId])).rows;
 const after=new Map(q.rows.map(p=>[p.id,{...p,...(ids.has(p.id)?{space_id:input.spaceId}:{}),...(p.id===pageId?{parent_id:input.parentId}:{} )}]));
 const byPage=new Map<string,Grant[]>();for(const grant of grants)byPage.set(grant.page_id,[...(byPage.get(grant.page_id)??[]),grant]);
 const changes:LocationPreview['changes']=[];
 for(const member of members.rows){const beforeCache=new Map<string,PageRole|null>(),afterCache=new Map<string,PageRole|null>();for(const id of [...ids].sort()){const before=effective(nodes,byPage,member,id,beforeCache),next=effective(after,byPage,member,id,afterCache);if(before!==next)changes.push({pageId:id,pageTitle:nodes.get(id)!.title,recipientId:member.id,recipientName:member.name,before,after:next});if(changes.length>5000)throw new DocumentError('This release supports up to 5,000 access changes per move. No pages were moved.','move_limit',422);}}
 const data={pageId,title:s.root.title,descendantCount:ids.size-1,treeVersion:s.treeVersion,sourcePath:path(nodes,s.root.parent_id,s.root.space_name),targetPath:path(nodes,input.parentId,target.rows[0].name),position:{index:input.index,afterId:input.index?siblings[input.index-1].id:null,afterTitle:input.index?siblings[input.index-1].title:null},changes,expandsAccess:changes.some(c=>rank(c.after)>rank(c.before))};
 return {...s,ids,siblings,preview:{...data,digest:hash({data,intent:{spaceId:input.spaceId,parentId:input.parentId,index:input.index},nodes:q.rows,members:members.rows,grants})}};
}
export async function previewPageLocation(r:Repository,actor:Actor,pageId:string,input:LocationIntent){return r.db.transaction(async tx=>(await review(r,tx,actor,pageId,input)).preview);}
export async function movePageTree(r:Repository,actor:Actor,pageId:string,input:LocationIntent&{operationId:string;expectedTreeVersion:number;previewDigest:string;confirmExpanded:boolean}){
 const requestHash=hash(input);
 return r.db.transaction(async tx=>{
  const s=await scope(r,tx,pageId,actor),old=await tx.query<{actor_id:string;page_id:string;request_hash:string;result:{pageId:string;treeVersion:number}}>('SELECT actor_id,page_id,request_hash,result FROM hs_page_tree_operations WHERE workspace_id=$1 AND operation_id=$2',[s.workspaceId,input.operationId]);
  if(old.rows.length){const op=old.rows[0];if(op.actor_id!==actor.id||op.page_id!==pageId||op.request_hash!==requestHash)throw new DocumentError('Move operation was reused with different fields','operation_mismatch',409);return {...op.result,replayed:true};}
  if(s.treeVersion!==input.expectedTreeVersion)throw new DocumentError('The page tree changed. Review the move again.','move_conflict',409);
  const result=await review(r,tx,actor,pageId,input),p=result.preview;
  if(p.digest!==input.previewDigest)throw new DocumentError('The page, destination or access changed. Review the move again.','move_conflict',409);
  if(p.expandsAccess&&!input.confirmExpanded)throw new DocumentError('Review and explicitly confirm the expanded inherited access','access_confirmation_required',422);
  const ordered=result.siblings.map(n=>n.id);ordered.splice(input.index,0,pageId);
  await tx.query('UPDATE hs_pages SET space_id=$2,acl_version=acl_version+1 WHERE id=ANY($1::text[])',[[...result.ids],input.spaceId]);
  const published=await import('./published-pages');
  await published.retargetPublishedPages(tx,actor,[...result.ids],input.spaceId,input.operationId);
  await tx.query('UPDATE hs_pages SET parent_id=$2 WHERE id=$1',[pageId,input.parentId]);
  for(const [position,id] of ordered.entries())await tx.query('UPDATE hs_pages SET position=$2 WHERE id=$1',[id,position]);
  await tx.query('UPDATE hs_workspaces SET tree_version=tree_version+1 WHERE id=$1',[s.workspaceId]);
  const ack={pageId,treeVersion:s.treeVersion+1};
  await tx.query('INSERT INTO hs_page_tree_operations(workspace_id,operation_id,actor_id,page_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[s.workspaceId,input.operationId,actor.id,pageId,requestHash,JSON.stringify(ack)]);
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,before_value,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.id,'page.move',pageId,JSON.stringify({spaceId:s.root.space_id,parentId:s.root.parent_id}),JSON.stringify({spaceId:input.spaceId,parentId:input.parentId,index:input.index,descendants:p.descendantCount,accessDelta:p.changes}),input.operationId]);
  return {...ack,replayed:false};
 });
}

// Server-only hierarchy helpers shared with the recoverable Trash workflow.
export {subtree as pageSubtree,effective as hierarchyRole};
export type {Node as HierarchyNode,Member as HierarchyMember,Grant as HierarchyGrant};
