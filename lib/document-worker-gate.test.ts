import {it,expect} from 'vitest';
import {claimDocumentWorker} from './document-worker-gate';
it('shares one import/export resource lease and a stale release cannot unlock a later worker',()=>{const first=claimDocumentWorker();try{expect(()=>claimDocumentWorker()).toThrow('Another document conversion');}finally{first();}const second=claimDocumentWorker();try{first();expect(()=>claimDocumentWorker()).toThrow('Another document conversion');}finally{second();}const third=claimDocumentWorker();third();});
