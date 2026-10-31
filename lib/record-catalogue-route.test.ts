import {beforeEach,expect,it,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),repository:vi.fn(),list:vi.fn(),describe:vi.fn()}));
vi.mock('./suite-tenant-authority',()=>({authenticateRecordAuthority:mocks.authenticate}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./shared-record-catalogue',()=>({SharedRecordCatalogueRepository:class{listCatalogue=mocks.list;describeCatalogue=mocks.describe;}}));
import {GET} from '../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-catalogue/route';

const tenantId='00000000-0000-4000-8000-000000000002';
const context=()=>({params:Promise.resolve({id:'workspace-a',tenantId})});
beforeEach(()=>{vi.resetAllMocks();mocks.authenticate.mockResolvedValue({actor:{id:'verified-user'},authority:{verify:vi.fn()}});mocks.repository.mockResolvedValue({});});

it('fails closed when records are disabled, before storage access',async()=>{
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const response=await GET(new Request('https://hs.example/api/record-catalogue'),context());
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({code:'record_feature_disabled',retryable:true});
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.list).not.toHaveBeenCalled();
 expect(mocks.describe).not.toHaveBeenCalled();
});

it('binds catalogue reads to the verified actor and URL tenant without caching',async()=>{
 mocks.list.mockResolvedValue({schemaVersion:1,collections:[],truncated:false});
 const listed=await GET(new Request('https://hs.example/api/record-catalogue'),context());
 expect(listed.status).toBe(200);
 expect(listed.headers.get('cache-control')).toBe('no-store');
 expect(listed.headers.get('vary')).toContain('Authorization');
 expect(mocks.list).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId});
 mocks.describe.mockResolvedValue({schemaVersion:1,collection:{id:'organisations'},fields:[]});
 const described=await GET(new Request('https://hs.example/api/record-catalogue?collection=organisations'),context());
 expect(described.status).toBe(200);
 expect(described.headers.get('cache-control')).toBe('no-store');
 expect(mocks.describe).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},'organisations');
});

it('preserves restricted authority responses without opening the database',async()=>{
 for(const status of [401,404,503]){
  mocks.authenticate.mockRejectedValueOnce(new DocumentError('Restricted','record_not_found',status));
  const response=await GET(new Request('https://hs.example/api/record-catalogue?collection=organisations'),context());
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
 }
 expect(mocks.repository).not.toHaveBeenCalled();
});

it('rejects unknown catalogue fields before dispatch and does not echo them',async()=>{
 const denied=await GET(new Request('https://hs.example/api/record-catalogue?collection=organisations&secret=hidden-salary-value'),context());
 expect(denied.status).toBe(400);
 expect(JSON.stringify(await denied.json())).not.toContain('hidden-salary-value');
 expect(mocks.list).not.toHaveBeenCalled();
 expect(mocks.describe).not.toHaveBeenCalled();
 mocks.list.mockRejectedValue(new Error('private provider detail'));
 const logger=vi.spyOn(console,'error').mockImplementation(()=>{});
 const response=await GET(new Request('https://hs.example/api/record-catalogue'),context());
 expect(response.status).toBe(503);
 expect(JSON.stringify(await response.json())).not.toContain('private provider detail');
 logger.mockRestore();
});
