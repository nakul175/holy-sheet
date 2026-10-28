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
    const caret=async(editor:typeof editorA,atEnd:boolean)=>editor.evaluate((element,end)=>{element.focus();const range=document.createRange(),selection=getSelection()!;range.selectNodeContents(element);range.collapse(end);selection.removeAllRanges();selection.addRange(range);},atEnd);
    await caret(editorA,false);await caret(editorB,true);
    const texts=()=>Promise.all([editorA.textContent().then(value=>value?.trim()),editorB.textContent().then(value=>value?.trim())]);
    await Promise.all([editorA.type('LEFTα '),editorB.type(' RIGHTβ')]);
    await expect.poll(async()=>{const values=await texts();return {same:values[0]===values[1],base:values[0]?.includes('Shared base'),left:values[0]?.includes('LEFTα'),right:values[0]?.includes('RIGHTβ')};}).toEqual({same:true,base:true,left:true,right:true});
    await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await expect(b.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await expect(a.locator('.live-collaborators span')).toHaveCount(1);
    await expect(a.locator('.collaborator-caret')).toHaveCount(1);
    const saved=await request.get(origin+`/api/v1/pages/${id}/document`);expect(saved.status()).toBe(200);expect(JSON.stringify((await saved.json()).page.document)).toContain('LEFTα');expect(JSON.stringify((await saved.json()).page.document)).toContain('RIGHTβ');
    const nextSubmit=(page:typeof a)=>page.waitForResponse(response=>response.url()===origin+`/api/v1/pages/${id}/collaboration`&&response.request().method()==='POST'&&response.request().postDataJSON().action==='submit');
    let submitted=nextSubmit(a);await editorA.press('ControlOrMeta+z');expect((await submitted).status()).toBe(200);
    await expect.poll(async()=>{const values=await texts();return {same:values[0]===values[1],left:values[0]?.includes('LEFTα'),right:values[0]?.includes('RIGHTβ')};}).toEqual({same:true,left:false,right:true});
    submitted=nextSubmit(b);await editorB.press('ControlOrMeta+z');expect((await submitted).status()).toBe(200);
    await expect.poll(texts).toEqual(['Shared base','Shared base']);
    await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
  }finally{await a.close();await b.close();}
});
