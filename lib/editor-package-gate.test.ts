// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {SessionGate} from '@aplyd/holy-sheet-editor/boundary';
it('enforces its own deadline even if a provider ignores abort and later succeeds',async()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  let finish!:(value:{status:'ready';subject:string})=>void;
  const provider={check:()=>new Promise<{status:'ready';subject:string}>(resolve=>{finish=resolve;})};
  try{
    await act(async()=>root.render(createElement(SessionGate,{pageId:'qa-page',viewContext:'standalone',sessionProvider:provider,children:createElement('p',null,'Protected fixture')})));
    await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
    expect(host.textContent).toContain('Document access could not be checked');
    await act(async()=>finish({status:'ready',subject:'qa-user'}));
    expect(host.textContent).not.toContain('Protected fixture');expect(host.textContent).toContain('Check again');
  }finally{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();}
});
