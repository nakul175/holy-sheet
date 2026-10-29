import { Extension, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin,PluginKey } from '@tiptap/pm/state';
import { Decoration,DecorationSet } from '@tiptap/pm/view';
import { isInTable,selectedRect } from '@tiptap/pm/tables';
import { TABLE_POSITION_LIMITS } from './table-position';

export const tableReadingGuidesKey=new PluginKey<boolean>('holySheetTableReadingGuides');

export type TableReadingGuideCells={row:number[];column:number[];tableStart:number};

/** Resolve only logical table geometry. Cell content and DOM text are never inspected. */
export function tableReadingGuideCells(state:EditorState):TableReadingGuideCells|null{
  if(!isInTable(state))return null;
  try{
    const rect=selectedRect(state),{map}=rect;
    if(map.height<1||map.width<1||map.height>TABLE_POSITION_LIMITS.rows||map.width>TABLE_POSITION_LIMITS.columns)return null;
    const row=[...new Set(map.cellsInRect({left:0,right:map.width,top:rect.top,bottom:rect.bottom}))];
    const column=[...new Set(map.cellsInRect({left:rect.left,right:rect.right,top:0,bottom:map.height}))];
    return {row,column,tableStart:rect.tableStart};
  }catch{return null;}
}

function guideDecorations(state:EditorState){
  const cells=tableReadingGuideCells(state);
  if(!cells)return DecorationSet.empty;
  const row=new Set(cells.row),column=new Set(cells.column),positions=new Set([...row,...column]),decorations:Decoration[]=[];
  for(const relative of positions){
    const from=cells.tableStart+relative,node=state.doc.nodeAt(from);
    if(!node||!['tableCell','tableHeader'].includes(node.type.name))continue;
    const classes=[row.has(relative)?'hs-table-guide-row':'',column.has(relative)?'hs-table-guide-column':''].filter(Boolean).join(' ');
    decorations.push(Decoration.node(from,from+node.nodeSize,{class:classes,'data-hs-table-guide':'true'}));
  }
  return DecorationSet.create(state.doc,decorations);
}

export const TableReadingGuides=Extension.create({
  name:'tableReadingGuides',
  addProseMirrorPlugins(){return [new Plugin<boolean>({
    key:tableReadingGuidesKey,
    state:{init:()=>false,apply(transaction,enabled){const next=transaction.getMeta(tableReadingGuidesKey);return typeof next==='boolean'?next:enabled;}},
    props:{decorations(state){return tableReadingGuidesKey.getState(state)?guideDecorations(state):DecorationSet.empty;}},
  })];},
});

export function setTableReadingGuides(editor:Editor,enabled:boolean){
  editor.view.dispatch(editor.state.tr.setMeta(tableReadingGuidesKey,enabled).setMeta('addToHistory',false));
}
