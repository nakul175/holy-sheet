// @vitest-environment jsdom
import { afterEach,describe,it,expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { applyRemoteDocument } from '../components/editor/history-boundary';
const editors:Editor[]=[];
afterEach(()=>editors.splice(0).forEach(e=>e.destroy()));
describe('remote document undo boundary',()=>{
  it('preserves undo on an unchanged acknowledgement and clears inverses across changed remote content',()=>{
    const e=new Editor({element:document.createElement('div'),extensions:[StarterKit.configure({trailingNode:false})],content:'<p>Base</p>'});editors.push(e);e.commands.insertContent('Local');expect(e.can().undo()).toBe(true);expect(applyRemoteDocument(e,e.getJSON())).toBe(false);expect(e.can().undo()).toBe(true);
    const remote={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Another editor saved this'}]}]};expect(applyRemoteDocument(e,remote)).toBe(true);expect(e.can().undo()).toBe(false);e.commands.insertContent('New local');expect(e.can().undo()).toBe(true);e.commands.undo();expect(e.getText()).toBe('Another editor saved this');
  });
});
