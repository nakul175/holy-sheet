// @vitest-environment jsdom
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { act,createElement,useEffect } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import EmbedIdentityBoundary from '../components/embed-identity-boundary';
import { embedContext } from './embed-context';
let root:Root,host:HTMLDivElement,parentDescriptor:PropertyDescriptor|undefined;
const fetcher=vi.fn(),mounted=vi.fn();
function Child(){useEffect(()=>{mounted();},[]);return createElement('p',null,'Protected document fixture');}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',fetcher);fetcher.mockReset();mounted.mockReset();parentDescriptor=Object.getOwnPropertyDescriptor(window,'parent');Object.defineProperty(window,'parent',{configurable:true,value:{}});location.hash='#hs-user=actor-a';host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();if(parentDescriptor)Object.defineProperty(window,'parent',parentDescriptor);location.hash='';vi.useRealTimers();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(createElement(EmbedIdentityBoundary,{pageId:'qa-page',children:createElement(Child)})));}
it('does not mount the document while identity is pending, then permits only the matching verified user',async()=>{
  let finish!:(response:Response)=>void;fetcher.mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve;}));await render();expect(mounted).not.toHaveBeenCalled();
  await act(async()=>finish(Response.json({authenticated:true,userId:'actor-a'})));
  expect(mounted).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('Protected document fixture');
  expect(fetcher).toHaveBeenCalledWith('/auth/session',expect.objectContaining({cache:'no-store'}));
});
it('never mounts or fetches document content for a different authenticated account',async()=>{
  fetcher.mockResolvedValue(Response.json({authenticated:true,userId:'actor-b'}));await render();
  expect(mounted).not.toHaveBeenCalled();expect(host.textContent).toContain('same Aplyd account');expect(host.textContent).not.toContain('Protected document');
});
it.each([401,503])('keeps the document unmounted when session check returns %s',async status=>{
  fetcher.mockResolvedValue(new Response('{}',{status}));await render();expect(mounted).not.toHaveBeenCalled();
});
it.each([{authenticated:false,userId:'actor-a'},{authenticated:true},{authenticated:true,userId:''}])('does not accept a malformed successful session response',async identity=>{
  fetcher.mockResolvedValue(Response.json(identity));await render();expect(mounted).not.toHaveBeenCalled();expect(host.textContent).toContain('Document access could not be checked');
});
it('refuses missing or ambiguous framed context without making an identity request',async()=>{
  location.hash='#hs-user=actor-a&hs-user=actor-b';await render();expect(fetcher).not.toHaveBeenCalled();expect(mounted).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Open this document from your task');
});
it('verifies top-level embed-route identity without pretending it is a host identity handoff',async()=>{
  Object.defineProperty(window,'parent',{configurable:true,value:window});location.hash='';fetcher.mockResolvedValue(Response.json({authenticated:true,userId:'actor-a'}));await render();expect(mounted).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledWith('/auth/session',expect.objectContaining({cache:'no-store'}));
});
it('rejects unsafe/oversize hints and treats hints as restrictions even at top level',()=>{
  expect(embedContext('#hs-user=%0Aactor',true)).toEqual({kind:'missing'});
  expect(embedContext('#hs-user='+('x'.repeat(201)),true)).toEqual({kind:'missing'});
  expect(embedContext('#hs-user=actor-a',false)).toEqual({kind:'restricted',userId:'actor-a'});
  expect(embedContext('',true)).toEqual({kind:'missing'});
});
it('times out a stalled identity check without mounting content and permits an explicit retry',async()=>{
  vi.useFakeTimers();
  fetcher.mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true})));
  await render();expect(mounted).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(host.textContent).toContain('Document access could not be checked');expect(mounted).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(Response.json({authenticated:true,userId:'actor-a'}));
  await act(async()=>host.querySelector('button')!.click());
  expect(mounted).toHaveBeenCalledOnce();
});
