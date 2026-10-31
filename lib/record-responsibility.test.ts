// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import RecordResponsibility from '../components/record-responsibility';

const fetchMock=vi.fn();
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();document.body.replaceChildren();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const state={responsible:{id:'owner',name:'Your workspace'},pending:null,canOffer:true,canAccept:false,canCancel:false,email:'secret@example.com',capabilities:['secret-cap']};

async function render(){
 vi.stubGlobal('fetch',fetchMock);
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(RecordResponsibility,{workspaceId:'ws one',tenantId:'00000000-0000-4000-8000-000000000002',recordId:'00000000-0000-4000-8000-0000000000a1'})));
 return {host,unmount:async()=>{await act(async()=>root.unmount());host.remove();}};
}

it('offers responsibility to a member who can view and does not render hidden fields',async()=>{
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return response({responsible:{id:'owner',name:'Your workspace'},pending:{id:'00000000-0000-4000-8000-0000000000b1',from:{id:'owner',name:'Your workspace'},to:{id:'ada',name:'Ada Viewer'},createdAt:'2026-10-31T12:00:00.000Z'},canOffer:false,canAccept:false,canCancel:true,email:'secret@example.com'});
  if(String(url).includes('q='))return response({people:[{id:'ada',name:'Ada Viewer',email:'secret@example.com'}]});
  return response(state);
 });
 const view=await render();
 try{
  expect(view.host.querySelector('section[aria-label="Record responsibility"]')).toBeTruthy();
  expect(view.host.textContent).toContain('Responsible: Your workspace');
  expect(view.host.textContent).toContain('does not grant access');
  expect(view.host.textContent).not.toContain('secret@example.com');
  expect(view.host.textContent).not.toContain('secret-cap');
  const field=view.host.querySelector('input')!;
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'Ada');
   field.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,180));});
  expect(view.host.textContent).toContain('Ada Viewer');
  expect(view.host.textContent).not.toContain('secret@example.com');
  await act(async()=>{view.host.querySelector<HTMLButtonElement>('[role="option"]')!.click();});
  await act(async()=>{view.host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  const post=fetchMock.mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(String(post[0])).toContain('/records/00000000-0000-4000-8000-0000000000a1/responsibility');
  expect(JSON.parse(String(post[1].body))).toMatchObject({action:'offer',toUserId:'ada'});
  expect(view.host.textContent).toContain('Handover offered.');
  expect(view.host.textContent).toContain('Handover from Your workspace to Ada Viewer is waiting.');
  expect(view.host.querySelector('button')?.textContent).toBe('Cancel handover');
 }finally{await view.unmount();}
});

it('accepts a waiting handover and hides the controls when access is denied',async()=>{
 const pending={id:'00000000-0000-4000-8000-0000000000b2',from:{id:'ada',name:'Ada Viewer'},to:{id:'owner',name:'Your workspace'},createdAt:'2026-10-31T12:00:00.000Z',email:'secret@example.com'};
 fetchMock.mockImplementation(async(_url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return response({responsible:{id:'owner',name:'Your workspace'},pending:null,canOffer:true,canAccept:false,canCancel:false});
  return response({responsible:{id:'ada',name:'Ada Viewer'},pending,canOffer:false,canAccept:true,canCancel:false,capabilities:['secret-cap']});
 });
 const view=await render();
 try{
  expect(view.host.textContent).toContain('Responsible: Ada Viewer');
  expect(view.host.textContent).not.toContain('secret@example.com');
  expect(view.host.textContent).not.toContain('secret-cap');
  const accept=[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Accept responsibility')!;
  await act(async()=>{accept.click();});
  const post=fetchMock.mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(JSON.parse(String(post[1].body)).action).toBe('accept');
  expect(JSON.parse(String(post[1].body)).toUserId).toBeUndefined();
  expect(view.host.textContent).toContain('You are now responsible for this record.');
 }finally{await view.unmount();}
 fetchMock.mockResolvedValue(response({error:'Record is restricted or unavailable.',code:'record_not_found'},404));
 const denied=await render();
 try{
  expect(denied.host.textContent).toContain('Responsibility is not available with your current access.');
  expect(denied.host.querySelector('form')).toBeNull();
  expect(denied.host.querySelector('button')).toBeNull();
 }finally{await denied.unmount();}
});
