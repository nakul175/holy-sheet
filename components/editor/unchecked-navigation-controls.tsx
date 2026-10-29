'use client';
import {useEffect,useRef,useState} from 'react';
import type {Editor} from '@tiptap/core';
import {TextSelection} from '@tiptap/pm/state';
import {skipTrailingNodeMeta} from '@tiptap/extensions';
import {UNCHECKED_NAVIGATION_META,uncheckedListText,uncheckedTarget,type UncheckedList} from './unchecked-navigation';
import {openSectionsForNavigation,restoreTemporarySections,type TemporarySection} from './section-navigation';

export function UncheckedNavigationControls({editor,list,preferenceKey}:{editor:Editor|null;list:UncheckedList|null;preferenceKey:string}){
  const temporary=useRef<TemporarySection[]>([]),[notice,setNotice]=useState('');
  useEffect(()=>{setNotice('');
    const selected=editor&&!editor.isDestroyed&&list?editor.view.domAtPos(editor.state.selection.head).node:null;
    // A reader's selected target must stay visible too, despite contenteditable=false.
    const retained=temporary.current.filter(entry=>selected&&entry.element.contains(selected));
    temporary.current=[...retained,...restoreTemporarySections(temporary.current.filter(entry=>!retained.includes(entry)))];
  },[editor,list?.node,list?.start]);
  useEffect(()=>()=>{temporary.current=restoreTemporarySections(temporary.current);},[]);
  if(!editor||!list)return null;
  function navigate(direction:'previous'|'next'){
    if(!editor||editor.isDestroyed||!list)return;
    if(editor.state.doc.nodeAt(list.start-1)!==list.node){setNotice('The checklist changed. Select a current checklist item again.');return;}
    const target=uncheckedTarget(editor.state,list,direction);
    if(target===null){setNotice(list.limited?'Navigation unavailable for this checklist.':!list.positions.length?'No unchecked items in this checklist.':direction==='previous'?'No previous unchecked item in this checklist.':'No next unchecked item in this checklist.');return;}
    const dom=editor.view.domAtPos(target).node,element=dom instanceof Element?dom:dom.parentElement;
    if(!element||!editor.view.dom.contains(element))return;
    temporary.current=restoreTemporarySections(temporary.current);
    openSectionsForNavigation(element,preferenceKey,temporary.current,editor.view.dom);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc,target)).setMeta('addToHistory',false).setMeta(skipTrailingNodeMeta,true).setMeta(UNCHECKED_NAVIGATION_META,true));
    element.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});setNotice(direction==='previous'?'Moved to the previous unchecked item.':'Moved to the next unchecked item.');
  }
  return <section className="context-tools" aria-label="Unchecked checklist navigation"><span>{uncheckedListText(list)}</span><button type="button" onClick={()=>navigate('previous')}>Previous unchecked item</button><button type="button" onClick={()=>navigate('next')}>Next unchecked item</button><span role="status" aria-live="polite" aria-atomic="true">{notice}</span></section>;
}
