import type { Node as ModelNode } from '@tiptap/pm/model';
import { NodeSelection,type EditorState } from '@tiptap/pm/state';

export const CHECKLIST_PROGRESS_LIMITS=Object.freeze({items:10_000,nodes:100_000,depth:16});
export type ChecklistProgress={kind:'ready';completed:number;total:number}|{kind:'unavailable'};
const unavailable:ChecklistProgress={kind:'unavailable'};
// Model nodes are immutable. Counts retain no document text and disappear with their weak key.
const counts=new WeakMap<ModelNode,ChecklistProgress>();

function count(list:ModelNode):ChecklistProgress{
 const cached=counts.get(list);if(cached)return cached;
 const frames=[{node:list,depth:0,next:-1}];let visits=0,total=0,completed=0;
 while(frames.length){
  const frame=frames[frames.length-1];
  if(frame.next===-1){
   if(++visits>CHECKLIST_PROGRESS_LIMITS.nodes||frame.depth>CHECKLIST_PROGRESS_LIMITS.depth){counts.set(list,unavailable);return unavailable;}
   if(frame.node.type.name==='taskItem'){
    if(++total>CHECKLIST_PROGRESS_LIMITS.items){counts.set(list,unavailable);return unavailable;}
    if(frame.node.attrs.checked===true)completed++;
   }
   frame.next=0;
  }
  if(frame.next===frame.node.childCount)frames.pop();
  else frames.push({node:frame.node.child(frame.next++),depth:frame.depth+1,next:-1});
 }
 const result:ChecklistProgress={kind:'ready',completed,total};counts.set(list,result);return result;
}

/** Nearest checklist for a caret; deepest common checklist for a range. Whole-list
 * node selection selects that list. Crossing outside it (including AllSelection) hides progress.
 * Count each descendant task item once, including nested items; never inspect item text. */
export function checklistProgress(state:EditorState):ChecklistProgress|null{
 const selection=state.selection;
 if(selection instanceof NodeSelection&&selection.node.type.name==='taskList')return count(selection.node);
 const {$from,$to}=selection;
 for(let depth=$from.depth;depth>0;depth--){
  const node=$from.node(depth);
  if(node.type.name==='taskList'&&$to.depth>=depth&&$to.node(depth)===node&&$from.before(depth)===$to.before(depth))return count(node);
 }
 return null;
}

export function checklistProgressText(value:ChecklistProgress|null){
 return !value?'':value.kind==='unavailable'?'Progress unavailable for this checklist.':`${value.completed} of ${value.total} completed.`;
}
