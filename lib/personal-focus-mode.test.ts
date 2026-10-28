// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {FocusModeExit,FocusModeLauncher,usePersonalFocusMode} from '../components/personal-focus-mode';
let root:Root,container:HTMLDivElement;
function Host({actor='A',page='page1',available=true}:{actor?:string;page?:string;available?:boolean}){
 const model=usePersonalFocusMode(actor,page,available);
 return createElement('div',{className:model.className,onKeyDown:model.onKeyDown},createElement('details',{open:true},createElement('summary',null,'Page options'),createElement(FocusModeLauncher,{model})),createElement('header',null,createElement(FocusModeExit,{model})),createElement('article',null,createElement('p',null,'Existing draft')),createElement('input',{'aria-label':'Nested control'}),createElement('div',{role:'dialog'},createElement('button',null,'Nested dialog control')),createElement('button',{onKeyDown:e=>e.preventDefault()},'Consumes Escape'));
}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.spyOn(window,'scrollTo').mockImplementation(()=>{});container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function render(props:Parameters<typeof Host>[0]={}){await act(async()=>root.render(createElement(Host,props)));}
function button(text:string){return Array.from(container.querySelectorAll('button')).find(b=>b.textContent===text)!;}
async function enter(){await act(async()=>button('Enter focus mode').click());}
async function escape(target:Element){await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));}
it('keeps document mounted, focuses visible exit and restores launcher and prior scroll',async()=>{
 await render();const article=container.querySelector('article'),source=article!.outerHTML;await enter();expect(document.activeElement).toBe(button('Exit focus mode'));expect(container.querySelector('article')).toBe(article);expect(article!.outerHTML).toBe(source);await act(async()=>button('Exit focus mode').click());expect(document.activeElement).toBe(container.querySelector('summary'));expect(window.scrollTo).toHaveBeenCalledWith(0,0);expect(button('Exit focus mode')).toBeUndefined();
});
it('gives nested controls and consumed Escape precedence, then exits on unconsumed Escape',async()=>{
 await render();await enter();for(const target of [container.querySelector('input')!,button('Nested dialog control'),button('Consumes Escape')]){await escape(target);expect(button('Exit focus mode')).toBeDefined();}await escape(container.querySelector('article')!);expect(button('Exit focus mode')).toBeUndefined();
});
it('immediately clears mode on actor page or access changes without restoring stale focus',async()=>{
 await render();await enter();await render({actor:'B'});expect(button('Exit focus mode')).toBeUndefined();await render();expect(button('Exit focus mode')).toBeUndefined();await enter();await render({page:'page2'});expect(button('Exit focus mode')).toBeUndefined();await enter();await render({page:'page2',available:false});expect(button('Enter focus mode').disabled).toBe(true);expect(button('Exit focus mode')).toBeUndefined();await render({actor:''});expect(button('Enter focus mode').disabled).toBe(true);
});
it('never reads or writes browser storage during entry exit or scope changes',async()=>{
 const read=vi.spyOn(Storage.prototype,'getItem'),write=vi.spyOn(Storage.prototype,'setItem'),remove=vi.spyOn(Storage.prototype,'removeItem');await render();await enter();await escape(container.querySelector('article')!);await render({actor:'B'});expect(read).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();
});
