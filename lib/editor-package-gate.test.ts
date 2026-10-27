// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {SessionGate,createHolySheetSessionProvider} from '@aplyd/holy-sheet-editor/boundary';
it('requires a restrictive context in any frame even if the host asks for standalone layout',async()=>{
  const parent=Object.getOwnPropertyDescriptor(window,'parent'),fetcher=vi.fn();
  Object.defineProperty(window,'parent',{configurable:true,value:{}});vi.stubGlobal('fetch',fetcher);location.hash='';
  try{expect(await createHolySheetSessionProvider().check({pageId:'qa-page',viewContext:'standalone',signal:new AbortController().signal})).toEqual({status:'missing'});expect(fetcher).not.toHaveBeenCalled();}
  finally{if(parent)Object.defineProperty(window,'parent',parent);vi.unstubAllGlobals();}
});
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
