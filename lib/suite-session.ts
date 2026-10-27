import { DocumentError } from './document';

/** Accounts' confidential-client contract, also bound to the upstream SHO session. */
export async function requireActiveSuiteSession(sub:string,uid:unknown,issuer:string,secret:string|undefined){
  if(typeof uid!=='string'||!uid.length||uid.length>200)throw new DocumentError('Sign in again to verify your suite session','authentication_required',401);
  let endpoint:URL;
  try{
    const base=new URL(issuer);
    if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('Invalid issuer');
    if(!secret||secret.length<32)throw Error('Missing client authentication');
    endpoint=new URL('/internal/session/status',base);
  }catch{throw new DocumentError('Suite session verification is unavailable','identity_unavailable',503);}
  let active:boolean;
  try{
    const response=await fetch(endpoint,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(3000),headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'holy-sheet',client_secret:secret,sub,uid})});
    if(!response.ok)throw Error('Session authority unavailable');
    const result=await response.json();
    if(result?.active===false)active=false;
    else if(result?.active===true&&result.sub===sub&&typeof result.local_id==='string'&&result.local_id.length>0)active=true;
    else throw Error('Invalid session authority response');
  }catch{throw new DocumentError('Suite session verification is unavailable','identity_unavailable',503);}
  if(!active)throw new DocumentError('Your suite session has ended. Sign in again.','authentication_required',401);
}
