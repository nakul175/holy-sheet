import { beforeAll,afterEach,describe,it,expect,vi } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,type JWTVerifyGetKey,type JWTPayload } from 'jose';
import { authenticate,verifyIdentityToken } from './auth';
let privateKey:CryptoKey,keys:JWTVerifyGetKey;
let publicKeys:unknown;
const issuer='https://identity.test',audience='holy-sheet';
beforeAll(async()=>{const pair=await generateKeyPair('ES256');privateKey=pair.privateKey;const jwks={keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'ES256'}]};publicKeys=jwks;keys=createLocalJWKSet(jwks);});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function token(changes:JWTPayload={}){const now=Math.floor(Date.now()/1000);return new SignJWT({sub:'immutable-user',iss:issuer,aud:audience,iat:now,exp:now+300,...changes}).setProtectedHeader({alg:'ES256',kid:'fixture'}).sign(privateKey);}
describe('trusted suite identity token boundaries',()=>{
  it('enforces live source revocation for a still-valid bearer token in OIDC mode',async()=>{
    vi.stubEnv('HS_IDENTITY_ISSUER',issuer);vi.stubEnv('HS_IDENTITY_JWKS_URL',issuer+'/jwks/'+crypto.randomUUID());vi.stubEnv('HS_IDENTITY_AUDIENCE',audience);vi.stubEnv('HS_OIDC_ENABLED','1');vi.stubEnv('HS_OIDC_CLIENT_SECRET','qa-secret-'.repeat(4));
    let active=true;const statuses:unknown[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:URL,options:RequestInit)=>{
      if(String(url).includes('/jwks/'))return Response.json(publicKeys);
      statuses.push(JSON.parse(String(options.body)));return Response.json(active?{active:true,sub:'immutable-user',local_id:'immutable-user'}:{active:false});
    }));
    const signed=await token({aplyd_session_uid:'bound-source-session'}),request=new Request('https://hs.example.test/api/pages',{headers:{authorization:'Bearer '+signed}});
    expect(await authenticate(request)).toEqual({id:'immutable-user'});active=false;
    await expect(authenticate(request)).rejects.toMatchObject({status:401,code:'authentication_required'});
    expect(statuses).toHaveLength(2);
  });
  it('keeps authority outages distinguishable from expired authentication',async()=>{
    vi.stubEnv('HS_IDENTITY_ISSUER',issuer);vi.stubEnv('HS_IDENTITY_JWKS_URL',issuer+'/jwks/'+crypto.randomUUID());vi.stubEnv('HS_IDENTITY_AUDIENCE',audience);vi.stubEnv('HS_OIDC_ENABLED','1');vi.stubEnv('HS_OIDC_CLIENT_SECRET','qa-secret-'.repeat(4));
    vi.stubGlobal('fetch',vi.fn(async(url:URL)=>String(url).includes('/jwks/')?Response.json(publicKeys):new Response('',{status:503})));
    await expect(authenticate(new Request('https://hs.example.test/api/pages',{headers:{authorization:'Bearer '+await token({aplyd_session_uid:'uid'})}}))).rejects.toMatchObject({status:503,code:'identity_unavailable'});
  });
  it('checks live session state only after issuer/audience/signature validation',async()=>{
    const check=vi.fn(async()=>{});
    await expect(verifyIdentityToken(await token({aud:'another-app',aplyd_session_uid:'uid'}),keys,issuer,audience,check)).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
    await verifyIdentityToken(await token({aplyd_session_uid:'uid'}),keys,issuer,audience,check);
    expect(check).toHaveBeenCalledWith(expect.objectContaining({sub:'immutable-user',aplyd_session_uid:'uid'}));
  });
  it('accepts a signed current session for the exact issuer and audience',async()=>expect(await verifyIdentityToken(await token(),keys,issuer,audience)).toEqual({id:'immutable-user'}));
  it('rejects a future-issued token, expired token and excessive lifetime',async()=>{const now=Math.floor(Date.now()/1000);for(const claims of [{iat:now+60,exp:now+300},{iat:now-100,exp:now-60},{exp:now+3601}])await expect(verifyIdentityToken(await token(claims),keys,issuer,audience)).rejects.toThrow();});
  it('rejects wrong issuer/audience and a token whose lifetime ends before issuance',async()=>{const now=Math.floor(Date.now()/1000);for(const claims of [{iss:'https://other.test'},{aud:'another-app'},{iat:now+2,exp:now+1}])await expect(verifyIdentityToken(await token(claims),keys,issuer,audience)).rejects.toThrow();});
});
