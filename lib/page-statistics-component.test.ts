// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import PageStatistics from '../components/page-statistics';
const doc=(text:string)=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.useFakeTimers();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
async function render(body:unknown,extra:Record<string,unknown>={}){await act(async()=>root.render(createElement(PageStatistics,{document:body,supportedSchema:true,...extra})));}
async function settle(){await act(async()=>vi.runAllTimersAsync());}
async function open(){const button=host.querySelector('button')!;button.focus();await act(async()=>button.click());}
it('opens one accessible dialog, traps focus, closes with Escape and returns focus to launcher',async()=>{
 await render(doc('One two'));await settle();const opener=host.querySelector('button')!;expect(opener.textContent).toBe('2 words');await open();const dialog=host.querySelector('[role=dialog]')!;expect(dialog.getAttribute('aria-modal')).toBe('true');expect(dialog.getAttribute('aria-label')).toBe('Page statistics');expect(dialog.textContent).toContain('200 words per minute');const close=dialog.querySelector('button')!;expect(document.activeElement).toBe(close);await act(async()=>close.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true})));expect(document.activeElement).toBe(close);await act(async()=>close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(host.querySelector('[role=dialog]')).toBeNull();expect(document.activeElement).toBe(opener);
});
it('refreshes from unsaved body and undo without mutation/network/persistence, hiding old counts immediately',async()=>{
 const fetch=vi.fn(),storage=vi.spyOn(Storage.prototype,'setItem');vi.stubGlobal('fetch',fetch);const before=doc('One two');await render(before);await settle();await open();const frozen=JSON.stringify(before);await render(doc('Changed to four words'));expect(host.textContent).toContain('Updating statistics');expect(host.querySelector('dd')).toBeNull();await settle();expect(host.querySelector('dd')?.textContent).toBe('4');await render(before);await settle();expect(host.querySelector('dd')?.textContent).toBe('2');expect(JSON.stringify(before)).toBe(frozen);expect(fetch).not.toHaveBeenCalled();expect(storage).not.toHaveBeenCalled();storage.mockRestore();
});
it('immediately removes all statistics on denied/unverified access and does not reopen on restoration',async()=>{
 const body=doc('Previously authorized');await render(body);await settle();await open();await render(body,{available:false});expect(host.textContent).toBe('');await settle();await render(body);expect(host.querySelector('[role=dialog]')).toBeNull();await settle();expect(host.textContent).toContain('2 words');
});
it('does not inspect unsupported schema text and explicitly explains why it is unavailable',async()=>{
 await render(doc('secret'),{supportedSchema:false});await settle();await open();expect(host.textContent).toContain('unavailable for this document version');expect(host.textContent).not.toContain('secret');expect(host.querySelector('dd')).toBeNull();
});
it('labels both footer and detail as approximate when Unicode segmentation is absent',async()=>{
 vi.stubGlobal('Intl',{...Intl,Segmenter:undefined});await render(doc('世界 hello'));await settle();expect(host.querySelector('button')?.textContent).toBe('≈ 2 words');await open();expect(host.textContent).toContain('Approximate counts');expect(host.textContent).toContain('code points');
});
it('coalesces rapid typing and ignores an old worker reply after access invalidation',async()=>{
 const workers:any[]=[];class MockWorker{onmessage:any;onerror:any;postMessage=vi.fn();terminate=vi.fn();constructor(){workers.push(this);}}vi.stubGlobal('Worker',MockWorker);vi.stubGlobal('__HS_PAGE_STATISTICS_PACKAGE_BASE__',import.meta.url);
 await render(doc('first'));await render(doc('second'));await render(doc('third'));await settle();expect(workers).toHaveLength(1);expect(workers[0].postMessage.mock.calls[0][0].document.content[0].content[0].text).toBe('third');await render(doc('denied'),{available:false});await act(async()=>workers[0].onmessage({data:{status:'ready',counts:{words:999,characters:999,charactersWithoutWhitespace:999,approximate:false}}}));expect(host.textContent).toBe('');expect(workers[0].terminate).toHaveBeenCalled();
});

it('cooperatively falls back after worker loading failure without leaking stale responses',async()=>{
 const workers:any[]=[];class BrokenWorker{onmessage:any;onerror:any;postMessage=vi.fn();terminate=vi.fn();constructor(){workers.push(this);}}vi.stubGlobal('Worker',BrokenWorker);vi.stubGlobal('__HS_PAGE_STATISTICS_PACKAGE_BASE__',import.meta.url);
 await render(doc('safe body'));await settle();await act(async()=>workers[0].onerror(new Event('error')));await settle();expect(host.querySelector('button')?.textContent).toBe('2 words');await render(doc('new body only'));await settle();await render(doc('inaccessible'),{available:false});await act(async()=>workers[0].onmessage({data:{status:'ready',counts:{words:999,characters:999,charactersWithoutWhitespace:999,approximate:false}}}));expect(host.textContent).toBe('');
});
it('handles worker constructor CSP denial through bounded cooperative calculation',async()=>{
 class DeniedWorker{constructor(){throw new DOMException('Blocked by worker-src','SecurityError');}}vi.stubGlobal('Worker',DeniedWorker);vi.stubGlobal('__HS_PAGE_STATISTICS_PACKAGE_BASE__',import.meta.url);await render(doc('still works'));await settle();expect(host.querySelector('button')?.textContent).toBe('2 words');
});
it('unmounts dialog and invalidates pending work on page/workspace/session context switch',async()=>{
 await render(doc('old page'),{key:'actor1:workspace1:page1'});await settle();await open();await render(doc('new document with five words'),{key:'actor2:workspace2:page2'});expect(host.querySelector('[role=dialog]')).toBeNull();expect(host.textContent).not.toContain('2 words');await settle();expect(host.querySelector('button')?.textContent).toBe('5 words');
});
