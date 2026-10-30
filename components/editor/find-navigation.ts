import type { Editor } from '@tiptap/core';
import { findKey } from './extensions';
import { openSectionsForNavigation,restoreTemporarySections,type TemporarySection } from './section-navigation';

/** Reveal without selecting: typing a query must keep focus in the Find input. */
export function revealFindMatch(editor:Editor,match:{from:number;to:number},preferenceKey:string,entries:TemporarySection[]){
  const node=editor.state.doc.nodeAt(match.from);
  const raw=node?.isAtom&&!node.isText?editor.view.nodeDOM(match.from):editor.view.domAtPos(match.from).node;
  const element=raw?.nodeType===1?raw as HTMLElement:raw?.parentElement;
  openSectionsForNavigation(element??null,preferenceKey,entries);
  element?.scrollIntoView?.({block:'center'});
}

export function updateFindQuery(editor:Editor,input:{query:string;matchCase:boolean;wholeWords?:boolean},preferenceKey:string,entries:TemporarySection[],revealFirst:boolean){
  entries.splice(0,entries.length,...restoreTemporarySections(entries));
  editor.view.dispatch(editor.state.tr.setMeta(findKey,input));
  const first=findKey.getState(editor.state)?.matches[0];
  if(revealFirst&&first)revealFindMatch(editor,first,preferenceKey,entries);
}
