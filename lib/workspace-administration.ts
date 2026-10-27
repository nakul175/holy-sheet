import { createHash,randomUUID } from 'node:crypto';
import type { Actor } from './auth';
import type { Sql } from './database';
import type { Repository } from './repository';
import { DocumentError,stableStringify } from './document';

export type WorkspaceRole='member'|'admin';
export type MemberState={id:string;name:string;role:WorkspaceRole;active:boolean};
export type WorkspaceAccess={id:string;name:string;version:number;role:WorkspaceRole;canManage:boolean;members:MemberState[]};
export type MemberChange={subjectId:string;role:WorkspaceRole;active:boolean};
export type AccessPreview={version:number;before:MemberState;after:MemberState;contentAccess:'all-workspace-content'|'page-grants';preservesPageGrants:true;warning:string|null;digest:string};
const unavailable=()=>new DocumentError('Workspace is restricted or unavailable','not_found',404);
const hash=(input:unknown)=>createHash('sha256').update(stableStringify(input)).digest('hex');
async function authority(tx:Sql,id:string,actor:Actor,lock=false){
 const q=await tx.query<{id:string;name:string;version:number;role:WorkspaceRole}>(`SELECT w.id,w.name,w.access_version AS version,m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1 ${lock?'FOR UPDATE OF w,m':''}`,[id,actor.id]);
 if(!q.rows.length)throw unavailable();return q.rows[0];
}
export async function workspaceAccess(r:Repository,actor:Actor,id:string):Promise<WorkspaceAccess>{
 return r.db.transaction(async tx=>{
 const w=await authority(tx,id,actor,true);
 const members=await tx.query<MemberState>(`SELECT u.id,u.name,m.role,m.active FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND ($2::boolean OR m.user_id=$3) ORDER BY u.name,u.id`,[id,w.role==='admin',actor.id]);
 return {...w,canManage:w.role==='admin',members:members.rows};
 });
}
async function preview(tx:Sql,id:string,actor:Actor,input:MemberChange,lock=false):Promise<AccessPreview>{
 const w=await authority(tx,id,actor,lock);
 if(w.role!=='admin')throw new DocumentError('Workspace administrator access required','admin_required',403);
 const q=await tx.query<MemberState>('SELECT u.id,u.name,m.role,m.active FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2'+(lock?' FOR UPDATE OF m':''),[id,input.subjectId]);
 if(!q.rows.length)throw unavailable();const before=q.rows[0],after={...before,role:input.role,active:input.active};
 if(before.role==='admin'&&before.active&&(!after.active||after.role!=='admin')){
  const others=await tx.query('SELECT user_id FROM hs_members WHERE workspace_id=$1 AND role=\'admin\' AND active=true AND user_id!=$2',[id,input.subjectId]);
  if(!others.rows.length)throw new DocumentError('Keep at least one active workspace administrator','last_admin',409);
 }
 if(!after.active){const owned=await tx.query('SELECT id FROM hs_pages WHERE workspace_id=$1 AND owner_id=$2 LIMIT 1',[id,input.subjectId]);if(owned.rows.length)throw new DocumentError('Transfer page ownership before deactivating this member','ownership_transfer_required',409);}
 const data={version:w.version,before,after,contentAccess:after.role==='admin'?'all-workspace-content' as const:'page-grants' as const,preservesPageGrants:true as const,warning:after.role==='admin'&&after.active?'Administrators can read and edit every active page in this workspace, including private pages.':!after.active?'Workspace access will stop. Content, attribution and existing grants are preserved.':before.role==='admin'?'Administrator access ends. Direct and inherited page grants still apply.':null};
 return {...data,digest:hash(data)};
}
export async function previewMemberChange(r:Repository,actor:Actor,id:string,input:MemberChange){return r.db.transaction(tx=>preview(tx,id,actor,input,true));}
export async function changeWorkspaceMember(r:Repository,actor:Actor,id:string,input:MemberChange&{operationId:string;expectedVersion:number;previewDigest:string}){
 const requestHash=hash(input);
 return r.db.transaction(async tx=>{
  const w=await authority(tx,id,actor,true);if(w.role!=='admin')throw new DocumentError('Workspace administrator access required','admin_required',403);
  const prior=await tx.query<{actor_id:string;request_hash:string;applied_version:number}>('SELECT actor_id,request_hash,applied_version FROM hs_workspace_operations WHERE workspace_id=$1 AND operation_id=$2',[id,input.operationId]);
  if(prior.rows.length){const p=prior.rows[0];if(p.actor_id!==actor.id||p.request_hash!==requestHash)throw new DocumentError('Operation was reused with different changes','operation_mismatch',409);return {appliedVersion:p.applied_version,replayed:true};}
  if(w.version!==input.expectedVersion)throw new DocumentError('Workspace access changed. Refresh and review again.','access_conflict',409);
  const p=await preview(tx,id,actor,input,true);if(p.digest!==input.previewDigest)throw new DocumentError('Access preview changed. Review again.','access_conflict',409);
  const changed=p.before.role!==p.after.role||p.before.active!==p.after.active;
  if(changed){
   await tx.query('UPDATE hs_members SET role=$3,active=$4 WHERE workspace_id=$1 AND user_id=$2',[id,input.subjectId,input.role,input.active]);
   await tx.query('UPDATE hs_workspaces SET access_version=access_version+1 WHERE id=$1',[id]);
   await tx.query('INSERT INTO hs_workspace_audit(id,workspace_id,actor_id,subject_id,action,before_value,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),id,actor.id,input.subjectId,'membership.change',JSON.stringify(p.before),JSON.stringify(p.after),input.operationId]);
  }
  const version=w.version+(changed?1:0);
  await tx.query('INSERT INTO hs_workspace_operations(workspace_id,operation_id,actor_id,request_hash,applied_version) VALUES($1,$2,$3,$4,$5)',[id,input.operationId,actor.id,requestHash,version]);
  return {appliedVersion:version,replayed:false};
 });
}
