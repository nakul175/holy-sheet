import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
const mocks=vi.hoisted(()=>({request:vi.fn(),release:vi.fn(async()=>{}),lock:vi.fn()}));
vi.mock('../components/editor/use-document-session',()=>({requestJson:mocks.request,ApiError:class extends Error{constructor(message:string,public status:number){super(message);}}}));
vi.mock('./upload-recovery-lock',()=>({tryUploadRecoveryLock:mocks.lock}));
import { importDraftKey,storeUploadCheckpoint,uploadRecoveryRecords } from './recovery-client';
import { acknowledgeUploadRecovery,unlockUploadRecovery,uploadIsCommitted } from './upload-recovery';
import type { UploadCheckpoint } from './upload-recovery-types';
let payload:UploadCheckpoint,key:string,id:string;
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.clearAllMocks();mocks.lock.mockResolvedValue(mocks.release);id=crypto.randomUUID();key=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');payload={schema:1,type:'file',name:'private.txt',size:12,alt:'',caption:'',phase:'ready',target:{kind:'after',blockId:crypto.randomUUID(),expected:'',type:'file',insertId:crypto.randomUUID()},attempt:{operationId:crypto.randomUUID(),id:crypto.randomUUID(),name:'private.txt',size:12}};mocks.request.mockImplementation(async(_url:string,init:RequestInit)=>init.method==='DELETE'?{}:{id,key,expiresAt:new Date(Date.now()+3600000).toISOString()});});
afterEach(()=>vi.unstubAllGlobals());
async function record(){await storeUploadCheckpoint({id,key:await importDraftKey(key),expiresAt:new Date(Date.now()+3600000).toISOString()},'actor','page',payload);return (await uploadRecoveryRecords('actor','page'))[0];}
const documentFor=()=>({type:'doc',content:[{type:'file',attrs:{id:payload.target.insertId,attachmentId:payload.attempt!.id,title:payload.name}}]});
describe('authorized upload recovery',()=>{
 it('requires a fresh existing-key authorization even with local ciphertext',async()=>{const r=await record();await unlockUploadRecovery(r);expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({id,existingOnly:true});mocks.request.mockRejectedValueOnce(Error('Access revoked'));await expect(unlockUploadRecovery(r)).rejects.toThrow('Access revoked');expect(await uploadRecoveryRecords('actor','page')).toHaveLength(1);});
 it('does not acknowledge an unrelated save or changed attachment metadata',async()=>{await record();expect(await acknowledgeUploadRecovery('page','actor',id,{type:'doc'})).toBe(false);const changed=documentFor();changed.content[0].attrs.title='Newer title';expect(uploadIsCommitted(changed,payload)).toBe(false);expect(await uploadRecoveryRecords('actor','page')).toHaveLength(1);expect(mocks.request.mock.calls.every(([,init])=>init.method!=='DELETE')).toBe(true);});
 it('acknowledges only the exact saved intent and releases its lock',async()=>{await record();expect(await acknowledgeUploadRecovery('page','actor',id,documentFor())).toBe(true);expect(await uploadRecoveryRecords('actor','page')).toHaveLength(0);expect(mocks.request).toHaveBeenCalledWith(expect.stringContaining('draftId='+id),expect.objectContaining({method:'DELETE'}));expect(mocks.release).toHaveBeenCalledTimes(1);});
 it('leaves another tab’s record untouched when its lock is held',async()=>{await record();mocks.lock.mockResolvedValueOnce(null);expect(await acknowledgeUploadRecovery('page','actor',id,documentFor())).toBe(false);expect(mocks.request).not.toHaveBeenCalled();expect(await uploadRecoveryRecords('actor','page')).toHaveLength(1);});
});
