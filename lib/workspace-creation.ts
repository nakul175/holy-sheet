import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from './auth';
import type {Repository} from './repository';
import {DocumentError,stableStringify} from './document';
import type {WorkspaceSummary} from './workspace-navigation';
export type WorkspaceCreation={name:string;sourceWorkspaceId:string;operationId:string};
export async function createWorkspaceIntent(r:Repository,actor:Actor,input:WorkspaceCreation){
 const name=input.name.trim();if(!name||name.length>80)throw new DocumentError('Workspace name must be between 1 and 80 characters','invalid_creation',422);
 const requestHash=createHash('sha256').update(stableStringify({...input,name})).digest('hex');
 return r.db.transaction(async tx=>{
  await tx.query('SELECT id FROM hs_users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
  const prior=await tx.query<{workspace_id:string|null;request_hash:string}>('SELECT workspace_id,request_hash FROM hs_workspace_creations WHERE actor_id=$1 AND operation_id=$2',[actor.id,input.operationId]);
  if(prior.rows.length){
   if(prior.rows[0].request_hash!==requestHash)throw new DocumentError('Creation attempt was reused with different fields','operation_mismatch',409);
   // A replay reads an existing result. It grants no new access and must still
   // pass current membership, even if the source Owner role has since changed.
   const existing=await tx.query<WorkspaceSummary>(`SELECT w.id,w.name,(m.role='owner') AS "canCreateWorkspace" FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1`,[prior.rows[0].workspace_id,actor.id]);
   if(!existing.rows.length)throw new DocumentError('Workspace unavailable','not_found',404);
   return {workspace:existing.rows[0],replayed:true,acknowledgedOperationId:input.operationId};
  }
  const source=await tx.query<{role:string;access_version:number}>(`SELECT m.role,w.access_version FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1 FOR UPDATE OF w,m`,[input.sourceWorkspaceId,actor.id]);
  if(!source.rows.length)throw new DocumentError('Workspace unavailable','not_found',404);
  if(source.rows[0].role!=='owner')throw new DocumentError('An active workspace Owner is required','owner_required',403);
  const workspace:WorkspaceSummary={id:randomUUID(),name,canCreateWorkspace:true};
  await tx.query('INSERT INTO hs_workspaces(id,name,access_model_version) VALUES($1,$2,2)',[workspace.id,name]);
  await tx.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,actor.id]);
  await tx.query('INSERT INTO hs_workspace_creations(actor_id,operation_id,source_workspace_id,workspace_id,request_hash) VALUES($1,$2,$3,$4,$5)',[actor.id,input.operationId,input.sourceWorkspaceId,workspace.id,requestHash]);
  await tx.query('INSERT INTO hs_workspace_audit(id,workspace_id,actor_id,subject_id,action,before_value,after_value,correlation_id) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[randomUUID(),workspace.id,actor.id,'workspace.create','{}',JSON.stringify({name,ownerId:actor.id,sourceWorkspaceId:input.sourceWorkspaceId,sourceRole:'owner',sourceAccessVersion:source.rows[0].access_version}),input.operationId]);
  return {workspace,replayed:false,acknowledgedOperationId:input.operationId};
 });
}
