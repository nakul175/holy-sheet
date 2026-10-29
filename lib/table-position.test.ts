// @vitest-environment jsdom
import { afterEach,describe,expect,it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { CellSelection,TableMap } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import { tablePosition,tablePositionKey,tablePositionText } from '../components/editor/table-position';

const editors:Editor[]=[];afterEach(()=>editors.splice(0).forEach(editor=>editor.destroy()));
const paragraph=(text:string)=>({type:'paragraph',content:[{type:'text',text}]});
function fixture(merged=false){
  const cell=(type:string,text:string,attrs={})=>({type,attrs:{colspan:1,rowspan:1,...attrs},content:[paragraph(text)]});
  const content=merged?[{type:'tableRow',content:[cell('tableHeader','A',{colspan:2}),cell('tableHeader','B')]},{type:'tableRow',content:[cell('tableCell','C'),cell('tableCell','D'),cell('tableCell','E')]}]:[{type:'tableRow',content:[cell('tableHeader','A'),cell('tableHeader','B')]},{type:'tableRow',content:[cell('tableCell','C'),cell('tableCell','D')]}];
  const editor=new Editor({element:document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TableKit],content:{type:'doc',content:[{type:'table',content},{type:'paragraph',content:[{type:'text',text:'After'}]}]}});editors.push(editor);return editor;
}
function cellPositions(editor:Editor){const table=editor.state.doc.firstChild!,map=TableMap.get(table);return map.cellsInRect({left:0,top:0,right:map.width,bottom:map.height}).map(pos=>pos+1);}
describe('accessible table position',()=>{
  it('reports rectangular header and body cells without reading content or mutating history',()=>{const editor=fixture(),before=editor.getJSON(),positions=cellPositions(editor);editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(positions[0]+1))));const header=tablePosition(editor.state);expect(header).toMatchObject({rows:2,columns:2,fromRow:1,toRow:1,fromColumn:1,toColumn:1,selectedCells:1,cellKind:'header'});expect(tablePositionText(header)).toBe('Table 2 rows by 2 columns. Header cell, row 1 of 2, column 1 of 2.');editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(positions[3]+1))));expect(tablePosition(editor.state)).toMatchObject({fromRow:2,fromColumn:2,cellKind:'body'});expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);});
  it('uses logical merged-cell coordinates and unique range cell counts',()=>{const editor=fixture(true),positions=cellPositions(editor);editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(positions[0]+1))));expect(tablePosition(editor.state)).toMatchObject({rows:2,columns:3,fromRow:1,toRow:1,fromColumn:1,toColumn:2,selectedCells:1,cellKind:'header'});editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc,positions[0],positions.at(-1)!)));const range=tablePosition(editor.state);expect(range).toMatchObject({fromRow:1,toRow:2,fromColumn:1,toColumn:3,selectedCells:5,cellKind:'mixed'});expect(tablePositionText(range)).toContain('5 header and body cells');});
  it('returns stable keys through typing and clears outside the table',()=>{const editor=fixture(),position=cellPositions(editor)[2];editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position+1))));const before=tablePositionKey(tablePosition(editor.state));editor.commands.insertContent('!');expect(tablePositionKey(tablePosition(editor.state))).toBe(before);const after=editor.state.doc.content.size-2;editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(after))));expect(tablePosition(editor.state)).toBeNull();expect(tablePositionText(null)).toBe('');});
});
