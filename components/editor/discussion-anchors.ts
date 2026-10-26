import { Extension } from '@tiptap/core';
import { Plugin,PluginKey } from '@tiptap/pm/state';
import { Decoration,DecorationSet } from '@tiptap/pm/view';
import type { Node } from '@tiptap/pm/model';
import type { ThreadView } from '../../lib/discussion-types';

type State={threads:ThreadView[];activeId:string|null;decorations:DecorationSet};
export const discussionKey=new PluginKey<State>('holy-discussion-anchors');
function decorations(doc:Node,threads:ThreadView[],activeId:string|null,onOpen:(id:string)=>void){
  const blocks=new Map<string,{pos:number;node:Node}>();doc.descendants((node,pos)=>{if(node.isTextblock&&node.attrs.id)blocks.set(node.attrs.id,{pos,node});});
  const values:Decoration[]=[];
  for(const thread of threads)for(const anchor of thread.anchors){
    const block=blocks.get(anchor.blockId);if(anchor.status!=='attached'||!block||anchor.end>block.node.content.size||block.node.textBetween(anchor.start,anchor.end,'','\n')!==anchor.quote)continue;
    const from=block.pos+1+anchor.start,to=block.pos+1+anchor.end;
    if(thread.id===activeId)values.push(Decoration.inline(from,to,{class:'discussion-passage-active'}));
    values.push(Decoration.widget(to,()=>{const button=document.createElement('button');button.type='button';button.className='discussion-marker';button.contentEditable='false';button.textContent='◌';button.setAttribute('aria-label','Open discussion for this passage');button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();onOpen(thread.id);});return button;},{side:1,key:`discussion:${thread.id}:${anchor.blockId}:${anchor.start}`}));
  }
  return DecorationSet.create(doc,values);
}
export const DiscussionAnchors=Extension.create<{onOpen:(id:string)=>void}>({
  name:'holyDiscussionAnchors',addOptions(){return {onOpen:()=>{}};},
  addProseMirrorPlugins(){const onOpen=this.options.onOpen;return [new Plugin<State>({key:discussionKey,state:{init:()=>({threads:[],activeId:null,decorations:DecorationSet.empty}),apply(tr,old){const meta=tr.getMeta(discussionKey) as Partial<State>|undefined;if(!meta&&!tr.docChanged)return old;const threads=meta?.threads??old.threads,activeId=meta&&'activeId' in meta?meta.activeId??null:old.activeId;return {threads,activeId,decorations:decorations(tr.doc,threads,activeId,onOpen)};}},props:{decorations:state=>discussionKey.getState(state)?.decorations}})];},
});
