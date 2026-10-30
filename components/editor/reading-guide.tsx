"use client";

import {useCallback,useEffect,useState} from 'react';
import {Extension,type Editor} from '@tiptap/core';
import {Plugin} from '@tiptap/pm/state';
import {Decoration,DecorationSet} from '@tiptap/pm/view';

type GuideStorage={enabled:boolean};
type GuideSetter=(value:boolean|((current:boolean)=>boolean))=>void;

function guideStorage(editor:Editor):GuideStorage{
  return (editor.storage as unknown as Record<string,GuideStorage>).readingGuide;
}

export function readingGuidePosition(editor:Pick<Editor,'state'>):number|null{
  const {$from}=editor.state.selection;
  if($from.depth!==1)return null;
  const node=$from.node(1);
  return node.type.name==='paragraph'||node.type.name==='heading'?$from.before(1):null;
}

export const ReadingGuide=Extension.create<GuideStorage>({
  name:'readingGuide',
  addStorage:()=>({enabled:false}),
  addProseMirrorPlugins(){
    const editor=this.editor;
    return [new Plugin({props:{decorations(state){
      if(!guideStorage(editor).enabled)return null;
      const position=readingGuidePosition({state} as Pick<Editor,'state'>);
      if(position===null)return null;
      const node=state.doc.nodeAt(position);
      return node?DecorationSet.create(state.doc,[Decoration.node(position,position+node.nodeSize,{class:'hs-reading-guide-active','data-hs-reading-guide':'Current passage'})]):null;
    }}})];
  },
});

export function useReadingGuide(editor:Editor|null,scope:string,available=true){
  const [enabled,setEnabledState]=useState(false),[active,setActive]=useState(false);
  const redraw=useCallback((value:boolean)=>{if(!editor||editor.isDestroyed)return;guideStorage(editor).enabled=value;editor.view.updateState(editor.state);setActive(value&&readingGuidePosition(editor)!==null);},[editor]);
  const setEnabled=useCallback<GuideSetter>(next=>setEnabledState(current=>typeof next==='function'?next(current):next),[]);
  useEffect(()=>{setEnabledState(false);redraw(false);},[scope,available,redraw]);
  useEffect(()=>{redraw(enabled&&available);},[enabled,available,redraw]);
  useEffect(()=>{if(!editor)return;const refresh=()=>setActive(enabled&&available&&readingGuidePosition(editor)!==null);editor.on('selectionUpdate',refresh);editor.on('transaction',refresh);return()=>{editor.off('selectionUpdate',refresh);editor.off('transaction',refresh);};},[editor,enabled,available]);
  useEffect(()=>{const logout=()=>setEnabledState(false);window.addEventListener('holy-sheet:logout',logout);return()=>window.removeEventListener('holy-sheet:logout',logout);},[]);
  useEffect(()=>()=>redraw(false),[redraw]);
  return {enabled,setEnabled,active};
}

export function ReadingGuideControl({model}:{model:ReturnType<typeof useReadingGuide>}){
  return <div className="reading-guide-control">
    <button type="button" aria-label="Reading guide" aria-pressed={model.enabled} title="Mark the paragraph or heading at the caret" onMouseDown={event=>event.preventDefault()} onClick={()=>model.setEnabled(value=>!value)}><span aria-hidden="true">⌞</span> Guide</button>
    <span className="reading-guide-status" role="status" aria-live="polite">Reading guide {model.enabled?'on':'off'}{model.enabled&&!model.active?' · move to a paragraph or heading':''}</span>
  </div>;
}
