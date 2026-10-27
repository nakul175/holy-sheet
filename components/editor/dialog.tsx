'use client';
import { useEffect,useRef,type ReactNode } from 'react';

function focusable(root:HTMLElement){
 return Array.from(root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"]')).filter(element=>{
  if(element.matches(':disabled,input[type="hidden"]')||element.closest('[hidden],[inert]'))return false;
  if(element.hasAttribute('tabindex')&&element.tabIndex<0)return false;
  if(element.tabIndex<0&&element.getAttribute('contenteditable')!=='true')return false;
  for(let parent:HTMLElement|null=element;parent;parent=parent.parentElement){
   const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden')return false;
   if(parent.tagName==='DETAILS'&&!parent.hasAttribute('open')&&!parent.querySelector(':scope > summary')?.contains(element))return false;
   if(parent===root)break;
  }
  return true;
 });
}
export function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null);
 // Capture before children mount: an autoFocus field otherwise replaces the opener.
 const previous=useRef<HTMLElement|null>(typeof document==='undefined'?null:document.activeElement as HTMLElement|null);
 useEffect(()=>{const root=ref.current;if(root)(focusable(root)[0]??root).focus();return()=>{if(previous.current?.isConnected)previous.current.focus();};},[]);
 return <div className="overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><div ref={ref} tabIndex={-1} className="modal editor-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event=>{
  if(event.defaultPrevented||event.nativeEvent.isComposing||event.keyCode===229)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
  if(event.key!=='Tab')return;event.stopPropagation();const root=ref.current;if(!root)return;const items=focusable(root),first=items[0],last=items.at(-1);
  if(!first){event.preventDefault();root.focus();return;}
  if(event.shiftKey&&(document.activeElement===first||document.activeElement===root)){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===root)){event.preventDefault();first.focus();}
 }}><div className="dialog-heading"><h2>{title}</h2><button aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</div></div>;
}
