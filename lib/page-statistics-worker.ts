import { calculatePageStatistics } from './page-statistics';
// Dedicated worker: no network, persistence, DOM, editor or service access.
self.onmessage=(event:MessageEvent<{document:unknown;supportedSchema:boolean}>)=>{
 try{self.postMessage(calculatePageStatistics(event.data.document,event.data.supportedSchema));}
 catch{self.postMessage({status:'unavailable',reason:'Statistics could not be calculated. Your document is unchanged.'});}
};
