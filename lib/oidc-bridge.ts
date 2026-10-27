import { createCipheriv,createDecipheriv,randomBytes,timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { safeSignInReturn } from './auth-paths';
export { safeSignInReturn } from './auth-paths';

const loginCookie='__Host-hs_login',logoutCookie='__Host-hs_logout';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
type Login={kind:'login';state:string;nonce:string;verifier:string;next:string;issued:number};
type Logout={kind:'logout';state:string;issued:number};
const now=()=>Math.floor(Date.now()/1000);
function cookie(name:string,value:string,age:number){return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;}
function readCookie(request:Request,name:string){const values=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));return values.length===1?values[0].slice(name.length+1):'';}
function equal(a:string,b:string){const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function redirect(url:string){return new Response(null,{status:303,headers:{...headers,Location:url}});}
function signedIn(destination:string){
 const nonce=randomBytes(18).toString('base64');
 // The route is a standalone document: notify other same-origin tabs before opening
 // the new identity. Only an anonymous marker and an allowlisted path reach JavaScript.
 const script=`try{localStorage.setItem('hs-session-signout',crypto.randomUUID())}catch{}location.replace(${JSON.stringify(destination)});`;
 return new Response(`<!doctype html><html lang="en"><title>Holy Sheet</title><main><h1>Signed in.</h1><p>Opening Holy Sheet…</p><noscript><a href="${destination}">Continue to Holy Sheet</a></noscript></main><script nonce="${nonce}">${script}</script></html>`,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`}});
}
function failure(status=503){return new Response('<!doctype html><html lang="en"><title>Holy Sheet sign-in</title><main><h1>Sign-in unavailable</h1><p>The sign-in request could not be completed. Return to Holy Sheet and try again.</p><a href="/">Return to Holy Sheet</a></main></html>',{status,headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});}
function origin(value:string|undefined){if(!value)throw Error('Missing origin');const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)throw Error('Invalid origin');return url.origin;}

/** Confidential code/PKCE bridge. No refresh tokens, entitlement creation or email binding. */
export function createOidcBridge(env:Readonly<Record<string,string|undefined>>,options:{fetch?:oidc.CustomFetch}={}){
 if(env.HS_OIDC_ENABLED!=='1')throw Error('Sign-in disabled');
 const app=origin(env.HS_ORIGIN),issuer=origin(env.HS_IDENTITY_ISSUER),secret=env.HS_OIDC_CLIENT_SECRET??'',key=Buffer.from(env.HS_OIDC_TRANSACTION_KEY??'','base64');
 if(secret.length<32||secret.length>1024||key.length!==32||key.toString('base64')!==env.HS_OIDC_TRANSACTION_KEY||(env.HS_IDENTITY_AUDIENCE??'holy-sheet')!=='holy-sheet')throw Error('Invalid sign-in configuration');
 const callbackUrl=app+'/auth/callback',signedOutUrl=app+'/auth/signed-out';
 let configuration:Promise<oidc.Configuration>|undefined;
 async function config(){
  if(!configuration)configuration=oidc.discovery(new URL(issuer),'holy-sheet',{id_token_signed_response_alg:'RS256'},oidc.ClientSecretBasic(secret),{timeout:10,...(options.fetch?{[oidc.customFetch]:options.fetch}:{})}).then(value=>{
   const metadata=value.serverMetadata();
   if(metadata.issuer!==issuer||!metadata.supportsPKCE())throw Error('Unsupported issuer');
   for(const name of ['authorization_endpoint','token_endpoint','jwks_uri','end_session_endpoint'] as const){const endpoint=metadata[name];if(typeof endpoint!=='string')throw Error('Missing issuer endpoint');const url=new URL(endpoint);if(url.origin!==issuer||url.username||url.password||url.hash)throw Error('Invalid issuer endpoint');}
   if(metadata.jwks_uri!==env.HS_IDENTITY_JWKS_URL)throw Error('Signing key endpoint mismatch');
   oidc.enableNonRepudiationChecks(value);return value;
  }).catch(error=>{configuration=undefined;throw error;});
  return configuration;
 }
 function seal(value:Login|Logout){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`holy-sheet-oidc:${value.kind}:v1`));const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');}
 function open<K extends 'login'|'logout'>(value:string,kind:K):Extract<Login|Logout,{kind:K}>{
  if(!/^[A-Za-z0-9_-]{40,2048}$/.test(value))throw Error('Invalid transaction');const data=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAAD(Buffer.from(`holy-sheet-oidc:${kind}:v1`));decipher.setAuthTag(data.subarray(12,28));
  const result=JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')) as Login|Logout;
  if(result.kind!==kind||!Number.isInteger(result.issued)||result.issued>now()+5||now()-result.issued>300||typeof result.state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.state))throw Error('Expired transaction');
  if(result.kind==='login'&&(!/^[A-Za-z0-9_-]{43}$/.test(result.nonce)||!/^[A-Za-z0-9_-]{43,128}$/.test(result.verifier)||safeSignInReturn(result.next)!==result.next))throw Error('Invalid login transaction');
  return result as Extract<Login|Logout,{kind:K}>;
 }
 async function signIn(request:Request){
  try{
   const incoming=new URL(request.url);if(incoming.search.length>1000)throw Error('Oversized return path');
   const transaction:Login={kind:'login',state:oidc.randomState(),nonce:oidc.randomNonce(),verifier:oidc.randomPKCECodeVerifier(),next:safeSignInReturn(incoming.searchParams.get('next')),issued:now()};
   const target=oidc.buildAuthorizationUrl(await config(),{response_type:'code',redirect_uri:callbackUrl,scope:'openid email profile aplyd',state:transaction.state,nonce:transaction.nonce,code_challenge:await oidc.calculatePKCECodeChallenge(transaction.verifier),code_challenge_method:'S256'});
   const response=redirect(target.href);response.headers.append('Set-Cookie',cookie(loginCookie,seal(transaction),300));return response;
  }catch{return failure();}
 }
 async function callback(request:Request){
  let response:Response;
  try{
   const incoming=new URL(request.url);if(incoming.search.length>8192)throw Error('Oversized callback');
   const transaction=open(readCookie(request,loginCookie),'login');
   if(incoming.searchParams.getAll('state').length!==1||!equal(incoming.searchParams.get('state')??'',transaction.state))throw Error('Invalid state');
   if(incoming.searchParams.has('iss')&&incoming.searchParams.get('iss')!==issuer)throw Error('Invalid issuer');
   const url=new URL(callbackUrl);url.search=incoming.search;
   const tokens=await oidc.authorizationCodeGrant(await config(),url,{pkceCodeVerifier:transaction.verifier,expectedState:transaction.state,expectedNonce:transaction.nonce,idTokenExpected:true});
   const claims=tokens.claims(),token=tokens.id_token;
   if(!claims||typeof claims.sub!=='string'||!claims.sub||claims.sub.length>200||!token||token.length>3800||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.iat!>now()+5||claims.exp!<=now()||claims.exp!-claims.iat!>3600||claims.exp!<=claims.iat!||now()-claims.iat!>3600)throw Error('Invalid session lifetime');
   response=signedIn(app+transaction.next);const age=Math.min(3600,claims.exp!-now());response.headers.append('Set-Cookie',cookie('hs_session',token,age));response.headers.append('Set-Cookie',cookie('__Host-hs_session',token,age));
  }catch{response=failure(400);}
  response.headers.append('Set-Cookie',cookie(loginCookie,'',0));return response;
 }
 async function signOut(request:Request){
  if(request.headers.get('origin')!==app)return failure(403);
  const wantsJson=request.headers.get('accept')?.includes('application/json');let response:Response;
  try{
   const transaction:Logout={kind:'logout',state:oidc.randomState(),issued:now()};
   const target=oidc.buildEndSessionUrl(await config(),{client_id:'holy-sheet',post_logout_redirect_uri:signedOutUrl,state:transaction.state});
   response=wantsJson?Response.json({redirect:target.href},{headers}):redirect(target.href);
   response.headers.append('Set-Cookie',cookie(logoutCookie,seal(transaction),300));
  }catch{response=wantsJson?Response.json({error:'Local session ended. Suite sign-out is unavailable.',localSignedOut:true},{status:503,headers}):failure();}
  response.headers.append('Set-Cookie',cookie('hs_session','',0));response.headers.append('Set-Cookie',cookie('__Host-hs_session','',0));response.headers.append('Set-Cookie',cookie(loginCookie,'',0));return response;
 }
 async function signedOut(request:Request){
  let response:Response;try{const transaction=open(readCookie(request,logoutCookie),'logout'),params=new URL(request.url).searchParams;if(params.getAll('state').length!==1||!equal(params.get('state')??'',transaction.state))throw Error('Invalid logout state');response=redirect(app+'/');response.headers.append('Set-Cookie',cookie('hs_session','',0));response.headers.append('Set-Cookie',cookie('__Host-hs_session','',0));}catch{response=failure(400);}response.headers.append('Set-Cookie',cookie(logoutCookie,'',0));return response;
 }
 return {signIn,callback,signOut,signedOut};
}
let runtime:ReturnType<typeof createOidcBridge>|undefined;
export async function oidcRoute(action:keyof ReturnType<typeof createOidcBridge>,request:Request){try{return await (runtime??=createOidcBridge(process.env))[action](request);}catch{return failure();}}
