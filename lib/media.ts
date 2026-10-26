import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { fileTypeFromBuffer } from "file-type";
import type { Actor } from "./auth";
import { DocumentError, documentBlocks } from "./document";
import type { Repository } from "./repository";
import { canEdit } from './types';
import { mediaIdPattern,usableMedia } from './media-authorization';

export type MediaRow = {id:string;page_id:string;uploader_id:string;name:string;mime:string;size:string|number;object_key:string;state:string;replaced_id:string|null;created_at:string;sha256:string|null};
export const mediaPolicy = {images:["png","jpg","jpeg","webp","gif"],files:["pdf","docx","xlsx","pptx","csv","txt","md","markdown"],imageBytes:10_000_000,fileBytes:25_000_000,pageBytes:100_000_000,pageObjects:100};
const mimeTypes:Record<string,string>={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",pdf:"application/pdf",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",csv:"text/csv",txt:"text/plain",md:"text/markdown",markdown:"text/markdown"};
const extension=(name:string)=>name.split(".").at(-1)?.toLowerCase()??"";
export function validateMediaMetadata(name:string,size:number) {
  const ext=extension(name), mime=mimeTypes[ext];
  if(!mime||!name.trim()||name.length>240||/[\u0000-\u001f\/\\]/.test(name)||!Number.isSafeInteger(size)||size<1)throw new DocumentError("Unsupported file name or type");
  const limit=mediaPolicy.images.includes(ext)?mediaPolicy.imageBytes:mediaPolicy.fileBytes;
  if(size>limit)throw new DocumentError(`This file exceeds the ${limit/1_000_000} MB limit`,"file_too_large",413);
  return {ext,mime};
}
export async function validateMediaBytes(name:string,bytes:Uint8Array){
  const {ext,mime}=validateMediaMetadata(name,bytes.length);
  if(["txt","csv","md","markdown"].includes(ext)){try{new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new DocumentError("Text files must be valid UTF-8");}if(bytes.includes(0))throw new DocumentError("Binary content is not allowed in text files");}
  else {const detected=await fileTypeFromBuffer(bytes);if(!detected||detected.mime!==mime)throw new DocumentError("The file bytes do not match its extension");}
  if(ext==='pdf'&&/\/Encrypt\b/.test(Buffer.from(bytes).toString('latin1')))throw new DocumentError("Password-protected PDF files cannot be verified");
  if(['docx','xlsx','pptx'].includes(ext)&&/vbaProject\.bin|EncryptedPackage|EncryptionInfo/i.test(Buffer.from(bytes).toString('latin1')))throw new DocumentError("Macro-enabled or encrypted Office files are not allowed");
  return mime;
}
function client(){return new S3Client({region:process.env.S3_REGION??"us-east-1",endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});}
async function putObject(key:string,bytes:Uint8Array,mime:string){
  if(process.env.S3_BUCKET){await client().send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:key,Body:bytes,ContentType:mime}));return;}
  if(process.env.NODE_ENV==="production")throw new DocumentError("Private object storage is not configured","storage_unavailable",503);
  const dir=path.join(process.cwd(),".holy-sheet/media");await mkdir(dir,{recursive:true});await writeFile(path.join(dir,key),bytes,{mode:0o600});
}
export async function getObject(key:string):Promise<Uint8Array>{
  if(!/^[a-f0-9-]{36}$/.test(key))throw new DocumentError("File unavailable","not_found",404);
  if(process.env.S3_BUCKET){const r=await client().send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}));if(!r.Body)throw new DocumentError("File unavailable","not_found",404);return r.Body.transformToByteArray();}
  if(process.env.NODE_ENV==="production")throw new DocumentError("Private object storage is not configured","storage_unavailable",503);
  return readFile(path.join(process.cwd(),".holy-sheet/media",key));
}
export async function deleteObject(key:string){
  if(!/^[a-f0-9-]{36}$/.test(key))throw new DocumentError("Invalid storage object");
  if(process.env.S3_BUCKET){await client().send(new DeleteObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}));return;}
  if(process.env.NODE_ENV==='production')throw new DocumentError("Private storage unavailable","storage_unavailable",503);
  try{await unlink(path.join(process.cwd(),'.holy-sheet/media',key));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}
export async function scanBytes(bytes:Uint8Array):Promise<void>{
  const host=process.env.CLAMAV_HOST;
  if(!host)throw new DocumentError("Upload is quarantined. Malware scanner is not configured yet.","scanner_unavailable",503);
  await new Promise<void>((resolve,reject)=>{
    const socket=net.createConnection({host,port:Number(process.env.CLAMAV_PORT??3310)});let response="";let settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;socket.destroy();if(error)reject(error);else resolve();};
    socket.setTimeout(45_000,()=>finish(new DocumentError("Malware scanning timed out; retry","scanner_unavailable",503)));
    socket.on("error",()=>finish(new DocumentError("Malware scanner is temporarily unavailable","scanner_unavailable",503)));
    socket.on("data",chunk=>{response+=chunk.toString();if(response.length>4096)return finish(new DocumentError("Invalid scanner response","scanner_unavailable",503));if(response.includes("\0")){if(/: OK\0/.test(response))finish();else if(response.includes("FOUND"))finish(new DocumentError("This upload was rejected by malware scanning","unsafe_file",422));else finish(new DocumentError("The scanner could not verify this file","scanner_unavailable",503));}});
    socket.on("end",()=>{if(!settled)finish(new DocumentError("Incomplete scanner response","scanner_unavailable",503));});
    socket.on("connect",()=>{socket.write("zINSTREAM\0");for(let at=0;at<bytes.length;at+=65536){const chunk=bytes.subarray(at,at+65536),length=Buffer.alloc(4);length.writeUInt32BE(chunk.length);socket.write(length);socket.write(chunk);}socket.write(Buffer.alloc(4));});
  });
}
export function mediaReferences(document:Parameters<typeof documentBlocks>[0]){return new Set(documentBlocks(document).filter(b=>["image","file"].includes(b.type)).map(b=>String(b.node.attrs?.attachmentId)));}

export async function reserveMedia(r:Repository,actor:Actor,pageId:string,input:{operationId:string;name:string;size:number;replacedId?:string}){
  const {mime}=validateMediaMetadata(input.name,input.size);
  return r.db.transaction(async tx=>{
    await r.access(tx,pageId,actor,true,true);
    const {rows}=await tx.query<MediaRow&{operation_id:string}>("SELECT * FROM hs_media WHERE page_id=$1 FOR UPDATE",[pageId]);
    const existing=rows.find(m=>m.operation_id===input.operationId);
    if(existing){if(existing.uploader_id!==actor.id||existing.name!==input.name||Number(existing.size)!==input.size||existing.replaced_id!==(input.replacedId??null))throw new DocumentError("Upload operation ID was reused","operation_mismatch",409);return {id:existing.id,state:existing.state};}
    const current=await r.get(pageId,actor,tx), refs=mediaReferences(current.document);
    const active=rows.filter(m=>refs.has(m.id));
    const pending=rows.filter(m=>!refs.has(m.id)&&!["rejected","deleted","purged","purging","cancelled"].includes(m.state)&&Date.now()-new Date(m.created_at).getTime()<30*60_000);
    let creditCount=0,creditBytes=0;
    if(input.replacedId){const old=active.find(m=>m.id===input.replacedId);const referenceCount=documentBlocks(current.document).filter(b=>b.node.attrs?.attachmentId===input.replacedId).length;
      if(!old||referenceCount!==1||pending.some(m=>m.replaced_id===input.replacedId))throw new DocumentError("Replacement changed elsewhere; review the page","conflict",409);creditCount=1;creditBytes=Number(old.size);}
    if(active.length+pending.length+1-creditCount>100||[...active,...pending].reduce((sum,m)=>sum+Number(m.size),0)+input.size-creditBytes>100_000_000)throw new DocumentError("Page upload allowance exceeded. Remove active media or choose a smaller file.","quota_exceeded",422);
    const id=randomUUID();await tx.query("INSERT INTO hs_media(id,page_id,uploader_id,operation_id,name,mime,size,object_key,state,replaced_id) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$1::text,'reserved',$8)",[id,pageId,actor.id,input.operationId,input.name,mime,input.size,input.replacedId??null]);
    return {id,state:"reserved"};
  });
}
export async function mediaAccess(r:Repository,actor:Actor,id:string,edit=false){
  if(!mediaIdPattern.test(id))throw new DocumentError("File unavailable","not_found",404);
  const {rows}=await r.db.query<MediaRow>("SELECT * FROM hs_media WHERE id=$1",[id]);if(!rows.length)throw new DocumentError("File unavailable","not_found",404);
  const m=rows[0];await r.access(r.db,m.page_id,actor,edit);
  if(edit&&m.uploader_id!==actor.id)throw new DocumentError("File unavailable","not_found",404);
  if(!edit){const p=await r.get(m.page_id,actor),active=mediaReferences(p.document).has(m.id);if(m.state!=='ready'||(!active&&(!canEdit(p.role)||!await usableMedia(r.db,m.page_id,actor.id,m.id,false))))throw new DocumentError("File unavailable","not_found",404);}
  return m;
}
export async function finishMedia(r:Repository,actor:Actor,id:string,bytes:Uint8Array){
  const media=await mediaAccess(r,actor,id,true);
  if(['cancelled','purging','purged'].includes(media.state))throw new DocumentError('Upload was cancelled','upload_cancelled',409);
  const hash=createHash("sha256").update(bytes).digest("hex");
  if(media.state==="ready"){if(media.sha256!==hash)throw new DocumentError("Upload contents differ from the acknowledged file","operation_mismatch",409);return {id,state:"ready"};}
  if(Number(media.size)!==bytes.length)throw new DocumentError("Upload length differs from reserved size");
  if(Date.now()-new Date(media.created_at).getTime()>30*60_000)throw new DocumentError("Upload reservation expired; select the file again","upload_expired",409);
  const mime=await validateMediaBytes(media.name,bytes);
  const alreadyReady=await r.db.transaction(async tx=>{
    await r.access(tx,media.page_id,actor,true,true);
    const {rows}=await tx.query<MediaRow>("SELECT * FROM hs_media WHERE id=$1 FOR UPDATE",[id]);const current=rows[0];
    if(current.sha256 && current.sha256!==hash)throw new DocumentError("Upload operation contents differ","operation_mismatch",409);
    if(current.state==="ready")return true;
    if(current.state==="rejected")throw new DocumentError("Rejected uploads cannot be activated","unsafe_file",422);
    if(['cancelled','purging','purged'].includes(current.state))throw new DocumentError('Upload was cancelled','upload_cancelled',409);
    await tx.query("UPDATE hs_media SET state='processing',sha256=$2 WHERE id=$1",[id,hash]);return false;
  });
  if(alreadyReady)return {id,state:"ready"};
  await putObject(media.object_key,bytes,mime);
  try{await scanBytes(bytes);}catch(e){if(e instanceof DocumentError&&e.code==="unsafe_file")await r.db.query("UPDATE hs_media SET state='rejected' WHERE id=$1",[id]);throw e;}
  return r.db.transaction(async tx=>{await r.access(tx,media.page_id,actor,true,true);const ready=await tx.query("UPDATE hs_media SET state='ready',scanned_at=now() WHERE id=$1 AND state='processing' RETURNING id",[id]);if(!ready.rows.length)throw new DocumentError("Upload was cancelled","upload_cancelled",409);return {id,state:"ready"};});
}
export async function startMedia(r:Repository,actor:Actor,id:string){
  const m=await mediaAccess(r,actor,id,true);
  return r.db.transaction(async tx=>{await r.access(tx,m.page_id,actor,true,true);const {rows}=await tx.query<MediaRow>("SELECT * FROM hs_media WHERE page_id=$1 FOR UPDATE",[m.page_id]);const current=rows.find(row=>row.id===id)!;if(['cancelled','rejected','purging','purged'].includes(current.state))throw new DocumentError("Select the file again to start a new upload","upload_expired",409);if(rows.filter(row=>row.id!==id&&['uploading','processing'].includes(row.state)&&Date.now()-new Date(row.created_at).getTime()<30*60_000).length>=3)throw new DocumentError("Three uploads are already active. Retry when one finishes.","upload_concurrency",429);if(current.state!=='ready')await tx.query("UPDATE hs_media SET state='uploading' WHERE id=$1",[id]);});
}
export async function cancelMedia(r:Repository,actor:Actor,id:string){
  const m=await mediaAccess(r,actor,id,true);
  return r.db.transaction(async tx=>{await r.access(tx,m.page_id,actor,true,true);const p=await r.get(m.page_id,actor,tx);if(mediaReferences(p.document).has(id))throw new DocumentError("This attachment is already part of the saved page","conflict",409);const history=await tx.query("SELECT rm.media_id FROM hs_revision_media rm JOIN hs_revisions v ON v.page_id=rm.page_id AND v.version=rm.version JOIN hs_pages p ON p.id=v.page_id WHERE rm.media_id=$1 AND p.deleted_at IS NULL AND (p.version=v.version OR v.superseded_at>clock_timestamp()-interval '90 days') LIMIT 1",[id]);if(history.rows.length)throw new DocumentError('This attachment is retained in saved page history','history_retained',409);await tx.query("UPDATE hs_media SET state='cancelled',deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 AND state NOT IN ('purged','purging')",[id]);return {id,state:'cancelled'};});
}
