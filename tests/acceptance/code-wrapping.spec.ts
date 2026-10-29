import {test,expect,type APIRequestContext} from '@playwright/test';
import axe,{type AxeResults,type RunOptions} from 'axe-core';

const origin='http://127.0.0.1:53340';
const source='const exact = "😀 नमस्ते";\n\t'+('veryLongIdentifier'.repeat(40))+'  ';

async function fixture(request:APIRequestContext){
  const created=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Personal code wrapping '+crypto.randomUUID(),spaceId:'space-product'}});expect(created.status()).toBe(200);
  const page=(await created.json()).page as {id:string;version:number;title:string};
  const document={type:'doc',content:[{type:'codeBlock',attrs:{id:crypto.randomUUID(),language:'plaintext'},content:[{type:'text',text:source}]},{type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:'After code'}]}]};
  const saved=await request.post(origin+'/api/v1/pages/'+page.id+'/operations',{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});expect(saved.status(),await saved.text()).toBe(200);
  return (await saved.json()).page as {id:string;version:number;document:unknown};
}

test('personal code wrapping is faithful, accessible, responsive and write-free',async({page,request,context})=>{
  const before=await fixture(request),operations:unknown[]=[];
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await page.route('**/api/v1/pages/'+before.id+'/operations',async route=>{operations.push(route.request().postDataJSON());await route.continue();});
  await page.goto('/pages/'+before.id);await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Collapse toolbox',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Document content',exact:true}),pre=editor.locator('pre'),toggle=page.getByRole('button',{name:'Wrap lines for code block',exact:true});
  for(const width of [1440,800,320]){
    await page.setViewportSize({width,height:900});
    await expect(toggle).toHaveAttribute('aria-pressed','false');await expect(pre).toHaveText(source);
    expect(await pre.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
    if(width===1440){await page.getByRole('button',{name:'Copy code',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(source);}
    await toggle.focus();await toggle.press('Enter');const preserve=page.getByRole('button',{name:'Preserve lines for code block',exact:true});await expect(preserve).toBeFocused();await expect(pre).toHaveAttribute('data-code-wrap','wrap');await expect(pre).toHaveText(source);
    expect(await pre.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
    if(width===1440){await page.getByRole('button',{name:'Copy code',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(source);}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await preserve.press('Enter');await expect(toggle).toBeFocused();
  }
  await page.addScriptTag({content:axe.source});const axeResult=await page.evaluate(async()=>{const engine=(window as unknown as {axe:{run:(context:Document,options:RunOptions)=>Promise<AxeResults>}}).axe;return engine.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}});});
  await test.info().attach('axe-results',{body:JSON.stringify(axeResult.violations,null,2),contentType:'application/json'});expect(axeResult.violations.map(violation=>({id:violation.id,nodes:violation.nodes.map(node=>node.target)}))).toEqual([]);
  await page.waitForTimeout(900);expect(operations).toEqual([]);await page.close();
  const after=(await(await request.get(origin+'/api/v1/pages/'+before.id+'/document')).json()).page as {version:number;document:unknown};expect(after.version).toBe(before.version);expect(after.document).toEqual(before.document);
});
