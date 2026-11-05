import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for(const width of [1920,1366,1024,800,390,320])test(`all workspace screens fit and remain accessible at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:768});
 for(const route of ['spaces','new','templates','snippets','people','invitations','handover']){
  await page.goto(`/workspaces/ws-aplyd/${route}`);
  await expect(page.locator('.laptop-screen')).toBeVisible();
  await expect(page.locator('.laptop-screen h1')).toBeVisible();
  await expect(page.locator('.laptop-screen')).not.toContainText(/Loading[ …]|Opening[ …]/);
  await expect(page.locator('.laptop-screen [role=alert]')).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const accessibility=await new AxeBuilder({page}).include('.laptop-workspace').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(accessibility.violations.filter(v=>v.impact==='critical'||v.impact==='serious'),JSON.stringify(accessibility.violations)).toEqual([]);
  await page.screenshot({path:`artifacts/laptop-design/${route}-${width}.png`,fullPage:true});
 }
});

test('writing shell follows window resizing with tools open and closed',async({page})=>{
 await page.goto('/pages/welcome');await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();
 for(const size of [{width:1920,height:1080},{width:1440,height:900},{width:1280,height:720}]){
  await page.setViewportSize(size);
  const open=page.getByRole('button',{name:'Open toolbox',exact:true});if(await open.isVisible())await open.click();
  const geometry=await page.evaluate(()=>{const box=(s:string)=>document.querySelector(s)!.getBoundingClientRect();return {shell:box('.shell').right,header:box('.doc-header').right,nav:box('.sidebar').bottom,rail:box('.editor-toolbox').right,railBottom:box('.editor-toolbox').bottom,scroll:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight,sidebarColor:getComputedStyle(document.querySelector('.sidebar')!).backgroundColor,newPageColor:getComputedStyle(document.querySelector('.laptop-create')!).backgroundColor};});
  expect(geometry.shell).toBe(size.width);expect(geometry.header).toBe(size.width);expect(geometry.nav).toBe(size.height);expect(geometry.rail).toBe(size.width);expect(geometry.railBottom).toBe(size.height);expect(geometry.scroll).toBeLessThanOrEqual(size.width+1);expect(geometry.sidebarColor).toBe('rgb(44, 47, 113)');expect(geometry.newPageColor).toBe('rgb(217, 157, 41)');
  const axe=await new AxeBuilder({page}).include('.laptop-document').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(axe.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
  await page.getByRole('button',{name:'Close toolbox',exact:true}).click();await expect(open).toBeFocused();await expect(page.locator('.editor-toolbox')).toBeHidden();expect(await page.locator('.laptop-toolbar-frame').evaluate(el=>el.getBoundingClientRect().right)).toBe(size.width);
 }
 await page.getByRole('button',{name:'Open toolbox',exact:true}).click();await page.screenshot({path:'artifacts/laptop-design/blue-gold-document.png',fullPage:true});
});
test('collapsing page navigation releases its grid column with either toolbox state',async({page})=>{
 await page.goto('/pages/welcome');await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();
 for(const width of [1366,1920,800]){
  await page.setViewportSize({width,height:900});
  await page.getByRole('button',{name:'Collapse pages',exact:true}).click();await expect(page.locator('.sidebar')).toBeHidden();
  for(const toolboxOpen of [true,false]){
   const toggle=page.getByRole('button',{name:'Open toolbox',exact:true});
   if(toolboxOpen&&await toggle.isVisible())await toggle.click();
   if(!toolboxOpen)await page.getByRole('button',{name:'Close toolbox',exact:true}).click();
   const bounds=await page.locator('.document').boundingBox();expect(bounds!.x).toBe(0);expect(bounds!.width).toBe(width);
   expect(await page.locator('.doc-header').evaluate(el=>el.getBoundingClientRect().left)).toBe(0);
   expect(await page.locator('.laptop-toolbar-frame').evaluate(el=>el.getBoundingClientRect().left)).toBe(0);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
   await expect(page.getByRole('button',{name:'Open page navigation',exact:true})).toBeVisible();
  }
  await page.getByRole('button',{name:'Open page navigation',exact:true}).click();await expect(page.locator('.sidebar')).toBeVisible();
  const sidebar=await page.locator('.sidebar').boundingBox(),documentBounds=await page.locator('.document').boundingBox();expect(documentBounds!.x).toBe(sidebar!.width);expect(documentBounds!.x+documentBounds!.width).toBe(width);
 }
});

test('embedded document occupies its single-column shell',async({page})=>{
 await page.goto('/embed/pages/welcome');await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();
 for(const width of [1366,1920,800]){
  await page.setViewportSize({width,height:900});
  const bounds=await page.locator('.document').boundingBox();expect(bounds!.x).toBe(0);expect(bounds!.width).toBe(width);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
 }
});

test('writing, tools, settings and subpages preserve the saved document',async({page,request,baseURL})=>{
 await page.setViewportSize({width:1366,height:768});
 const origin=baseURL!;
 const created=await request.post('/api/pages',{headers:{Origin:origin},data:{title:'Laptop acceptance '+Date.now(),spaceId:'space-product'}});
 expect(created.ok()).toBe(true);const {page:record}=await created.json();
 await page.goto(`/pages/${record.id}`);
 const editor=page.getByRole('textbox',{name:'Document content',exact:true});await expect(editor).toBeVisible();
 await editor.fill('Preserve this draft across navigation.');
 await expect.poll(async()=>JSON.stringify(await(await request.get(`/api/v1/pages/${record.id}/document`)).json())).toContain('Preserve this draft');
 const baseline=(await(await request.get(`/api/v1/pages/${record.id}/document`)).json()).page;
 await expect(page.getByRole('complementary',{name:'Editor toolbox'})).toBeVisible();
 await page.getByRole('button',{name:'Collapse toolbox',exact:true}).click();await expect(page.locator('.editor-toolbox')).toHaveClass(/is-collapsed/);
 await page.getByRole('button',{name:'Open toolbox',exact:true}).click();
 await page.getByRole('button',{name:'Unpin toolbox',exact:true}).click();await editor.click();await expect(page.locator('.editor-toolbox')).toHaveClass(/is-collapsed/);
 await page.getByRole('button',{name:'Open toolbox',exact:true}).click();await page.getByRole('button',{name:'Pin toolbox',exact:true}).click();await editor.click();await expect(page.locator('.editor-toolbox')).toHaveClass(/is-open/);
 await page.getByLabel('Page options',{exact:true}).click();await page.getByRole('button',{name:'Page settings',exact:true}).click();
 const settings=page.getByRole('dialog',{name:'Page settings',exact:true});await expect(settings).toBeVisible();
 for(const section of ['Review','Languages','Links','Details'])await settings.getByRole('button',{name:section,exact:true}).click();
 await settings.getByRole('button',{name:'Close dialog',exact:true}).click();
 const unchanged=(await(await request.get(`/api/v1/pages/${record.id}/document`)).json()).page;expect(unchanged.document).toEqual(baseline.document);expect(unchanged.version).toBe(baseline.version);
 await page.getByRole('button',{name:'Collapse pages',exact:true}).click();await expect(page.getByRole('complementary',{name:'Workspace navigation'})).toBeHidden();
 await page.getByRole('button',{name:'Open page navigation',exact:true}).click();await expect(page.getByRole('complementary',{name:'Workspace navigation'})).toBeVisible();
 await page.getByRole('button',{name:'Subpage',exact:true}).click();const creation=page.getByRole('dialog',{name:'Create a page',exact:true});await creation.getByLabel('Title',{exact:true}).fill('Child '+record.id);await creation.getByRole('button',{name:'Create page',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Page title',exact:true})).toHaveValue('Child '+record.id);
 const child=(await(await request.get('/api/pages')).json()).pages.find((p:{title:string})=>p.title==='Child '+record.id);expect(child.parentPageId).toBe(record.id);
 await page.goto(`/pages/${record.id}`);await expect(editor).toContainText('Preserve this draft');
 await page.screenshot({path:'artifacts/laptop-design/document-1366.png',fullPage:true});
});
test('templates filter and open an actual template preview',async({page})=>{
 await page.goto('/workspaces/ws-aplyd/templates');await expect(page.getByLabel('Search templates')).toBeVisible();await page.getByLabel('Search templates').fill('Meeting');
 const tile=page.locator('.template-cards button').filter({hasText:'Meeting'});await expect(tile).toHaveCount(1);await tile.click();await expect(page.locator('.template-preview')).toBeVisible();await expect(page.getByRole('button',{name:'Create independent page',exact:true})).toBeVisible();
});
test('invitation screen does not imply email delivery and keeps identity form explicit',async({page})=>{
 await page.goto('/workspaces/ws-aplyd/invitations');await expect(page.getByRole('heading',{name:'Workspace invitations'})).toBeVisible();await expect(page.getByLabel('Aplyd recipient ID')).toBeHidden();await page.getByRole('button',{name:'Link an Aplyd invitation',exact:true}).click();await expect(page.getByLabel('Aplyd recipient ID')).toBeVisible();await expect(page.getByText('Sending a new email invitation is not available here yet.',{exact:false})).toBeVisible();
});

test('failed invitation submission retains entered values without creating access',async({page})=>{
 await page.goto('/workspaces/ws-aplyd/invitations');await page.getByRole('button',{name:'Link an Aplyd invitation',exact:true}).click();
 await page.getByLabel('Aplyd invitation reference').fill('disposable-reference');await page.getByLabel('Aplyd recipient ID').fill('disposable-subject');
 let writes=0;await page.route('**/api/v1/workspaces/ws-aplyd/invitations',async route=>{if(route.request().method()==='POST'){writes++;await route.fulfill({status:503,json:{error:'Temporarily unavailable'}});}else await route.continue();});
 await page.getByRole('button',{name:'Save invitation',exact:true}).click();await expect(page.locator('.laptop-screen').getByRole('alert')).toHaveText('Temporarily unavailable');
 await expect(page.getByLabel('Aplyd invitation reference')).toHaveValue('disposable-reference');await expect(page.getByLabel('Aplyd recipient ID')).toHaveValue('disposable-subject');await expect(page.getByRole('button',{name:'Save invitation',exact:true})).toBeEnabled();expect(writes).toBe(1);
});

test('approved writing frame keeps long workspace identity and selected tree row compact',async({page,request,baseURL})=>{
 const response=await request.post('/api/pages',{headers:{Origin:baseURL!},data:{title:'Design fidelity '+Date.now(),spaceId:'space-product'}});expect(response.ok()).toBe(true);const {page:record}=await response.json();
 const longName='HOLY-92 N47 Acme staging 20261104';
 await page.route(`**/api/v1/pages/${record.id}/document`,async route=>{const res=await route.fetch();const json=await res.json();json.page.workspaceName=longName;await route.fulfill({response:res,json});});
 await page.setViewportSize({width:1366,height:768});await page.goto(`/pages/${record.id}`);await expect(page.getByRole('textbox',{name:'Document content',exact:true})).toBeVisible();
 const identity=page.locator('.workspace-identity strong');await expect(identity).toHaveAttribute('title',longName);
 const sizes=await page.evaluate(()=>{const box=(s:string)=>document.querySelector(s)!.getBoundingClientRect();const style=(s:string)=>getComputedStyle(document.querySelector(s)!);return {brandWidth:box('.workspace-avatar').width,brandHeight:box('.workspace-avatar').height,nameHeight:box('.workspace-identity strong').height,nameLine:parseFloat(style('.workspace-identity strong').lineHeight),toolbarBottom:box('.laptop-toolbar-host').bottom,titleTop:box('.title').top,toolboxRight:box('.editor-toolbox').right,toolboxBottom:box('.editor-toolbox').bottom,navy:style('.workspace-avatar').backgroundColor,viewportWidth:innerWidth,viewportHeight:innerHeight};});
 expect(sizes.brandWidth).toBe(31);expect(sizes.brandHeight).toBe(34);expect(sizes.nameHeight).toBeLessThanOrEqual(sizes.nameLine+1);expect(sizes.toolbarBottom).toBeLessThan(sizes.titleTop);expect(sizes.toolboxRight).toBe(sizes.viewportWidth);expect(sizes.toolboxBottom).toBe(sizes.viewportHeight);expect(sizes.navy).toBe('rgb(44, 47, 113)');
 const row=page.locator(`.page-tree-row[aria-current=page]`);await expect(row).toBeVisible();await row.getByRole('button',{name:record.title,exact:true}).click();
 expect(await row.locator('.page-tree-open').evaluate(el=>getComputedStyle(el).boxShadow)).toBe('none');expect(await row.evaluate(el=>getComputedStyle(el).boxShadow)).toContain('inset');
 await page.getByRole('group',{name:'Toolbox sections'}).getByRole('button',{name:'Page',exact:true}).click();await expect(page.locator('.toolbox-utilities').getByRole('button',{name:'Comments',exact:true})).toBeVisible();
 await page.getByRole('group',{name:'Toolbox sections'}).getByRole('button',{name:'Insert',exact:true}).click();await expect(page.getByRole('button',{name:'Subpage',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close toolbox',exact:true}).click();await expect(page.getByRole('button',{name:'Open toolbox',exact:true})).toBeFocused();await page.getByRole('button',{name:'Open toolbox',exact:true}).click();await page.getByLabel('More formatting',{exact:true}).click();await expect(page.getByLabel('Text colour',{exact:true})).toBeVisible();await page.getByLabel('Text colour',{exact:true}).press('Escape');await expect(page.getByLabel('More formatting',{exact:true})).toBeFocused();await page.screenshot({path:'artifacts/laptop-design/fidelity-document-1366.png',fullPage:true});
});
