import { createHash,randomUUID } from 'node:crypto';
import type { Actor } from './auth';
import type { Repository } from './repository';
import type { Sql } from './database';
import { DocumentError,stableStringify } from './document';

type Role='editor'|'commenter'|'viewer';
export type SharingState={version:number;members:{id:string;name:string}[];direct:{id:string;name:string;role:Role;active:boolean}[];inherited:{sourceId:string;sourceTitle:string;sourceReadable:boolean;recipientId:string;recipientName:string;role:Role}[]};
export type ShareChange={operationId:string;expectedVersion:number;recipientId:string;role:Role|null};
async function recipientRole(r:Repository,tx:Sql,pageId:string,id:string){try{return (await r.access(tx,pageId,{id})).role;}catch(e){if(e instanceof DocumentError&&e.status===404)return null;throw e;}}

export async function sharingState(r:Repository,actor:Actor,pageId:string,tx:Sql=r.db):Promise<SharingState>{
  const page=await r.access(tx,pageId,actor);
  if(page.role!=='owner')throw new DocumentError('Only the page owner can manage sharing','owner_required',403);
  const members=await tx.query<{id:string;name:string}>(`SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active=true AND u.id!=$2 ORDER BY u.name,u.id`,[page.workspace_id,page.owner_id]);
  const direct=await tx.query<SharingState['direct'][number]>(`SELECT u.id,u.name,g.role,COALESCE(m.active,false) AS active FROM hs_grants g JOIN hs_users u ON u.id=g.subject LEFT JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 WHERE g.page_id=$1 ORDER BY u.name,u.id`,[pageId,page.workspace_id]);
  const inherited=await tx.query<{sourceId:string;sourceTitle:string;recipientId:string;recipientName:string;role:Role}>(`WITH RECURSIVE ancestors AS (
    SELECT id,parent_id,workspace_id,title,owner_id,visibility,ARRAY[id] AS path FROM hs_pages WHERE id=$1
    UNION ALL SELECT p.id,p.parent_id,p.workspace_id,p.title,p.owner_id,p.visibility,a.path||p.id FROM hs_pages p JOIN ancestors a ON p.id=a.parent_id AND p.workspace_id=a.workspace_id WHERE p.deleted_at IS NULL AND NOT p.id=ANY(a.path)
  ) SELECT a.id AS "sourceId",a.title AS "sourceTitle",u.id AS "recipientId",u.name AS "recipientName",g.role FROM ancestors a JOIN hs_grants g ON g.page_id=a.id JOIN hs_users u ON u.id=g.subject WHERE a.id!=$1
  UNION ALL SELECT a.id,a.title,u.id,u.name,'editor' FROM ancestors a JOIN hs_users u ON u.id=a.owner_id WHERE a.id!=$1
  UNION ALL SELECT a.id,a.title,'space','Active workspace members',g.role FROM ancestors a JOIN hs_grants g ON g.page_id=a.id AND g.subject='space' WHERE a.visibility='space'`,[pageId]);
  const readable=new Set<string>();for(const id of new Set(inherited.rows.map(x=>x.sourceId))){try{await r.access(tx,id,actor);readable.add(id);}catch(e){if(!(e instanceof DocumentError&&e.status===404))throw e;}}
  return {version:page.acl_version,members:members.rows,direct:direct.rows,inherited:inherited.rows.map(x=>({...x,sourceTitle:readable.has(x.sourceId)?x.sourceTitle:'Restricted ancestor',sourceReadable:readable.has(x.sourceId)}))};
}

export async function changeSharing(r:Repository,actor:Actor,pageId:string,input:ShareChange){
  const hash=createHash('sha256').update(stableStringify(input)).digest('hex');
  return r.db.transaction(async tx=>{
    const page=await r.access(tx,pageId,actor,false,true);
    if(page.role!=='owner')throw new DocumentError('Only the page owner can manage sharing','owner_required',403);
    const existing=await tx.query<{actor_id:string;request_hash:string;applied_version:number}>('SELECT * FROM hs_share_operations WHERE page_id=$1 AND operation_id=$2',[pageId,input.operationId]);
    if(existing.rows.length){const op=existing.rows[0];if(op.actor_id!==actor.id||op.request_hash!==hash)throw new DocumentError('Operation ID was reused with a different sharing change','operation_mismatch',409);return {state:await sharingState(r,actor,pageId,tx),appliedVersion:op.applied_version,replayed:true,effectiveRole:await recipientRole(r,tx,pageId,input.recipientId)};}
    if(page.acl_version!==input.expectedVersion)throw new DocumentError('Sharing changed since your preview. Refresh and review before applying.','sharing_conflict',409);
    if(input.recipientId===page.owner_id)throw new DocumentError('Page ownership is separate from sharing','owner_protected',422);
    const old=await tx.query<{role:Role}>('SELECT role FROM hs_grants WHERE page_id=$1 AND subject=$2 FOR UPDATE',[pageId,input.recipientId]);
    if(input.role!==null){const member=await tx.query('SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true FOR UPDATE',[page.workspace_id,input.recipientId]);if(!member.rows.length)throw new DocumentError('Choose an active member of this workspace','member_required',422);}
    const before=old.rows[0]?.role??null,changed=before!==input.role;
    if(changed){
      if(input.role===null)await tx.query('DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2',[pageId,input.recipientId]);
      else await tx.query('INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3) ON CONFLICT(page_id,subject) DO UPDATE SET role=excluded.role',[pageId,input.recipientId,input.role]);
      await tx.query('UPDATE hs_pages SET acl_version=acl_version+1 WHERE id=$1',[pageId]);
      await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,before_value,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),actor.id,'sharing.change',pageId,input.recipientId,JSON.stringify({role:before}),JSON.stringify({role:input.role}),input.operationId]);
    }
    const version=page.acl_version+(changed?1:0);
    await tx.query('INSERT INTO hs_share_operations(page_id,operation_id,actor_id,request_hash,applied_version) VALUES($1,$2,$3,$4,$5)',[pageId,input.operationId,actor.id,hash,version]);
    const effectiveRole=await recipientRole(r,tx,pageId,input.recipientId);
    return {state:await sharingState(r,actor,pageId,tx),appliedVersion:version,replayed:false,effectiveRole};
  });
}
