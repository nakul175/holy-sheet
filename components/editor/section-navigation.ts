export type TemporarySection={element:HTMLElement;key:string;preference:string|null;interaction:number};
const interactions=new WeakMap<HTMLElement,number>();
function preference(key:string){try{return localStorage.getItem(key);}catch{return null;}}
export function setSectionOpen(element:HTMLElement,open:boolean){
  element.classList.toggle('is-open',open);
  const button=element.querySelector(':scope > button');button?.setAttribute('aria-expanded',String(open));button?.setAttribute('aria-label',open?'Collapse details content':'Expand details content');
  element.querySelector(':scope > div > [data-type="detailsContent"]')?.toggleAttribute('hidden',!open);
}
export function markSectionInteraction(target:Node|null){
  let element=(target instanceof Element?target:target?.parentElement)?.closest<HTMLElement>('[data-type="details"]');
  while(element){interactions.set(element,(interactions.get(element)??0)+1);element=element.parentElement?.closest<HTMLElement>('[data-type="details"]');}
}
/** Personal view state only: never dispatch a document transaction or write defaults. */
export function installSectionPreferences(root:HTMLElement,keyPrefix:string){
  const initialized=new WeakMap<HTMLElement,{id:string;content:Element|null}>();let disposed=false;
  function initialize(element:HTMLElement){
    const id=element.getAttribute('data-id');if(!id)return;
    const content=element.querySelector(':scope > div > [data-type="detailsContent"]'),previous=initialized.get(element);
    if(previous?.id===id&&previous.content===content)return;
    initialized.set(element,{id,content});
    setSectionOpen(element,previous?.id===id?element.classList.contains('is-open'):preference(`hs-collapse:${keyPrefix}:${id}`)!=='closed');
  }
  function discover(node:Node){
    if(!(node instanceof Element))return;
    const parent=node.closest<HTMLElement>('[data-type="details"]');if(parent&&root.contains(parent))initialize(parent);
    node.querySelectorAll<HTMLElement>('[data-type="details"]').forEach(initialize);
  }
  discover(root);
  const observer=new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')discover(record.target);else for(const added of record.addedNodes)discover(added);}});
  observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['data-id']});
  const click=(event:Event)=>{
    if(!event.isTrusted||!(event.target instanceof Element))return;
    const section=event.target.closest<HTMLElement>('[data-type="details"]');
    if(!section||event.target.closest('button')!==section.querySelector(':scope > button'))return;
    markSectionInteraction(section);
    queueMicrotask(()=>{if(disposed||!root.contains(section))return;const open=section.classList.contains('is-open');setSectionOpen(section,open);const id=section.getAttribute('data-id');if(!id)return;try{localStorage.setItem(`hs-collapse:${keyPrefix}:${id}`,open?'open':'closed');}catch{}});
  };
  root.addEventListener('click',click);
  return()=>{disposed=true;observer.disconnect();root.removeEventListener('click',click);};
}
export function openSectionsForNavigation(target:Element|null,keyPrefix:string,entries:TemporarySection[]){
  let parent=target?.parentElement;
  while(parent){if(parent.getAttribute('data-type')==='details'&&!parent.classList.contains('is-open')){const key=`hs-collapse:${keyPrefix}:${parent.getAttribute('data-id')}`;entries.push({element:parent,key,preference:preference(key),interaction:interactions.get(parent)??0});setSectionOpen(parent,true);}parent=parent.parentElement;}
}
export function restoreTemporarySections(entries:TemporarySection[]):TemporarySection[]{
  const retained:TemporarySection[]=[];
  for(const e of entries){
    if(!e.element.isConnected)continue;
    if(preference(e.key)!==e.preference||(interactions.get(e.element)??0)!==e.interaction)continue;
    const selected=window.getSelection()?.anchorNode;
    const active=document.activeElement,editing=active?.closest('[contenteditable="true"]');
    if(editing&&(e.element.contains(active)||(selected&&e.element.contains(selected)))){retained.push(e);continue;}
    setSectionOpen(e.element,false);
  }
  return retained;
}
