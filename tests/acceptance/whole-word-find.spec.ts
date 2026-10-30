import {test,expect,type APIRequestContext} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const text=(value:string)=>({type:'text',text:value});
async function fixture(request:APIRequestContext,origin:string){
  const created=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'Disposable HOLY-146 whole-word fixture '+crypto.randomUUID(),spaceId:'space-product'}});expect(created.status()).toBe(200);const page=(await created.json()).page;
  const document={type:'doc',content:[{type:'paragraph',attrs:{id:page.id+'-words'},content:[text('cat catalog cat café cafés 中文 中文词 42 420 item_1 item_10 👋cat')]},{type:'paragraph',attrs:{id:page.id+'-literal'},content:[text('a.b aXb')]}]};
  const saved=await request.post(`/api/v1/pages/${page.id}/operations`,{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});expect(saved.status()).toBe(200);return (await saved.json()).page;
}

test('Whole words preserves current-page Find navigation, accessibility and zero-write behaviour',async({page,request,baseURL})=>{
  await page.setViewportSize({width:320,height:900});await page.emulateMedia({reducedMotion:'reduce'});const saved=await fixture(request,baseURL!);let writes=0;page.on('request',request=>{if(request.method()==='POST'&&(request.url().includes('/operations')||request.url().endsWith('/drafts')))writes++;});
  await page.goto('/pages/'+saved.id);await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();const baseline=(await(await request.get(`/api/v1/pages/${saved.id}/document`)).json()).page,writesBeforeFind=writes;
  const openFind=page.getByRole('button',{name:'⌕ Find',exact:true});await openFind.focus();await page.keyboard.press('Enter');const find=page.getByRole('search',{name:'Find within page',exact:true}),query=find.getByRole('textbox',{name:'Find in this page',exact:true}),whole=find.getByRole('checkbox',{name:'Whole words',exact:true});
  await expect(whole).not.toBeChecked();await query.fill('cat');await expect(find.getByRole('status')).toHaveText('1 of 4');await whole.check();await expect(find.getByRole('status')).toHaveText('1 of 3');await query.press('Enter');await expect(find.getByRole('status')).toHaveText('2 of 3');await query.press('Shift+Enter');await expect(find.getByRole('status')).toHaveText('1 of 3');
  await query.fill('a.b');await expect(find.getByRole('status')).toHaveText('1 of 1');expect(await new AxeBuilder({page}).include('.page-find').analyze()).toMatchObject({violations:[]});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');await expect(find).toHaveCount(0);await openFind.focus();await page.keyboard.press('Enter');await expect(page.getByRole('checkbox',{name:'Whole words',exact:true})).not.toBeChecked();await page.waitForTimeout(250);expect(writes).toBe(writesBeforeFind);expect((await(await request.get(`/api/v1/pages/${saved.id}/document`)).json()).page.version).toBe(baseline.version);
});
