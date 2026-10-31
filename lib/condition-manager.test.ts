// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import ConditionManager from '../components/condition-manager';

const fetchMock=vi.fn();
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
const ruleId='00000000-0000-4000-8000-0000000000c1';
const previewId='00000000-0000-4000-8000-0000000000c2';
const hash='ab'.repeat(32);
const comparison=[{field:'core:flag',operator:'equals',value:true},{field:'core:amount',operator:'greater-than',value:10}];
const group={any:comparison};
const fields=[
 {key:'core:flag',label:'Flag',kind:'boolean',required:false,choices:[]},
 {key:'core:amount',label:'Amount',kind:'number',required:false,choices:[]},
 {key:'core:notes',label:'Notes',kind:'long-text',required:false,choices:[]},
 {key:'core:code',label:'Code',kind:'text',required:true,choices:[]},
];
const policy={version:4,schemaVersion:3,rules:[{id:ruleId,target:'core:notes',showWhen:group,requiredWhen:group}],fields};

async function mount(){
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');
 document.body.append(host);
 const root=createRoot(host);
 await act(async()=>root.render(createElement(ConditionManager,{workspaceId:'ws one',tenantId:'00000000-0000-4000-8000-000000000002',collection:'organisations'})));
 return {host,dispose:async()=>{await act(async()=>root.unmount());host.remove();}};
}
async function choose(element:HTMLSelectElement,value:string){
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('change',{bubbles:true}));});
}

it('reviews an all-or-any typed rule and publishes that review without record values',async()=>{
 fetchMock.mockImplementation((_url:string,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):null;
  if(body?.kind==='preview')return response({previewId,reviewHash:hash,blocked:false,existingRecordsReviewed:2,incompatibleRecords:0,draftsReady:false});
  if(body?.kind==='publish')return response({version:5,replayed:false});
  return response(policy);
 });
 const view=await mount();
 try{
  expect(view.host.querySelector('textarea')).toBeNull();
  expect((view.host.querySelector('[aria-label="Rule 1 match"]') as HTMLSelectElement).value).toBe('any');
  expect(view.host.querySelectorAll('[aria-label^="Rule 1 comparison"][aria-label$="source"]')).toHaveLength(2);
  expect((view.host.querySelector('[aria-label="Rule 1 show"]') as HTMLInputElement).checked).toBe(true);
  await act(async()=>[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Add comparison')!.click());
  await act(async()=>[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Review policy')!.click());
  const reviewed=JSON.parse(String(fetchMock.mock.calls.find(call=>call[1]?.method==='POST')![1].body));
  expect(reviewed).toMatchObject({kind:'preview',selection:{collection:'organisations',expectedVersion:4,expectedSchemaVersion:3}});
  expect(reviewed.selection.rules[0].showWhen.any).toEqual([...comparison,{field:'core:flag',operator:'is-not-empty'}]);
  expect(reviewed.selection.rules[0].requiredWhen).toEqual(reviewed.selection.rules[0].showWhen);
  expect(reviewed.values).toBeUndefined();
  expect(JSON.stringify(reviewed)).not.toContain('salary');
  expect(view.host.querySelector('section[aria-label="Policy confirmation"]')).not.toBeNull();
  await choose(view.host.querySelector('[aria-label="Rule 1 match"]') as HTMLSelectElement,'all');
  expect(view.host.querySelector('section[aria-label="Policy confirmation"]')).toBeNull();
  await act(async()=>[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Review policy')!.click());
  await act(async()=>[...view.host.querySelectorAll('button')].find(button=>button.textContent==='Publish reviewed policy')!.click());
  const sent=fetchMock.mock.calls.filter(call=>call[1]?.method==='POST').map(call=>JSON.parse(String(call[1].body)));
  expect(sent.at(-1)).toMatchObject({kind:'publish',previewId,reviewHash:hash,confirm:'publish-conditional-policy'});
  expect(sent.at(-1).selection.rules[0].showWhen.all).toHaveLength(3);
  expect(sent.at(-1).values).toBeUndefined();
  expect(view.host.textContent).toContain('Hidden values are retained until explicitly cleared.');
  await choose(view.host.querySelector('[aria-label="Rule 1 target"]') as HTMLSelectElement,'core:code');
  const show=view.host.querySelector('[aria-label="Rule 1 show"]') as HTMLInputElement;
  expect(show.disabled).toBe(true);
  expect(show.checked).toBe(false);
 }finally{await view.dispose();}
});

it('shows a forbidden policy response without rule fields',async()=>{
 fetchMock.mockResolvedValueOnce(await response({error:'Conditional policy is unavailable.',rules:[{target:'Unpublished salary'}]},403));
 const view=await mount();
 try{
  expect(view.host.textContent).toContain('Conditional policy is unavailable.');
  expect(view.host.textContent).not.toContain('Unpublished salary');
  expect(fetchMock).toHaveBeenCalledTimes(1);
 }finally{await view.dispose();}
});
