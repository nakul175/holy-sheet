// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import RecordNotifications from '../components/record-notifications';

const fetchMock=vi.fn();
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();document.body.replaceChildren();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const item={id:'00000000-0000-4000-8000-0000000000d1',recordId:'00000000-0000-4000-8000-0000000000a1',recordName:'Northwind',commentId:'00000000-0000-4000-8000-0000000000c1',body:'Thanks for the update',authorName:'Ada Viewer',reason:'mention',createdAt:'2026-10-31T12:00:00.000Z',readAt:null,email:'secret@example.com',capabilities:['secret-cap']};

async function render(onOpen=vi.fn()){
 vi.stubGlobal('fetch',fetchMock);
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(RecordNotifications,{workspaceId:'ws one',tenantId:'00000000-0000-4000-8000-000000000002',onOpen})));
 return {host,onOpen,unmount:async()=>{await act(async()=>root.unmount());host.remove();}};
}

it('loads record notifications on open and marks the parsed record read',async()=>{
 fetchMock.mockImplementation(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return response({id:item.id,read:true,recordId:'forged-record',email:'secret@example.com'});
  return response({notifications:[item]});
 });
 const view=await render();
 try{
  expect(fetchMock).not.toHaveBeenCalled();
  expect(view.host.textContent).not.toContain('Northwind');
  await act(async()=>{view.host.querySelector('button')!.click();});
  expect(view.host.textContent).toContain('Northwind');
  expect(view.host.textContent).toContain('Mentioned you');
  expect(view.host.textContent).toContain('Thanks for the update');
  expect(view.host.textContent).not.toContain('secret@example.com');
  expect(view.host.textContent).not.toContain('secret-cap');
  expect(view.host.querySelector('[aria-label="Unread"]')).toBeTruthy();
  await act(async()=>{view.host.querySelector<HTMLButtonElement>('.notification-link')!.click();});
  const post=fetchMock.mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(String(post[0])).toContain('/tenants/00000000-0000-4000-8000-000000000002/record-notifications');
  expect(JSON.parse(String(post[1].body))).toEqual({id:item.id});
  expect(view.onOpen).toHaveBeenCalledTimes(1);
  expect(view.onOpen).toHaveBeenCalledWith(item.recordId);
 }finally{await view.unmount();}
});

it('does not open a record when marking the notification read is denied',async()=>{
 let posted=false;
 fetchMock.mockImplementation(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posted=true;return response({error:'Notification unavailable.',code:'not_found',recordId:'forged-record'},404);}
  return response({notifications:posted?[]:[item]});
 });
 const view=await render();
 try{
  await act(async()=>{view.host.querySelector('button')!.click();});
  await act(async()=>{view.host.querySelector<HTMLButtonElement>('.notification-link')!.click();});
  expect(view.onOpen).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain('No accessible record notifications yet.');
  expect(view.host.textContent).not.toContain('forged-record');
  expect(view.host.textContent).not.toContain('secret@example.com');
 }finally{await view.unmount();}
});
