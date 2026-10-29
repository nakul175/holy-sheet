import type {Node as PMNode} from '@tiptap/pm/model';
import {TextSelection,type EditorState} from '@tiptap/pm/state';

export const UNCHECKED_NAVIGATION_META='holySheetUncheckedNavigation';
export const UNCHECKED_LIST_MAX_UNITS=1_000_000,UNCHECKED_LIST_MAX_NODES=10_000;
type Entry={offset:number;target:number};
export type UncheckedList={node:PMNode;start:number;positions:Entry[];limited:boolean;previous:number|null;next:number|null;current:number|null};
function after(values:Entry[],position:number){let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>>1;if(values[mid].offset<=position)lo=mid+1;else hi=mid;}return lo;}
function indexList(node:PMNode):{positions:Entry[];limited:boolean}{
  const positions:Entry[]=[];
  if(node.content.size>UNCHECKED_LIST_MAX_UNITS)return {positions,limited:true};
  const stack=[{node,index:0,offset:0}];let visits=0;
  while(stack.length){const frame=stack[stack.length-1];if(frame.index===frame.node.childCount){stack.pop();continue;}
    if(++visits>UNCHECKED_LIST_MAX_NODES)return {positions:[],limited:true};
    const child=frame.node.child(frame.index++),offset=frame.offset;frame.offset+=child.nodeSize;
    if(child.type.name==='taskItem'&&child.attrs.checked!==true){
      // The schema requires a paragraph first; never jump to an invented text offset.
      if(child.firstChild?.isTextblock)positions.push({offset,target:offset+2});
    }
    if(child.childCount)stack.push({node:child,index:0,offset:offset+1});
  }
  return {positions,limited:false};
}
/** Retain only the active immutable list; caret movement does not traverse document content. */
export function createUncheckedListReader(){
  let cached:PMNode|null=null,index:ReturnType<typeof indexList>|null=null;
  return (state:EditorState):UncheckedList|null=>{
    const selection=state.selection;if(!(selection instanceof TextSelection)){cached=null;index=null;return null;}
    const head=selection.$head;let depth=head.depth;while(depth>0&&head.node(depth).type.name!=='taskList')depth--;
    if(!depth){cached=null;index=null;return null;}
    const node=head.node(depth),start=head.start(depth);
    if(selection.from<start||selection.to>start+node.content.size){cached=null;index=null;return null;}
    if(cached!==node||!index){cached=node;index=indexList(node);}
    let itemOffset:number|null=null;for(let d=head.depth;d>depth;d--)if(head.node(d).type.name==='taskItem'){itemOffset=head.before(d)-start;break;}
    const relative=itemOffset??head.pos-start,upper=after(index.positions,relative),current=upper>0&&index.positions[upper-1].offset===itemOffset?upper-1:null;
    const previous=(current!==null?current-1:upper-1),next=current!==null?current+1:upper;
    return {node,start,...index,current,previous:previous>=0?start+index.positions[previous].target:null,next:next<index.positions.length?start+index.positions[next].target:null};
  };
}
export function uncheckedListText(list:UncheckedList|null){
  if(!list)return '';
  if(list.limited)return 'This checklist is too large for unchecked-item navigation. Navigate directly in the document.';
  if(!list.positions.length)return 'No unchecked items in this checklist.';
  return list.current===null?`${list.positions.length} unchecked items in this checklist.`:`Unchecked item ${list.current+1} of ${list.positions.length}.`;
}
/** Reject stale controls after remote edits, list removal, or a different selection context. */
export function uncheckedTarget(state:EditorState,expected:UncheckedList,direction:'previous'|'next'){
  const current=createUncheckedListReader()(state);
  return current?.node===expected.node&&current.start===expected.start&&!current.limited?current[direction]:null;
}
