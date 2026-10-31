import {beforeEach,expect,it,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),repository:vi.fn(),state:vi.fn(),follow:vi.fn(),unfollow:vi.fn()}));
vi.mock('./suite-tenant-authority',()=>({authenticateRecordAuthority:mocks.authenticate}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./shared-record-follows',()=>({SharedRecordFollowsRepository:class{followState=mocks.state;follow=mocks.follow;unfollow=mocks.unfollow;}}));
import {DELETE,GET,PUT} from '../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/follow/route';

const tenantId='00000000-0000-4000-8000-000000000002',recordId='00000000-0000-4000-8000-0000000000a1';
const context=()=>({params:Promise.resolve({id:'workspace-a',tenantId,recordId})});
const request=(method:string,data:unknown,origin='https://hs.example')=>new Request('https://hs.example/api/follow',{method,headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('HS_ORIGIN','https://hs.example');mocks.authenticate.mockResolvedValue({actor:{id:'verified-user'},authority:{verify:vi.fn()}});mocks.repository.mockResolvedValue({});});

it('fails closed when records are disabled, before storage access',async()=>{
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const response=await GET(new Request('https://hs.example/api/follow'),context());
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({code:'record_feature_disabled',retryable:true});
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.state).not.toHaveBeenCalled();
});

it('binds follow state to the verified actor and URL record without caching',async()=>{
 mocks.state.mockResolvedValue({following:false});
 const response=await GET(new Request('https://hs.example/api/follow'),context());
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('vary')).toContain('Authorization');
 expect(await response.json()).toEqual({following:false});
 expect(mocks.state).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId);
});

it('denies cross-origin writes before authentication or database access',async()=>{
 const response=await PUT(request('PUT',{},'https://attacker.example'),context());
 expect(response.status).toBe(403);
 expect(mocks.authenticate).not.toHaveBeenCalled();
 expect(mocks.repository).not.toHaveBeenCalled();
 const removed=await DELETE(request('DELETE',{},'https://attacker.example'),context());
 expect(removed.status).toBe(403);
 expect(mocks.unfollow).not.toHaveBeenCalled();
});

it('rejects forged fields before follow or unfollow',async()=>{
 const followed=await PUT(request('PUT',{actor:{id:'forged'},acl:['secret-acl-name']}),context());
 expect(followed.status).toBe(400);
 expect(JSON.stringify(await followed.json())).not.toContain('secret-acl-name');
 expect(mocks.follow).not.toHaveBeenCalled();
 const removed=await DELETE(request('DELETE',{following:true,grant:'secret-grant'}),context());
 expect(removed.status).toBe(400);
 expect(JSON.stringify(await removed.json())).not.toContain('secret-grant');
 expect(mocks.unfollow).not.toHaveBeenCalled();
});

it('follows and unfollows for the verified actor',async()=>{
 mocks.follow.mockResolvedValue({following:true});
 mocks.unfollow.mockResolvedValue({following:false});
 expect((await PUT(request('PUT',{}),context())).status).toBe(200);
 expect(mocks.follow).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId);
 expect(await (await DELETE(request('DELETE',{}),context())).json()).toEqual({following:false});
 expect(mocks.unfollow.mock.calls[0][0].actor).toEqual({id:'verified-user'});
});
