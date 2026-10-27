import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection,type SelectionBookmark } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { plainText,stableStringify,validateDocument,type RichNode } from '../../lib/document';
import { normalizeRichDocument } from '../../lib/editor-document';
import { selectedTable } from './table-actions';
import { blankPasteCell,type TablePasteSource } from './table-paste-source';
export type PastePoint={expected:string;bookmark:SelectionBookmark;topAfter:number;replacesSelection:boolean;table:ReturnType<typeof selectedTable>};
export type PasteMode='fill'|'separate'|'plain';
export function capturePastePoint(editor:Editor):PastePoint{const {$from}=editor.state.selection;return {expected:stableStringify(editor.getJSON()),bookmark:editor.state.selection.getBookmark(),topAfter:$from.depth?$from.after(1):editor.state.doc.content.size,replacesSelection:!editor.state.selection.empty,table:selectedTable(editor)};}
const id=()=>crypto.randomUUID();
function occupied(cell:RichNode){return !(cell.content?.length===1&&cell.content[0].type==='paragraph'&&!plainText(cell).length);}
export function previewTablePaste(editor:Editor,source:TablePasteSource,point:PastePoint,mode:PasteMode){
 if(editor.isDestroyed||!editor.isEditable)throw Error('This page is no longer editable. No content changed.');
 if(stableStringify(editor.getJSON())!==point.expected)throw Error('The page changed while this paste preview was open. Cancel and paste again.');
 let tr=editor.state.tr,summary='',replaced=0;
 if(mode==='plain'){
  if(!source.text.length)throw Error('No literal text was supplied.');tr=tr.setSelection(point.bookmark.resolve(tr.doc)).replaceSelectionWith(editor.schema.text(source.text,[]),false).setMeta('preventAutolink',true);summary=`Insert ${source.text.length.toLocaleString()} literal characters, preserving tabs and line breaks, with no marks, automatic links or automatic tables.${point.replacesSelection?' The selected content will be replaced.':''}`;
 }else if(mode==='separate'){
  if(!source.grids.length)throw Error('This source requires literal text review.');
  const tables:RichNode[]=[];for(const grid of source.grids){if(grid.rows[0].length>20)throw Error('The source has more than 20 columns. Choose literal text to retain every column, or split the source before pasting.');for(let start=0;start<grid.rows.length;start+=100)tables.push({type:'table',attrs:{id:id()},content:grid.rows.slice(start,start+100).map(cells=>({type:'tableRow',attrs:{id:id()},content:structuredClone(cells)}))});}
  tr=tr.insert(point.topAfter,Fragment.fromArray(tables.map(n=>editor.schema.nodeFromJSON(n))));const firstCell=tables[0].content![0].content![0].attrs!.id;tr.doc.descendants((node,pos)=>{if(node.attrs.id===firstCell)tr.setSelection(TextSelection.near(tr.doc.resolve(pos+2)));});summary=`Insert ${tables.length} separate table${tables.length===1?'':'s'} after the containing top-level block, with at most 100 rows and 20 columns each. Existing cells stay intact.`;
 }else{
  const target=point.table;if(!target)throw Error('Select a destination table cell before pasting.');if(source.grids.length!==1)throw Error('Fill requires exactly one rectangular source table.');const grid=source.grids[0],rowCount=Math.max(target.node.childCount,target.row+grid.rows.length),columns=Math.max(target.node.firstChild!.childCount,target.column+grid.rows[0].length);if(rowCount>100||columns>20)throw Error('The fill would exceed 100 rows or 20 columns. Insert separate row-split tables or choose complete literal text.');
  const table=target.node.toJSON() as RichNode,rows=table.content!;const header=rows[0].content!.every(c=>c.type==='tableHeader');for(let y=0;y<rowCount;y++){rows[y]??={type:'tableRow',attrs:{id:id()},content:[]};for(let x=0;x<columns;x++)rows[y].content![x]??=blankPasteCell(header&&y===0);}
  for(let y=0;y<grid.rows.length;y++)for(let x=0;x<grid.rows[y].length;x++){const cell=rows[target.row+y].content![target.column+x];if(occupied(cell))replaced++;cell.content=structuredClone(grid.rows[y][x].content);}
  const destinationId=rows[target.row].content![target.column].attrs!.id;tr=tr.replaceWith(target.from,target.from+target.node.nodeSize,editor.schema.nodeFromJSON(table));tr.doc.descendants((node,pos)=>{if(node.attrs.id===destinationId)tr.setSelection(TextSelection.near(tr.doc.resolve(pos+2)));});summary=`Fill ${grid.rows.length} row${grid.rows.length===1?'':'s'} × ${grid.rows[0].length} column${grid.rows[0].length===1?'':'s'} from row ${target.row+1}, column ${target.column+1}. ${replaced} occupied cell${replaced===1?' will':'s will'} be replaced. Result: ${rowCount} rows × ${columns} columns. Existing headers and column widths stay intact.`;
 }
 validateDocument(normalizeRichDocument(tr.doc.toJSON()));return {transaction:tr,summary,replaced};
}
export function applyTablePaste(editor:Editor,source:TablePasteSource,point:PastePoint,mode:PasteMode){const {transaction}=previewTablePaste(editor,source,point,mode);editor.view.dispatch(closeHistory(transaction).scrollIntoView());editor.view.dispatch(closeHistory(editor.state.tr));editor.view.focus();}
