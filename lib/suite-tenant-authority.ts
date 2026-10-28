import {z} from 'zod';
import {authenticate,type Actor} from './auth';
import {DocumentError} from './document';
import type {CurrentSuiteTenantAuthority,RecordContext} from './shared-records';
const context=z.object({tenantId:z.string().uuid(),workspaceId:z.string().min(1).max(200)});
const proof=z.object({active:z.literal(true),subject:z.string().min(1).max(200),tenantId:z.string().uuid(),workspaceId:z.string().min(1).max(200),tenantAdministrator:z.boolean(),revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const unavailable=()=>new DocumentError('Suite tenant verification is unavailable.','record_authority_unavailable',503);
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);

/** Server-only factory. The UID and client secret live only in this closure;
 * callers receive an ordinary Actor and an authority, never a session object.
 * There is no preview, email, JWT-role or workspace-admin authority fallback. */
export async function authenticateRecordAuthority(request:Request):Promise<{actor:Actor;authority:CurrentSuiteTenantAuthority}>{
 let verified:{subject:string;uid:string}|undefined;
 const actor=await authenticate(request,(subject:string)=>{verified={subject,uid:subject};});
 if(process.env.HS_RECORDS_ENABLED!=='1')throw new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503);
 if(!verified||verified.subject!==actor.id)throw unavailable();
 const session=verified,secret=process.env.HS_OIDC_CLIENT_SECRET;
 let endpoint:URL;
 try{
  const issuer=new URL(process.env.HS_IDENTITY_ISSUER??'');
  if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash||!secret||secret.length<32)throw Error();
  endpoint=new URL('/internal/tenant/status',issuer);
 }catch{throw unavailable();}
 const authority:CurrentSuiteTenantAuthority={verify:async(ctx:RecordContext)=>{
  if(ctx.actor.id!==session.subject||!context.safeParse(ctx).success)throw missing();
  let response:Response;
  try{response=await fetch(endpoint,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(3000),headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'holy-sheet',client_secret:secret,sub:session.subject,uid:session.uid,tenant_id:ctx.tenantId,workspace_id:ctx.workspaceId})});}catch{throw unavailable();}
  if(response.status===409)throw new DocumentError('Suite authority changed during this operation.','record_authority_changed',409);
  if(!response.ok)throw unavailable();
  let body:unknown;try{body=await response.json();}catch{throw unavailable();}
  if(z.object({active:z.literal(false)}).strict().safeParse(body).success)throw missing();
  const p=proof.safeParse(body);
  if(!p.success||p.data.subject!==session.subject||p.data.tenantId!==ctx.tenantId||p.data.workspaceId!==ctx.workspaceId)throw unavailable();
  return p.data;
 }};
 return {actor,authority};
}
