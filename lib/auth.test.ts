import { beforeAll,describe,it,expect } from 'vitest';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT,type JWTVerifyGetKey,type JWTPayload } from 'jose';
import { verifyIdentityToken } from './auth';
let privateKey:CryptoKey,keys:JWTVerifyGetKey;
const issuer='https://identity.test',audience='holy-sheet';
beforeAll(async()=>{const pair=await generateKeyPair('ES256');privateKey=pair.privateKey;keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'fixture',alg:'ES256'}]});});
async function token(changes:JWTPayload={}){const now=Math.floor(Date.now()/1000);return new SignJWT({sub:'immutable-user',iss:issuer,aud:audience,iat:now,exp:now+300,...changes}).setProtectedHeader({alg:'ES256',kid:'fixture'}).sign(privateKey);}
describe('trusted suite identity token boundaries',()=>{
  it('accepts a signed current session for the exact issuer and audience',async()=>expect(await verifyIdentityToken(await token(),keys,issuer,audience)).toEqual({id:'immutable-user'}));
  it('rejects a future-issued token, expired token and excessive lifetime',async()=>{const now=Math.floor(Date.now()/1000);for(const claims of [{iat:now+60,exp:now+300},{iat:now-100,exp:now-60},{exp:now+3601}])await expect(verifyIdentityToken(await token(claims),keys,issuer,audience)).rejects.toThrow();});
  it('rejects wrong issuer/audience and a token whose lifetime ends before issuance',async()=>{const now=Math.floor(Date.now()/1000);for(const claims of [{iss:'https://other.test'},{aud:'another-app'},{iat:now+2,exp:now+1}])await expect(verifyIdentityToken(await token(claims),keys,issuer,audience)).rejects.toThrow();});
});
