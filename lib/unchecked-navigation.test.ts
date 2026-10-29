// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Editor,type JSONContent} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {NodeSelection,TextSelection} from '@tiptap/pm/state';
import {createUncheckedListReader,uncheckedListText,uncheckedTarget,UNCHECKED_LIST_MAX_UNITS} from '../components/editor/unchecked-navigation';

const editors:Editor[]=[];afterEach(()=>editors.splice(0).forEach(e=>e.destroy()));
const paragraph=(text='')=>({type:'paragraph',content:text?[{type:'text',text}]:[]});
const item=(text:string,checked=false,nested:JSONContent[]=[])=>({type:'taskItem',attrs:{checked},content:[paragraph(text),...nested]});
const list=(content:JSONContent[])=>({type:'taskList',content});
function fixture(content:JSONContent[]=[list([item('A'),item('B',true),item('C',false,[list([item('D'),item('E',true)])]),item('F')]),list([item('other')]),paragraph('after')]){
  const editor=new Editor({element:document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false}),TaskList,TaskItem.configure({nested:true})],content:{type:'doc',content}});editors.push(editor);return editor;
}
function position(e:Editor,text:string){let result=-1;e.state.doc.descendants((n,p)=>{if(n.isText&&n.text===text)result=p;});return result;}
function select(e:Editor,from:number,to=from){e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc,from,to)));}
describe('nearest-list unchecked navigation',()=>{
  it('indexes nested eligible items once, ordered and excluding checked items',()=>{const e=fixture();select(e,position(e,'A'));const value=createUncheckedListReader()(e.state)!;expect(value.positions.map(p=>e.state.doc.resolve(value.start+p.target).parent.textContent)).toEqual(['A','C','D','F']);expect(value.current).toBe(0);expect(value.previous).toBeNull();expect(value.next).toBe(position(e,'C'));});
  it('uses the nearest nested list and never crosses unrelated lists',()=>{const e=fixture(),read=createUncheckedListReader();select(e,position(e,'D'));const inner=read(e.state)!;expect(inner.positions).toHaveLength(1);expect(inner.next).toBeNull();select(e,position(e,'other'));expect(read(e.state)?.positions).toHaveLength(1);});
  it('finds adjacent items from checked text and end boundaries without wrapping',()=>{const e=fixture(),read=createUncheckedListReader();select(e,position(e,'B'));let value=read(e.state)!;expect(value.current).toBeNull();expect(value.previous).toBe(position(e,'A'));expect(value.next).toBe(position(e,'C'));select(e,position(e,'F')+1);value=read(e.state)!;expect(value.current).toBe(3);expect(value.next).toBeNull();expect(uncheckedListText(value)).toBe('Unchecked item 4 of 4.');});
  it('reports all checked lists honestly, without changing checkboxes or history',()=>{const e=fixture([list([item('done',true)])]);select(e,position(e,'done'));const before=e.getJSON(),v=createUncheckedListReader()(e.state)!;expect(uncheckedListText(v)).toBe('No unchecked items in this checklist.');expect(v.next).toBeNull();expect(v.previous).toBeNull();expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);});
  it('suppresses node/mixed selections and clears cache when leaving a list',()=>{const e=fixture(),read=createUncheckedListReader();select(e,position(e,'A'),position(e,'C'));expect(read(e.state)).not.toBeNull();select(e,position(e,'A'),position(e,'after'));expect(read(e.state)).toBeNull();e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc,0)));expect(read(e.state)).toBeNull();select(e,position(e,'after'));expect(read(e.state)).toBeNull();});
  it('reuses a single immutable list index through caret movement',()=>{const e=fixture(),read=createUncheckedListReader();select(e,position(e,'A'));const a=read(e.state)!;select(e,position(e,'B'));const spy=vi.spyOn(a.node,'child');const b=read(e.state)!;expect(b.positions).toBe(a.positions);expect(spy).not.toHaveBeenCalled();spy.mockRestore();});
  it('rejects stale targets after editing or list removal',()=>{const e=fixture();select(e,position(e,'A'));const read=createUncheckedListReader(),old=read(e.state)!;expect(uncheckedTarget(e.state,old,'next')).toBe(position(e,'C'));e.commands.insertContent('!');expect(uncheckedTarget(e.state,old,'next')).toBeNull();e.commands.setContent({type:'doc',content:[paragraph('replacement')]});expect(read(e.state)).toBeNull();expect(uncheckedTarget(e.state,old,'next')).toBeNull();});
  it('retains exact model and Undo under read-only selection navigation',()=>{const e=fixture();e.setEditable(false);select(e,position(e,'A'));const before=e.getJSON(),read=createUncheckedListReader(),value=read(e.state)!;select(e,uncheckedTarget(e.state,value,'next')!);expect(e.getJSON()).toEqual(before);expect(e.can().undo()).toBe(false);expect(e.isEditable).toBe(false);});
  it('applies strict true checked semantics',()=>{const e=fixture([list([item('yes',true),{...item('false-ish'),attrs:{checked:'true'}}])]);select(e,position(e,'yes'));expect(createUncheckedListReader()(e.state)?.positions).toHaveLength(1);});
  it('refuses over-budget lists without partial invented counts',()=>{const e=fixture([list([item('x'.repeat(UNCHECKED_LIST_MAX_UNITS+1))])]);select(e,3);const v=createUncheckedListReader()(e.state)!;expect(v.limited).toBe(true);expect(v.positions).toEqual([]);expect(v.next).toBeNull();expect(uncheckedListText(v)).toContain('too large');});
  it('bounds node work for very large empty-item lists',()=>{const e=fixture([list(Array.from({length:6000},()=>item('')))]);select(e,3);const v=createUncheckedListReader()(e.state)!;expect(v.limited).toBe(true);expect(v.positions).toEqual([]);});
});
