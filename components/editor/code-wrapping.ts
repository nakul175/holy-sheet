import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState } from '@tiptap/pm/state';

type WrapState={scope:string;wrapped:ReadonlySet<string>};
type WrapMeta={type:'reset';scope:string}|{type:'toggle';scope:string;id:string};

export const codeWrappingKey=new PluginKey<WrapState>('hs-code-wrapping');

function decorations(editorState:EditorState,state:WrapState){
  const result:Decoration[]=[];
  editorState.doc.descendants((node,pos)=>{
    if(node.type.name!=='codeBlock'||typeof node.attrs.id!=='string')return;
    const id=node.attrs.id,wrapped=state.wrapped.has(id);
    result.push(Decoration.node(pos,pos+node.nodeSize,wrapped
      ? {'data-code-wrap':'wrap','aria-label':'Code block, long lines wrapped'}
      : {'data-code-wrap':'preserve','aria-label':'Code block, horizontal scrolling','tabindex':'0'}));
    result.push(Decoration.widget(pos,view=>{
      const controls=document.createElement('div');
      controls.className='code-wrap-control';
      controls.contentEditable='false';
      const button=document.createElement('button');
      button.type='button';
      button.dataset.codeWrapId=id;
      button.setAttribute('aria-label',`${wrapped?'Preserve':'Wrap'} lines for code block`);
      button.setAttribute('aria-pressed',String(wrapped));
      button.textContent=wrapped?'Preserve lines':'Wrap long lines';
      const activate=()=>{
        view.dispatch(view.state.tr.setMeta(codeWrappingKey,{type:'toggle',scope:state.scope,id} satisfies WrapMeta).setMeta('addToHistory',false));
        queueMicrotask(()=>view.dom.querySelector<HTMLButtonElement>(`button[data-code-wrap-id="${CSS.escape(id)}"]`)?.focus());
      };
      button.addEventListener('mousedown',event=>event.stopPropagation());
      button.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();activate();
      });
      button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();activate();}});
      controls.append(button);return controls;
    },{key:`code-wrap:${state.scope}:${id}:${wrapped}`,side:-1,ignoreSelection:true}));
  });
  return DecorationSet.create(editorState.doc,result);
}

export const CodeWrapping=Extension.create<{scope:string}>({
  name:'codeWrapping',
  addOptions:()=>({scope:''}),
  addProseMirrorPlugins(){
    const initialScope=this.options.scope;
    return [new Plugin<WrapState>({
      key:codeWrappingKey,
      state:{
        init:()=>({scope:initialScope,wrapped:new Set()}),
        apply(transaction,previous){
          const meta=transaction.getMeta(codeWrappingKey) as WrapMeta|undefined;
          if(meta?.type==='reset')return meta.scope===previous.scope?previous:{scope:meta.scope,wrapped:new Set()};
          const valid=new Set<string>();transaction.doc.descendants(node=>{if(node.type.name==='codeBlock'&&typeof node.attrs.id==='string')valid.add(node.attrs.id);});
          const wrapped=new Set([...previous.wrapped].filter(id=>valid.has(id)));
          if(meta?.type==='toggle'&&meta.scope===previous.scope&&valid.has(meta.id)){wrapped.has(meta.id)?wrapped.delete(meta.id):wrapped.add(meta.id);}
          return wrapped.size===previous.wrapped.size&&[...wrapped].every(id=>previous.wrapped.has(id))?previous:{...previous,wrapped};
        },
      },
      props:{decorations(state){const current=codeWrappingKey.getState(state);return current?decorations(state,current):null;}},
    })];
  },
});

export function resetCodeWrapping(editor:Editor,scope:string){
  editor.view.dispatch(editor.state.tr.setMeta(codeWrappingKey,{type:'reset',scope} satisfies WrapMeta).setMeta('addToHistory',false));
}
