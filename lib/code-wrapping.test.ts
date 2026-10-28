// @vitest-environment jsdom
import { afterEach,describe,expect,it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { CodeWrapping,codeWrappingKey,resetCodeWrapping } from '../components/editor/code-wrapping';
import { LazyCodeBlock } from '../components/editor/lazy-code-highlight';

const editors:Editor[]=[];
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());document.body.replaceChildren();});

function setup(scope='actor-a:page-a'){
  const host=document.createElement('div');document.body.append(host);
  const editor=new Editor({element:host,extensions:[StarterKit.configure({codeBlock:false,trailingNode:false}),LazyCodeBlock,UniqueID.configure({types:['codeBlock'],attributeName:'id'}),CodeWrapping.configure({scope})],content:{type:'doc',content:[{type:'codeBlock',attrs:{id:'code-a',language:'plaintext'},content:[{type:'text',text:'const long = "😀";\n\t  exact'}]},{type:'codeBlock',attrs:{id:'code-b',language:'plaintext'},content:[{type:'text',text:'second'}]}]}});editors.push(editor);return {editor,host};
}

describe('personal code-block wrapping',()=>{
  it('renders an accessible independent toggle for every stable block without changing source or history',()=>{
    const {editor,host}=setup(),before=editor.getJSON(),buttons=host.querySelectorAll<HTMLButtonElement>('[data-code-wrap-id]');
    expect(buttons).toHaveLength(2);expect(buttons[0].textContent).toBe('Wrap long lines');expect(buttons[0].getAttribute('aria-pressed')).toBe('false');expect(host.querySelector('pre')?.tabIndex).toBe(0);
    buttons[0].click();expect(host.querySelector('pre[data-code-wrap=wrap]')).not.toBeNull();expect(host.querySelector('button[data-code-wrap-id="code-a"]')?.textContent).toBe('Preserve lines');
    expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);expect(editor.state.selection.from).toBe(1);
  });

  it('activates from the keyboard without the editor consuming Enter',()=>{
    const {host}=setup(),button=host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-a"]')!;
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    expect(host.querySelector('pre[data-code-wrap=wrap]')).not.toBeNull();expect(host.querySelector('[aria-pressed=true]')).not.toBeNull();
  });

  it('preserves Unicode, tabs, newlines, language and highlighted DOM text exactly in both modes',()=>{
    const {editor,host}=setup(),text='const long = "😀";\n\t  exact',pre=host.querySelector('pre')!;
    expect(pre.textContent).toBe(text);expect(pre.getAttribute('data-language')).toBe('plaintext');host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-a"]')!.click();
    const json=editor.getJSON() as {content?:Array<{content?:Array<{text?:string}>}>};
    expect(pre.textContent).toBe(text);expect(editor.getAttributes('codeBlock').language).toBe('plaintext');expect(json.content?.[0].content?.[0].text).toBe(text);
  });

  it('clears choices when the page or actor scope changes',()=>{
    const {editor,host}=setup();host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-a"]')!.click();expect(codeWrappingKey.getState(editor.state)?.wrapped.has('code-a')).toBe(true);
    resetCodeWrapping(editor,'actor-b:page-a');const state=codeWrappingKey.getState(editor.state)!;expect(state.scope).toBe('actor-b:page-a');expect(state.wrapped).toEqual(new Set());expect(host.querySelector('pre[data-code-wrap=wrap]')).toBeNull();
  });

  it('prunes deleted IDs and keeps the preference attached across reorder',()=>{
    const {editor,host}=setup();host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-b"]')!.click();
    const first=editor.state.doc.child(0),second=editor.state.doc.child(1);
    editor.view.dispatch(editor.state.tr.replaceWith(0,editor.state.doc.content.size,[second,first]));
    expect(editor.state.doc.child(0).attrs.id).toBe('code-b');expect(codeWrappingKey.getState(editor.state)?.wrapped.has('code-b')).toBe(true);
    editor.view.dispatch(editor.state.tr.delete(0,editor.state.doc.child(0).nodeSize));
    expect(codeWrappingKey.getState(editor.state)?.wrapped.has('code-b')).toBe(false);expect(editor.getJSON().content).toHaveLength(1);
  });

  it('does not add operations during rapid toggles or large plain-render fallback',()=>{
    const {editor,host}=setup(),before=editor.getJSON(),button=()=>host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-a"]')!;
    for(let index=0;index<50;index++)button().click();expect(editor.getJSON()).toEqual(before);expect(editor.can().undo()).toBe(false);expect(codeWrappingKey.getState(editor.state)?.wrapped.size).toBe(0);
  });

  it('caches decorations across selection-only work with 1,000 code blocks and invalidates only on document or wrap changes',()=>{
    const host=document.createElement('div');document.body.append(host);
    const content=Array.from({length:1_000},(_,index)=>({type:'codeBlock',attrs:{id:`code-${index}`,language:'plaintext'},content:[{type:'text',text:`const value${index} = "${'x'.repeat(80)}";`}]}));
    const editor=new Editor({element:host,extensions:[StarterKit.configure({codeBlock:false,trailingNode:false}),LazyCodeBlock,UniqueID.configure({types:['codeBlock'],attributeName:'id'}),CodeWrapping.configure({scope:'actor:large-page'})],content:{type:'doc',content}});editors.push(editor);
    const initial=codeWrappingKey.getState(editor.state)!;
    const started=performance.now();
    for(let index=0;index<100;index++)editor.commands.setTextSelection(index%2?1:2);
    const selected=codeWrappingKey.getState(editor.state)!;
    expect(selected).toBe(initial);expect(selected.decorations).toBe(initial.decorations);expect(performance.now()-started).toBeLessThan(1_000);
    host.querySelector<HTMLButtonElement>('[data-code-wrap-id="code-500"]')!.click();
    const toggled=codeWrappingKey.getState(editor.state)!;expect(toggled.decorations).not.toBe(initial.decorations);expect(toggled.wrapped.has('code-500')).toBe(true);
    editor.commands.insertContentAt(2,'x');
    expect(codeWrappingKey.getState(editor.state)!.decorations).not.toBe(toggled.decorations);
  });
});
