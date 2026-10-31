import {beforeEach,expect,it,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),repository:vi.fn(),list:vi.fn(),people:vi.fn(),create:vi.fn()}));
vi.mock('./suite-tenant-authority',()=>({authenticateRecordAuthority:mocks.authenticate}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./shared-record-comments',()=>({SharedRecordCommentsRepository:class{listComments=mocks.list;mentionPeople=mocks.people;createComment=mocks.create;}}));
import {GET,POST} from '../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/comments/route';

const tenantId='00000000-0000-4000-8000-000000000002',recordId='00000000-0000-4000-8000-0000000000a1',operationId='00000000-0000-4000-8000-0000000000a2';
const context=()=>({params:Promise.resolve({id:'workspace-a',tenantId,recordId})});
const request=(data:unknown,origin='https://hs.example')=>new Request('https://hs.example/api/comments',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('HS_ORIGIN','https://hs.example');mocks.authenticate.mockResolvedValue({actor:{id:'verified-user'},authority:{verify:vi.fn()}});mocks.repository.mockResolvedValue({});});

it('fails closed when records are disabled, before storage access',async()=>{
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const response=await GET(new Request('https://hs.example/api/comments'),context());
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({code:'record_feature_disabled',retryable:true});
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.list).not.toHaveBeenCalled();
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const posted=await POST(request({operationId,body:'Hello',mentionIds:[]}),context());
 expect(posted.status).toBe(503);
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.create).not.toHaveBeenCalled();
});

it('binds list and mention search to the verified actor and URL record without caching',async()=>{
 mocks.list.mockResolvedValue({comments:[],truncated:false});
 const response=await GET(new Request('https://hs.example/api/comments'),context());
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('vary')).toContain('Authorization');
 expect(mocks.list).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId);
 mocks.people.mockResolvedValue({people:[{id:'ada',name:'Ada Viewer'}]});
 expect((await GET(new Request('https://hs.example/api/comments?q=Ada'),context())).status).toBe(200);
 expect(mocks.people).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId,'Ada');
});

it('denies cross-origin writes before authentication or database access',async()=>{
 const response=await POST(request({operationId,body:'Hello',mentionIds:[]},'https://attacker.example'),context());
 expect(response.status).toBe(403);
 expect(mocks.authenticate).not.toHaveBeenCalled();
 expect(mocks.repository).not.toHaveBeenCalled();
});

it('preserves restricted authority responses without opening the database',async()=>{
 for(const status of [401,404,503]){mocks.authenticate.mockRejectedValueOnce(new DocumentError('Restricted','record_not_found',status));const response=await GET(new Request('https://hs.example/api/comments'),context());expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toBe('no-store');}
 expect(mocks.repository).not.toHaveBeenCalled();
});

it('rejects ambiguous queries and unknown fields before dispatch',async()=>{
 const ambiguous=await GET(new Request('https://hs.example/api/comments?q=Ada&secret=hidden-salary-value'),context());
 expect(ambiguous.status).toBe(400);
 expect(JSON.stringify(await ambiguous.json())).not.toContain('hidden-salary-value');
 expect(mocks.list).not.toHaveBeenCalled();
 expect(mocks.people).not.toHaveBeenCalled();
 const saved=await POST(request({operationId,body:'Hello @Ada',mentionIds:['ada'],actor:{id:'forged'},acl:['secret-acl-name']}),context());
 expect(saved.status).toBe(400);
 expect(JSON.stringify(await saved.json())).not.toContain('secret-acl-name');
 expect(mocks.create).not.toHaveBeenCalled();
});

it('dispatches a comment and hides provider errors',async()=>{
 const input={operationId,body:'Hello @Ada',mentionIds:['ada']};
 mocks.create.mockResolvedValue({replayed:false,comment:{id:'comment-1'}});
 expect((await POST(request(input),context())).status).toBe(200);
 expect(mocks.create.mock.calls[0][1]).toBe(recordId);
 expect(mocks.create.mock.calls[0][2]).toEqual(input);
 mocks.list.mockRejectedValue(new Error('private provider detail'));
 const logger=vi.spyOn(console,'error').mockImplementation(()=>{});
 const response=await GET(new Request('https://hs.example/api/comments'),context());
 expect(response.status).toBe(503);
 expect(JSON.stringify(await response.json())).not.toContain('private provider detail');
 logger.mockRestore();
});
