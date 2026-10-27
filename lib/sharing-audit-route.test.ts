import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({audit:vi.fn(),repository:vi.fn(async()=>({}))}));
vi.mock('./repository',()=>({repository:mocks.repository}));vi.mock('./sharing',()=>({sharingAudit:mocks.audit}));
import {GET} from '../app/api/v1/pages/[id]/sharing/audit/route';
const context={params:Promise.resolve({id:'qa-page'})};
beforeEach(()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('HS_LOCAL_PREVIEW','1');vi.clearAllMocks();});afterEach(()=>vi.unstubAllEnvs());
describe('sharing audit HTTP privacy',()=>{
 it('returns private no-store audit metadata through the authenticated owner service',async()=>{mocks.audit.mockResolvedValue([{operationId:'committed-operation'}]);const response=await GET(new Request('http://localhost/api/v1/pages/qa-page/sharing/audit'),context);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');expect(await response.json()).toEqual({events:[{operationId:'committed-operation'}]});expect(mocks.audit).toHaveBeenCalledWith({},expect.objectContaining({id:expect.any(String)}),'qa-page');});
 it('does not disclose events when audit permission is refused',async()=>{mocks.audit.mockRejectedValue(new DocumentError('Owner required','owner_required',403));const response=await GET(new Request('http://localhost/api/v1/pages/qa-page/sharing/audit'),context);expect(response.status).toBe(403);expect(await response.json()).not.toHaveProperty('events');});
 it('does not use preview identity for remote callers',async()=>{vi.stubEnv('HS_IDENTITY_ISSUER','');const response=await GET(new Request('https://hs.example/api/v1/pages/qa-page/sharing/audit'),context);expect(response.status).toBe(503);expect(mocks.audit).not.toHaveBeenCalled();});
});
