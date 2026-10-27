// @vitest-environment jsdom
import { describe,it,expect,afterEach,vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import { ensureIds,idTypes,plainText,type RichNode } from './document';
import { handleTableKeyDown,leaveBlock,reorderTable } from '../components/editor/table-actions';
import { TextSelection } from '@tiptap/pm/state';

const editors:Editor[]=[];
afterEach(()=>{editors.splice(0).forEach(e=>e.destroy());});
function table(rows=2){
  const cell=(text:string)=>({type:'tableCell',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  const document=ensureIds({type:'doc',content:[{type:'table',content:Array.from({length:rows},(_,i)=>({type:'tableRow',content:[cell(String.fromCharCode(65+i*2)),cell(String.fromCharCode(66+i*2))]}))}]});
  const e=new Editor({element:window.document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TableKit,UniqueID.configure({types:idTypes})],content:document});editors.push(e);
  let from=0;e.state.doc.descendants((n,pos)=>{if(n.isText&&n.text==='A')from=pos;});e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,from)));return e;
}
describe('table editing transactions',()=>{
  it('moves a row and column without changing identities and undoes both moves',()=>{
    const e=table(),before=e.getJSON();const ids=(d:RichNode):string[]=>[String(d.attrs?.id??''),...(d.content??[]).flatMap(ids)].filter(Boolean).sort();
    expect(reorderTable(e,'row',1)).toBe(true);expect(plainText(e.getJSON() as RichNode)).toBe('C\nD\nA\nB');
    expect(reorderTable(e,'column',1)).toBe(true);expect(plainText(e.getJSON() as RichNode)).toBe('D\nC\nB\nA');expect(ids(e.getJSON() as RichNode)).toEqual(ids(before as RichNode));
    e.commands.undo();expect(plainText(e.getJSON() as RichNode)).toBe('C\nD\nA\nB');e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
  it('does not mutate at a table boundary and provides an undoable exit paragraph',()=>{
    const e=table(),before=e.getJSON();expect(reorderTable(e,'row',-1)).toBe(false);expect(e.getJSON()).toEqual(before);
    expect(leaveBlock(e,'table')).toBe(true);expect(e.state.selection.$from.parent.type.name).toBe('paragraph');expect(e.state.doc.childCount).toBe(2);e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
  it('Escape focuses tools without changing content or Undo, including read-only mode',()=>{
    const e=table(),before=e.getJSON(),focus=vi.fn(),announce=vi.fn();
    for(const editable of [true,false]){e.setEditable(editable);const key=new KeyboardEvent('keydown',{key:'Escape',cancelable:true});expect(handleTableKeyDown(e,key,focus,announce)).toBe(true);expect(key.defaultPrevented).toBe(true);expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);}
    expect(focus).toHaveBeenCalledTimes(2);
  });
  it.each(['ctrlKey','metaKey'] as const)('supports %s+Enter as a one-step undoable continuation',modifier=>{
    const e=table(),before=e.getJSON(),key=new KeyboardEvent('keydown',{key:'Enter',[modifier]:true,cancelable:true});
    expect(handleTableKeyDown(e,key,vi.fn(),vi.fn())).toBe(true);expect(key.defaultPrevented).toBe(true);expect(e.state.selection.$from.parent.type.name).toBe('paragraph');expect(e.state.selection.$from.depth).toBe(1);expect(e.state.doc.firstChild?.toJSON()).toEqual(before.content![0]);e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
  it('never grows beyond 100 rows and announces the final-cell Tab exit',()=>{
    const e=table(100),before=e.getJSON();let pos=0;e.state.doc.descendants((n,p)=>{if(n.type.name==='tableCell')pos=p+2;});e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,pos)));const announce=vi.fn(),key=new KeyboardEvent('keydown',{key:'Tab',cancelable:true});
    expect(handleTableKeyDown(e,key,vi.fn(),announce)).toBe(true);expect(announce).toHaveBeenCalledWith('Maximum 100 rows reached. Continued below the table.');expect(e.state.doc.firstChild!.childCount).toBe(100);expect(e.state.doc.firstChild!.toJSON()).toEqual(before.content![0]);expect(e.state.selection.$from.depth).toBe(1);e.commands.undo();expect(e.getJSON()).toEqual(before);
  });
  it('preserves ordinary Tab, Shift+Tab, IME and browser modifier combinations',()=>{
    const e=table(),before=e.getJSON();for(const options of [{key:'Tab'},{key:'Tab',shiftKey:true},{key:'Tab',ctrlKey:true},{key:'Enter',ctrlKey:true,isComposing:true},{key:'Enter',ctrlKey:true,shiftKey:true},{key:'Escape',altKey:true}]){const key=new KeyboardEvent('keydown',{...options,cancelable:true});expect(handleTableKeyDown(e,key,vi.fn(),vi.fn())).toBe(false);expect(key.defaultPrevented).toBe(false);}expect(e.getJSON()).toEqual(before);
  });
  it('refuses read-only continuation/reorder and leaves existing following text intact',()=>{
    const e=table();e.commands.insertContentAt(e.state.doc.content.size,{type:'paragraph',content:[{type:'text',text:'After table'}]});e.commands.setTextSelection(4);const before=e.getJSON();e.setEditable(false);expect(handleTableKeyDown(e,new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true}),vi.fn(),vi.fn())).toBe(false);expect(leaveBlock(e,'table')).toBe(false);expect(reorderTable(e,'row',1)).toBe(false);expect(e.getJSON()).toEqual(before);e.setEditable(true);expect(leaveBlock(e,'table')).toBe(true);expect(e.getJSON()).toEqual(before);expect(e.state.selection.$from.parent.textContent).toBe('After table');
  });
  it('does not merge a structural table command with preceding or following typing',()=>{
    for(const action of ['reorder','continue'] as const){const e=table();e.commands.insertContent('!');const typed=e.getJSON();if(action==='reorder')reorderTable(e,'row',1);else leaveBlock(e,'table');const structural=e.getJSON();e.commands.insertContent('?');e.commands.undo();expect(e.getJSON()).toEqual(structural);e.commands.undo();expect(e.getJSON()).toEqual(typed);}
  });
});
