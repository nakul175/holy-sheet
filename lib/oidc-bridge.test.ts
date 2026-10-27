import { beforeAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import type { CustomFetch } from 'openid-client';
import { createOidcBridge,safeSignInReturn } from './oidc-bridge';
import { identityTokenFromRequest,verifyIdentityToken } from './auth';

const issuer='https://accounts.example.test',app='https://hs.example.test',secret='c'.repeat(32);
const env={HS_OIDC_ENABLED:'1',HS_ORIGIN:app,HS_IDENTITY_ISSUER:issuer,HS_IDENTITY_JWKS_URL:issuer+'/jwks',HS_IDENTITY_AUDIENCE:'holy-sheet',HS_OIDC_CLIENT_SECRET:secret,HS_OIDC_TRANSACTION_KEY:Buffer.alloc(32,7).toString('base64')};
let privateKey:CryptoKey,jwk:Awaited<ReturnType<typeof exportJWK>>,nonce='',challenge='',used=false,tokenCalls=0;
let override:Record<string,unknown>={},metadataPatch:Record<string,unknown>={},badSignature=false;
beforeAll(async()=>{const pair=await generateKeyPair('RS256');privateKey=pair.privateKey;jwk={...await exportJWK(pair.publicKey),alg:'RS256',kid:'fixture'};});
beforeEach(()=>{nonce='';challenge='';used=false;tokenCalls=0;override={};metadataPatch={};badSignature=false;});
afterEach(()=>vi.useRealTimers());
const json=(data:unknown,status=200)=>Response.json(data,{status});
const network:CustomFetch=async(input,init)=>{
 const url=new URL(String(input));
 if(url.href===issuer+'/.well-known/openid-configuration')return json({issuer,authorization_endpoint:issuer+'/auth',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',end_session_endpoint:issuer+'/session/end',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_basic'],code_challenge_methods_supported:['S256'],...metadataPatch});
 if(url.href===issuer+'/jwks')return json({keys:[jwk]});
 if(url.href===issuer+'/token'){
  tokenCalls++;const params=new URLSearchParams(String(init?.body));
  const authorization=new Headers(init?.headers).get('authorization')!;expect(authorization.startsWith('Basic ')).toBe(true);expect(Buffer.from(authorization.slice(6),'base64').toString().split(':').map(v=>decodeURIComponent(v.replace(/\+/g,' ')))).toEqual(['holy-sheet',secret]);
  expect(params.get('redirect_uri')).toBe(app+'/auth/callback');expect(params.get('grant_type')).toBe('authorization_code');
  expect(createHash('sha256').update(params.get('code_verifier')??'').digest('base64url')).toBe(challenge);
  if(used)return json({error:'invalid_grant'},400);used=true;
  const time=Math.floor(Date.now()/1000),payload={sub:'fixture-subject',iss:issuer,aud:'holy-sheet',iat:time,exp:time+300,nonce,...override};
  let token=await new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(privateKey);
  if(badSignature){const parts=token.split('.');parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);token=parts.join('.');}
  return json({access_token:'synthetic-access-token',token_type:'Bearer',expires_in:300,id_token:token});
 }
 throw Error('Unexpected outbound URL');
};
function bridge(){return createOidcBridge(env,{fetch:network});}
async function begin(next='/pages/welcome'){
 const client=bridge(),response=await client.signIn(new Request(app+'/auth/sign-in?next='+encodeURIComponent(next)));
 expect(response.status).toBe(303);const target=new URL(response.headers.get('location')!);nonce=target.searchParams.get('nonce')!;challenge=target.searchParams.get('code_challenge')!;
 const cookie=response.headers.getSetCookie()[0].split(';')[0];return {client,response,target,cookie,state:target.searchParams.get('state')!};
}
function callbackRequest(flow:Awaited<ReturnType<typeof begin>>,state=flow.state,cookie=flow.cookie){return new Request(app+'/auth/callback?code=synthetic-code&state='+encodeURIComponent(state),{headers:{cookie}});}

describe('confidential OIDC bridge boundaries',()=>{
 it('fails closed on disabled, weak or insecure configuration',()=>{for(const patch of [{HS_OIDC_ENABLED:'0'},{HS_ORIGIN:'http://hs.example.test'},{HS_IDENTITY_ISSUER:'https://accounts.example.test/'},{HS_OIDC_CLIENT_SECRET:'short'},{HS_OIDC_TRANSACTION_KEY:'invalid'},{HS_IDENTITY_AUDIENCE:'another-app'}])expect(()=>createOidcBridge({...env,...patch})).toThrow();});
 it('uses one-time state, nonce and S256 with an encrypted secure host-only transaction',async()=>{const first=await begin(),second=await begin();expect(first.state).not.toBe(second.state);expect(first.target.searchParams.get('code_challenge_method')).toBe('S256');expect(first.target.searchParams.get('scope')).not.toContain('offline_access');const cookie=first.response.headers.getSetCookie()[0];expect(cookie).toMatch(/__Host-hs_login=/);for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=300'])expect(cookie).toContain(flag);expect(cookie).not.toContain(nonce);expect(first.response.headers.get('cache-control')).toBe('no-store');expect(first.response.headers.get('referrer-policy')).toBe('no-referrer');});
 it('exchanges a valid code and issues a short-lived session compatible with HS verification',async()=>{const flow=await begin(),response=await flow.client.callback(callbackRequest(flow));expect(response.status).toBe(200);expect(response.headers.get('content-security-policy')).toContain("script-src 'nonce-");const cookie=response.headers.getSetCookie().find(value=>value.startsWith('hs_session='))!;expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax; Max-Age=');const age=Number(/Max-Age=(\d+)/.exec(cookie)![1]);expect(age).toBeGreaterThan(0);expect(age).toBeLessThanOrEqual(300);const token=cookie.split(';')[0].slice('hs_session='.length);const sessionCookies=response.headers.getSetCookie().filter(c=>c.startsWith('hs_session=')||c.startsWith('__Host-hs_session=')).map(c=>c.split(';')[0]).join('; ');expect(identityTokenFromRequest(new Request(app,{headers:{cookie:sessionCookies}}),true)).toBe(token);expect(await verifyIdentityToken(token,createLocalJWKSet({keys:[jwk]}),issuer,'holy-sheet')).toEqual({id:'fixture-subject'});expect(response.headers.getSetCookie()).toContain('__Host-hs_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');const html=await response.text();expect(html).not.toContain(token);expect(html).toContain('hs-session-signout');expect(html).toContain(JSON.stringify(app+'/pages/welcome'));});
 it('rejects wrong state before exchanging a code',async()=>{const flow=await begin(),response=await flow.client.callback(callbackRequest(flow,'wrong'));expect(response.status).toBe(400);expect(tokenCalls).toBe(0);expect(response.headers.getSetCookie().some(c=>c.startsWith('hs_session='))).toBe(false);});
 it('rejects altered, missing or duplicated transaction cookies',async()=>{const flow=await begin();for(const cookie of ['',flow.cookie+'x',flow.cookie+'; '+flow.cookie]){expect((await flow.client.callback(callbackRequest(flow,flow.state,cookie))).status).toBe(400);}expect(tokenCalls).toBe(0);});
 it('expires login transactions after five minutes',async()=>{vi.useFakeTimers();const flow=await begin();vi.setSystemTime(Date.now()+301000);expect((await flow.client.callback(callbackRequest(flow))).status).toBe(400);expect(tokenCalls).toBe(0);});
 it.each(['nonce','aud','iss','expired','future','long-life','signature'])('rejects invalid signed-in identity: %s',async problem=>{const flow=await begin(),time=Math.floor(Date.now()/1000);if(problem==='nonce')override={nonce:'wrong'};if(problem==='aud')override={aud:'another-app'};if(problem==='iss')override={iss:'https://wrong.example.test'};if(problem==='expired')override={iat:time-600,exp:time-300};if(problem==='future')override={iat:time+60,exp:time+300};if(problem==='long-life')override={exp:time+3601};if(problem==='signature')badSignature=true;const response=await flow.client.callback(callbackRequest(flow));expect(response.status).toBe(400);expect(response.headers.getSetCookie().some(c=>c.startsWith('hs_session='))).toBe(false);});
 it('rejects duplicate callback state and a provider error without publishing a session',async()=>{const flow=await begin();expect((await flow.client.callback(new Request(callbackRequest(flow).url+'&state='+flow.state,{headers:{cookie:flow.cookie}}))).status).toBe(400);const error=await flow.client.callback(new Request(app+'/auth/callback?error=access_denied&state='+flow.state,{headers:{cookie:flow.cookie}}));expect(error.status).toBe(400);expect(tokenCalls).toBe(0);});
 it('does not reuse a redeemed authorization code',async()=>{const flow=await begin();expect((await flow.client.callback(callbackRequest(flow))).status).toBe(200);const replay=await flow.client.callback(callbackRequest(flow));expect(replay.status).toBe(400);expect(replay.headers.getSetCookie().some(c=>c.startsWith('hs_session='))).toBe(false);});
 it('rejects metadata without S256 and foreign endpoints',async()=>{for(const patch of [{code_challenge_methods_supported:[]},{token_endpoint:'https://foreign.example.test/token'},{jwks_uri:issuer+'/wrong-keys'}]){metadataPatch=patch;expect((await bridge().signIn(new Request(app+'/auth/sign-in'))).status).toBe(503);}});
 it('allows only local document destinations',()=>{for(const unsafe of ['https://attacker.test','//attacker.test','/\\attacker.test','/pages/a?next=evil','/auth/sign-out','/%2f%2fattacker.test'])expect(safeSignInReturn(unsafe)).toBe('/');for(const safe of ['/','/pages/welcome','/embed/pages/a-b'])expect(safeSignInReturn(safe)).toBe(safe);});
 it('denies foreign-origin logout without clearing cookies',async()=>{const flow=await begin(),response=await flow.client.signOut(new Request(app+'/auth/sign-out',{method:'POST',headers:{origin:'https://foreign.example.test'}}));expect(response.status).toBe(403);expect(response.headers.getSetCookie()).toEqual([]);});
 it('clears the local session and binds the suite logout return to the browser',async()=>{const flow=await begin(),response=await flow.client.signOut(new Request(app+'/auth/sign-out',{method:'POST',headers:{origin:app,accept:'application/json'}}));expect(response.status).toBe(200);const {redirect}=await response.json(),target=new URL(redirect);expect(target.origin).toBe(issuer);expect(target.searchParams.get('id_token_hint')).toBeNull();expect(target.searchParams.get('post_logout_redirect_uri')).toBe(app+'/auth/signed-out');expect(response.headers.getSetCookie().some(c=>c.startsWith('hs_session=;')&&c.includes('Max-Age=0'))).toBe(true);const cookie=response.headers.getSetCookie().find(c=>c.startsWith('__Host-hs_logout='))!.split(';')[0],state=target.searchParams.get('state')!;expect((await flow.client.signedOut(new Request(app+'/auth/signed-out?state='+state,{headers:{cookie}}))).status).toBe(303);expect((await flow.client.signedOut(new Request(app+'/auth/signed-out?state=wrong',{headers:{cookie}}))).status).toBe(400);});
});
