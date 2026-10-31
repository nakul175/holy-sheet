// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import RecordComments from '../components/record-comments';

const fetchMock=vi.fn();
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();document.body.replaceChildren();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const comment={id:'00000000-0000-4000-8000-0000000000c1',authorId:'ada',authorName:'Ada Viewer',body:'Thanks @Your workspace',createdAt:'2026-10-31T12:00:00.000Z',mentions:[{id:'owner',name:'Your workspace'}],email:'secret@example.com',capabilities:['secret-cap']};

async function render(){
 vi.stubGlobal('fetch',fetchMock);
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(RecordComments,{workspaceId:'ws one',tenantId:'00000000-0000-4000-8000-000000000002',recordId:'00000000-0000-4000-8000-0000000000a1'})));
 return {host,unmount:async()=>{await act(async()=>root.unmount());host.remove();}};
}
async function type(element:HTMLTextAreaElement,value:string){
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(element,value);
  element.selectionStart=element.selectionEnd=value.length;
  element.dispatchEvent(new Event('input',{bubbles:true}));
 });
}

it('shows a saved mention and does not render hidden comment fields',async()=>{
 fetchMock.mockResolvedValue(response({comments:[comment],truncated:false}));
 const view=await render();
 try{
  expect(view.host.querySelector('section[aria-label="Record comments"]')).toBeTruthy();
  expect(view.host.textContent).toContain('Ada Viewer');
  expect(view.host.textContent).toContain('@Your workspace');
  expect(view.host.querySelector('.record-mention')?.textContent).toBe('@Your workspace');
  expect(view.host.textContent).toContain('A mention does not grant access.');
  expect(view.host.textContent).not.toContain('secret@example.com');
  expect(view.host.textContent).not.toContain('secret-cap');
  expect(view.host.querySelector('button[name="grant"],[aria-label="Grant access"]')).toBeNull();
 }finally{await view.unmount();}
});

it('inserts a resolved member and posts that mention',async()=>{
 const saved={...comment,id:'00000000-0000-4000-8000-0000000000c2',body:'Thanks @Ada Viewer ',mentions:[{id:'ada',name:'Ada Viewer'}],email:undefined,capabilities:undefined};
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST')return response({comment:saved,replayed:false});
  if(String(url).includes('q='))return response({people:[{id:'ada',name:'Ada Viewer',email:'secret@example.com'}]});
  return response({comments:[],truncated:false});
 });
 const view=await render();
 try{
  const field=view.host.querySelector('textarea')!;
  await type(field,'Thanks @Ad');
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,180));});
  expect(view.host.textContent).toContain('Ada Viewer');
  expect(view.host.textContent).not.toContain('secret@example.com');
  await act(async()=>{view.host.querySelector<HTMLButtonElement>('[role="option"]')!.click();});
  expect(field.value).toBe('Thanks @Ada Viewer ');
  await act(async()=>{view.host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  const post=fetchMock.mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(String(post[0])).toContain('/records/00000000-0000-4000-8000-0000000000a1/comments');
  expect(JSON.parse(String(post[1].body))).toMatchObject({body:'Thanks @Ada Viewer ',mentionIds:['ada']});
  expect(view.host.textContent).toContain('Comment posted.');
  expect(view.host.querySelector('.record-mention')?.textContent).toBe('@Ada Viewer');
 }finally{await view.unmount();}
});

it('follows and unfollows without rendering hidden follow fields',async()=>{
 fetchMock.mockImplementation(async(url:string,init?:RequestInit)=>{
  if(String(url).endsWith('/follow')&&init?.method==='PUT')return response({following:true,email:'secret@example.com',capabilities:['secret-cap']});
  if(String(url).endsWith('/follow')&&init?.method==='DELETE')return response({following:false,email:'secret@example.com'});
  if(String(url).endsWith('/follow'))return response({following:false,email:'secret@example.com',capabilities:['secret-cap']});
  return response({comments:[],truncated:false});
 });
 const view=await render();
 try{
  expect(view.host.textContent).toContain('Following does not grant access.');
  expect(view.host.textContent).not.toContain('secret@example.com');
  expect(view.host.textContent).not.toContain('secret-cap');
  const follow=view.host.querySelector<HTMLButtonElement>('button')!;
  expect(follow.textContent).toBe('Follow');
  await act(async()=>{follow.click();});
  const put=fetchMock.mock.calls.find(call=>call[1]?.method==='PUT')!;
  expect(String(put[0])).toContain('/follow');
  expect(put[1].body).toBe('{}');
  expect(view.host.textContent).toContain('You follow this record.');
  const unfollow=[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Unfollow')!;
  await act(async()=>{unfollow.click();});
  expect(fetchMock.mock.calls.some(call=>call[1]?.method==='DELETE'&&String(call[0]).endsWith('/follow'))).toBe(true);
  expect(view.host.textContent).toContain('You unfollowed this record.');
 }finally{await view.unmount();}
});

it('hides the composer when the record is not available',async()=>{
 fetchMock.mockResolvedValue(response({error:'Record is restricted or unavailable.',code:'record_not_found'},404));
 const view=await render();
 try{
  expect(view.host.textContent).toContain('Comments are not available with your current access.');
  expect(view.host.querySelector('textarea')).toBeNull();
  expect(view.host.querySelector('form')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{await view.unmount();}
});
