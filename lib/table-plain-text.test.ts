// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {TableKit} from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {escapeTablePlainText,serializeTablePlainText} from '../components/editor/table-plain-text';
import {selectedTable} from '../components/editor/table-actions';

const editors:Editor[]=[];afterEach(()=>editors.splice(0).forEach(editor=>editor.destroy()));
const text=(value:string)=>({type:'text',text:value});
const paragraph=(...content:ReturnType<typeof text>[])=>({type:'paragraph',content});
function editor(content:unknown){const subject=new Editor({element:document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TableKit,TaskList,TaskItem.configure({nested:true})],content:content as never});editors.push(subject);return subject;}

describe('plain-text table serializer',()=>{
  it('produces deterministic TSV and escapes only cell-breaking characters',()=>{
    const subject=editor({type:'doc',content:[{type:'table',content:[
      {type:'tableRow',content:[{type:'tableHeader',content:[paragraph(text('Name'))]},{type:'tableHeader',content:[paragraph(text('Notes'))]}]},
      {type:'tableRow',content:[{type:'tableCell',content:[paragraph(text('表 👋'))]},{type:'tableCell',content:[paragraph(text('tab\there')),paragraph(text('line\\end'))]}]},
    ]}]});const table=subject.state.doc.firstChild!;
    expect(serializeTablePlainText(table)).toBe('Name\tNotes\n表 👋\ttab\\there\\nline\\\\end');
    expect(serializeTablePlainText(table)).toBe(serializeTablePlainText(table));
    expect(escapeTablePlainText('a\r\nb\tc\\d')).toBe('a\\nb\\tc\\\\d');
  });

  it('emits merged text once, empty covered coordinates and defined checklist text',()=>{
    const subject=editor({type:'doc',content:[{type:'table',content:[
      {type:'tableRow',content:[{type:'tableHeader',attrs:{colspan:2,rowspan:1},content:[paragraph(text('Wide'))]},{type:'tableHeader',content:[paragraph(text('Third'))]}]},
      {type:'tableRow',content:[{type:'tableCell',attrs:{colspan:1,rowspan:2},content:[{type:'taskList',content:[{type:'taskItem',attrs:{checked:true},content:[paragraph(text('Done'))]},{type:'taskItem',attrs:{checked:false},content:[paragraph(text('Next'))]}]}]},{type:'tableCell',content:[paragraph(text('B'))]},{type:'tableCell',content:[paragraph(text('C'))]}]},
      {type:'tableRow',content:[{type:'tableCell',content:[paragraph(text('D'))]},{type:'tableCell',content:[paragraph(text('E'))]}]},
    ]}]});
    expect(serializeTablePlainText(subject.state.doc.firstChild!)).toBe('Wide\t\tThird\n[x] Done\\n[ ] Next\tB\tC\n\tD\tE');
  });

  it('bounds and serializes the supported 100 by 20 table without scanning siblings',()=>{
    const rows=Array.from({length:100},(_,row)=>({type:'tableRow',content:Array.from({length:20},(_,column)=>({type:'tableCell',content:[paragraph(text(`${row}:${column}`))]}))}));
    const subject=editor({type:'doc',content:[{type:'paragraph',content:[text('Private sibling')]},{type:'table',content:rows}]});
    const table=subject.state.doc.child(1),started=performance.now(),result=serializeTablePlainText(table);
    expect(result.split('\n')).toHaveLength(100);expect(result.split('\n')[0].split('\t')).toHaveLength(20);expect(result).not.toContain('Private sibling');expect(performance.now()-started).toBeLessThan(1000);
  });

  it('reuses immutable table identity across repeated caret moves without serializing the large table',()=>{
    const rows=Array.from({length:100},(_,row)=>({type:'tableRow',content:Array.from({length:20},(_,column)=>({type:'tableCell',content:[paragraph(text(`${row}:${column}`))]}))})),subject=editor({type:'doc',content:[{type:'table',content:rows},{type:'paragraph',content:[text('After')]}]}),table=subject.state.doc.firstChild!,toJSON=vi.spyOn(table,'toJSON'),positions:number[]=[];
    subject.state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&positions.length<100)positions.push(pos+1);});
    for(const position of positions){subject.commands.setTextSelection(position);expect(selectedTable(subject)?.node).toBe(table);}
    expect(positions).toHaveLength(100);expect(toJSON).not.toHaveBeenCalled();
  });
});
