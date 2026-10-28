// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {currentLinkedHeading,headingLink,parseHeadingFragment,savedHeadingIds,watchHeadingLink,type HeadingNavigationState} from '../components/editor/heading-links';
import {markSectionInteraction} from '../components/editor/section-navigation';
const pageId='00000000-0000-4000-8000-000000000133',scope='actor:workspace:'+pageId;
const doc=(...ids:string[])=>({type:'doc',content:ids.map(id=>({type:'heading',attrs:{id,level:2},content:[{type:'text',text:'Unicode 界 مرحبا'}]}))});
function fixture(html='<h2 data-id="a">Unicode 界 مرحبا</h2>'){const host=document.createElement('article');host.innerHTML=`<div class="rich-editor" data-preference-key="${scope}"><div class="rich-prose" role="textbox" contenteditable="true">${html}</div></div>`;document.body.append(host);return {host,root:host.querySelector<HTMLElement>('.rich-prose')!};}
const tick=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
beforeEach(()=>{vi.useFakeTimers();history.replaceState(null,'','/pages/'+pageId);vi.stubGlobal('matchMedia',()=>({matches:true}));Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,writable:true,value:vi.fn()});});
afterEach(()=>{document.body.replaceChildren();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('forms canonical origin/page/ID URLs without heading text or another origin path',()=>{
 expect(headingLink('https://hs.example',pageId,'a_B-9')).toBe('https://hs.example/pages/'+pageId+'#hs-heading=a_B-9');
 for(const id of ['界','a/b','x\n','x'.repeat(101),'a&actor=private'])expect(headingLink('https://hs.example',pageId,id)).toBeNull();
 for(const origin of ['javascript:alert(1)','https://user:secret@hs.example','https://hs.example/other'])expect(headingLink(origin,pageId,'a')).toBeNull();
 expect(headingLink('https://hs.example','../other','a')).toBeNull();
});
it('decodes only the heading fragment and rejects malformed/oversized/unsupported IDs',()=>{
 expect(parseHeadingFragment('#hs-heading=%61')).toEqual({kind:'heading',id:'a'});
 expect(parseHeadingFragment('#discussion-thread')).toEqual({kind:'other'});
 for(const hash of ['#hs-heading=','#hs-heading=%E0%A4%A','#hs-heading=%E7%95%8C','#hs-heading=a%00','#hs-heading=a&other=x','#hs-heading='+('a'.repeat(101)),'#hs-heading='+('%61'.repeat(101))])expect(parseHeadingFragment(hash)).toEqual({kind:'invalid'});
});
it('uses confirmed heading IDs only and rejects duplicates, malformed bodies and oversized documents',()=>{
 expect([...savedHeadingIds(doc('a','b'))]).toEqual(['a','b']);
 expect(savedHeadingIds(doc('a','a','界')).size).toBe(0);
 expect([...savedHeadingIds({type:'doc',content:[{type:'heading',attrs:{id:'a'}},{type:'paragraph',attrs:{id:'a'}},{type:'heading',attrs:{id:'b'}}]})]).toEqual(['b']);
 expect(savedHeadingIds({type:'heading',attrs:{id:'a'}}).size).toBe(0);
 const cyclic:{type:string;content?:unknown[]}= {type:'doc'};cyclic.content=[cyclic];expect(savedHeadingIds(cyclic).size).toBe(0);
 expect(savedHeadingIds(doc(...Array.from({length:10_001},(_,i)=>'h'+i))).size).toBe(0);
});
it('resolves only exact readable unique headings in the current scoped editor',()=>{
 const {host,root}=fixture('<h2 data-id="a">Valid</h2><h2 data-id="aa">Prefix</h2><div hidden><h1 data-id="hidden">PRIVATE</h1></div>');
 expect(currentLinkedHeading(host,scope,'a',new Set(['a']))?.heading.target).toBe(root.querySelector('h2'));
 expect(currentLinkedHeading(host,'other','a',new Set(['a']))).toBeNull();expect(currentLinkedHeading(host,scope,'hidden',new Set(['hidden']))).toBeNull();expect(currentLinkedHeading(host,scope,'a',new Set())).toBeNull();
 root.insertAdjacentHTML('beforeend','<p data-id="a">Duplicate</p>');expect(currentLinkedHeading(host,scope,'a',new Set(['a']))).toBeNull();
});
it('jumps once after editor readiness without changing selection, body, storage, history or operations',async()=>{
 const host=document.createElement('article');document.body.append(host);history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const publish=vi.fn(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const write=vi.spyOn(Storage.prototype,'setItem'),push=vi.spyOn(history,'pushState');
 const navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});expect(publish).toHaveBeenLastCalledWith({kind:'waiting'});
 host.innerHTML=`<div class="rich-editor" data-preference-key="${scope}"><div class="rich-prose" role="textbox" contenteditable="true"><h2 data-id="a">Unicode 界</h2></div></div>`;const heading=host.querySelector('h2')!,text=heading.firstChild!;const range=document.createRange();range.setStart(text,2);range.collapse(true);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range);const before=host.innerHTML;await tick();
 expect(publish).toHaveBeenLastCalledWith({kind:'ready',label:'Unicode 界'});expect(heading.scrollIntoView).toHaveBeenCalledExactlyOnceWith({block:'start',behavior:'auto'});expect(window.getSelection()!.anchorNode).toBe(text);expect(window.getSelection()!.anchorOffset).toBe(2);expect(host.innerHTML).toBe(before);expect(fetch).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(push).not.toHaveBeenCalled();
 window.dispatchEvent(new Event('popstate'));window.dispatchEvent(new Event('hashchange'));await tick();expect(heading.scrollIntoView).toHaveBeenCalledTimes(1);navigation.stop();
});
it('expires missing targets, supports explicit retry, and cancels delayed callbacks on disposal',async()=>{
 const {host}=fixture('');history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');let state:HeadingNavigationState={kind:'idle'};const publish=vi.fn(value=>state=value),navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});
 await vi.advanceTimersByTimeAsync(5_000);expect(state).toEqual({kind:'unavailable'});host.querySelector('.rich-prose')!.innerHTML='<h2 data-id="a">Ready</h2>';await tick();expect(state).toEqual({kind:'unavailable'});navigation.retry();expect(state).toEqual({kind:'ready',label:'Ready'});navigation.stop();publish.mockClear();host.querySelector('h2')!.remove();await tick();await vi.runAllTimersAsync();expect(publish).not.toHaveBeenCalled();
});
it('refuses another page even for the same hash and leaves discussion routing alone',async()=>{
 const {host}=fixture();history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const publish=vi.fn(),navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});
 history.replaceState(null,'','/pages/00000000-0000-4000-8000-000000000999#hs-heading=a');window.dispatchEvent(new Event('popstate'));expect(publish).toHaveBeenLastCalledWith({kind:'idle'});expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
 history.replaceState(null,'','/pages/'+pageId+'#discussion-thread');window.dispatchEvent(new Event('hashchange'));expect(publish).toHaveBeenLastCalledWith({kind:'idle'});expect(location.hash).toBe('#discussion-thread');navigation.stop();await tick();
});
it('reveals ancestors temporarily, respects preference/user interaction, and removes stale destinations',async()=>{
 const {host,root}=fixture('<div data-type="details" data-id="section"><button aria-expanded="false"></button><div><div data-type="detailsContent" hidden><h2 data-id="a">Nested</h2></div></div></div>');const section=root.querySelector<HTMLElement>('[data-type=details]')!;
 localStorage.setItem('hs-collapse:'+scope+':section','closed');history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const publish=vi.fn(),navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});expect(section.classList.contains('is-open')).toBe(true);expect(localStorage.getItem('hs-collapse:'+scope+':section')).toBe('closed');
 root.querySelector('h2')!.remove();await tick();expect(publish).toHaveBeenLastCalledWith({kind:'unavailable'});expect(section.classList.contains('is-open')).toBe(false);navigation.stop();
});
it('retains a user-interacted reveal and saved collapse preference after link navigation ends',()=>{
 const {host,root}=fixture('<div data-type="details" data-id="section"><button aria-expanded="false"></button><div><div data-type="detailsContent" hidden><h2 data-id="a">Nested</h2></div></div></div>'),section=root.querySelector<HTMLElement>('[data-type=details]')!;
 localStorage.setItem('hs-collapse:'+scope+':section','closed');history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish:vi.fn()});markSectionInteraction(section);navigation.stop();expect(section.classList.contains('is-open')).toBe(true);expect(localStorage.getItem('hs-collapse:'+scope+':section')).toBe('closed');
});
it('invalidates current access without announcing a stale heading label or jumping again',async()=>{
 const {host}=fixture();history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const publish=vi.fn(),navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});host.querySelector<HTMLElement>('.rich-editor')!.hidden=true;await tick();expect(publish).toHaveBeenLastCalledWith({kind:'unavailable'});expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);navigation.stop();
});
it('uses smooth navigation only when reduced motion is not requested',()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false}));const {host}=fixture();history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish:vi.fn()});expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({block:'start',behavior:'smooth'});navigation.stop();
});
it('cancels a pending jump when its registered trusted editor-interaction callback runs',async()=>{
 const {host}=fixture(''),listen=vi.spyOn(host,'addEventListener');history.replaceState(null,'','/pages/'+pageId+'#hs-heading=a');const publish=vi.fn(),navigation=watchHeadingLink({host,scope,pageId,saved:()=>new Set(['a']),publish});
 const callback=listen.mock.calls.find(call=>call[0]==='keydown')![1] as EventListener;
 // Unit input to the registered handler; actual trusted interaction is a separate browser gate.
 callback({isTrusted:true} as Event);expect(publish).toHaveBeenLastCalledWith({kind:'unavailable'});host.querySelector('.rich-prose')!.innerHTML='<h2 data-id="a">Later</h2>';await tick();expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();navigation.stop();
});
it('resolves a thousand-heading document by exact identity and fails closed above the DOM work limit',()=>{
 const {host,root}=fixture(Array.from({length:1000},(_,i)=>`<h2 data-id="h${i}">Section ${i}</h2>`).join(''));expect(currentLinkedHeading(host,scope,'h999',new Set(['h999']))?.heading.label).toBe('Section 999');
 const extra=document.createDocumentFragment();for(let i=0;i<100_001;i++)extra.appendChild(document.createTextNode(' '));root.append(extra);expect(currentLinkedHeading(host,scope,'h999',new Set(['h999']))).toBeNull();
});
