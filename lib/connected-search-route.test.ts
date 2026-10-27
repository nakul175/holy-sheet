import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
const mocks=vi.hoisted(()=>({search:vi.fn(),repository:vi.fn(async()=>({}))}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./connected-search',()=>({connectedSearch:mocks.search}));
import { POST } from '../app/api/v1/connected-search/route';
const body=()=>({query:'private query',workspaceId:'ws-aplyd',requestId:crypto.randomUUID()});
beforeEach(()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('HS_LOCAL_PREVIEW','1');vi.clearAllMocks();mocks.search.mockResolvedValue({results:[],nextCursor:null});});afterEach(()=>vi.unstubAllEnvs());
describe('connected search HTTP boundary',()=>{
 it('requires exact origin for a browser cookie request before executing search',async()=>{const response=await POST(new Request('http://localhost:3000/api/v1/connected-search',{method:'POST',headers:{origin:'https://untrusted.example','content-type':'application/json'},body:JSON.stringify(body())}));expect(response.status).toBe(403);expect(mocks.search).not.toHaveBeenCalled();});
 it('accepts a bounded private JSON query and returns no-store response',async()=>{const data=body(),response=await POST(new Request('http://localhost:3000/api/v1/connected-search',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify(data)}));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(mocks.search).toHaveBeenCalledWith({},expect.objectContaining({id:expect.any(String)}),data);});
 it('rejects malformed scopes, request IDs and unbounded queries',async()=>{for(const patch of [{query:'x'.repeat(513)},{workspaceId:''},{requestId:'bad'},{cursor:'x'.repeat(129)},{unexpected:true}]){const response=await POST(new Request('http://localhost:3000/api/v1/connected-search',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify({...body(),...patch})}));expect(response.status).toBe(422);}expect(mocks.search).not.toHaveBeenCalled();});
});
