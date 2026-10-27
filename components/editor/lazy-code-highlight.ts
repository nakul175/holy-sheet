import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Plugin,PluginKey } from '@tiptap/pm/state';
import { Decoration,DecorationSet,type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { createLowlight } from 'lowlight';
import type { LanguageFn } from 'highlight.js';

const loaders:Record<string,()=>Promise<{default:LanguageFn}>>={
 bash:()=>import('highlight.js/lib/languages/bash'),javascript:()=>import('highlight.js/lib/languages/javascript'),typescript:()=>import('highlight.js/lib/languages/typescript'),json:()=>import('highlight.js/lib/languages/json'),html:()=>import('highlight.js/lib/languages/xml'),css:()=>import('highlight.js/lib/languages/css'),sql:()=>import('highlight.js/lib/languages/sql'),python:()=>import('highlight.js/lib/languages/python'),java:()=>import('highlight.js/lib/languages/java'),csharp:()=>import('highlight.js/lib/languages/csharp'),cpp:()=>import('highlight.js/lib/languages/cpp'),go:()=>import('highlight.js/lib/languages/go'),rust:()=>import('highlight.js/lib/languages/rust'),php:()=>import('highlight.js/lib/languages/php'),ruby:()=>import('highlight.js/lib/languages/ruby'),yaml:()=>import('highlight.js/lib/languages/yaml'),markdown:()=>import('highlight.js/lib/languages/markdown'),
};
export const largeCode=(text:string)=>text.length>20_000||text.split('\n',502).length>500;
type Span={from:number;to:number;classes:string[]};
type HighlightNode={value?:string;children?:HighlightNode[];properties?:{className?:string[]}};
type Cached={text:string;language:string;generation:number;spans:Span[]};
export type GrammarLoader=(language:string)=>Promise<LanguageFn>;

// Decoration-only asynchronous work: no grammar callback ever changes document content/history.
export function lazyHighlightPlugin(load:GrammarLoader=async language=>(await loaders[language]()).default){
 const key=new PluginKey('hs-lazy-code-highlight'),engine=createLowlight(),pending=new Set<string>(),failed=new Set<string>();
 let view:EditorView|null=null,generation=0,cache=new Map<string,Cached>();
 function request(language:string){if(pending.has(language)||failed.has(language)||engine.registered(language))return;pending.add(language);void load(language).then(grammar=>{engine.register(language,grammar);generation++;}).catch(()=>{failed.add(language);generation++;}).finally(()=>{pending.delete(language);if(view&&!view.isDestroyed)view.dispatch(view.state.tr.setMeta(key,true).setMeta('addToHistory',false));});}
 function spans(text:string,language:string):Span[]{
  if(language==='plaintext'||!loaders[language]||largeCode(text)||!text)return [];
  if(!engine.registered(language)){request(language);return [];}
  let at=0;const result:Span[]=[];
  function walk(nodes:HighlightNode[],parents:string[]=[]){for(const n of nodes){const classes=[...parents,...(n.properties?.className??[])];if(n.children)walk(n.children,classes);else{const end=at+(n.value?.length??0);if(classes.length&&end>at)result.push({from:at,to:end,classes});at=end;}}}
  try{walk(engine.highlight(language,text).children as HighlightNode[]);return result.length<=5000?result:[];}catch{return [];}
 }
 function build(doc:PMNode){const decorations:Decoration[]=[],next=new Map<string,Cached>();doc.descendants((node,pos)=>{if(node.type.name!=='codeBlock')return;const language=String(node.attrs.language??'plaintext'),text=node.textContent,id=String(node.attrs.id??pos),old=cache.get(id);const entry=old&&old.text===text&&old.language===language&&old.generation===generation?old:{text,language,generation,spans:spans(text,language)};next.set(id,entry);for(const s of entry.spans)decorations.push(Decoration.inline(pos+1+s.from,pos+1+s.to,{class:s.classes.join(' ')}));});cache=next;return DecorationSet.create(doc,decorations);}
 return new Plugin<DecorationSet>({key,state:{init:(_,state)=>build(state.doc),apply:(tr,previous)=>tr.docChanged||tr.getMeta(key)?build(tr.doc):previous.map(tr.mapping,tr.doc)},props:{decorations:state=>key.getState(state)},view:current=>{view=current;return {destroy(){view=null;cache.clear();}};}});
}

export const LazyCodeBlock=CodeBlockLowlight.extend({
 addProseMirrorPlugins(){return [lazyHighlightPlugin()];},
 renderHTML({node,HTMLAttributes}){const language=String(node.attrs.language??'plaintext');return ['pre',{...this.options.HTMLAttributes,...HTMLAttributes,'data-language':language},['code',{class:`language-${language}`},0]];},
});
