import { createHash,randomUUID } from 'node:crypto';
import type { Actor } from './auth';
import type { Sql } from './database';
import type { Repository } from './repository';
import { DocumentError,documentBlocks,schemaVersion,stableStringify,validateDocument,type RichNode } from './document';
import { revisionDigest } from './revision';

type Revision={version:number;title:string;document:RichNode;actor_id:string|null;author_name:string|null;created_at:string;source_surface:string;schema_version:number;restored_from:number|null;superseded_at:string|null;content_hash:string|null};
export type RevisionSummary={version:number;author:string;createdAt:string;sourceSurface:string;restoredFrom:number|null;current:boolean;expiresAt:string|null;integrity:'recorded'|'legacy'};
export type RestorePreview={previewId:string;source:RevisionSummary;title:string;document:RichNode;currentTitle:string;currentDocument:RichNode;expectedVersion:number;warnings:string[];expiresAt:string};
const unavailable=()=>new DocumentError('Saved version is unavailable or expired','history_unavailable',404);
async function historyAccess(r:Repository,tx:Sql,pageId:string,actor:Actor){const page=await r.access(tx,pageId,actor,true,true);if(page.schema_version!==schemaVersion)throw new DocumentError('This page requires a different editor schema; history cannot change it','history_schema',409);return page;}
async function audit(tx:Sql,actor:Actor,pageId:string,action:string,values:unknown,correlation:string=randomUUID()){
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,action,pageId,JSON.stringify(values),correlation]);
}
function summary(row:Revision,current:number):RevisionSummary{return {version:row.version,author:row.author_name??'Unknown author (legacy)',createdAt:new Date(row.created_at).toISOString(),sourceSurface:row.source_surface,restoredFrom:row.restored_from,current:row.version===current,expiresAt:row.superseded_at?new Date(new Date(row.superseded_at).getTime()+90*86400_000).toISOString():null,integrity:row.content_hash?'recorded':'legacy'};}
async function revision(tx:Sql,pageId:string,version:number,current:number):Promise<Revision>{
  const result=await tx.query<Revision>(`SELECT v.*,u.name AS author_name FROM hs_revisions v LEFT JOIN hs_users u ON u.id=v.actor_id WHERE v.page_id=$1 AND v.version=$2 AND v.version<=$3 AND (v.version=$3 OR v.superseded_at>clock_timestamp()-interval '90 days')`,[pageId,version,current]);
  const row=result.rows[0];if(!row)throw unavailable();
  if(!row.title.trim()||row.title.length>240)throw new DocumentError('Saved version title is malformed','history_integrity',409);
  if(row.schema_version!==schemaVersion)throw new DocumentError('This saved version requires a different editor schema','history_schema',409);
  const document=validateDocument(row.document);
  if(row.content_hash&&row.content_hash!==revisionDigest(row.title,document,row.schema_version))throw new DocumentError('Saved version integrity check failed. The live page was not changed.','history_integrity',409);
  return {...row,document};
}

async function permittedSnapshot(tx:Sql,pageId:string,source:RichNode){
  const mediaIds=new Set<string>();function collect(n:RichNode){if((n.type==='image'||n.type==='file')&&typeof n.attrs?.attachmentId==='string')mediaIds.add(n.attrs.attachmentId);n.content?.forEach(collect);}collect(source);
  const states:{id:string;state:string;hash:string|null;size:number;name:string;key:string|null;mime:string|null}[]=[];
  for(const id of [...mediaIds].sort()){
    const m=await tx.query<{state:string;sha256:string|null;size:string;name:string;object_key:string;mime:string}>('SELECT state,sha256,size,name,object_key,mime FROM hs_media WHERE id=$1 AND page_id=$2 FOR UPDATE',[id,pageId]);
    states.push({id,state:m.rows[0]?.state??'missing',hash:m.rows[0]?.sha256??null,size:Number(m.rows[0]?.size??0),name:m.rows[0]?.name??'Unknown attachment',key:m.rows[0]?.object_key??null,mime:m.rows[0]?.mime??null});
  }
  const unavailableIds=new Set(states.filter(m=>m.state!=='ready').map(m=>m.id));
  function copy(n:RichNode):RichNode{if((n.type==='image'||n.type==='file')&&unavailableIds.has(String(n.attrs?.attachmentId))){const item=states.find(m=>m.id===n.attrs?.attachmentId)!;return {type:'paragraph',attrs:{id:n.attrs?.id},content:[{type:'text',text:`Unavailable attachment: ${item.name}`} ]};}return {...n,...(n.content?{content:n.content.map(copy)}:{})};}
  const warnings=states.filter(m=>m.state!=='ready').map(m=>`${m.name} is unavailable and will be represented by a text placeholder.`);
  const document=validateDocument(copy(source));
  const ready=states.filter(m=>m.state==='ready');if(ready.length>100||ready.reduce((n,m)=>n+m.size,0)>100_000_000)throw new DocumentError('This saved version exceeds the current attachment allowance','history_quota',422);
  return {document,warnings,signature:createHash('sha256').update(stableStringify(states)).digest('hex')};
}

export async function listHistory(r:Repository,actor:Actor,pageId:string,before?:number){
  return r.db.transaction(async tx=>{
    const page=await historyAccess(r,tx,pageId,actor),ceiling=Math.min(before??page.version+1,page.version+1);
    const result=await tx.query<Revision>(`SELECT v.*,u.name AS author_name FROM hs_revisions v LEFT JOIN hs_users u ON u.id=v.actor_id WHERE v.page_id=$1 AND v.version<$2 AND (v.version=$3 OR v.superseded_at>clock_timestamp()-interval '90 days') ORDER BY v.version DESC LIMIT 21`,[pageId,ceiling,page.version]);
    const items=result.rows.slice(0,20);await audit(tx,actor,pageId,'history.list',{before:ceiling,versions:items.map(v=>v.version)});
    return {versions:items.map(v=>summary(v,page.version)),nextBefore:result.rows.length>20?items.at(-1)!.version:null,currentVersion:page.version,retentionDays:90};
  });
}
export async function previewHistory(r:Repository,actor:Actor,pageId:string,version:number):Promise<RestorePreview>{
  return r.db.transaction(async tx=>{
    const page=await historyAccess(r,tx,pageId,actor),source=await revision(tx,pageId,version,page.version),current=await r.get(pageId,actor,tx),snapshot=await permittedSnapshot(tx,pageId,source.document),previewId=randomUUID();
    const expiry=await tx.query<{expires_at:string}>("INSERT INTO hs_restore_previews(id,user_id,page_id,source_version,expected_version,media_signature,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes') RETURNING expires_at",[previewId,actor.id,pageId,version,page.version,snapshot.signature]);
    await audit(tx,actor,pageId,'history.preview',{sourceVersion:version,currentVersion:page.version});
    if(!source.content_hash)snapshot.warnings.unshift('This legacy snapshot predates integrity recording; its structure has been validated and original authorship is unknown where not recorded.');
    return {previewId,source:summary(source,page.version),title:source.title,document:snapshot.document,currentTitle:current.title,currentDocument:current.document,expectedVersion:page.version,warnings:snapshot.warnings,expiresAt:new Date(expiry.rows[0].expires_at).toISOString()};
  });
}
export async function recordHistoryCompare(r:Repository,actor:Actor,pageId:string,version:number){return r.db.transaction(async tx=>{const page=await historyAccess(r,tx,pageId,actor);await revision(tx,pageId,version,page.version);await audit(tx,actor,pageId,'history.compare',{sourceVersion:version,currentVersion:page.version});return {recorded:true};});}

export async function restoreHistory(r:Repository,actor:Actor,pageId:string,input:{operationId:string;previewId:string;sourceVersion:number;expectedVersion:number}){
  const hash=createHash('sha256').update(stableStringify(input)).digest('hex');
  try{return await r.db.transaction(async tx=>{
    const page=await historyAccess(r,tx,pageId,actor);
    const old=await tx.query<{actor_id:string;request_hash:string;result_version:number;source_version:number;warnings:string[]}>('SELECT * FROM hs_history_operations WHERE page_id=$1 AND operation_id=$2',[pageId,input.operationId]);
    if(old.rows.length){const op=old.rows[0];if(op.actor_id!==actor.id||op.request_hash!==hash)throw new DocumentError('Restore operation ID was reused for another request','operation_mismatch',409);return {page:await r.get(pageId,actor,tx),committedVersion:op.result_version,sourceVersion:op.source_version,warnings:op.warnings,replayed:true};}
    if(page.version!==input.expectedVersion)throw new DocumentError('The live page changed after this review. Refresh and compare before restoring.','history_conflict',409);
    if(input.sourceVersion===page.version)throw new DocumentError('This version is already current','history_current',422);
    const preview=await tx.query<{media_signature:string}>('SELECT media_signature FROM hs_restore_previews WHERE id=$1 AND user_id=$2 AND page_id=$3 AND source_version=$4 AND expected_version=$5 AND expires_at>clock_timestamp() FOR UPDATE',[input.previewId,actor.id,pageId,input.sourceVersion,input.expectedVersion]);
    if(!preview.rows.length)throw new DocumentError('The restore review expired or is unavailable. Refresh the preview.','history_preview_expired',409);
    const source=await revision(tx,pageId,input.sourceVersion,page.version),snapshot=await permittedSnapshot(tx,pageId,source.document);
    if(snapshot.signature!==preview.rows[0].media_signature)throw new DocumentError('Attachment availability changed. Refresh and review the warnings.','history_media_changed',409);
    const ids=documentBlocks(snapshot.document).map(b=>b.id);for(const id of ids){const collision=await tx.query('SELECT id FROM hs_blocks WHERE id=$1 AND page_id!=$2',[id,pageId]);if(collision.rows.length)throw new DocumentError('A saved block identity conflicts with another page. No content was replaced.','history_identity_conflict',409);}
    const version=page.version+1;
    await r.writeDocument(tx,pageId,snapshot.document,version,source.title,actor.id,'history-restore',source.version);
    await tx.query('UPDATE hs_pages SET title=$2,version=$3,updated_at=clock_timestamp() WHERE id=$1',[pageId,source.title,version]);
    await tx.query("UPDATE hs_media m SET deleted_at=CASE WHEN EXISTS(SELECT 1 FROM hs_blocks b WHERE b.page_id=$1 AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=m.id::text) THEN NULL ELSE COALESCE(m.deleted_at,clock_timestamp()) END WHERE m.page_id=$1 AND m.state='ready'",[pageId]);
    await tx.query('INSERT INTO hs_history_operations(page_id,operation_id,actor_id,request_hash,result_version,source_version,warnings) VALUES($1,$2,$3,$4,$5,$6,$7)',[pageId,input.operationId,actor.id,hash,version,source.version,JSON.stringify(snapshot.warnings)]);
    await audit(tx,actor,pageId,'history.restore',{sourceVersion:source.version,previousVersion:page.version,resultVersion:version},input.operationId);
    return {page:await r.get(pageId,actor,tx),committedVersion:version,sourceVersion:source.version,warnings:snapshot.warnings,replayed:false};
  });}catch(error){
    // Failure audit is outside the rolled-back restore and never contains historical content.
    try{await r.db.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) SELECT $1,u.id,$3,p.id,$5,$6 FROM hs_users u CROSS JOIN hs_pages p WHERE u.id=$2 AND p.id=$4',[randomUUID(),actor.id,'history.restore.failed',pageId,JSON.stringify({sourceVersion:input.sourceVersion,expectedVersion:input.expectedVersion,code:error instanceof DocumentError?error.code:'service_unavailable'}),input.operationId]);}catch{ /* A failed audit cannot turn a failed restore into success. */ }
    throw error;
  }
}
