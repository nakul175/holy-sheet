import {test,expect} from '@playwright/test';
const origin='http://127.0.0.1:53300';
for(const width of [1280,390])test(`move, Trash and recovery preserve a synthetic page tree at ${width}px`,async({page,request})=>{
 await page.setViewportSize({width,height:900});
 const action=async(name:string)=>{const control=page.getByRole('button',{name,exact:true});if(!await control.isVisible())await page.getByLabel('Page options',{exact:true}).click();await control.click();};
 const name='Browser tree '+Date.now(),root=await(await request.post('/api/pages',{headers:{Origin:origin},data:{title:name,spaceId:'space-product'}})).json();expect(root.page.id).toBeTruthy();
 const child=await(await request.post('/api/pages',{headers:{Origin:origin},data:{title:'Child '+name,spaceId:'space-product',parentPageId:root.page.id}})).json();expect(child.page.id).toBeTruthy();
 await page.goto('/pages/'+root.page.id);const editor=page.getByRole('textbox',{name:'Document content',exact:true});await editor.fill('Recover this synthetic body');
 await expect.poll(async()=>JSON.stringify(await(await request.get('/api/v1/pages/'+root.page.id+'/document')).json())).toContain('Recover this synthetic body');await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
 const baseline=(await(await request.get('/api/v1/pages/'+root.page.id+'/document')).json()).page;
 await action('Move page');const move=page.getByRole('dialog',{name:'Move page',exact:true});await move.getByRole('combobox',{name:'Destination space',exact:true}).selectOption({label:'My pages'});await move.getByRole('button',{name:'Review move and access',exact:true}).click();await expect(move.getByRole('region',{name:'Review page move',exact:true})).toContainText('1 descendant');await move.getByRole('button',{name:'Confirm move',exact:true}).click();
 await expect.poll(async()=>(await(await request.get('/api/v1/pages/'+root.page.id+'/document')).json()).page.spaceId).toBe('space-private');await expect(page.getByRole('button',{name:'✓ Saved',exact:true})).toBeVisible();
 await action('Move to Trash');const deletion=page.getByRole('dialog',{name:'Move page to Trash',exact:true});await expect(deletion).toContainText('2 pages');await deletion.getByRole('checkbox').check();await deletion.getByRole('button',{name:'Move to Trash',exact:true}).click();
 await expect.poll(async()=>(await request.get('/api/v1/pages/'+root.page.id+'/document')).status()).toBe(404);expect((await request.get('/api/v1/pages/'+child.page.id+'/document')).status()).toBe(404);
 await page.waitForURL(u=>u.pathname!=='/pages/'+root.page.id);
 await action('Trash');const trash=page.getByRole('dialog',{name:'Trash',exact:true});await trash.locator('.trash-list button').filter({hasText:name}).click();await trash.getByRole('button',{name:'Review recovery and access',exact:true}).click();await expect(trash.getByRole('region',{name:'Review page recovery',exact:true})).toBeVisible();await trash.getByRole('checkbox').check();await trash.getByRole('button',{name:'Recover batch',exact:true}).click();
 await expect(editor).toContainText('Recover this synthetic body');const restored=(await(await request.get('/api/v1/pages/'+root.page.id+'/document')).json()).page;expect(restored.id).toBe(root.page.id);expect(restored.version).toBe(baseline.version);expect(restored.document).toEqual(baseline.document);expect((await request.get('/api/v1/pages/'+child.page.id+'/document')).status()).toBe(200);await page.screenshot({path:`test-results/accessibility/workspace-${width}-restored.png`});
});
