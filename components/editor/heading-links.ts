import {collectOutline,outlineRoot,type OutlineHeading} from './page-outline';
import {openSectionsForNavigation,restoreTemporarySections,type TemporarySection} from './section-navigation';

// This is the existing persisted block-ID contract, not a new schema allowance.
export const savedHeadingIdPattern=/^[a-zA-Z0-9_-]{1,100}$/;
export type HeadingFragment={kind:'other'}|{kind:'invalid'}|{kind:'heading';id:string};
export function parseHeadingFragment(hash:string):HeadingFragment{
 if(!hash.startsWith('#hs-heading='))return {kind:'other'};
 if(hash.length>312)return {kind:'invalid'};
 try{const id=decodeURIComponent(hash.slice(12));return savedHeadingIdPattern.test(id)?{kind:'heading',id}:{kind:'invalid'};}catch{return {kind:'invalid'};}
}
export function headingLink(origin:string,pageId:string,id:string):string|null{
 if(!savedHeadingIdPattern.test(id)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(pageId))return null;
 try{const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==origin)return null;return `${url.origin}/pages/${encodeURIComponent(pageId)}#hs-heading=${encodeURIComponent(id)}`;}catch{return null;}
}
/** Only pass an already-authorized, server-confirmed body. No fetch/save or metadata inspection. */
export function savedHeadingIds(body:unknown):Set<string>{
 if(!body||typeof body!=='object'||(body as {type?:unknown}).type!=='doc')return new Set();
 const counts=new Map<string,number>(),headings=new Set<string>(),seen=new Set<object>();
 const pending=[{value:body,depth:0}];let visits=0,blocks=0;
 while(pending.length){const {value,depth}=pending.pop()!;if(++visits>100_000||depth>16||!value||typeof value!=='object'||Array.isArray(value)||seen.has(value))return new Set();seen.add(value);
  const node=value as {type?:unknown;attrs?:{id?:unknown};content?:unknown};const id=node.attrs?.id;
  if(typeof id==='string'){if(++blocks>10_000)return new Set();counts.set(id,(counts.get(id)??0)+1);if(node.type==='heading'&&savedHeadingIdPattern.test(id))headings.add(id);}
  if(node.content!==undefined){if(!Array.isArray(node.content))return new Set();for(let i=node.content.length-1;i>=0;i--)pending.push({value:node.content[i],depth:depth+1});}
 }
 return new Set([...headings].filter(id=>counts.get(id)===1));
}
/** Bound hostile/unsupported rendered trees before consuming the merged outline collector. */
export function currentLinkedHeading(host:HTMLElement,scope:string,id:string,saved:ReadonlySet<string>):{root:HTMLElement;heading:OutlineHeading}|null{
 if(!saved.has(id)||!savedHeadingIdPattern.test(id))return null;
 const root=outlineRoot(host,scope);if(!root)return null;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let visits=0;
 while(walker.nextNode())if(++visits>100_000)return null;
 const heading=collectOutline(root,id)[0];return heading?{root,heading}:null;
}
export type HeadingNavigationState={kind:'idle'}|{kind:'waiting'}|{kind:'unavailable'}|{kind:'ready';label:string};
/** One exact-ID jump per hash navigation. Never touches editor transactions or DOM selection. */
export function watchHeadingLink({host,scope,pageId,saved,publish}:{host:HTMLElement;scope:string;pageId:string;saved:()=>ReadonlySet<string>;publish:(state:HeadingNavigationState)=>void}){
 let alive=true,epoch=0,lastHash:string|null=null,lastPath:string|null=null,observer:MutationObserver|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let temporary:TemporarySection[]=[],target:HTMLElement|null=null,queued=false,currentCheck:(()=>void)|undefined;
 const clear=()=>{observer?.disconnect();observer=undefined;clearTimeout(timer);timer=undefined;temporary=restoreTemporarySections(temporary);target=null;currentCheck=undefined;};
 const read=(force=false)=>{
  if(!alive||!force&&location.hash===lastHash&&location.pathname===lastPath)return;lastHash=location.hash;lastPath=location.pathname;const token=++epoch;clear();
  const fragment=parseHeadingFragment(lastHash);if(location.pathname!==`/pages/${encodeURIComponent(pageId)}`||fragment.kind==='other'){publish({kind:'idle'});return;}if(fragment.kind==='invalid'){publish({kind:'unavailable'});return;}
  publish({kind:'waiting'});
  const unavailable=()=>{if(!alive||token!==epoch)return;clear();publish({kind:'unavailable'});};
  const check=()=>{queued=false;if(!alive||token!==epoch)return;
   if(location.pathname!==`/pages/${encodeURIComponent(pageId)}`){clear();publish({kind:'idle'});return;}
   if(location.hash!==lastHash){read();return;}
   const found=currentLinkedHeading(host,scope,fragment.id,saved());
   if(target){if(!found||found.heading.target!==target)unavailable();return;}
   if(!found)return;target=found.heading.target;clearTimeout(timer);timer=undefined;
   openSectionsForNavigation(target,scope,temporary,found.root);
   target.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
   publish({kind:'ready',label:found.heading.label});
  };
  observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(check);});
  observer.observe(host,{subtree:true,childList:true,attributes:true,attributeFilter:['data-id','data-preference-key','hidden','inert','aria-hidden','class','style']});
  currentCheck=check;timer=setTimeout(unavailable,5_000);check();
 };
 const changed=()=>read();
 const interaction=(event:Event)=>{if(alive&&event.isTrusted&&observer&&!target){epoch++;clear();publish({kind:'unavailable'});}};
 window.addEventListener('hashchange',changed);window.addEventListener('popstate',changed);host.addEventListener('pointerdown',interaction,true);host.addEventListener('keydown',interaction,true);read();
 return {retry:()=>read(true),refresh:()=>currentCheck?.(),stop:()=>{alive=false;epoch++;clear();window.removeEventListener('hashchange',changed);window.removeEventListener('popstate',changed);host.removeEventListener('pointerdown',interaction,true);host.removeEventListener('keydown',interaction,true);}};
}
