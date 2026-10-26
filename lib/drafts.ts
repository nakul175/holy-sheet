import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocumentError } from "./document";
import type { Actor } from "./auth";
import type { Repository } from "./repository";
import { mediaReferences } from "./media";
import { canEdit } from "./types";
import { mediaIdPattern,usableMedia } from './media-authorization';

async function masterKey(){
  if(process.env.HS_RECOVERY_MASTER_KEY){const b=Buffer.from(process.env.HS_RECOVERY_MASTER_KEY,"base64");if(b.length!==32)throw new DocumentError("Recovery key service is not configured","recovery_unavailable",503);return b;}
  if(process.env.NODE_ENV==="production")throw new DocumentError("Recovery key service is not configured","recovery_unavailable",503);
  const dir=path.join(process.cwd(),".holy-sheet");await mkdir(dir,{recursive:true});const file=path.join(dir,"recovery.key");
  try{await writeFile(file,randomBytes(32),{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  return readFile(file);
}
function wrap(key:Buffer,master:Buffer,aad:string){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",master,iv);cipher.setAAD(Buffer.from(aad));const bytes=Buffer.concat([cipher.update(key),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString("base64");}
function unwrap(wrapped:string,master:Buffer,aad:string){const b=Buffer.from(wrapped,"base64"),cipher=createDecipheriv("aes-256-gcm",master,b.subarray(0,12));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(b.subarray(12,28));return Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]);}
export async function draftKey(r:Repository,actor:Actor,pageId:string,input:{id:string;renew?:boolean;attachmentIds?:string[];baseVersion?:number}){
  const master=await masterKey();
  return r.db.transaction(async tx=>{
    const p=await r.access(tx,pageId,actor,false,true);
    const {rows}=await tx.query<{id:string;user_id:string;wrapped_key:string;expires_at:string;attachment_ids:string[]}>("SELECT * FROM hs_drafts WHERE id=$1 FOR UPDATE",[input.id]);
    const aad=`${actor.id}:${pageId}:${input.id}`;
    if(rows.length){const d=rows[0];if(d.user_id!==actor.id||new Date(d.expires_at).getTime()<=Date.now())throw new DocumentError("Recovery draft is unavailable or expired","draft_expired",404);
      // A page ID is part of the key binding as well as the row predicate.
      const binding=await tx.query("SELECT id FROM hs_drafts WHERE id=$1 AND page_id=$2 AND user_id=$3",[input.id,pageId,actor.id]);if(!binding.rows.length)throw new DocumentError("Recovery draft unavailable","not_found",404);
      if(input.renew){if(!canEdit(p.role))throw new DocumentError("Read only drafts cannot be renewed","read_only",403);const refs=input.attachmentIds??d.attachment_ids;await validateReferences(r,tx,actor,pageId,refs);if(input.baseVersion!==undefined){const revision=await tx.query("SELECT version FROM hs_revisions WHERE page_id=$1 AND version=$2",[pageId,input.baseVersion]);if(!revision.rows.length)throw new DocumentError("Recovery base is unavailable","base_unavailable",409);}await tx.query("UPDATE hs_drafts SET attachment_ids=$2,base_version=COALESCE($3,base_version),expires_at=now()+interval '7 days',updated_at=now() WHERE id=$1",[input.id,JSON.stringify(refs),input.baseVersion??null]);}
      const key=unwrap(d.wrapped_key,master,aad);
      const expiry=await tx.query<{expires_at:string}>("SELECT expires_at FROM hs_drafts WHERE id=$1",[input.id]);
      return {id:input.id,key:key.toString("base64"),expiresAt:new Date(expiry.rows[0].expires_at).toISOString()};
    }
    if(!canEdit(p.role))throw new DocumentError("Read only pages cannot create drafts","read_only",403);
    const current=await r.get(pageId,actor,tx);const refs=[...new Set([...mediaReferences(current.document),...(input.attachmentIds??[])])];await validateReferences(r,tx,actor,pageId,refs);
    const key=randomBytes(32),expiresAt=new Date(Date.now()+7*86400_000).toISOString();
    await tx.query("INSERT INTO hs_drafts(id,page_id,user_id,wrapped_key,attachment_ids,base_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[input.id,pageId,actor.id,wrap(key,master,aad),JSON.stringify(refs),p.version,expiresAt]);
    return {id:input.id,key:key.toString("base64"),expiresAt};
  });
}
async function validateReferences(r:Repository,tx:Parameters<Repository["access"]>[0],actor:Actor,pageId:string,ids:string[]){
  const current=await r.get(pageId,actor,tx),active=mediaReferences(current.document);
  for(const id of ids){if(!mediaIdPattern.test(id)||!await usableMedia(tx,pageId,actor.id,id,active.has(id)))throw new DocumentError('Recovery attachment unavailable');}
}
