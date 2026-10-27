import {createHash,randomUUID} from 'node:crypto';
import type {Actor} from './auth';
import type {Sql} from './database';
import type {Repository} from './repository';
import {DocumentError,ensureIds,stableStringify,validateDocument,type RichNode} from './document';
import {parseImport} from './import-parser';
import type {ImportConversion,ImportFormat} from './import-conversion';
type ImportRow={id:string;actor_id:string;workspace_id:string;space_id:string;title:string;filename:string;format:ImportFormat;request_hash:string;review_hash:string;source_bytes:number;state:'preview'|'committed'|'cancelled'|'expired';document:RichNode|null;report:Omit<ImportConversion,'document'>;page_id:string|null;expires_at:string;live:boolean};
export type ImportRequest={id:string;spaceId:string;title:string;filename:string};
export type ImportPreview={id:string;state:ImportRow['state'];workspaceId:string;spaceId:string;title:string;filename:string;format:ImportFormat;sourceBytes:number;report:ImportRow['report'];document:RichNode|null;reviewHash:string;expiresAt:string;pageId:string|null};
const digest=(value:unknown)=>createHash('sha256').update(stableStringify(value)).digest('hex');
export function importFilename(value:string):{filename:string;format:ImportFormat}{if(!value||value.length>180||/[\u0000-\u001f\u007f/\\]/.test(value)||value==='.'||value==='..')throw new DocumentError('Use a filename of at most 180 characters without paths or control characters.','import_filename');const format=value.split('.').at(-1)?.toLowerCase();if(!['txt','md','docx'].includes(format??''))throw new DocumentError('Choose .docx, .md or .txt. Legacy Word, macros and other formats are unsupported.','import_format');return {filename:value,format:format as ImportFormat};}
async function destination(tx:Sql,actor:Actor,spaceId:string){
 const lock=await tx.query<{workspace_id:string}>('SELECT s.workspace_id FROM hs_spaces s JOIN hs_workspaces w ON w.id=s.workspace_id JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE s.id=$1 FOR UPDATE OF w,m',[spaceId,actor.id]);
 if(!lock.rows.length)throw new DocumentError('Destination unavailable. Current workspace membership is required.','not_found',404);return lock.rows[0].workspace_id;
}
async function row(tx:Sql,actor:Actor,id:string){const result=await tx.query<ImportRow>("SELECT *,expires_at>clock_timestamp() AS live FROM hs_import_jobs WHERE id=$1 AND actor_id=$2 FOR UPDATE",[id,actor.id]);if(!result.rows.length)throw new DocumentError('Import unavailable','not_found',404);return result.rows[0];}
function view(j:ImportRow):ImportPreview{return {id:j.id,state:j.state,workspaceId:j.workspace_id,spaceId:j.space_id,title:j.title,filename:j.filename,format:j.format,sourceBytes:j.source_bytes,report:j.report,document:j.state==='preview'?j.document:null,reviewHash:j.review_hash,expiresAt:new Date(j.expires_at).toISOString(),pageId:j.page_id};}
async function available(r:Repository,tx:Sql,actor:Actor,j:ImportRow){
 if(j.state==='preview'&&!j.live)throw new DocumentError('This import preview expired. Select the source file again.','import_expired',410);
 if(j.state==='expired')throw new DocumentError('This import preview expired. Select the source file again.','import_expired',410);
 if(j.state==='committed'){if(!j.page_id)throw new DocumentError('Imported page unavailable','not_found',404);await r.access(tx,j.page_id,actor);}
 return view(j);
}
export async function readImport(r:Repository,actor:Actor,id:string){return r.db.transaction(async tx=>{
 const initial=await tx.query<{space_id:string}>('SELECT space_id FROM hs_import_jobs WHERE id=$1 AND actor_id=$2',[id,actor.id]);if(!initial.rows.length)throw new DocumentError('Import unavailable','not_found',404);
 await destination(tx,actor,initial.rows[0].space_id);return available(r,tx,actor,await row(tx,actor,id));
});}
export async function prepareImport(r:Repository,actor:Actor,input:ImportRequest,source:Buffer,parse:(bytes:Buffer,format:ImportFormat)=>Promise<ImportConversion>=parseImport){
 const {filename,format}=importFilename(input.filename),title=input.title.trim();if(!title||title.length>240)throw new DocumentError('Choose a page title of 1–240 characters.','import_title');if(!source.length||source.length>20*1024*1024)throw new DocumentError('Choose one non-empty file of at most 20 MiB.','import_size',413);
 const requestHash=digest({...input,title,filename,format,sourceHash:createHash('sha256').update(source).digest('hex')});
 const prior=await r.db.transaction(async tx=>{await destination(tx,actor,input.spaceId);const existing=await tx.query<ImportRow>('SELECT *,expires_at>clock_timestamp() AS live FROM hs_import_jobs WHERE id=$1 FOR UPDATE',[input.id]);if(!existing.rows.length)return null;const j=existing.rows[0];if(j.actor_id!==actor.id)throw new DocumentError('Import unavailable','not_found',404);if(j.request_hash!==requestHash)throw new DocumentError('This import attempt was reused with different fields. Start a new import.','operation_mismatch',409);return available(r,tx,actor,j);});
 if(prior)return prior;
 // Parsing holds no DB lock, stores no source file and receives no application secrets.
 const converted=await parse(source,format),document=validateDocument(ensureIds(converted.document,true)),{document:_document,...report}=converted;
 const reviewHash=digest({title,spaceId:input.spaceId,document,report,requestHash});
 return r.db.transaction(async tx=>{const workspaceId=await destination(tx,actor,input.spaceId);const existing=await tx.query<ImportRow>('SELECT *,expires_at>clock_timestamp() AS live FROM hs_import_jobs WHERE id=$1 FOR UPDATE',[input.id]);if(existing.rows.length){const j=existing.rows[0];if(j.actor_id!==actor.id)throw new DocumentError('Import unavailable','not_found',404);if(j.request_hash!==requestHash)throw new DocumentError('This import attempt was reused with different fields.','operation_mismatch',409);return available(r,tx,actor,j);}
  await tx.query("INSERT INTO hs_import_jobs(id,actor_id,workspace_id,space_id,title,filename,format,request_hash,review_hash,source_bytes,state,document,report) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'preview',$11,$12)",[input.id,actor.id,workspaceId,input.spaceId,title,filename,format,requestHash,reviewHash,source.length,JSON.stringify(document),JSON.stringify(report)]);
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,'import.preview',JSON.stringify({jobId:input.id,workspaceId,spaceId:input.spaceId,filename,format,sourceBytes:source.length,blocks:report.blocks,omittedImages:report.omittedImages}),input.id]);return view(await row(tx,actor,input.id));
 });
}
export async function changeImport(r:Repository,actor:Actor,id:string,input:{action:'commit'|'cancel';reviewHash:string;omitImages?:boolean}){return r.db.transaction(async tx=>{
 const initial=await tx.query<{space_id:string}>('SELECT space_id FROM hs_import_jobs WHERE id=$1 AND actor_id=$2',[id,actor.id]);if(!initial.rows.length)throw new DocumentError('Import unavailable','not_found',404);await destination(tx,actor,initial.rows[0].space_id);const j=await row(tx,actor,id);
 if(j.review_hash!==input.reviewHash)throw new DocumentError('The import review does not match. Reopen the preview.','import_review',409);
 if(input.action==='cancel'){
  if(j.state==='committed')throw new DocumentError('This import already created a page. Open its confirmed result.','import_committed',409);
  if(j.state!=='cancelled'){await tx.query("UPDATE hs_import_jobs SET state='cancelled',document=NULL,completed_at=clock_timestamp() WHERE id=$1",[id]);await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,'import.cancel',JSON.stringify({jobId:id}),id]);}return {id,state:'cancelled' as const,replayed:j.state==='cancelled'};
 }
 if(j.state==='committed'){if(!j.page_id)throw new DocumentError('Imported page unavailable','not_found',404);await r.access(tx,j.page_id,actor);return {id,state:'committed' as const,pageId:j.page_id,replayed:true};}
 if(j.state!=='preview'||!j.live)throw new DocumentError('The import was cancelled or expired. Select the source again.','import_expired',410);
 if(j.report.omittedImages>0&&input.omitImages!==true)throw new DocumentError('Explicitly confirm the image omission shown in the preview before creating a page.','import_omission',422);
 if(!j.document)throw new DocumentError('Import preview unavailable. Select the source again.','import_preview_unavailable',409);
 const document=validateDocument(ensureIds(j.document,true)),pageId=randomUUID();
 // Destination capability follows HS's existing create rule: current active native
 // workspace membership. No role/email/suite claim is promoted or copied.
 await tx.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title,visibility) VALUES($1,$2,$3,$4,$5,'private')",[pageId,j.workspace_id,j.space_id,actor.id,j.title]);
 await r.writeDocument(tx,pageId,document,1,j.title,actor.id,'import');
 await tx.query("UPDATE hs_import_jobs SET state='committed',document=NULL,page_id=$2,completed_at=clock_timestamp() WHERE id=$1",[id,pageId]);
 await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'import.commit',pageId,JSON.stringify({jobId:id,workspaceId:j.workspace_id,spaceId:j.space_id,filename:j.filename,format:j.format,blocks:j.report.blocks,omittedImages:j.report.omittedImages,omissionConfirmed:input.omitImages===true}),id]);
 return {id,state:'committed' as const,pageId,replayed:false};
});}
