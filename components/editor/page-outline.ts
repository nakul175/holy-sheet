import {openSectionsForNavigation,restoreTemporarySections,type TemporarySection} from './section-navigation';
export type OutlineHeading={id:string;level:1|2|3;label:string;target:HTMLElement};
export type OutlineSnapshot={root:HTMLElement|null;headings:OutlineHeading[]};

export function outlineRoot(host:HTMLElement,preferenceKey:string):HTMLElement|null{
 const wrappers=Array.from(host.querySelectorAll<HTMLElement>('.rich-editor')).filter(n=>n.dataset.preferenceKey===preferenceKey);
 if(wrappers.length!==1)return null;
 const wrapper=wrappers[0];
 for(let node:HTMLElement|null=wrapper;node&&host.contains(node);node=node.parentElement){const style=getComputedStyle(node);if(node.hidden||node.hasAttribute('inert')||node.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return null;if(node===host)break;}
 const roots=Array.from(wrapper.querySelectorAll<HTMLElement>('.rich-prose[role="textbox"]')).filter(n=>n.closest('.rich-editor')===wrapper);
 return roots.length===1?roots[0]:null;
}
function readable(element:HTMLElement,root:HTMLElement,cache:Map<HTMLElement,boolean>):boolean{
 const known=cache.get(element);if(known!==undefined)return known;
 if(element!==root&&!root.contains(element))return false;
 const collapsible=element.dataset.type==='detailsContent'&&element.parentElement?.parentElement?.dataset.type==='details';
 const style=getComputedStyle(element);
 const own=element.getAttribute('aria-hidden')!=='true'&&!element.hasAttribute('inert')&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&(!element.hidden&&style.display!=='none'||collapsible);
 const allowed=own&&(element===root||!!element.parentElement&&readable(element.parentElement,root,cache));cache.set(element,allowed);return allowed;
}
function labelFor(heading:HTMLElement,root:HTMLElement,cache:Map<HTMLElement,boolean>){
 const walker=document.createTreeWalker(heading,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);let text='',read=0,visits=0,node:Node|null;
 // Labels are previews; cap work and retained text even for a huge unsaved heading.
 while((node=walker.nextNode())&&read<8192&&++visits<8192){if(node instanceof HTMLElement){if(node.tagName==='BR'&&readable(node,root,cache)){text+=' ';read++;}continue;}const parent=node.parentElement;if(!parent||!readable(parent,root,cache))continue;const value=(node.nodeValue??'').slice(0,8192-read);read+=value.length;text+=value;if(text.replace(/\s+/gu,' ').trim().length>256)break;}
 const value=text.replace(/\s+/gu,' ').trim();const characters=Array.from(value);return characters.length>256?characters.slice(0,256).join('')+'…':value||'Untitled heading';
}
export function collectOutline(root:HTMLElement,onlyId?:string):OutlineHeading[]{
 const counts=new Map<string,number>();for(const node of root.querySelectorAll<HTMLElement>('[data-id]')){if(node.closest('.rich-prose')!==root)continue;const id=node.dataset.id!;if(onlyId!==undefined&&id!==onlyId)continue;counts.set(id,(counts.get(id)??0)+1);}
 const cache=new Map<HTMLElement,boolean>(),headings:OutlineHeading[]=[];
 for(const target of root.querySelectorAll<HTMLElement>('h1[data-id],h2[data-id],h3[data-id]')){
  const id=target.dataset.id!;if(onlyId!==undefined&&id!==onlyId)continue;if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||counts.get(id)!==1||target.closest('.rich-prose')!==root||!readable(target,root,cache))continue;
  headings.push({id,level:Number(target.tagName[1]) as 1|2|3,label:labelFor(target,root,cache),target});
 }
 return headings;
}
export function observeOutline(host:HTMLElement,preferenceKey:string,publish:(snapshot:OutlineSnapshot)=>void){
 let root:HTMLElement|null=null,live=true,scheduled=false;
 const refresh=()=>{if(!live)return;const next=outlineRoot(host,preferenceKey);if(next!==root){content.disconnect();root=next;publish({root,headings:[]});if(root)content.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-id','hidden','inert','aria-hidden','class','style']});}publish({root,headings:root?collectOutline(root):[]});};
 const schedule=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;refresh();});};
 const content=new MutationObserver(schedule),mount=new MutationObserver(()=>{if(outlineRoot(host,preferenceKey)!==root)refresh();});
 mount.observe(host,{subtree:true,childList:true,attributes:true,attributeFilter:['data-preference-key','hidden','inert','aria-hidden','class','style']});refresh();
 return()=>{live=false;content.disconnect();mount.disconnect();root=null;};
}
export function jumpToOutline(root:HTMLElement,heading:OutlineHeading,preferenceKey:string,temporary:TemporarySection[]){
 if(!root.isConnected||!root.contains(heading.target)||heading.target.dataset.id!==heading.id)return false;
 const matches=Array.from(root.querySelectorAll<HTMLElement>('[data-id]')).filter(n=>n.dataset.id===heading.id&&n.closest('.rich-prose')===root);
 if(matches.length!==1||matches[0]!==heading.target||!readable(heading.target,root,new Map()))return false;
 temporary.splice(0,temporary.length,...restoreTemporarySections(temporary));
 openSectionsForNavigation(heading.target,preferenceKey,temporary,root);
 heading.target.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 return true; // No editor transaction, DOM selection, hash, ID or saved preference changes.
}
