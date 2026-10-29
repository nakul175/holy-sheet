import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import type {Editor} from '@tiptap/core';
import axe,{type AxeResults,type RunOptions} from 'axe-core';
import {normalizeRichDocument,semanticRichDocument} from '../../lib/editor-document';

const unicode='A👩‍💻e\u0301\tZ\r\n\r\nEnd\n';
async function fixture(request:APIRequestContext,origin:string,code=unicode){
  const made=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'Disposable HOLY-140 code position '+crypto.randomUUID(),spaceId:'space-product'}});expect(made.status()).toBe(200);const page=(await made.json()).page;
  // Assign IDs once; never normalize/canonicalize the fixture's text or document.
  const document={type:'doc',content:[{type:'paragraph',attrs:{id:page.id+'-intro'},content:[{type:'text',text:'Before code'}]},{type:'codeBlock',attrs:{id:page.id+'-code',language:'plaintext'},content:[{type:'text',text:code}]},{type:'paragraph',attrs:{id:page.id+'-after'},content:[{type:'text',text:'After code'}]},{type:'codeBlock',attrs:{id:page.id+'-second',language:'plaintext'},content:[{type:'text',text:'Other code'}]},{type:'paragraph',attrs:{id:page.id+'-tail'}}]};
  const saved=await request.post(`/api/v1/pages/${page.id}/operations`,{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});expect(saved.status()).toBe(200);return (await(await request.get(`/api/v1/pages/${page.id}/document`)).json());
}
type Events={phase:string;operations:{phase:string;at:number;body:unknown}[];drafts:{phase:string;at:number;request:unknown}[];mutations:{phase:string;url:string}[]};
const traces=new WeakMap<Page,Events>();
function trace(page:Page):Events{
  const events:Events={phase:'load',operations:[],drafts:[],mutations:[]};page.on('request',request=>{
    if(!['POST','PUT','PATCH','DELETE'].includes(request.method()))return;
    events.mutations.push({phase:events.phase,url:new URL(request.url()).pathname});
    if(request.url().includes('/operations'))events.operations.push({phase:events.phase,at:Date.now(),body:request.postDataJSON()});
    if(request.url().endsWith('/drafts'))events.drafts.push({phase:events.phase,at:Date.now(),request:request.postDataJSON()});
  });traces.set(page,events);return events;
}
async function ready(page:Page,request:APIRequestContext,id:string){
  await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();
  // Read-only comparison matches existing production readiness, retaining every initial trace.
  await expect.poll(async()=>semanticRichDocument((await(await request.get(`/api/v1/pages/${id}/document`)).json()).page.document)).toEqual(semanticRichDocument(normalizeRichDocument(await page.locator('.rich-prose').evaluate(n=>(n as HTMLElement&{editor:Editor}).editor.getJSON()))));
  await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();return (await(await request.get(`/api/v1/pages/${id}/document`)).json()).page;
}
async function model(page:Page){return page.locator('.rich-prose').evaluate(n=>{const e=(n as HTMLElement&{editor:Editor}).editor;return {document:e.getJSON(),selection:e.state.selection.toJSON(),undo:e.can().undo(),redo:e.can().redo()};});}
async function select(page:Page,id:string,from=0,to=from){await page.locator('.rich-prose').evaluate((n,args)=>{const e=(n as HTMLElement&{editor:Editor}).editor;let start:number|undefined;e.state.doc.descendants((node,pos)=>{if(node.attrs.id===args.id)start=pos+1;});if(start===undefined)throw new Error('Missing code fixture');e.commands.setTextSelection({from:start+args.from,to:start+args.to});e.commands.focus();},{id,from,to});}
async function retain(events:Events){const path=test.info().outputPath('full-initial-operation-trace.json');await writeFile(path,JSON.stringify(events,null,2));await test.info().attach('full-initial-operation-trace',{path,contentType:'application/json'});}
test.afterEach(async({page})=>{const events=traces.get(page);if(events)await retain(events);});

test('literal Unicode boundaries, ranges, wrapping and focus inspection preserve exact document and all initial traces',async({page,request,baseURL})=>{
  const data=await fixture(request,baseURL!),id=data.page.id,events=trace(page);await page.goto('/pages/'+id);const before=await ready(page,request,id),history=await(await request.get(`/api/v1/pages/${id}/history`)).json();
  // Existing recovery establishes one lease on owner load. Retain and verify it;
  // do not reset counters or attribute that baseline request to status inspection.
  await expect.poll(()=>events.drafts.length).toBe(1);expect(events.drafts[0]).toMatchObject({phase:'load',request:{id:expect.any(String)}});
  const initial=await model(page),storage=await page.evaluate(()=>({local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage})}));events.phase='inspect';await select(page,id+'-code',8);const status=page.getByRole('region',{name:'Code position',exact:true});await expect(status).toContainText('line 1 of 4, character position 4. 5 characters in line.');
  const selected=await model(page);await status.focus();await expect(status).toBeFocused();expect(await model(page)).toEqual(selected);
  await select(page,id+'-code',11);await expect(status).toContainText('character position 6 (end of line). 5 characters in line.');await select(page,id+'-code',12);await expect(status).toContainText('line 2 of 4, character position 1 (end of line). 0 characters in line.');
  await select(page,id+'-code',8,1);await expect(status).toContainText('Code selection: line 1, character 2 to line 1, character 4.');
  await select(page,id+'-code',8);const label=await status.locator('span').first().textContent();await page.getByRole('button',{name:'Wrap lines for code block',exact:true}).first().click();await expect(status.locator('span').first()).toHaveText(label!);
  await page.locator('.rich-prose').evaluate(n=>{const e=(n as HTMLElement&{editor:Editor}).editor;let first=0,last=0;e.state.doc.descendants((node,pos)=>{if(node.type.name==='codeBlock'){if(!first)first=pos+1;else last=pos+2;}});e.commands.setTextSelection({from:first,to:last});});await expect(status).toHaveCount(0);
  const after=await model(page);expect(after.document).toEqual(initial.document);expect(after.undo).toBe(initial.undo);expect(after.redo).toBe(initial.redo);expect(events.operations).toEqual([]);expect(events.drafts).toHaveLength(1);expect(events.drafts[0].phase).toBe('load');expect(events.mutations.filter(e=>e.phase==='inspect')).toEqual([]);expect(await page.evaluate(()=>({local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage})}))).toEqual(storage);
  expect((await(await request.get(`/api/v1/pages/${id}/document`)).json()).page).toEqual(before);expect(await(await request.get(`/api/v1/pages/${id}/history`)).json()).toEqual(history);
});

for(const width of [320,1440])test(`keyboard details and existing modes remain accessible at ${width}px`,async({page,request,baseURL})=>{
  await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});const data=await fixture(request,baseURL!),id=data.page.id,events=trace(page);await page.goto('/pages/'+id);await ready(page,request,id);await select(page,id+'-code',1);
  const status=page.getByRole('region',{name:'Code position',exact:true});await expect(status).toBeVisible();await status.focus();await expect(status).toBeFocused();expect(await status.getAttribute('aria-describedby')).toBeTruthy();
  await page.getByLabel('Page options',{exact:true}).click();await page.getByRole('button',{name:'Enter focus mode',exact:true}).click();await expect(status).toBeVisible();await page.getByRole('button',{name:'Exit focus mode',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await page.addScriptTag({content:axe.source});const violations=await page.evaluate(async()=>{const engine=(window as unknown as {axe:{run:(root:Element,options:RunOptions)=>Promise<AxeResults>}}).axe;return (await engine.run(document.querySelector('#document-content')!,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}})).violations;});expect(violations).toEqual([]);expect(events.operations).toEqual([]);await page.screenshot({path:test.info().outputPath('code-position-'+width+'.png')});
});

test('navigation and controlled viewer reload clear old context without adding rights or executing code',async({page,request,baseURL})=>{
  const data=await fixture(request,baseURL!,'<script>window.holy140Executed=true</script>\nsecond'),other=await fixture(request,baseURL!),id=data.page.id;const events=trace(page);await page.goto('/pages/'+id);await ready(page,request,id);await select(page,id+'-code',2);await expect(page.getByRole('region',{name:'Code position',exact:true})).toBeVisible();
  await page.goto('/pages/'+other.page.id);await ready(page,request,other.page.id);await expect(page.getByRole('region',{name:'Code position',exact:true})).toHaveCount(0);
  // Controlled reader transport is rendering/access-loss evidence, not real ACL/auth acceptance.
  await page.route('**/document',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,actorId:'controlled-other-reader',page:{...body.page,role:'viewer'}}});});await page.route('**/access',route=>route.fulfill({json:{role:'viewer',actorId:'controlled-other-reader'}}));await page.goto('/pages/'+id);await expect(page.locator('.rich-prose')).toHaveAttribute('contenteditable','false');await expect(page.getByRole('region',{name:'Code position',exact:true})).toHaveCount(0);await select(page,id+'-code',1);await expect(page.getByRole('region',{name:'Code position',exact:true})).toContainText('line 1 of 2');expect(await page.evaluate(()=>(window as unknown as {holy140Executed?:boolean}).holy140Executed)).toBeUndefined();expect((await model(page)).undo).toBe(false);expect(events.operations).toEqual([]);
});

test('large selected code remains responsive across cached caret movement and a real edit saves normally',async({page,request,baseURL})=>{
  const data=await fixture(request,baseURL!,'x'.repeat(100_000)+'\nlast'),id=data.page.id,events=trace(page);await page.goto('/pages/'+id);const before=await ready(page,request,id);await select(page,id+'-code');
  const timing=await page.locator('.rich-prose').evaluate(n=>{const e=(n as HTMLElement&{editor:Editor}).editor;let start=0;e.state.doc.descendants((node,pos)=>{if(node.type.name==='codeBlock'&&!start)start=pos+1;});const began=performance.now();for(let i=0;i<200;i++)e.commands.setTextSelection(start+(i*499)%100000);return performance.now()-began;});await writeFile(test.info().outputPath('caret-performance.json'),JSON.stringify({textCharacters:100005,moves:200,milliseconds:timing}));expect(timing).toBeLessThan(3000);await expect(page.getByRole('region',{name:'Code position',exact:true})).toBeVisible();expect(events.operations).toEqual([]);
  events.phase='intentional-edit';await select(page,id+'-code',0);await page.keyboard.type('!');await expect.poll(async()=>(await(await request.get(`/api/v1/pages/${id}/document`)).json()).page.version).toBe(before.version+1);await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();expect(events.operations.length).toBeGreaterThan(0);expect(events.operations.every(e=>e.phase==='intentional-edit')).toBe(true);
});
