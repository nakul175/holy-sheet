import type { Editor } from '@tiptap/core';
import { NodeSelection,TextSelection,type SelectionBookmark,type Transaction,type Selection } from '@tiptap/pm/state';
import type { ResolvedPos,Node } from '@tiptap/pm/model';
type Anchor={id:string;offset:number};
type FindKey=Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'shiftKey'|'altKey'|'isComposing'>&{getModifierState?:(name:string)=>boolean};
export function isPageFindShortcut(event:FindKey){return !event.isComposing&&!event.getModifierState?.('AltGraph')&&!event.shiftKey&&!event.altKey&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f';}
export function focusAfterFind(editor:Editor){if(editor.isEditable)editor.commands.focus();else{editor.view.dom.focus({preventScroll:true});editor.view.focus();}}
export type FindSelection={bookmark:SelectionBookmark;nodeId?:string;anchor?:Anchor;head?:Anchor;text?:string;lost?:boolean};
function anchor(position:ResolvedPos):Anchor|undefined{for(let depth=position.depth;depth>0;depth--){const node=position.node(depth);if(node.isTextblock&&typeof node.attrs.id==='string')return {id:node.attrs.id,offset:position.pos-position.start(depth)};}}
export function captureFindSelection(editor:Editor):FindSelection{
 const selection=editor.state.selection;
 return {bookmark:selection.getBookmark(),...(selection instanceof NodeSelection&&typeof selection.node.attrs.id==='string'?{nodeId:selection.node.attrs.id}:{}),...(selection instanceof TextSelection?{anchor:anchor(selection.$anchor),head:anchor(selection.$head),text:editor.state.doc.textBetween(selection.from,selection.to,'\n')}: {})};
}
export function mapFindSelection(saved:FindSelection,transaction:Transaction):FindSelection{
 let lost=saved.lost??false;
 if(saved.anchor&&saved.head){const before=saved.bookmark.resolve(transaction.before);lost=lost||transaction.mapping.mapResult(before.anchor).deleted||transaction.mapping.mapResult(before.head).deleted;}
 const next={...saved,bookmark:saved.bookmark.map(transaction.mapping),lost};
 if(!lost&&saved.anchor&&saved.head){const selection=next.bookmark.resolve(transaction.doc),a=anchor(selection.$anchor),h=anchor(selection.$head);if(a?.id===saved.anchor.id&&h?.id===saved.head.id){next.anchor=a;next.head=h;next.text=transaction.doc.textBetween(selection.from,selection.to,'\n');}}
 return next;
}
function position(doc:Node,target:Anchor){let found:number|undefined;doc.descendants((node,pos)=>{if(node.isTextblock&&node.attrs.id===target.id&&target.offset<=node.content.size)found=pos+1+target.offset;});return found;}
export function restoreFindSelection(editor:Editor,saved:FindSelection){
 try{
  const doc=editor.state.doc;let selection:Selection|undefined;
  if(saved.nodeId){doc.descendants((node,pos)=>{if(node.attrs.id===saved.nodeId&&NodeSelection.isSelectable(node))selection=NodeSelection.create(doc,pos);});if(!selection)return false;}
  else if(saved.anchor&&saved.head){
   const mapped=saved.bookmark.resolve(doc),a=anchor(mapped.$anchor),h=anchor(mapped.$head);
   if(!saved.lost&&a?.id===saved.anchor.id&&h?.id===saved.head.id)selection=mapped;
   else{const from=position(doc,saved.anchor),to=position(doc,saved.head);if(from===undefined||to===undefined||doc.textBetween(Math.min(from,to),Math.max(from,to),'\n')!==saved.text)return false;selection=TextSelection.create(doc,from,to);}
  }else selection=saved.bookmark.resolve(doc);
  editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory',false));return true;
 }catch{return false;}
}
export function selectFindMatch(editor:Editor,match:{from:number;to:number}){
 const {doc}=editor.state,{from,to}=match;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>doc.content.size)return false;
 const node=doc.nodeAt(from);let selection:Selection;
 if(node?.isBlock&&node.isAtom&&to===from+node.nodeSize&&NodeSelection.isSelectable(node))selection=NodeSelection.create(doc,from);
 else{const a=doc.resolve(from),b=doc.resolve(to);if(!a.parent.inlineContent||!b.parent.inlineContent)return false;selection=TextSelection.create(doc,from,to);}
 editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory',false));return true;
}
