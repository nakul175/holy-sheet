import type { Mark } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

export const mixedPaletteValue='__mixed__';
type ToggleState=boolean|'mixed';
export type SelectionFormat={bold:ToggleState;italic:ToggleState;underline:ToggleState;strike:ToggleState;color:string;highlight:string};
function sample(marks:readonly Mark[]):SelectionFormat{
  const attribute=(name:string,key:string)=>{const value=marks.find(mark=>mark.type.name===name)?.attrs[key];return typeof value==='string'?value:'';};
  return {bold:marks.some(m=>m.type.name==='bold'),italic:marks.some(m=>m.type.name==='italic'),underline:marks.some(m=>m.type.name==='underline'),strike:marks.some(m=>m.type.name==='strike'),color:attribute('textStyle','color'),highlight:attribute('highlight','color')};
}
/** Inspect selected text only; a caret uses pending typing marks, including an explicit empty set. */
export function selectionFormat(state:EditorState):SelectionFormat{
  const {from,to,empty,$from}=state.selection;
  if(empty)return sample(state.storedMarks??$from.marks());
  let result:SelectionFormat|undefined;
  state.doc.nodesBetween(from,to,(node,pos)=>{
    if(!node.isText||Math.max(from,pos)>=Math.min(to,pos+node.nodeSize))return;
    const next=sample(node.marks);if(!result){result=next;return;}
    for(const key of ['bold','italic','underline','strike'] as const)if(result[key]!==next[key])result[key]='mixed';
    for(const key of ['color','highlight'] as const)if(result[key]!==next[key])result[key]=mixedPaletteValue;
  });
  return result??sample([]);
}
