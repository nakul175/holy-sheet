import {expect,test,type APIRequestContext,type Page} from '@playwright/test';
import type {Editor} from '@tiptap/core';
import axe,{type AxeResults,type RunOptions} from 'axe-core';

const origin='http://127.0.0.1:53341';
const href='https://example.test/inspect/%F0%9F%98%80?literal=%3Ctag%3E&long='+('x'.repeat(500));
const link=(label:string,destination=href)=>({type:'text',text:label,marks:[{type:'bold'},{type:'italic'},{type:'link',attrs:{href:destination,target:'_blank',rel:'noopener noreferrer'}}]});

async function fixture(request:APIRequestContext){
  const targetResponse=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'HOLY-137 reference target '+crypto.randomUUID(),spaceId:'space-product'}});expect(targetResponse.status()).toBe(200);const target=(await targetResponse.json()).page;
  const created=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'HOLY-137 link inspector '+crypto.randomUUID(),spaceId:'space-product'}});expect(created.status()).toBe(200);const page=(await created.json()).page;
  const bulk=Array.from({length:150},(_,index)=>({type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:`Large document row ${index} `},link(`link ${index}`,`https://example.test/${index}`)]}));
  const document={type:'doc',content:[{type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:'Before '},link('Formatted <inspect> مرحبا 世界'),{type:'text',text:' after'}]},{type:'pageLink',attrs:{id:crypto.randomUUID(),pageId:target.id}},...bulk,{type:'paragraph',attrs:{id:crypto.randomUUID()},content:[link('Mail','mailto:reader@example.test'),{type:'text',text:' '},link('Telephone','tel:+44123456789')]}]};
  const saved=await request.post(`/api/v1/pages/${page.id}/operations`,{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});expect(saved.status(),await saved.text()).toBe(200);
  return {page:(await saved.json()).page,target};
}

async function editorState(page:Page){return page.locator('.rich-prose').evaluate(node=>{const editor=(node as HTMLElement&{editor:Editor}).editor,{from,to}=editor.state.selection;return {document:editor.getJSON(),selection:{from,to},undo:editor.can().undo(),redo:editor.can().redo()};});}
async function ready(page:Page){await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();}

test('owner inspects, copies and opens an exact formatted destination without document mutation',async({page,request,context})=>{
  const data=await fixture(request),operations:unknown[]=[],external:unknown[]=[];
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.addInitScript(()=>{(window as unknown as {opened:unknown[]}).opened=[];window.open=((url?:string|URL,target?:string,features?:string)=>{(window as unknown as {opened:unknown[]}).opened.push([String(url),target,features]);return {opener:{}} as Window;}) as typeof window.open;});
  await page.route('**/document',async route=>{const response=await route.fetch(),body=await response.json(),document=body.page.document;await route.fulfill({response,json:{...body,page:{...body.page,document:{...document,content:[...document.content.slice(0,2),{type:'file',attrs:{id:crypto.randomUUID(),attachmentId:'holy137-download',title:'HOLY-137 attachment'}},...document.content.slice(2)]}}}});});
  await page.route('**/api/media/holy137-download/metadata',route=>route.fulfill({json:{name:'HOLY-137 attachment',size:10,mime:'text/plain'}}));
  await page.route('**/api/media/holy137-download',route=>route.fulfill({status:200,headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="holy137.txt"'},body:'attachment'}));
  await page.route(`**/api/v1/pages/${data.page.id}/operations`,async route=>{operations.push(route.request().postDataJSON());await route.continue();});
  page.on('request',request=>{if(request.url().startsWith('https://example.test/'))external.push(request.url());});
  await page.goto('/pages/'+data.page.id);await ready(page);const before=await editorState(page),anchor=page.getByRole('link',{name:'Formatted <inspect> مرحبا 世界',exact:true});
  await anchor.click();const dialog=page.getByRole('dialog',{name:'Inspect link',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByLabel('Link destination')).toHaveValue(href);expect(await editorState(page)).toEqual(before);
  await dialog.getByRole('button',{name:'Copy',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Destination copied.');expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(href);
  await dialog.getByRole('button',{name:'Open',exact:true}).click();await expect(dialog.getByRole('status')).toHaveText('Destination opened.');expect(await page.evaluate(()=>(window as unknown as {opened:unknown[]}).opened)).toEqual([[href,'_blank','noopener,noreferrer']]);expect(external).toEqual([]);
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(anchor).toBeFocused();expect(await editorState(page)).toEqual(before);
  await anchor.focus();await anchor.press('Enter');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Close dialog'}).click();await expect(anchor).toBeFocused();
  const preserved=await anchor.evaluate(async element=>{
    const activate=(init:MouseEventInit)=>new Promise<boolean>(resolve=>{let seen=false;const observe=(event:Event)=>{seen=true;const prevented=event.defaultPrevented;event.preventDefault();resolve(!prevented);};element.addEventListener('click',observe,{once:true});element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...init}));setTimeout(()=>{if(!seen)resolve(false);},20);});
    return Promise.all([{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}].map(activate));
  });expect(preserved).toEqual([true,true,true,true,true]);await expect(dialog).toHaveCount(0);
  const received=page.waitForEvent('download');await page.getByRole('link',{name:'HOLY-137 attachment'}).click();expect((await received).suggestedFilename()).not.toBe('');await expect(dialog).toHaveCount(0);
  await page.locator('.reference-block a').first().click();await expect(page).toHaveURL('/pages/'+data.target.id);await expect(page.getByRole('dialog',{name:'Inspect link'})).toHaveCount(0);
  expect(operations).toEqual([]);const after=(await(await request.get(`/api/v1/pages/${data.page.id}/document`)).json()).page;expect(after.version).toBe(data.page.version);expect(after.document).toEqual(data.page.document);
});

test('viewer remains read-only with honest fallback, dismissal, responsive zoom and bounded repeated activation',async({page,request,context})=>{
  const data=await fixture(request),operations:unknown[]=[];let actor='holy137-controlled-viewer';
  await page.route('**/auth/session',route=>route.fulfill({json:{authenticated:true,userId:actor}}));
  await page.route('**/document',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,actorId:actor,page:{...body.page,role:'viewer'}}});});
  await page.route('**/access',route=>route.fulfill({json:{actorId:actor,role:'viewer'}}));
  await page.route(`**/api/v1/pages/${data.page.id}/operations`,async route=>{operations.push(route.request().postDataJSON());await route.continue();});
  await context.clearPermissions();await page.setViewportSize({width:320,height:800});await page.goto('/pages/'+data.page.id);await expect(page.locator('.rich-prose')).toHaveAttribute('contenteditable','false');
  const anchor=page.getByRole('link',{name:'Formatted <inspect> مرحبا 世界',exact:true}),started=Date.now();
  for(let index=0;index<8;index++){await anchor.focus();await anchor.press('Enter');await expect(page.getByRole('dialog',{name:'Inspect link'})).toBeVisible();await page.keyboard.press('Escape');}
  expect(Date.now()-started).toBeLessThan(15000);expect(operations).toEqual([]);
  await anchor.press('Enter');const dialog=page.getByRole('dialog',{name:'Inspect link'});await dialog.getByRole('button',{name:'Copy'}).click();const feedback=dialog.locator('[role="status"],[role="alert"]');await expect(feedback).toBeVisible();if(await feedback.getAttribute('role')==='alert'){await expect(feedback).toContainText('Select and copy');await expect(dialog.getByLabel('Link destination')).toBeFocused();}
  const session=await context.newCDPSession(page);await session.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});const bounds=await dialog.evaluate(node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,viewport:window.innerWidth};});expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.viewport+1);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.addScriptTag({content:axe.source});const violations=await page.evaluate(async()=>{const engine=(window as unknown as {axe:{run:(root:Element,options:RunOptions)=>Promise<AxeResults>}}).axe;return (await engine.run(document.querySelector('[role="dialog"]')!,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}})).violations;});expect(violations).toEqual([]);
  actor='holy137-second-viewer';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(dialog).toHaveCount(0);await page.reload();await expect(page.locator('.rich-prose')).toHaveAttribute('contenteditable','false');await expect(page.getByRole('button',{name:'Edit link'})).toHaveCount(0);expect(operations).toEqual([]);
});
