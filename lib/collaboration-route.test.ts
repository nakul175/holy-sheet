import {beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({begin:vi.fn(),pull:vi.fn(),submit:vi.fn(),presence:vi.fn(),leave:vi.fn()}));
vi.mock('./collaboration',()=>({beginCollaboration:mocks.begin,pullCollaboration:mocks.pull,submitCollaboration:mocks.submit,updateCollaborationPresence:mocks.presence,leaveCollaboration:mocks.leave}));
import {POST} from '../app/api/v1/pages/[id]/collaboration/route';
const origin='http://localhost:3000',clientId='11111111-1111-4111-8111-111111111111',params={params:Promise.resolve({id:'welcome'})};
const request=(body:unknown,headers:Record<string,string>={origin})=>new Request(origin+'/api/v1/pages/welcome/collaboration',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();process.env.HS_COLLABORATION_ENABLED='1';});
describe('collaboration HTTP boundary',()=>{
 it('is disabled by default and requires the exact mutation origin',async()=>{process.env.HS_COLLABORATION_ENABLED='0';expect((await POST(request({action:'start',clientId}),params)).status).toBe(503);process.env.HS_COLLABORATION_ENABLED='1';expect((await POST(request({action:'start',clientId},{origin:'https://untrusted.example'}),params)).status).toBe(403);expect(mocks.begin).not.toHaveBeenCalled();});
 it('routes strict bounded actions without accepting caller identity',async()=>{mocks.begin.mockResolvedValue({sessionId:clientId});const response=await POST(request({action:'start',clientId}),params);expect(response.status).toBe(200);expect(mocks.begin).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:expect.any(String)}),'welcome',clientId);for(const body of [{action:'start',clientId,actorId:'other'},{action:'submit',sessionId:clientId,epoch:clientId,clientId,operationId:clientId,baseStepVersion:0,steps:[]},{action:'pull',sessionId:clientId,epoch:clientId,clientId,afterVersion:-1},{action:'presence',sessionId:clientId,epoch:clientId,clientId,presence:{anchorOffset:1_000_001}}])expect((await POST(request(body),params)).status).toBe(422);});
});
