import {test,expect,type APIRequestContext} from '@playwright/test';

const origin='http://127.0.0.1:53300';

type StoredPage={id:string;title:string;version:number;document:{type:'doc';content:Array<Record<string,unknown>>}};

async function fixture(request:APIRequestContext){
  const created=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Unchanged empty heading '+crypto.randomUUID(),spaceId:'space-product'}});
  expect(created.status()).toBe(200);
  const page=(await created.json()).page as StoredPage;
  const document={type:'doc' as const,content:[
    {type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:'Before the empty heading'}]},
    {type:'heading',attrs:{id:crypto.randomUUID(),level:2},content:[]},
    {type:'paragraph',attrs:{id:crypto.randomUUID()},content:[{type:'text',text:'After the empty heading'}]},
  ]};
  const saved=await request.post(origin+'/api/v1/pages/'+page.id+'/operations',{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document}});
  expect(saved.status()).toBe(200);
  const stored=(await saved.json()).page as StoredPage;
  expect(stored.document).toEqual(document);
  return stored;
}

test('opening a noncanonical empty heading does not save until the user edits',async({browser,request})=>{
  const before=await fixture(request),operationBodies:unknown[]=[];
  const warm=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Editor bundle warmup '+crypto.randomUUID(),spaceId:'space-product'}});expect(warm.status()).toBe(200);
  const warmContext=await browser.newContext(),warmPage=await warmContext.newPage();await warmPage.goto('/pages/'+(await warm.json()).page.id);await expect(warmPage.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();await warmContext.close();
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/api/v1/pages/'+before.id+'/operations',async route=>{
    operationBodies.push(route.request().postDataJSON());
    await route.continue();
  });

  await page.goto('/pages/'+before.id);
  const editor=page.getByRole('textbox',{name:'Document content',exact:true});
  await expect(editor).toContainText('Before the empty heading');
  await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
  await page.waitForTimeout(1500);

  const unchanged=(await(await request.get(origin+'/api/v1/pages/'+before.id+'/document')).json()).page as StoredPage;
  expect(operationBodies).toEqual([]);
  expect(unchanged.version).toBe(before.version);
  expect(unchanged.document).toEqual(before.document);

  await editor.locator('p').last().click();
  await page.keyboard.type(' legitimately edited');
  await expect.poll(()=>operationBodies.length).toBe(1);
  await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
  const edited=(await(await request.get(origin+'/api/v1/pages/'+before.id+'/document')).json()).page as StoredPage;
  expect(edited.version).toBe(before.version+1);
  expect(JSON.stringify(edited.document)).toContain('legitimately edited');
  await context.close();
});
