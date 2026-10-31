import {beforeEach,expect,it,vi} from 'vitest';
import {DocumentError} from './document';
const mocks=vi.hoisted(()=>({authenticate:vi.fn(),repository:vi.fn(),state:vi.fn(),people:vi.fn(),offer:vi.fn(),accept:vi.fn(),cancel:vi.fn()}));
vi.mock('./suite-tenant-authority',()=>({authenticateRecordAuthority:mocks.authenticate}));
vi.mock('./repository',()=>({repository:mocks.repository}));
vi.mock('./shared-record-responsibility',()=>({SharedRecordResponsibilityRepository:class{state=mocks.state;people=mocks.people;offer=mocks.offer;accept=mocks.accept;cancel=mocks.cancel;}}));
import {GET,POST} from '../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/responsibility/route';

const tenantId='00000000-0000-4000-8000-000000000002',recordId='00000000-0000-4000-8000-0000000000a1',operationId='00000000-0000-4000-8000-0000000000a2';
const context=()=>({params:Promise.resolve({id:'workspace-a',tenantId,recordId})});
const request=(data:unknown,origin='https://hs.example')=>new Request('https://hs.example/api/responsibility',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('HS_ORIGIN','https://hs.example');mocks.authenticate.mockResolvedValue({actor:{id:'verified-user'},authority:{verify:vi.fn()}});mocks.repository.mockResolvedValue({});});

it('fails closed when records are disabled, before storage access',async()=>{
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const response=await GET(new Request('https://hs.example/api/responsibility'),context());
 expect(response.status).toBe(503);
 expect(await response.json()).toMatchObject({code:'record_feature_disabled',retryable:true});
 expect(mocks.repository).not.toHaveBeenCalled();
 expect(mocks.state).not.toHaveBeenCalled();
 mocks.authenticate.mockRejectedValueOnce(new DocumentError('Structured records are not enabled in this environment.','record_feature_disabled',503));
 const posted=await POST(request({operationId,action:'accept'}),context());
 expect(posted.status).toBe(503);
 expect(mocks.offer).not.toHaveBeenCalled();
});

it('binds responsibility state and member search to the verified actor and URL record',async()=>{
 mocks.state.mockResolvedValue({responsible:null,pending:null,canOffer:false,canAccept:false,canCancel:false});
 const response=await GET(new Request('https://hs.example/api/responsibility'),context());
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('vary')).toContain('Authorization');
 expect(mocks.state).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId);
 mocks.people.mockResolvedValue({people:[{id:'ada',name:'Ada Viewer'}]});
 expect((await GET(new Request('https://hs.example/api/responsibility?q=Ada'),context())).status).toBe(200);
 expect(mocks.people).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId,'Ada');
});

it('denies cross-origin writes before authentication or database access',async()=>{
 const response=await POST(request({operationId,action:'accept'},'https://attacker.example'),context());
 expect(response.status).toBe(403);
 expect(mocks.authenticate).not.toHaveBeenCalled();
 expect(mocks.repository).not.toHaveBeenCalled();
});

it('rejects forged fields and the wrong member payload before dispatch',async()=>{
 const ambiguous=await GET(new Request('https://hs.example/api/responsibility?q=Ada&secret=hidden-salary-value'),context());
 expect(ambiguous.status).toBe(400);
 expect(JSON.stringify(await ambiguous.json())).not.toContain('hidden-salary-value');
 expect(mocks.state).not.toHaveBeenCalled();
 const offered=await POST(request({operationId,action:'offer',toUserId:'ada',actor:{id:'forged'},acl:['secret-acl-name']}),context());
 expect(offered.status).toBe(400);
 expect(JSON.stringify(await offered.json())).not.toContain('secret-acl-name');
 expect(mocks.offer).not.toHaveBeenCalled();
 const accepted=await POST(request({operationId,action:'accept',toUserId:'ada'}),context());
 expect(accepted.status).toBe(400);
 expect(mocks.accept).not.toHaveBeenCalled();
 const missing=await POST(request({operationId,action:'offer'}),context());
 expect(missing.status).toBe(400);
 expect(mocks.offer).not.toHaveBeenCalled();
});

it('dispatches offer, accept and cancel for the verified actor and hides provider errors',async()=>{
 mocks.offer.mockResolvedValue({replayed:false,responsible:null,pending:null,canOffer:false,canAccept:true,canCancel:false});
 mocks.accept.mockResolvedValue({replayed:false,responsible:{id:'ada',name:'Ada Viewer'},pending:null,canOffer:true,canAccept:false,canCancel:false});
 mocks.cancel.mockResolvedValue({replayed:false,responsible:null,pending:null,canOffer:true,canAccept:false,canCancel:false});
 expect((await POST(request({operationId,action:'offer',toUserId:'ada'}),context())).status).toBe(200);
 expect(mocks.offer).toHaveBeenCalledWith({actor:{id:'verified-user'},workspaceId:'workspace-a',tenantId},recordId,{operationId,toUserId:'ada'});
 expect((await POST(request({operationId,action:'accept'}),context())).status).toBe(200);
 expect(mocks.accept.mock.calls[0][0].actor).toEqual({id:'verified-user'});
 expect((await POST(request({operationId,action:'cancel'}),context())).status).toBe(200);
 expect(mocks.cancel).toHaveBeenCalled();
 mocks.state.mockRejectedValue(new Error('private provider detail'));
 const logger=vi.spyOn(console,'error').mockImplementation(()=>{});
 const response=await GET(new Request('https://hs.example/api/responsibility'),context());
 expect(response.status).toBe(503);
 expect(JSON.stringify(await response.json())).not.toContain('private provider detail');
 logger.mockRestore();
});
