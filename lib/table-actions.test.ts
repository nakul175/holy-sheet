// @vitest-environment jsdom
import { describe,it,expect,afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import { ensureIds,idTypes,plainText,type RichNode } from './document';
import { leaveBlock,reorderTable } from '../components/editor/table-actions';
import { TextSelection } from '@tiptap/pm/state';

const editors:Editor[]=[];
afterEach(()=>{editors.splice(0).forEach(e=>e.destroy());});
function table(){
  const cell=(text:string)=>({type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  const document=ensureIds({type:'doc',content:[{type:'table',content:[{type:'tableRow',content:[cell('A'),cell('B')]},{type:'tableRow',content:[cell('C'),cell('D')]}]}]});
  const e=new Editor({element:window.document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TableKit,UniqueID.configure({types:idTypes})],content:document});editors.push(e);
  let from=0;e.state.doc.descendants((n,pos)=>{if(n.isText&&n.text==='A')from=pos;});e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,from)));return e;
}
describe('table editing transactions',()=>{
  it('moves a row and column without changing identities and undoes both moves',()=>{
    const e=table(),before=e.getJSON();const ids=(d:RichNode):string[]=>[String(d.attrs?.id??''),...(d.content??[]).flatMap(ids)].filter(Boolean).sort();
    expect(reorderTable(e,'row',1)).toBe(true);expect(plainText(e.getJSON() as RichNode)).toBe('C\nD\nA\nB');
    expect(reorderTable(e,'column',1)).toBe(true);expect(plainText(e.getJSON() as RichNode)).toBe('D\nC\nB\nA');expect(ids(e.getJSON() as RichNode)).toEqual(ids(before as RichNode));
    e.commands.undo();e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
  it('does not mutate at a table boundary and provides an undoable exit paragraph',()=>{
    const e=table(),before=e.getJSON();expect(reorderTable(e,'row',-1)).toBe(false);expect(e.getJSON()).toEqual(before);
    expect(leaveBlock(e,'table')).toBe(true);expect(e.state.selection.$from.parent.type.name).toBe('paragraph');expect(e.state.doc.childCount).toBe(2);e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
});
