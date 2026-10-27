import { describe,it,expect } from 'vitest';
import { identityTokenFromRequest } from './auth';
const request=(cookie:string)=>new Request('https://hs.example.test',{headers:{cookie}});
describe('host-bound identity cookie selection',()=>{
 it('requires the protected host cookie when the bridge is enabled',()=>{expect(identityTokenFromRequest(request('hs_session=legacy'),true)).toBeUndefined();expect(identityTokenFromRequest(request('__Host-hs_session=signed; hs_session=signed'),true)).toBe('signed');expect(identityTokenFromRequest(request('__Host-hs_session=signed'),true)).toBe('signed');});
 it('rejects duplicate or conflicting cookies instead of selecting an account ambiguously',()=>{for(const cookie of ['hs_session=a; hs_session=b','__Host-hs_session=a; __Host-hs_session=b','__Host-hs_session=a; hs_session=b'])expect(identityTokenFromRequest(request(cookie),true)).toBeUndefined();});
 it('retains legacy compatibility while the bridge is disabled',()=>expect(identityTokenFromRequest(request('hs_session=legacy'))).toBe('legacy'));
 it('keeps verified bearer delegation separate from browser cookie binding',()=>expect(identityTokenFromRequest(new Request('https://hs.example.test',{headers:{authorization:'Bearer delegated',cookie:'hs_session=untrusted'}}),true)).toBe('delegated'));
});
