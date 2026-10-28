import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({search:vi.fn(),repository:vi.fn(async()=>({}))}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./workspace-search',()=>({workspaceSearch:mocks.search}));
import {GET} from '../app/api/search/route';
beforeEach(()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('HS_LOCAL_PREVIEW','1');vi.clearAllMocks();mocks.search.mockResolvedValue({results:[],nextCursor:null});});
afterEach(()=>vi.unstubAllEnvs());
it('requires explicit bounded workspace scope before native search',async()=>{
 for(const query of ['q=launch','workspaceId=&q=launch','workspaceId=w&q='+('a'.repeat(513)),'workspaceId=w&q=launch&cursor=bad']){expect((await GET(new Request('http://localhost/api/search?'+query))).status).toBe(400);}expect(mocks.search).not.toHaveBeenCalled();
});
it('binds actor and scope and never caches search responses',async()=>{
 const result=await GET(new Request('http://localhost/api/search?workspaceId=w&q=launch&spaceId=s'));expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');expect(mocks.search).toHaveBeenCalledWith({},expect.objectContaining({id:expect.any(String)}),{query:'launch',workspaceId:'w',spaceId:'s',cursor:undefined},expect.any(AbortSignal));
});
it('does not authenticate a remote request using the local preview actor',async()=>{
 vi.stubEnv('HS_IDENTITY_ISSUER','https://identity.example');vi.stubEnv('HS_IDENTITY_JWKS_URL','https://identity.example/jwks');expect((await GET(new Request('https://holysheet.aplyd.org/api/search?workspaceId=w&q=launch'))).status).toBe(401);expect(mocks.search).not.toHaveBeenCalled();
});
