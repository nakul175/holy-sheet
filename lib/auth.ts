import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey,type JWTPayload } from "jose";
import { DocumentError } from "./document";
import { requireActiveSuiteSession } from './suite-session';
import {requireSuiteApplicationAccess} from './suite-application-access';

export type Actor = { id: string; name?: string };
export const localActor: Actor = {id:"00000000-0000-4000-8000-000000000001",name:"Your workspace"};
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyIdentityToken(token:string,keyset:JWTVerifyGetKey,issuer:string,audience:string,checkSession?:(payload:JWTPayload)=>Promise<void>):Promise<Actor>{
  const {payload}=await jwtVerify(token,keyset,{issuer,audience,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat'],maxTokenAge:'1h',clockTolerance:5});
  if(!payload.sub||payload.sub.length>200||payload.exp!-Number(payload.iat)>3600||payload.exp!<=Number(payload.iat))throw new Error('Invalid session');
  // Never send an unverified subject/session identifier to the live authority.
  if(checkSession)await checkSession(payload);
  return {id:payload.sub};
}
export function localPreview(request: Request) {
  const host=request.headers.get("host")??new URL(request.url).host;
  return process.env.NODE_ENV !== "production" && process.env.HS_LOCAL_PREVIEW !== "0" && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) && ["localhost","127.0.0.1","[::1]"].includes(new URL(request.url).hostname);
}
export function sameOrigin(request: Request) {
  const url=new URL(request.url);
  const expected = process.env.HS_ORIGIN ?? (localPreview(request)?`${url.protocol}//${request.headers.get('host')??url.host}`:url.origin);
  if(process.env.NODE_ENV==='production'&&!process.env.HS_ORIGIN)throw new DocumentError("Application origin is not configured","origin_unavailable",503);
  if(request.headers.get("origin") !== expected) throw new DocumentError("Request origin is not allowed", "origin_denied", 403);
}
export function identityTokenFromRequest(request:Request,requireProtectedCookie=false){
  const bearer=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(bearer)return bearer;
  const cookies=(request.headers.get('cookie')??'').split(';').map(value=>value.trim());
  const values=(name:string)=>cookies.filter(value=>value.startsWith(name+'=')).map(value=>value.slice(name.length+1));
  const protectedValues=values('__Host-hs_session'),legacy=values('hs_session');
  if(protectedValues.length>1||legacy.length>1||(protectedValues.length&&legacy.length&&protectedValues[0]!==legacy[0]))return;
  if(requireProtectedCookie&&!protectedValues.length)return;
  return protectedValues[0]??legacy[0];
}
export async function authenticate(request: Request, onVerifiedSuiteSession?: (subject:string,uid:string)=>void): Promise<Actor> {
  if(localPreview(request)) return localActor;
  const issuer=process.env.HS_IDENTITY_ISSUER, jwks=process.env.HS_IDENTITY_JWKS_URL;
  if(!issuer || !jwks) throw new DocumentError("Suite identity is not configured", "identity_unavailable", 503);
  if(!jwks.startsWith("https://")) throw new DocumentError("Secure identity configuration required", "identity_unavailable",503);
  const token=identityTokenFromRequest(request,process.env.HS_OIDC_ENABLED==='1');
  if(!token) throw new DocumentError("Sign in to open this page", "authentication_required",401);
  try {
    let keyset=keys.get(jwks);if(!keyset){keyset=createRemoteJWKSet(new URL(jwks));keys.set(jwks,keyset);}
    const checkSession=process.env.HS_OIDC_ENABLED==='1'?async(payload:JWTPayload)=>{
      await requireActiveSuiteSession(payload.sub!,payload.aplyd_session_uid,issuer,process.env.HS_OIDC_CLIENT_SECRET);
      await requireSuiteApplicationAccess(payload.sub!,payload.aplyd_session_uid as string,issuer,process.env.HS_OIDC_CLIENT_SECRET);
      // This server-only callback runs after JWT and current source-session checks.
      // The public Actor and all existing API responses still contain no session UID.
      onVerifiedSuiteSession?.(payload.sub!,payload.aplyd_session_uid as string);
    }:undefined;
    return await verifyIdentityToken(token,keyset,issuer,process.env.HS_IDENTITY_AUDIENCE??'holy-sheet',checkSession);
  } catch(error) { if(error instanceof DocumentError)throw error;throw new DocumentError("Session is invalid or expired", "authentication_required",401); }
}

export async function api(request: Request, fn: (actor: Actor)=>Promise<unknown>, mutation = false) {
  try {
    if(mutation) sameOrigin(request);
    const actor=await authenticate(request);
    if(process.env.NODE_ENV==='production'&&process.env.HS_RICH_EDITOR_ENABLED!=='1')throw new DocumentError("The document editor is not enabled in this environment","feature_disabled",503);
    const result=await fn(actor);
    if(result instanceof Response)return result;
    return Response.json(result,{headers:{"Cache-Control":"no-store","Vary":"Cookie, Authorization"}});
  } catch(e) {
    if(e instanceof DocumentError){const body:Record<string,unknown>={error:e.message,code:e.code,retryable:e.status>=500};if(e.details!==undefined)body.details=e.details;return Response.json(body,{status:e.status,headers:{"Cache-Control":"no-store"}});}
    console.error("HS request failed", e instanceof Error ? e.name : "UnknownError");
    return Response.json({error:"Service temporarily unavailable",code:"service_unavailable",retryable:true},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
export async function readJson(request: Request, limit=25_000_000) {
  const bytes=await readBytes(request,limit);
  try{return JSON.parse(Buffer.from(bytes).toString("utf8"));}catch{throw new DocumentError("Invalid JSON");}
}
export async function readBytes(request: Request, limit=25_000_000) {
  const reader=request.body?.getReader();if(!reader) throw new DocumentError("Request body required");
  let size=0;const chunks:Uint8Array[]=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new DocumentError("Request exceeds its size limit","payload_too_large",413);}chunks.push(value);}
  return Buffer.concat(chunks);
}
