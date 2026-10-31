import {beforeEach,expect,it,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),repository:vi.fn(),list:vi.fn(),read:vi.fn()}));
vi.mock('./suite-tenant-authority',()=>({authenticateRecordAuthority:mocks.authenticate}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./record-notifications',()=>({SharedRecordNotificationsRepository:class{listNotifications=mocks.list;readNotification=mocks.read;}}));
import {GET,POST} from '../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-notifications/route';

const tenantId='00000000-0000-4000-8000-000000000002',notificationId='00000000-0000-4000-8000-0000000000b1';
const context=()=>({params:Promise.resolve({id:'workspace-a',tenantId})});
const request=(data:unknown,origin='https://hs.example')=>new Request('https://hs.example/api/record-notifications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('HS_ORIGIN','https://hs.example');mocks.authenticate.mockResolvedValue({actor:{id:'verified-user'},authority:{verify:vi.fn()}});mocks.repository.mockResolvedValue({});});

it('fails closed when records are disabled, before storage access',async()=>{
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const response=await GET(new Request('https://hs.example/api/record-notifications'),context());
 expect(response.status).toBe(503);
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.list).not.toHaveBeenCalled();
});

it('lists notifications for the verified actor without caching',async()=>{
 mocks.list.mockResolvedValue({notifications:[]});
 const response=await GET(new Request('https://hs.example/api/record-notifications'),context());
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('vary')).toContain('Authorization');
 expect(mocks.list).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId});
});

it('rejects a query secret and a forged read before dispatch',async()=>{
 const listed=await GET(new Request('https://hs.example/api/record-notifications?secret=hidden-salary-value'),context());
 expect(listed.status).toBe(400);
 expect(JSON.stringify(await listed.json())).not.toContain('hidden-salary-value');
 expect(mocks.list).not.toHaveBeenCalled();
 const read=await POST(request({id:notificationId,actor:{id:'forged'},acl:['secret-acl-name']}),context());
 expect(read.status).toBe(400);
 expect(JSON.stringify(await read.json())).not.toContain('secret-acl-name');
 expect(mocks.read).not.toHaveBeenCalled();
});

it('denies a cross-origin read before authentication',async()=>{
 const response=await POST(request({id:notificationId},'https://attacker.example'),context());
 expect(response.status).toBe(403);
 expect(mocks.authenticate).not.toHaveBeenCalled();
 expect(mocks.read).not.toHaveBeenCalled();
});

it('marks the verified actor notification read and hides provider errors',async()=>{
 mocks.read.mockResolvedValue({id:notificationId,read:true});
 expect(await (await POST(request({id:notificationId}),context())).json()).toEqual({id:notificationId,read:true});
 expect(mocks.read).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},notificationId);
 mocks.list.mockRejectedValue(new Error('private provider detail'));
 const logger=vi.spyOn(console,'error').mockImplementation(()=>{});
 const response=await GET(new Request('https://hs.example/api/record-notifications'),context());
 expect(response.status).toBe(503);
 expect(JSON.stringify(await response.json())).not.toContain('private provider detail');
 logger.mockRestore();
});
