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
    if(e.element.contains(document.activeElement)||(document.activeElement?.classList.contains('rich-prose')&&selected&&e.element.contains(selected))){retained.push(e);continue;}
    setSectionOpen(e.element,false);
  }
  return retained;
}
