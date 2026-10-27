import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({access:vi.fn(),repository:vi.fn()}));
vi.mock('./repository',()=>({repository:mocks.repository}));
import {GET} from '../app/api/v1/pages/[id]/access/route';
const context={params:Promise.resolve({id:'private-page'})};
beforeEach(()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('HS_LOCAL_PREVIEW','1');vi.clearAllMocks();mocks.repository.mockResolvedValue({db:{},access:mocks.access});mocks.access.mockResolvedValue({role:'editor',title:'secret',document:'private',owner_id:'owner'});});
afterEach(()=>vi.unstubAllEnvs());
describe('page permission monitoring boundary',()=>{
 it('returns only authenticated actor and effective role with no-store',async()=>{const response=await GET(new Request('http://localhost/api/v1/pages/private-page/access'),context);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({actorId:'00000000-0000-4000-8000-000000000001',role:'editor'});expect(mocks.access).toHaveBeenCalledWith({},'private-page',expect.objectContaining({id:expect.any(String)}));});
 it('does not disclose revoked page metadata',async()=>{mocks.access.mockRejectedValue(new DocumentError('Page unavailable','not_found',404));const response=await GET(new Request('http://localhost/api/v1/pages/private-page/access'),context);expect(response.status).toBe(404);expect(JSON.stringify(await response.json())).not.toContain('secret');});
 it('never falls back to preview identity for a remote caller',async()=>{vi.stubEnv('HS_IDENTITY_ISSUER','');const response=await GET(new Request('https://hs.example/api/v1/pages/private-page/access'),context);expect(response.status).toBe(503);expect(mocks.repository).not.toHaveBeenCalled();});
});
