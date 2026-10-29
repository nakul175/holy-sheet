import type { EditorState } from '@tiptap/pm/state';
import { CellSelection,isInTable,selectedRect } from '@tiptap/pm/tables';

export const TABLE_POSITION_LIMITS={rows:100,columns:20} as const;

export type TablePosition={
  rows:number;columns:number;fromRow:number;toRow:number;fromColumn:number;toColumn:number;
  selectedCells:number;cellKind:'header'|'body'|'mixed';
};

/** Read logical table geometry without dispatching a transaction or inspecting cell text. */
export function tablePosition(state:EditorState):TablePosition|null{
  if(!isInTable(state))return null;
  try{
    const rect=selectedRect(state),{map,table}=rect;
    if(map.height<1||map.width<1||map.height>TABLE_POSITION_LIMITS.rows||map.width>TABLE_POSITION_LIMITS.columns)return null;
    const positions=state.selection instanceof CellSelection?map.cellsInRect(rect):[map.map[rect.top*map.width+rect.left]];
    const unique=[...new Set(positions)],kinds=new Set(unique.map(position=>table.nodeAt(position)?.type.spec.tableRole==='header_cell'?'header':'body'));
    return {rows:map.height,columns:map.width,fromRow:rect.top+1,toRow:rect.bottom,fromColumn:rect.left+1,toColumn:rect.right,selectedCells:unique.length,cellKind:kinds.size>1?'mixed':kinds.has('header')?'header':'body'};
  }catch{return null;}
}

export function tablePositionText(value:TablePosition|null){
  if(!value)return '';
  const dimensions=`${value.rows} row${value.rows===1?'':'s'} by ${value.columns} column${value.columns===1?'':'s'}`;
  const kind=value.cellKind==='mixed'?'header and body cells':`${value.cellKind} cell${value.selectedCells===1?'':'s'}`;
  if(value.selectedCells===1)return `Table ${dimensions}. ${value.cellKind==='header'?'Header':'Body'} cell, row ${value.fromRow} of ${value.rows}, column ${value.fromColumn} of ${value.columns}.`;
  return `Table ${dimensions}. Selected rows ${value.fromRow} to ${value.toRow}, columns ${value.fromColumn} to ${value.toColumn}: ${value.selectedCells} ${kind}.`;
}

export function tablePositionKey(value:TablePosition|null){return value?`${value.rows}:${value.columns}:${value.fromRow}:${value.toRow}:${value.fromColumn}:${value.toColumn}:${value.selectedCells}:${value.cellKind}`:'';}
