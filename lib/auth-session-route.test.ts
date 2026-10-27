import { beforeEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({authenticate:vi.fn()}));
vi.mock('./auth',()=>({authenticate:mocks.authenticate}));
import { GET } from '../app/auth/session/route';
import { DocumentError } from './document';
beforeEach(()=>{mocks.authenticate.mockReset();});
describe('private session status independent of editor enablement',()=>{
 it('returns only the verified immutable subject and no token',async()=>{mocks.authenticate.mockResolvedValue({id:'fixture-subject',name:'Private name'});const response=await GET(new Request('https://hs.example.test/auth/session'));expect(response.status).toBe(200);expect(await response.json()).toEqual({authenticated:true,userId:'fixture-subject'});expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');});
 it('returns 401 on missing or expired identity without exposing details',async()=>{mocks.authenticate.mockRejectedValue(new DocumentError('private failure detail','authentication_required',401));const response=await GET(new Request('https://hs.example.test/auth/session'));expect(response.status).toBe(401);expect(await response.json()).toEqual({authenticated:false});});
 it('distinguishes unavailable identity from a signed-out session',async()=>{mocks.authenticate.mockRejectedValue(new Error('private exception'));const response=await GET(new Request('https://hs.example.test/auth/session'));expect(response.status).toBe(503);expect(await response.json()).toEqual({authenticated:false});});
});
