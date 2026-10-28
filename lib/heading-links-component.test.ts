// @vitest-environment jsdom
import {act,createElement,type ComponentProps} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CopyHeadingLink,HeadingLinkDestination} from '../components/heading-links';
import PageOutline from '../components/page-outline';
import {collectOutline} from '../components/editor/page-outline';
import {Schema} from '@tiptap/pm/model';
import {EditorState,TextSelection} from '@tiptap/pm/state';
import {EditorView} from '@tiptap/pm/view';
import {history as editorHistory,undoDepth,redoDepth} from '@tiptap/pm/history';
const pageId='00000000-0000-4000-8000-000000000133',scope='actor:workspace:'+pageId;
let root:Root,container:HTMLElement,host:HTMLElement,write:ReturnType<typeof vi.fn>;
const ref={current:null as HTMLElement|null};
const body=(ids=['a'])=>({type:'doc',content:ids.map(id=>({type:'heading',attrs:{id,level:2},content:[{type:'text',text:'Unicode 界 مرحبا'}]}))});
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('matchMedia',()=>({matches:true}));history.replaceState(null,'','/pages/'+pageId);host=document.createElement('article');host.innerHTML=`<div class="rich-editor" data-preference-key="${scope}"><div class="rich-prose" role="textbox" contenteditable="true"><h2 data-id="a">Unicode 界 مرحبا</h2></div></div>`;document.body.append(host);ref.current=host;container=document.createElement('div');document.body.append(container);root=createRoot(container);write=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:write}});Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,writable:true,value:vi.fn()});});
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();vi.restoreAllMocks();vi.unstubAllGlobals();});
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
async function copyProps(saved=new Set(['a'])){const heading=collectOutline(host.querySelector('.rich-prose')!)[0];await act(async()=>root.render(createElement(CopyHeadingLink,{pageId,scope,host:ref,heading,saved})));}
it('copies the saved current ID with no title/actor or document/selection/history/storage/network mutations',async()=>{
 const text=host.querySelector('h2')!.firstChild!,range=document.createRange();range.setStart(text,2);range.collapse(true);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);const before=host.innerHTML,historyLength=history.length,fetch=vi.fn(),store=vi.spyOn(Storage.prototype,'setItem');vi.stubGlobal('fetch',fetch);await copyProps();await act(async()=>container.querySelector('button')!.click());
 expect(write).toHaveBeenCalledExactlyOnceWith(location.origin+'/pages/'+pageId+'#hs-heading=a');expect(container.textContent).toContain('Recipients still need page permission');expect(host.innerHTML).toBe(before);expect(history.length).toBe(historyLength);expect(window.getSelection()!.anchorNode).toBe(text);expect(window.getSelection()!.anchorOffset).toBe(2);expect(fetch).not.toHaveBeenCalled();expect(store).not.toHaveBeenCalled();
});
it('explains save first for a new heading without invoking clipboard or save',async()=>{
 await copyProps(new Set());await act(async()=>container.querySelector('button')!.click());expect(container.textContent).toContain('Save this heading');expect(write).not.toHaveBeenCalled();
});
it('exposes a selectable exact link when clipboard is denied and never claims it copied',async()=>{
 write.mockRejectedValue(new Error('Denied'));await copyProps();await act(async()=>container.querySelector('button')!.click());const field=container.querySelector('input')!;expect(field.readOnly).toBe(true);expect(field.value).toBe(location.origin+'/pages/'+pageId+'#hs-heading=a');expect(container.textContent).toContain('Clipboard unavailable');expect(container.textContent).not.toContain('link copied');
});
it('refuses removed or duplicated targets even when the copy action was rendered earlier',async()=>{
 await copyProps();host.querySelector('h2')!.remove();await act(async()=>container.querySelector('button')!.click());expect(write).not.toHaveBeenCalled();expect(container.textContent).toContain('unavailable');
});
it('discards late clipboard rejection after the page action unmounts',async()=>{
 let reject!:(error:Error)=>void;write.mockImplementation(()=>new Promise((_,fail)=>reject=fail));await copyProps();await act(async()=>container.querySelector('button')!.click());await act(async()=>root.render(createElement('div',null,'New page')));await act(async()=>reject(new Error('Late')));expect(container.textContent).toBe('New page');expect(document.querySelector('input[aria-label="Heading link"]')).toBeNull();
});
it('preserves real ProseMirror selection, document and undo while focusing a labelled external destination',async()=>{
 const schema=new Schema({nodes:{doc:{content:'block+'},text:{group:'inline'},paragraph:{group:'block',content:'text*',toDOM:()=>['p',0]},heading:{group:'block',content:'text*',attrs:{id:{}},toDOM:node=>['h2',{'data-id':node.attrs.id},0]}}});
 const doc=schema.node('doc',null,[schema.node('heading',{id:'a'},schema.text('Unicode 界 مرحبا'))]);host.querySelector('.rich-prose')!.remove();let transactions=0;
 const view=new EditorView(host.querySelector('.rich-editor')!,{state:EditorState.create({schema,doc,selection:TextSelection.create(doc,3),plugins:[editorHistory()]}),attributes:{class:'rich-prose',role:'textbox'},dispatchTransaction(transaction){transactions++;view.updateState(view.state.apply(transaction));}});
 try{view.focus();const before=JSON.stringify(view.state.doc.toJSON()),selection=view.state.selection.toJSON(),undo=undoDepth(view.state),redo=redoDepth(view.state),heading=host.querySelector('h2')!.outerHTML;history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');await act(async()=>root.render(createElement(HeadingLinkDestination,{host:ref,scope,pageId,available:true,saved:new Set(['a'])})));
  const destination=document.querySelector('[role=region]')!;expect(destination.getAttribute('aria-label')).toBe('Linked heading: Unicode 界 مرحبا');expect(document.activeElement).toBe(destination);expect(host.contains(destination)).toBe(false);expect(view.state.selection.toJSON()).toEqual(selection);expect(JSON.stringify(view.state.doc.toJSON())).toBe(before);expect(undoDepth(view.state)).toBe(undo);expect(redoDepth(view.state)).toBe(redo);expect(transactions).toBe(0);expect(host.querySelector('h2')!.outerHTML).toBe(heading);
  // jsdom itself collapses DOM Selection on every native focus (focusing.js277-279).
  // Editor selection is asserted above; native DOM range behavior needs actual-browser evidence.
  await act(async()=>root.render(createElement(HeadingLinkDestination,{host:ref,scope,pageId,available:false,saved:new Set<string>()})));expect(document.querySelector('[role=region]')).toBeNull();await act(tick);expect(document.body.textContent).not.toContain('Linked heading:');
 }finally{view.destroy();}
});
it('integrates saved-only copy actions into the on-demand outline, retaining confirmed IDs across drafts',async()=>{
 async function render(extra:Partial<ComponentProps<typeof PageOutline>>={}){await act(async()=>root.render(createElement(PageOutline,{documentHost:ref,preferenceKey:scope,available:true,pageId,savedDocument:body(),...extra})));}
 await render();expect(document.querySelector('[aria-label^="Copy heading link:"]')).toBeNull();await act(async()=>container.querySelector('button')!.click());expect(document.querySelectorAll('[aria-label^="Copy heading link:"]')).toHaveLength(1);
 await act(async()=>{host.querySelector('.rich-prose')!.insertAdjacentHTML('beforeend','<h2 data-id="new">Unsaved</h2>');await tick();});await render({savedDocument:undefined});const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label^="Copy heading link:"]'));await act(async()=>buttons[1].click());expect(write).not.toHaveBeenCalled();expect(document.body.textContent).toContain('Save this heading');await act(async()=>buttons[0].click());expect(write).toHaveBeenCalledWith(location.origin+'/pages/'+pageId+'#hs-heading=a');
 await render({savedDocument:body(['a','new'])});await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="Copy heading link: Unsaved"]')!.click());expect(write).toHaveBeenLastCalledWith(location.origin+'/pages/'+pageId+'#hs-heading=new');
});
it('refreshes a cold fragment when saved eligibility arrives without changing the editor DOM',async()=>{
 history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const before=host.innerHTML;await act(async()=>root.render(createElement(HeadingLinkDestination,{host:ref,scope,pageId,available:true,saved:new Set<string>()})));expect(document.querySelector('[role=region]')!.textContent).toContain('Finding linked heading');await act(async()=>root.render(createElement(HeadingLinkDestination,{host:ref,scope,pageId,available:true,saved:new Set(['a'])})));expect(document.querySelector('[role=region]')!.textContent).toContain('At heading: Unicode');expect(host.innerHTML).toBe(before);expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});
