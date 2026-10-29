import {expect,test,type APIRequestContext,type Page} from '@playwright/test';
import axe,{type AxeResults,type RunOptions} from 'axe-core';
import type {Editor} from '@tiptap/core';

const imageId='00000000-0000-4000-8000-000000000138';
async function fixture(request:APIRequestContext,origin:string){
 const response=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'Disposable HOLY-138 image fixture '+crypto.randomUUID(),spaceId:'space-product'}});expect(response.status()).toBe(200);return (await response.json()).page;
}
async function controlledViewer(page:Page,request:APIRequestContext,baseURL:string,fail=false,role:'viewer'|'owner'='viewer'){
 const made=await fixture(request,baseURL);let imageRequests=0,operations=0,drafts=0;
 page.on('request',value=>{if(value.method()==='POST'&&value.url().includes('/operations'))operations++;if(value.method()==='POST'&&value.url().endsWith('/drafts'))drafts++;});
 await page.route('**/document',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({response,json:{...body,page:{...body.page,role,document:{type:'doc',content:[...Array.from({length:40},(_,index)=>({type:'paragraph',attrs:{id:`long-${index}`},content:[{type:'text',text:`Long page row ${index} ${'content '.repeat(20)}`}]})),{type:'image',attrs:{id:'image',attachmentId:imageId,src:`/api/media/${imageId}`,alt:'Quarterly revenue chart',caption:'FY26 actuals',width:1600}},{type:'paragraph',attrs:{id:'tail'}}]}}}});});
 await page.route('**/access',route=>route.fulfill({json:{actorId:'00000000-0000-4000-8000-000000000001',role}}));
 await page.route(`**/api/media/${imageId}`,route=>{imageRequests++;return fail?route.abort('failed'):route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200"><rect width="2400" height="1200" fill="#3f3d82"/></svg>'});});
 await page.goto('/pages/'+made.id);await expect(page.locator('.rich-prose')).toHaveAttribute('contenteditable',role==='viewer'?'false':'true');return {made,imageRequests:()=>imageRequests,writes:()=>({operations,drafts})};
}
async function editorState(page:Page){return page.locator('.rich-prose').evaluate(node=>{const editor=(node as HTMLElement&{editor:Editor}).editor;return {document:editor.getJSON(),selection:{from:editor.state.selection.from,to:editor.state.selection.to},undo:editor.can().undo(),redo:editor.can().redo()};});}

test('viewer opens one permitted image accessibly without changing editor state or writing',async({page,request,baseURL})=>{
 await page.setViewportSize({width:320,height:900});await page.emulateMedia({reducedMotion:'reduce'});const fixture=await controlledViewer(page,request,baseURL!);const opener=page.getByRole('button',{name:'Enlarge image',exact:true});await expect(opener).toBeVisible();const before=await editorState(page),version=(await(await request.get(`/api/v1/pages/${fixture.made.id}/document`)).json()).page.version;
 await opener.focus();await opener.click();const dialog=page.getByRole('dialog',{name:'Enlarged image',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole('img',{name:'Quarterly revenue chart',exact:true})).toBeVisible();await expect(dialog).toContainText('FY26 actuals');await expect(dialog.locator('img')).toHaveCount(1);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
 await page.keyboard.press('Shift+Tab');await expect(dialog.getByRole('button',{name:'Close dialog'})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(opener).toBeFocused();expect(await editorState(page)).toEqual(before);expect(fixture.writes()).toEqual({operations:0,drafts:0});expect((await(await request.get(`/api/v1/pages/${fixture.made.id}/document`)).json()).page.version).toBe(version);expect(fixture.imageRequests()).toBeLessThanOrEqual(2);
 await page.addScriptTag({content:axe.source});const violations=await page.evaluate(async()=>{const engine=(window as unknown as {axe:{run:(root:Element,options:RunOptions)=>Promise<AxeResults>}}).axe;return (await engine.run(document.querySelector('#document-content')!,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}})).violations;});expect(violations).toEqual([]);
});

test('failed protected media stays honest and Retry never changes its path',async({page,request,baseURL})=>{
 const fixture=await controlledViewer(page,request,baseURL!,true);await page.getByRole('button',{name:'Enlarge image',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Enlarged image',exact:true});await expect(dialog.getByRole('alert')).toContainText('unavailable');const before=fixture.imageRequests();await dialog.getByRole('button',{name:'Retry image',exact:true}).click();await expect.poll(fixture.imageRequests).toBeGreaterThan(before);for(const source of await dialog.locator('img').evaluateAll(images=>images.map(image=>image.getAttribute('src'))))expect(source).toBe(`/api/media/${imageId}`);expect(fixture.writes()).toEqual({operations:0,drafts:0});
});

test('owner image selection and undo state survive opening and closing the viewer',async({page,request,baseURL})=>{
 const fixture=await controlledViewer(page,request,baseURL!,false,'owner');const image=page.getByRole('img',{name:'Quarterly revenue chart',exact:true});await image.click();await expect(page.locator('figure[data-hs-image]')).toHaveClass(/ProseMirror-selectednode/);const before=await editorState(page),baseline=fixture.writes();await page.getByRole('button',{name:'Enlarge image',exact:true}).click();await page.getByRole('button',{name:'Close dialog',exact:true}).click();expect(await editorState(page)).toEqual(before);expect(fixture.writes()).toEqual(baseline);
});
