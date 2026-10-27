import { afterEach,expect,it,vi } from 'vitest';
import { requireActiveSuiteSession } from './suite-session';
const secret='qa-only-client-secret-'.repeat(2),issuer='https://accounts.example.test';
afterEach(()=>{vi.unstubAllGlobals();});
it('authenticates the confidential client and binds an active response to the verified subject',async()=>{
  const request=vi.fn(async()=>Response.json({active:true,sub:'actor',local_id:'native-id'}));vi.stubGlobal('fetch',request);
  await requireActiveSuiteSession('actor','session-uid',issuer,secret);
  const [url,options]=request.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.href).toBe(issuer+'/internal/session/status');expect(url.href).not.toContain(secret);
  expect(options).toMatchObject({method:'POST',redirect:'error',cache:'no-store'});
  expect(JSON.parse(String(options.body))).toEqual({client_id:'holy-sheet',client_secret:secret,sub:'actor',uid:'session-uid'});
});
it('does not cache an active result across a later source-session revocation',async()=>{
  const request=vi.fn().mockResolvedValueOnce(Response.json({active:true,sub:'actor',local_id:'actor'})).mockResolvedValueOnce(Response.json({active:false}));vi.stubGlobal('fetch',request);
  await requireActiveSuiteSession('actor','uid',issuer,secret);
  await expect(requireActiveSuiteSession('actor','uid',issuer,secret)).rejects.toMatchObject({status:401,code:'authentication_required'});
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([undefined,'',123,'x'.repeat(201)])('refuses a missing or malformed signed session UID before any request (%s)',async uid=>{
  const request=vi.fn();vi.stubGlobal('fetch',request);
  await expect(requireActiveSuiteSession('actor',uid,issuer,secret)).rejects.toMatchObject({status:401});expect(request).not.toHaveBeenCalled();
});
it.each([{active:true,sub:'other',local_id:'actor'},{active:true,sub:'actor'},{active:'true',sub:'actor',local_id:'actor'},{}])('fails closed on a malformed or mismatched authority response',async body=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json(body)));
  await expect(requireActiveSuiteSession('actor','uid',issuer,secret)).rejects.toMatchObject({status:503});
});
it.each([401,403,500,503])('distinguishes authority failure (%s) from a user logout',async status=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status})));
  await expect(requireActiveSuiteSession('actor','uid',issuer,secret)).rejects.toMatchObject({status:503});
});
it('fails closed without disclosing network errors or secrets',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw Error(secret);}));
  await expect(requireActiveSuiteSession('actor','uid',issuer,secret)).rejects.toMatchObject({status:503,message:'Suite session verification is unavailable'});
});
it.each(['http://accounts.example.test','https://user:pass@accounts.example.test','https://accounts.example.test?redirect=other'])('refuses unsafe configuration before sending client credentials',async value=>{
  const request=vi.fn();vi.stubGlobal('fetch',request);
  await expect(requireActiveSuiteSession('actor','uid',value,secret)).rejects.toMatchObject({status:503});expect(request).not.toHaveBeenCalled();
});
