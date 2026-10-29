'use client';
import {useLayoutEffect,useRef,useState,type KeyboardEvent,type MouseEvent} from 'react';
import styles from './personal-focus-mode.module.css';

export function usePersonalFocusMode(actorId:string,pageId:string,available:boolean){
 const context=JSON.stringify([actorId,pageId]),permitted=available&&!!actorId.trim();
 const [scope,setScope]=useState('');
 const launcher=useRef<HTMLButtonElement>(null),exitButton=useRef<HTMLButtonElement>(null);
 const position=useRef({x:0,y:0,scope:''}),restore=useRef<'launcher'|'discussion'|null>(null),previous=useRef(false),discussionHeading=useRef<HTMLElement|null>(null);
 const active=permitted&&scope===context;
 useLayoutEffect(()=>{if(!permitted||scope&&scope!==context)setScope('');},[context,permitted,scope]);
 useLayoutEffect(()=>{
  if(active)exitButton.current?.focus({preventScroll:true});
  else if(previous.current&&restore.current){
   const reason=restore.current;restore.current=null;
   if(permitted&&position.current.scope===context){
    if(reason==='discussion'&&discussionHeading.current?.isConnected)discussionHeading.current.focus({preventScroll:true});
    else {launcher.current?.closest('details')?.querySelector('summary')?.focus({preventScroll:true});window.scrollTo(position.current.x,position.current.y);}
   }
   discussionHeading.current=null;
  }
  previous.current=active;
 },[active,permitted,context]);
 function enter(){if(!permitted)return;position.current={x:window.scrollX,y:window.scrollY,scope:context};restore.current=null;discussionHeading.current=null;setScope(context);}
 function exit(){restore.current='launcher';setScope('');}
 function onKeyDown(event:KeyboardEvent<HTMLElement>){
  if(!active||event.key!=='Escape'||event.defaultPrevented||event.nativeEvent.isComposing||event.keyCode===229)return;
  const target=event.target;if(target instanceof Element&&target.closest('[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"],select,input'))return;
  event.preventDefault();event.stopPropagation();exit();
 }
 function onClickCapture(event:MouseEvent<HTMLElement>){
  // Passage markers stop bubbling themselves. Reveal their existing panel before it attempts focus.
  if(active&&event.target instanceof Element&&event.target.closest('.discussion-marker')){
   restore.current='discussion';discussionHeading.current=event.currentTarget.querySelector<HTMLElement>('.discussion-panel h2');setScope('');
  }
 }
 return {active,permitted,launcher,exitButton,enter,exit,onKeyDown,onClickCapture,className:active?styles.focused:''};
}
export function FocusModeLauncher({model}:{model:ReturnType<typeof usePersonalFocusMode>}){
 return <button ref={model.launcher} type="button" disabled={!model.permitted} aria-pressed={model.active} onMouseDown={event=>event.preventDefault()} onClick={model.enter}>Enter focus mode</button>;
}
export function FocusModeExit({model}:{model:ReturnType<typeof usePersonalFocusMode>}){
 return model.active?<button ref={model.exitButton} type="button" className={styles.exit} onMouseDown={event=>event.preventDefault()} onClick={model.exit}>Exit focus mode</button>:null;
}
