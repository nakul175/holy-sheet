// @vitest-environment jsdom
import { afterEach,describe,expect,it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { CellSelection,TableMap } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import { TableReadingGuides,setTableReadingGuides,tableReadingGuideCells,tableReadingGuidesKey } from '../components/editor/table-reading-guides';

const editors:Editor[]=[];afterEach(()=>editors.splice(0).forEach(editor=>editor.destroy()));
const paragraph=(text:string)=>({type:'paragraph',content:[{type:'text',text}]});
function fixture(merged=false){
  const cell=(type:string,text:string,attrs={})=>({type,attrs:{colspan:1,rowspan:1,...attrs},content:[paragraph(text)]});
  const content=merged?[{type:'tableRow',content:[cell('tableHeader','A',{colspan:2}),cell('tableHeader','B')]},{type:'tableRow',content:[cell('tableCell','C'),cell('tableCell','D'),cell('tableCell','E')]}]:[{type:'tableRow',content:[cell('tableHeader','A'),cell('tableHeader','B')]},{type:'tableRow',content:[cell('tableCell','C'),cell('tableCell','D')]}];
  const editor=new Editor({element:document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TableKit,TableReadingGuides],content:{type:'doc',content:[{type:'table',content},{type:'paragraph',content:[{type:'text',text:'After'}]}]}});editors.push(editor);return editor;
}
function cells(editor:Editor){const table=editor.state.doc.firstChild!,map=TableMap.get(table);return map.cellsInRect({left:0,top:0,right:map.width,bottom:map.height}).map(pos=>pos+1);}

describe('temporary table reading guides',()=>{
  it('resolves the logical row and column without reading or changing content',()=>{const editor=fixture(),positions=cells(editor),before=editor.getJSON();editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(positions[3]+1))));const guides=tableReadingGuideCells(editor.state)!;expect(guides.tableStart).toBe(1);expect(guides.row).toHaveLength(2);expect(guides.column).toHaveLength(2);expect(guides.row.filter(position=>guides.column.includes(position))).toHaveLength(1);expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);});
  it('treats merged cells and ranges deterministically',()=>{const editor=fixture(true),positions=cells(editor);editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc,positions[0],positions.at(-1)!)));const guides=tableReadingGuideCells(editor.state)!;expect(guides.row).toEqual([...new Set(guides.row)]);expect(guides.column).toEqual([...new Set(guides.column)]);expect(guides.row.length).toBe(5);expect(guides.column.length).toBe(5);});
  it('toggles presentation metadata with zero selection, document or history changes and clears outside tables',()=>{const editor=fixture(),position=cells(editor)[0],before=editor.getJSON();editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position+1))));const selection=editor.state.selection.toJSON();setTableReadingGuides(editor,true);expect(tableReadingGuidesKey.getState(editor.state)).toBe(true);expect(editor.state.selection.toJSON()).toEqual(selection);expect(editor.view.dom.querySelectorAll('[data-hs-table-guide=true]').length).toBeGreaterThan(0);setTableReadingGuides(editor,false);expect(tableReadingGuidesKey.getState(editor.state)).toBe(false);expect(editor.state.selection.toJSON()).toEqual(selection);expect(editor.view.dom.querySelectorAll('[data-hs-table-guide=true]')).toHaveLength(0);expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);const after=editor.state.doc.content.size-2;editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(after))));expect(tableReadingGuideCells(editor.state)).toBeNull();});
});
