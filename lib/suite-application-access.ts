import {DocumentError} from './document';

export async function requireSuiteApplicationAccess(sub:string,uid:string,issuer:string,secret:string|undefined){
 if(process.env.HS_APP_AUTHORITY_ENABLED!=='1')return;
 let endpoint:URL;
 try{const base=new URL(issuer);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!secret||secret.length<32)throw Error();endpoint=new URL('/internal/application/status',base);}catch{throw new DocumentError('Suite application access verification is unavailable','identity_unavailable',503);}
 let response:Response;
 try{response=await fetch(endpoint,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(3000),headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'holy-sheet',client_secret:secret,sub,uid})});}catch{throw new DocumentError('Suite application access verification is unavailable','identity_unavailable',503);}
 if(!response.ok)throw new DocumentError('Suite application access verification is unavailable','identity_unavailable',503);
 let result:unknown;try{result=await response.json();}catch{throw new DocumentError('Suite application access verification is unavailable','identity_unavailable',503);}
 if((result as {active?:unknown})?.active!==true||(result as {subject?:unknown}).subject!==sub)throw new DocumentError('Holy Sheet access has been removed','application_access_required',403);
}
