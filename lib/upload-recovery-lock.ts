// A tab holds an exclusive draft lock until its final queued checkpoint completes.
// Crashes release browser locks automatically; another tab then reads the latest ciphertext.
export async function tryUploadRecoveryLock(actorId:string,pageId:string,id:string):Promise<(()=>Promise<void>)|null>{
 if(!navigator.locks)throw new Error('This browser cannot safely coordinate upload recovery across tabs. Recovery is unavailable.');
 let acquired!:(value:(()=>Promise<void>)|null)=>void,rejected!:(error:unknown)=>void,release!:()=>void;
 const ready=new Promise<(()=>Promise<void>)|null>((resolve,reject)=>{acquired=resolve;rejected=reject;});
 const lifetime=navigator.locks.request(JSON.stringify(['holy-sheet-upload',actorId,pageId,id]),{ifAvailable:true},async lock=>{if(!lock){acquired(null);return;}const held=new Promise<void>(resolve=>{release=resolve;});acquired(async()=>{release();await lifetime;});await held;});
 void lifetime.catch(rejected);return ready;
}
