import {expect,test,type APIRequestContext,type Page} from '@playwright/test';
import type {Editor} from '@tiptap/core';
import axe,{type AxeResults,type RunOptions} from 'axe-core';
import {releaseRoutesWhenDone} from './release-routes';
releaseRoutesWhenDone();

const origin='http://127.0.0.1:53345';
const paragraph=(id:string,text:string)=>({type:'paragraph',attrs:{id},content:[{type:'text',text}]});

async function fixture(request:APIRequestContext){
  const created=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'HOLY-142 reading guide '+crypto.randomUUID(),spaceId:'space-product'}});expect(created.status()).toBe(200);const page=(await created.json()).page;
  const bulk=Array.from({length:180},(_,index)=>paragraph(`${page.id}-bulk-${index}`,`Large reading fixture paragraph ${index}`));
  const document={type:'doc',content:[paragraph(`${page.id}-intro`,'First guided paragraph'),{type:'heading',attrs:{id:`${page.id}-heading`,level:2},content:[{type:'text',text:'Guided heading'}]},{type:'bulletList',attrs:{id:`${page.id}-list`},content:[{type:'listItem',attrs:{id:`${page.id}-item`},content:[paragraph(`${page.id}-nested`,'List paragraph is excluded')]}]},{type:'codeBlock',attrs:{id:`${page.id}-code`,language:'plaintext'},content:[{type:'text',text:'const excluded = true;'}]},...bulk]};
  const saved=await request.post(`/api/v1/pages/${page.id}/operations`,{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});expect(saved.status(),await saved.text()).toBe(200);
  return (await saved.json()).page;
}

async function ready(page:Page,editable=true){await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();if(editable)await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();}
async function selectBlock(page:Page,id:string){await page.locator('.rich-prose').evaluate((node,target)=>{const editor=(node as HTMLElement&{editor:Editor}).editor;let position:number|undefined;editor.state.doc.descendants((child,pos)=>{if(child.attrs.id===target){position=pos+1;return false;}});if(position===undefined)throw new Error('Fixture block not found');editor.commands.setTextSelection(position);editor.view.focus();},id);}
async function model(page:Page){return page.locator('.rich-prose').evaluate(node=>{const editor=(node as HTMLElement&{editor:Editor}).editor;return {doc:editor.getJSON(),selection:{from:editor.state.selection.from,to:editor.state.selection.to},undo:editor.can().undo(),redo:editor.can().redo()};});}

test('explicit guide follows only top-level paragraphs and headings with zero writes',async({page,request})=>{
  const data=await fixture(request),operations:unknown[]=[];await page.route(`**/api/v1/pages/${data.id}/operations`,async route=>{operations.push(route.request().postDataJSON());await route.continue();});
  await page.goto('/pages/'+data.id);await ready(page);const before=await model(page),toggle=page.getByRole('button',{name:'Reading guide',exact:true}),intro=page.locator(`[data-id="${data.id}-intro"]`),heading=page.locator(`[data-id="${data.id}-heading"]`);
  await expect(toggle).toHaveAttribute('aria-pressed','false');await selectBlock(page,`${data.id}-intro`);const selection=await model(page);await toggle.click();await expect(toggle).toHaveAttribute('aria-pressed','true');await expect.poll(()=>page.locator('.rich-prose').evaluate(node=>{const editor=(node as HTMLElement&{editor:Editor}).editor,$from=editor.state.selection.$from;return {active:Array.from(document.querySelectorAll('.hs-reading-guide-active')).map(item=>item.getAttribute('data-id')),depth:$from.depth,type:$from.node($from.depth).type.name,status:document.querySelector('.reading-guide-status')?.textContent};})).toEqual({active:[`${data.id}-intro`],depth:1,type:'paragraph',status:'Reading guide on'});expect((await model(page)).selection).toEqual(selection.selection);
  await selectBlock(page,`${data.id}-heading`);await expect(heading).toHaveClass(/hs-reading-guide-active/);await expect(intro).not.toHaveClass(/hs-reading-guide-active/);await selectBlock(page,`${data.id}-nested`);await expect(page.locator('.hs-reading-guide-active')).toHaveCount(0);await expect(page.locator('.reading-guide-status')).toContainText('move to a paragraph or heading');
  const started=Date.now();for(let index=0;index<20;index++){await toggle.click();await toggle.click();}expect(Date.now()-started).toBeLessThan(10000);expect(operations).toEqual([]);expect((await model(page)).doc).toEqual(before.doc);expect((await model(page)).undo).toBe(before.undo);
});

test('viewer guide is temporary, responsive and accessible and resets across pages',async({page,request,context})=>{
  const first=await fixture(request),second=await fixture(request);let actor='holy142-controlled-viewer';
  await page.route('**/auth/session',route=>route.fulfill({json:{authenticated:true,userId:actor}}));await page.route('**/document',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,actorId:actor,page:{...body.page,role:'viewer'}}});});await page.route('**/access',route=>route.fulfill({json:{actorId:actor,role:'viewer'}}));
  await page.setViewportSize({width:320,height:800});await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});await page.goto('/pages/'+first.id);await ready(page,false);await expect(page.locator('.rich-prose')).toHaveAttribute('contenteditable','false');const intro=page.locator(`[data-id="${first.id}-intro"]`);await selectBlock(page,`${first.id}-intro`);await page.getByRole('button',{name:'Reading guide'}).click();await expect(intro).toHaveClass(/hs-reading-guide-active/);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.addScriptTag({content:axe.source});const violations=await page.evaluate(async()=>{const engine=(window as unknown as {axe:{run:(root:Element,options:RunOptions)=>Promise<AxeResults>}}).axe;return (await engine.run(document.querySelector('.rich-editor')!,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}})).violations;});expect(violations).toEqual([]);
  await page.goto('/pages/'+second.id);await ready(page,false);await expect(page.getByRole('button',{name:'Reading guide'})).toHaveAttribute('aria-pressed','false');await expect(page.locator('.hs-reading-guide-active')).toHaveCount(0);actor='holy142-other-viewer';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('.hs-reading-guide-active')).toHaveCount(0);expect((await(await request.get(`/api/v1/pages/${first.id}/document`)).json()).page.version).toBe(first.version);await context.clearPermissions();
});
