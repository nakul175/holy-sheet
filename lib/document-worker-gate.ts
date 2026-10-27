import {DocumentError} from './document';
const runtime=globalThis as typeof globalThis&{hsDocumentWorkerLease?:symbol};
export function claimDocumentWorker(){if(runtime.hsDocumentWorkerLease)throw new DocumentError('Another document conversion is running. Keep this request and retry shortly.','document_worker_busy',503);const lease=Symbol('document-worker');runtime.hsDocumentWorkerLease=lease;return ()=>{if(runtime.hsDocumentWorkerLease===lease)delete runtime.hsDocumentWorkerLease;};}
