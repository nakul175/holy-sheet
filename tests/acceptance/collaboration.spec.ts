import {test,expect} from '@playwright/test';

const origin='http://127.0.0.1:53300';

test('two live editor clients converge and report durable save and presence',async({browser,request})=>{
  const created=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Disposable collaboration fixture',spaceId:'space-product'}});
  expect(created.status()).toBe(200);const id=(await created.json()).page.id;
  const a=await browser.newPage(),b=await browser.newPage();
  try{
    await Promise.all([a.goto(`${origin}/pages/${id}`),b.goto(`${origin}/pages/${id}`)]);
    const editorA=a.getByRole('textbox',{name:'Document content',exact:true}),editorB=b.getByRole('textbox',{name:'Document content',exact:true});
    await expect(editorA).toBeEditable();await expect(editorB).toBeEditable();
    await editorA.fill('Shared base');
    await expect(editorB).toContainText('Shared base');
    await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await editorA.press('Home');await editorB.press('End');
    await Promise.all([editorA.type('A '),editorB.type(' B')]);
    await expect.poll(async()=>Promise.all([editorA.innerText(),editorB.innerText()])).toEqual(['A Shared base B','A Shared base B']);
    await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await expect(b.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await expect(a.locator('.live-collaborators span')).toHaveCount(1);
    const saved=await request.get(origin+`/api/v1/pages/${id}/document`);expect(saved.status()).toBe(200);expect(JSON.stringify((await saved.json()).page.document)).toContain('A Shared base B');
  }finally{await a.close();await b.close();}
});
