import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

export function selectedTable(editor:Editor){
  const {$from}=editor.state.selection;
  for(let depth=$from.depth;depth>0;depth--)if($from.node(depth).type.name==='table'){
    return {node:$from.node(depth),from:$from.before(depth),row:$from.index(depth),column:$from.index(depth+1)};
  }
  return null;
}

/** Reorder complete rows/columns in a single undoable transaction, preserving every stable ID. */
export function reorderTable(editor:Editor,axis:'row'|'column',direction:-1|1){
  const table=selectedTable(editor);if(!table)return false;
  const index=axis==='row'?table.row:table.column,target=index+direction;
  const size=axis==='row'?table.node.childCount:table.node.firstChild!.childCount;
  if(target<0||target>=size)return false;
  const selectedId=table.node.child(table.row).child(table.column).attrs.id;
  const rows=Array.from({length:table.node.childCount},(_,i)=>table.node.child(i));
  if(axis==='row')[rows[index],rows[target]]=[rows[target],rows[index]];
  else for(let i=0;i<rows.length;i++){
    const cells=Array.from({length:rows[i].childCount},(_,j)=>rows[i].child(j));
    [cells[index],cells[target]]=[cells[target],cells[index]];
    rows[i]=rows[i].copy(Fragment.from(cells));
  }
  const replacement=table.node.copy(Fragment.from(rows));
  const tr=editor.state.tr.replaceWith(table.from,table.from+table.node.nodeSize,replacement);
  tr.doc.descendants((node,pos)=>{if(node.attrs.id===selectedId)tr.setSelection(TextSelection.near(tr.doc.resolve(pos+2)));});
  editor.view.dispatch(tr.scrollIntoView());editor.view.focus();return true;
}

export function leaveBlock(editor:Editor,type:'table'|'codeBlock'){
  const {$from}=editor.state.selection;
  for(let depth=$from.depth;depth>0;depth--)if($from.node(depth).type.name===type){
    const after=$from.after(depth),tr=editor.state.tr;
    if(!tr.doc.nodeAt(after)?.isTextblock)tr.insert(after,editor.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.near(tr.doc.resolve(after+1)));
    editor.view.dispatch(tr.scrollIntoView());editor.view.focus();return true;
  }
  return false;
}
