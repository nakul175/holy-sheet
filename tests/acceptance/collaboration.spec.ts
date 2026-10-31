import {test,expect} from '@playwright/test';

const origin='http://127.0.0.1:53300';

test('failed live edits survive encrypted recovery and rejoin collaboration after restoration',async({browser,request})=>{
 const created=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Disposable recovery fixture',spaceId:'space-product'}});
 expect(created.status()).toBe(200);const id=(await created.json()).page.id;
 const a=await browser.newPage();
 try{
  await a.goto(`${origin}/pages/${id}`);
  const editor=a.getByRole('textbox',{name:'Document content',exact:true});await expect(editor).toBeEditable();
  await a.route(`**/api/v1/pages/${id}/collaboration`,async route=>{
   if(route.request().method()==='POST'&&route.request().postDataJSON().action==='submit')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Disposable recovery outage',code:'unavailable'})});
   else await route.continue();
  });
  await editor.fill('Encrypted recovery survives a failed live submit');
  await expect(a.getByRole('button',{name:'Save failed · retry',exact:true})).toBeVisible();
  await expect.poll(()=>a.evaluate(pageId=>new Promise<number>((resolve,reject)=>{
   const open=indexedDB.open('holy-sheet-recovery',2);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('drafts','readonly'),query=tx.objectStore('drafts').getAll();query.onsuccess=()=>resolve(query.result.filter(row=>row.pageId===pageId&&row.ciphertext instanceof ArrayBuffer&&row.ciphertext.byteLength>0).length);tx.oncomplete=()=>db.close();};
  }),id)).toBeGreaterThan(0);
  const before=await request.get(origin+`/api/v1/pages/${id}/document`);expect(JSON.stringify((await before.json()).page.document)).not.toContain('Encrypted recovery survives');
  await a.reload();await expect(a.getByRole('button',{name:'Restore draft',exact:true})).toBeVisible();
  await a.unroute(`**/api/v1/pages/${id}/collaboration`);
  await a.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect(editor).toContainText('Encrypted recovery survives a failed live submit');await expect(editor).toBeEditable();
  await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
  await editor.evaluate(element=>{element.focus();const range=document.createRange(),selection=getSelection()!;range.selectNodeContents(element);range.collapse(false);selection.removeAllRanges();selection.addRange(range);});
  await editor.pressSequentially(' and resumes');
  await expect.poll(async()=>{const response=await request.get(origin+`/api/v1/pages/${id}/document`);return JSON.stringify((await response.json()).page.document);}).toContain('and resumes');
  await a.reload();await expect(editor).toContainText('Encrypted recovery survives a failed live submit and resumes');
 }finally{await a.close();}
});

test('native heading conversion, Undo and Redo persist with fresh block identities and converge',async({browser,request})=>{
 const created=await request.post(origin+'/api/pages',{headers:{Origin:origin},data:{title:'Disposable typed identity fixture',spaceId:'space-product'}});
 expect(created.status()).toBe(200);const page=(await created.json()).page;
 const initialId=crypto.randomUUID();
 const seeded=await request.post(origin+`/api/v1/pages/${page.id}/operations`,{headers:{Origin:origin},data:{operationId:crypto.randomUUID(),baseVersion:page.version,title:page.title,document:{type:'doc',content:[{type:'paragraph',attrs:{id:initialId},content:[{type:'text',text:'Shape source'}]}]}}});
 expect(seeded.status()).toBe(200);const initial=(await seeded.json()).page;
 const a=await browser.newPage(),b=await browser.newPage();
 try{
  await Promise.all([a.goto(`${origin}/pages/${page.id}`),b.goto(`${origin}/pages/${page.id}`)]);
  const editorA=a.getByRole('textbox',{name:'Document content',exact:true}),editorB=b.getByRole('textbox',{name:'Document content',exact:true});
  await expect(editorA).toContainText('Shape source');await expect(editorB).toContainText('Shape source');
  const submit=()=>a.waitForResponse(response=>response.url()===origin+`/api/v1/pages/${page.id}/collaboration`&&response.request().method()==='POST'&&response.request().postDataJSON().action==='submit');
  const saved=async()=>{const response=await request.get(origin+`/api/v1/pages/${page.id}/document`);expect(response.status()).toBe(200);return (await response.json()).page;};
  let response=submit();await editorA.click();await a.getByRole('button',{name:'H1 Heading',exact:true}).click();expect((await response).status()).toBe(200);
  // Presence decorations contribute the other actor's name to the accessible name.
  await expect(editorB.getByRole('heading',{name:/^Shape source(?: |$)/})).toBeVisible();
  const heading=await saved();expect(heading.version).toBeGreaterThan(initial.version);expect(heading.document.content[0].type).toBe('heading');expect(heading.document.content[0].attrs.id).not.toBe(initialId);
  response=submit();await editorA.press('ControlOrMeta+z');expect((await response).status()).toBe(200);
  await expect(editorB.getByRole('heading',{name:/^Shape source(?: |$)/})).toHaveCount(0);await expect(editorB).toContainText('Shape source');
  const undone=await saved();expect(undone.version).toBeGreaterThan(heading.version);expect(undone.document.content[0].type).toBe('paragraph');expect([initialId,heading.document.content[0].attrs.id]).not.toContain(undone.document.content[0].attrs.id);
  response=submit();await editorA.press('ControlOrMeta+Shift+z');expect((await response).status()).toBe(200);
  await expect(editorB.getByRole('heading',{name:/^Shape source(?: |$)/})).toBeVisible();
  const redone=await saved();expect(redone.version).toBeGreaterThan(undone.version);expect(JSON.stringify(redone.document)).toContain('Shape source');expect(redone.title).toBe(initial.title);
  expect(redone.document.content[0].content).toEqual(initial.document.content[0].content);
  expect([initialId,heading.document.content[0].attrs.id,undone.document.content[0].attrs.id]).not.toContain(redone.document.content[0].attrs.id);
 }finally{await a.close();await b.close();}
});

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
    // One insertion per client. Per-character typing races a remote DOM update and can drop a side before it becomes a step. These two insertions still overlap, and both edits must survive.
    await Promise.all([a.keyboard.insertText('LEFTα '),b.keyboard.insertText(' RIGHTβ')]);
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
    const title=a.getByRole('textbox',{name:'Page title',exact:true});
    await expect(title).toBeEditable();
    await title.fill('Renamed after live collaboration');
    await expect(a.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
    await expect.poll(async()=>{const result=await request.get(origin+`/api/v1/pages/${id}/document`);return (await result.json()).page.title;}).toBe('Renamed after live collaboration');
    await a.reload();
    await expect(title).toHaveValue('Renamed after live collaboration');
    await expect(editorA).toContainText('Shared base');
  }finally{await a.close();await b.close();}
});
