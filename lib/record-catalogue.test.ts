// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import RecordCatalogue from '../components/record-catalogue';

const fetchMock=vi.fn();
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();document.body.replaceChildren();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const listId='00000000-0000-4000-8000-000000000010',itemId='00000000-0000-4000-8000-000000000011',fieldId='00000000-0000-4000-8000-000000000012';
const list={schemaVersion:4,collections:[{id:'organisations',name:'Organisations',core:true,deprecated:false,version:1,description:'Public organisation catalogue'}],truncated:false};
const detail={schemaVersion:4,collection:list.collections[0],fields:[{key:'core:notes',label:'Notes',kind:'long-text',required:false,sensitive:false,deprecated:false,core:true,version:1,choices:[]},{key:fieldId,label:'Department',kind:'single-select',required:true,sensitive:false,deprecated:false,core:false,version:2,choices:[],referenceListId:listId,referenceList:{id:listId,name:'Departments',version:3,items:[{id:itemId,label:'Finance',deprecated:false,code:'SECRETCODE',translations:{fr:'Secret translation'}}]}}]};

async function render(collection?:string){
 vi.stubGlobal('fetch',fetchMock);
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(RecordCatalogue,{workspaceId:'workspace a',tenantId:'00000000-0000-4000-8000-000000000002',collection})));
 return {host,unmount:async()=>{await act(async()=>root.unmount());host.remove();}};
}

it('lists allowed collections and expands field definitions without rendering restricted schema',async()=>{
 fetchMock.mockImplementation(async(url:string)=>response(String(url).includes('collection=')?detail:list));
 const view=await render('organisations');
 try{
  expect(view.host.textContent).toContain('Organisations');
  expect(view.host.textContent).toContain('Public organisation catalogue');
  expect(view.host.textContent).toContain('Notes');
  expect(view.host.textContent).toContain('core:notes');
  expect(view.host.textContent).toContain('Department');
  expect(view.host.textContent).toContain('Required');
  expect(view.host.textContent).toContain('Departments');
  expect(view.host.textContent).toContain('Finance');
  expect(view.host.textContent).toContain(itemId);
  expect(view.host.textContent).not.toContain('Private salary');
  expect(view.host.textContent).not.toContain('SECRETCODE');
  expect(view.host.textContent).not.toContain('Secret translation');
  expect(view.host.querySelector('a[href="/workspaces/workspace%20a/tenants/00000000-0000-4000-8000-000000000002/records"]')).toBeTruthy();
  const calls=fetchMock.mock.calls.map(call=>String(call[0]));
  expect(calls.some(url=>url.endsWith('/record-catalogue'))).toBe(true);
  expect(calls.some(url=>url.endsWith('/record-catalogue?collection=organisations'))).toBe(true);
 }finally{await view.unmount();}
});

it('does not request or display a deep-linked collection the catalogue omitted',async()=>{
 fetchMock.mockImplementation(async()=>response(list));
 const view=await render('secret-collection');
 try{
  expect(view.host.textContent).toContain('Organisations');
  expect(view.host.textContent).not.toContain('secret-collection');
  expect(fetchMock.mock.calls.map(call=>String(call[0])).some(url=>url.includes('secret-collection'))).toBe(false);
 }finally{await view.unmount();}
});

it('clears the catalogue when a read is denied and on session lock',async()=>{
 fetchMock.mockImplementation(async(url:string)=>response(String(url).includes('collection=')?detail:list));
 const view=await render();
 try{
  const show=[...view.host.querySelectorAll('button')].find(item=>item.textContent==='Show fields for Organisations');
  await act(async()=>show!.click());
  expect(view.host.textContent).toContain('Department');
  fetchMock.mockImplementation(async()=>response({error:'Record is restricted or unavailable.',leaked:'Private salary'},404));
  const refresh=[...view.host.querySelectorAll('button')].find(item=>item.textContent==='Refresh catalogue');
  await act(async()=>refresh!.click());
  expect(view.host.textContent).toContain('Record is restricted or unavailable.');
  expect(view.host.textContent).not.toContain('Private salary');
  expect(view.host.textContent).not.toContain('Department');
  expect(view.host.textContent).not.toContain('Organisations');
  fetchMock.mockImplementation(async(url:string)=>response(String(url).includes('collection=')?detail:list));
  const again=[...view.host.querySelectorAll('button')].find(item=>item.textContent==='Refresh catalogue');
  await act(async()=>again!.click());
  expect(view.host.textContent).toContain('Organisations');
  await act(async()=>window.dispatchEvent(new Event('hs-session-lock')));
  expect(view.host.textContent).not.toContain('Organisations');
  expect(view.host.textContent).not.toContain('Department');
 }finally{await view.unmount();}
});
