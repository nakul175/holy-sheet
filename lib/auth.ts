import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { DocumentError } from "./document";

export type Actor = { id: string; name?: string };
export const localActor: Actor = {id:"00000000-0000-4000-8000-000000000001",name:"Your workspace"};
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyIdentityToken(token:string,keyset:JWTVerifyGetKey,issuer:string,audience:string):Promise<Actor>{
  const {payload}=await jwtVerify(token,keyset,{issuer,audience,algorithms:['RS256','ES256'],requiredClaims:['sub','exp','iat'],maxTokenAge:'1h',clockTolerance:5});
  if(!payload.sub||payload.sub.length>200||payload.exp!-Number(payload.iat)>3600||payload.exp!<=Number(payload.iat))throw new Error('Invalid session');
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
export async function authenticate(request: Request): Promise<Actor> {
  if(localPreview(request)) return localActor;
  const issuer=process.env.HS_IDENTITY_ISSUER, jwks=process.env.HS_IDENTITY_JWKS_URL;
  if(!issuer || !jwks) throw new DocumentError("Suite identity is not configured", "identity_unavailable", 503);
  if(!jwks.startsWith("https://")) throw new DocumentError("Secure identity configuration required", "identity_unavailable",503);
  const bearer=request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const cookie=request.headers.get("cookie")?.split(";").map(c=>c.trim()).find(c=>c.startsWith("hs_session="))?.slice(11);
  const token=bearer ?? cookie;
  if(!token) throw new DocumentError("Sign in to open this page", "authentication_required",401);
  try {
    let keyset=keys.get(jwks);if(!keyset){keyset=createRemoteJWKSet(new URL(jwks));keys.set(jwks,keyset);}
    return await verifyIdentityToken(token,keyset,issuer,process.env.HS_IDENTITY_AUDIENCE??'holy-sheet');
  } catch { throw new DocumentError("Session is invalid or expired", "authentication_required",401); }
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
    if(e instanceof DocumentError) return Response.json({error:e.message,code:e.code,retryable:e.status>=500},{status:e.status,headers:{"Cache-Control":"no-store"}});
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
