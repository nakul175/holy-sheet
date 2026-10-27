/** Active-tab checks supplement, never replace, server authorization on every operation. */
export function monitorAccess<T>(check:(signal:AbortSignal)=>Promise<T>,receive:(value:T)=>void,unavailable:()=>void,interval=1000){
  let stopped=false,running=false,again=false,controller:AbortController|null=null;
  let deadline:ReturnType<typeof setTimeout>|null=null;
  const run=async()=>{
    if(stopped||document.visibilityState==='hidden')return;
    if(running){again=true;return;}
    running=true;controller=new AbortController();
    try{const request=check(controller.signal);const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{controller?.abort();reject(new Error('Access check timed out'));},5000);});const value=await Promise.race([request,timeout]);if(!stopped)receive(value);}
    catch{if(!stopped)unavailable();}
    finally{if(deadline)clearTimeout(deadline);deadline=null;running=false;controller=null;if(again&&!stopped){again=false;void run();}}
  };
  const recheck=()=>{void run();};
  const visible=()=>{if(document.visibilityState==='visible')recheck();};
  const storage=(event:StorageEvent)=>{if(event.key==='hs-sharing-recheck')recheck();};
  window.addEventListener('focus',recheck);window.addEventListener('online',recheck);
  window.addEventListener('holy-sheet:sharing-changed',recheck);window.addEventListener('storage',storage);
  document.addEventListener('visibilitychange',visible);
  const timer=setInterval(recheck,interval);recheck();
  return ()=>{stopped=true;clearInterval(timer);if(deadline)clearTimeout(deadline);controller?.abort();window.removeEventListener('focus',recheck);window.removeEventListener('online',recheck);window.removeEventListener('holy-sheet:sharing-changed',recheck);window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',visible);};
}

export function announceSharingChange(){
  window.dispatchEvent(new Event('holy-sheet:sharing-changed'));
  try{localStorage.setItem('hs-sharing-recheck',crypto.randomUUID());}catch{/* Poll/focus checks still run when storage is disabled. */}
}
