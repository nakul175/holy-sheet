// @vitest-environment jsdom
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { act,createElement } from 'react';
import { createRoot,type Root } from 'react-dom/client';
const mocks=vi.hoisted(()=>({records:[] as import('./recovery-client').RecoveryRecord[],request:vi.fn(),cleanup:vi.fn(),unlock:vi.fn()}));
vi.mock('./recovery-client',()=>({uploadRecoveryRecords:vi.fn(async()=>mocks.records)}));
vi.mock('./upload-recovery',()=>({acknowledgeUploadRecovery:vi.fn(async()=>false),discardExpiredLocalUploads:mocks.cleanup,discardRecoveredUpload:vi.fn(),resumeUploadRecovery:vi.fn(),unlockUploadRecovery:mocks.unlock}));
vi.mock('../components/editor/use-document-session',()=>({requestJson:mocks.request,ApiError:class extends Error{constructor(message:string,public status:number){super(message);}}}));
import PendingUploads from '../components/editor/pending-uploads';
import { ApiError } from '../components/editor/use-document-session';
let root:Root,container:HTMLDivElement;
const record=(expiresAt:string)=>({id:crypto.randomUUID(),actorId:'actor',pageId:'page',expiresAt,updatedAt:new Date().toISOString(),iv:new Uint8Array(12),ciphertext:new ArrayBuffer(1)});
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.clearAllMocks();mocks.records=[record(new Date(Date.now()-1000).toISOString())];mocks.request.mockRejectedValue(new ApiError('Page restricted',403,'not_found'));mocks.cleanup.mockImplementation(async()=>{mocks.records=[];window.dispatchEvent(new CustomEvent('holy-sheet:upload-recovery',{detail:{pageId:'page'}}));return {removed:1,skipped:0};});container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(PendingUploads,{pageId:'page',actorId:'actor',role:'viewer',confirmedVersion:1,onResume:vi.fn()})));}
const cleanupButton=()=>Array.from(container.querySelectorAll('button')).find(b=>b.textContent==='Remove expired device records');
describe('own-device expired recovery controls',()=>{
 it('requires explicit confirmation and does not request a key or server page for expired-only data',async()=>{const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);await render();expect(cleanupButton()).toBeTruthy();expect(mocks.request).not.toHaveBeenCalled();expect(mocks.unlock).not.toHaveBeenCalled();await act(async()=>cleanupButton()!.click());expect(confirm).toHaveBeenCalled();expect(mocks.cleanup).not.toHaveBeenCalled();expect(mocks.records).toHaveLength(1);confirm.mockReturnValue(true);await act(async()=>cleanupButton()!.click());expect(mocks.cleanup).toHaveBeenCalledWith('actor','page');expect(container.textContent).toContain('1 expired local record removed');expect(cleanupButton()).toBeUndefined();confirm.mockRestore();});
 it('keeps expired cleanup available when an unrelated key/page refresh fails and clears it on logout',async()=>{mocks.records.push(record(new Date(Date.now()+3600000).toISOString()));await render();expect(container.textContent).toContain('Page restricted');expect(cleanupButton()).toBeTruthy();expect(mocks.unlock).not.toHaveBeenCalled();await act(async()=>window.dispatchEvent(new Event('holy-sheet:logout')));expect(cleanupButton()).toBeUndefined();expect(container.textContent).toBe('');expect(mocks.cleanup).not.toHaveBeenCalled();});
});
