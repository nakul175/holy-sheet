// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createElement,act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {UncheckedNavigationControls} from '../components/editor/unchecked-navigation-controls';
import {createUncheckedListReader,UNCHECKED_NAVIGATION_META} from '../components/editor/unchecked-navigation';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|null=null,editor:Editor|null=null;
afterEach(async()=>{await act(async()=>root?.unmount());editor?.destroy();document.body.replaceChildren();vi.restoreAllMocks();});
function fixture(){
  const host=document.createElement('div'),content=document.createElement('div');document.body.append(host,content);
  editor=new Editor({element:content,extensions:[StarterKit,TaskList,TaskItem],content:{type:'doc',content:[{type:'taskList',content:['A','B'].map(text=>({type:'taskItem',attrs:{checked:false},content:[{type:'paragraph',content:[{type:'text',text}]}]}))}]}});
  root=createRoot(host);vi.stubGlobal('matchMedia',()=>({matches:true}));Element.prototype.scrollIntoView=vi.fn();return {host,editor,list:createUncheckedListReader()(editor.state)!};
}
it('dispatches selection-only, addToHistory false, no document update under existing viewer access',async()=>{const f=fixture();f.editor.setEditable(false);let updates=0;const transactions:{changed:boolean;meta:unknown;history:unknown}[]=[];f.editor.on('update',()=>updates++);f.editor.on('transaction',({transaction})=>transactions.push({changed:transaction.docChanged,meta:transaction.getMeta(UNCHECKED_NAVIGATION_META),history:transaction.getMeta('addToHistory')}));const before=f.editor.getJSON();await act(async()=>root!.render(createElement(UncheckedNavigationControls,{...f,preferenceKey:'test'})));await act(async()=>(f.host.querySelectorAll('button')[1] as HTMLButtonElement).click());expect(f.editor.state.selection.$head.parent.textContent).toBe('B');expect(transactions).toEqual([{changed:false,meta:true,history:false}]);expect(updates).toBe(0);expect(f.editor.getJSON()).toEqual(before);expect(f.editor.can().undo()).toBe(false);expect(f.editor.isEditable).toBe(false);});
it('rejects a rendered stale list after removal without transaction, and clears notices on context reset',async()=>{const f=fixture();await act(async()=>root!.render(createElement(UncheckedNavigationControls,{...f,preferenceKey:'test'})));f.editor.commands.setContent('<p>Replacement</p>');let count=0;f.editor.on('transaction',()=>count++);await act(async()=>(f.host.querySelectorAll('button')[1] as HTMLButtonElement).click());expect(count).toBe(0);expect(f.host.textContent).toContain('The checklist changed.');await act(async()=>root!.render(createElement(UncheckedNavigationControls,{editor:f.editor,list:null,preferenceKey:'next'})));expect(f.host.textContent).toBe('');});

it('preserves a document ending in a checklist with the real trailing-node plugin enabled',async()=>{const f=fixture();const before=f.editor.getJSON();expect(before.content?.at(-1)?.type).toBe('taskList');await act(async()=>root!.render(createElement(UncheckedNavigationControls,{...f,preferenceKey:'test'})));await act(async()=>(f.host.querySelectorAll('button')[1] as HTMLButtonElement).click());expect(f.editor.state.selection.$head.parent.textContent).toBe('B');expect(f.editor.getJSON()).toEqual(before);expect(f.editor.can().undo()).toBe(false);});
