// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import ReferenceListManager from '../components/reference-list-manager';
const fetchMock=vi.fn();
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const previewId='00000000-0000-4000-8000-0000000000b1',reviewHash='ab'.repeat(32);
async function mount(){
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(ReferenceListManager,{workspaceId:'ws one',tenantId:'00000000-0000-4000-8000-000000000002'})));
 return {host,dispose:async()=>{await act(async()=>root.unmount());host.remove();}};
}
function button(host:HTMLElement,label:string){return [...host.querySelectorAll('button')].find(item=>item.textContent===label)!;}
async function type(element:HTMLInputElement,value:string){
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});
}

it('reviews and publishes stable item ids, then binds a field without inline choices',async()=>{
 let published:Record<string,unknown>|undefined;
 fetchMock.mockImplementation((url:string,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):null;
  if(String(url).includes('/reference-lists')&&body?.kind==='preview')return response({previewId,reviewHash});
  if(String(url).includes('/reference-lists')&&body?.kind==='apply'){published=body.selection.definition;return response({definition:published,appliedVersion:published?.version,replayed:false});}
  if(String(url).includes('history=1'))return response({versions:[{version:1,definition:published}],nextBeforeVersion:null});
  if(String(url).includes('/record-schema')&&body?.kind==='preview')return response({previewId,reviewHash,impact:{blockers:[]}});
  if(String(url).includes('/record-schema')&&body?.kind==='apply')return response({fieldKey:'dept'});
  if(String(url).includes('/record-schema'))return response({schemaVersion:4});
  return response({lists:[]});
 });
 const view=await mount();
 try{
  const name=view.host.querySelector('input')!;
  await type(name,'Departments');
  await act(async()=>button(view.host,'Add item').click());
  const label=view.host.querySelector<HTMLInputElement>('[aria-label="Item 1 label"]')!;
  const id=view.host.textContent?.match(/Stable ID ([0-9a-f-]{36})/)?.[1];
  expect(id).toBeTruthy();
  await type(label,'Finance');
  await act(async()=>button(view.host,'Review list').click());
  const reviewed=JSON.parse(String(fetchMock.mock.calls.find(call=>JSON.parse(String(call[1]?.body??'{}')).kind==='preview'&&String(call[0]).includes('/reference-lists'))![1].body));
  expect(reviewed.selection).toMatchObject({expectedVersion:0,definition:{name:'Departments',version:1,items:[{id,code:'ITEM_1',label:'Finance',deprecated:false}]}});
  await type(label,'Treasury');
  expect(view.host.querySelector('section[aria-label="List confirmation"]')).toBeNull();
  await act(async()=>button(view.host,'Review list').click());
  await act(async()=>button(view.host,'Publish reviewed list').click());
  const applied=JSON.parse(String(fetchMock.mock.calls.find(call=>JSON.parse(String(call[1]?.body??'{}')).kind==='apply')![1].body));
  expect(applied.selection.definition.items[0]).toMatchObject({id,label:'Treasury'});
  expect(applied.selection.definition.items[0].id).toBe(reviewed.selection.definition.items[0].id);
  expect(view.host.textContent).toContain('Stable item IDs were retained.');
  await act(async()=>button(view.host,'Show history').click());
  expect(view.host.textContent).toContain(`Treasury`);
  expect(view.host.textContent).toContain(id);
  await act(async()=>view.host.querySelector<HTMLInputElement>('[aria-label="Item 1 deprecated"]')!.click());
  await act(async()=>button(view.host,'Review list').click());
  const deprecated=fetchMock.mock.calls.filter(call=>call[1]?.body).map(call=>JSON.parse(String(call[1].body))).filter(body=>body.kind==='preview'&&body.selection);
  expect(deprecated.at(-1).selection.definition.items[0]).toMatchObject({id,deprecated:true,label:'Treasury'});
  const field=[...view.host.querySelectorAll('label')].find(item=>item.textContent?.startsWith('Field label'))!.querySelector('input')!;
  await type(field,'Department');
  await act(async()=>button(view.host,'Review field binding').click());
  const binding=fetchMock.mock.calls.filter(call=>String(call[0]).includes('/record-schema')&&call[1]?.method==='POST').map(call=>JSON.parse(String(call[1].body)));
  expect(binding[0]).toMatchObject({kind:'preview',collection:'organisations',expectedSchemaVersion:4,definition:{label:'Department',kind:'single-select',choices:[],referenceListId:applied.selection.definition.id}});
  expect(fetchMock.mock.calls.some(call=>String(call[0]).includes('/record-conditions'))).toBe(false);
  await act(async()=>button(view.host,'Create reviewed field').click());
  expect(view.host.textContent).toContain('Stored values use item IDs.');
 }finally{await view.dispose();}
});
