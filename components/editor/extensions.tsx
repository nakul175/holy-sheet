"use client";
import { Extension, Node, mergeAttributes,type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useState,useRef } from "react";
import { openSectionsForNavigation,restoreTemporarySections,type TemporarySection } from "./section-navigation";

export const Callout = Node.create({
  name:"callout",group:"block",content:"paragraph+",defining:true,
  addAttributes(){return {theme:{default:"neutral",parseHTML:e=>e.getAttribute("data-theme")},icon:{default:"✦"}};},
  parseHTML(){return [{tag:"aside[data-hs-callout]"}];},
  renderHTML({HTMLAttributes}){return ["aside",mergeAttributes(HTMLAttributes,{"data-hs-callout":"","data-theme":HTMLAttributes.theme}),0];},
});

function ContentsView({editor}:NodeViewProps) {
  const temporary=useRef<TemporarySection[]>([]);
  useEffect(()=>{const outside=(event:MouseEvent)=>{if(temporary.current.some(e=>e.element.contains(event.target as globalThis.Node)))return;temporary.current=restoreTemporarySections(temporary.current);};document.addEventListener("click",outside);return()=>{document.removeEventListener("click",outside);restoreTemporarySections(temporary.current);};},[]);
  const [headings,setHeadings]=useState<{id:string;level:number;text:string}[]>([]);
  useEffect(()=>{const collect=()=>{const next:typeof headings=[];editor.state.doc.descendants(n=>{if(n.type.name==="heading")next.push({id:n.attrs.id,level:n.attrs.level,text:n.textContent||"Untitled heading"});});setHeadings(next);};collect();editor.on("update",collect);return()=>{editor.off("update",collect);};},[editor]);
  function navigate(id:string) {
    const target=editor.view.dom.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if(!target)return;
    const key=editor.view.dom.closest("[data-preference-key]")?.getAttribute("data-preference-key")??"session";
    openSectionsForNavigation(target,key,temporary.current);
    target.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth",block:"center"});
    target.setAttribute("tabindex","-1");(target as HTMLElement).focus({preventScroll:true});
  }
  return <NodeViewWrapper className="contents-block" contentEditable={false}><span className="block-eyebrow">On this page</span><nav aria-label="Table of contents">{headings.length?headings.map(h=><a key={h.id} href={`#${h.id}`} style={{paddingInlineStart:(h.level-1)*16}} onClick={e=>{e.preventDefault();navigate(h.id);}}>{h.text}</a>):<p>Add a heading to build your contents.</p>}</nav></NodeViewWrapper>;
}
export const TableOfContents = Node.create({name:"tableOfContents",group:"block",atom:true,draggable:true,parseHTML:()=>[{tag:"nav[data-hs-toc]"}],renderHTML:()=>["nav",{"data-hs-toc":""}],addNodeView(){return ReactNodeViewRenderer(ContentsView);}});

function ReferenceView({node,editor,extension}:NodeViewProps){
  const [title,setTitle]=useState('Loading linked page…');
  useEffect(()=>{let active=true,generation=0;const load=async()=>{const token=++generation;setTitle('Loading linked page…');publishFindLabel(editor,node.attrs.id,'');try{const response=await fetch(`/api/v1/references/${encodeURIComponent(node.attrs.pageId)}?sourcePageId=${encodeURIComponent(extension.options.sourcePageId)}`,{cache:'no-store'}),data=await response.json();if(!active||token!==generation)return;const name=response.ok&&typeof data.title==='string'?data.title:'';setTitle(name||'Restricted or unavailable page');publishFindLabel(editor,node.attrs.id,name);}catch{if(active&&token===generation){setTitle('Restricted or unavailable page');publishFindLabel(editor,node.attrs.id,'');}}};void load();window.addEventListener('focus',load);return()=>{active=false;window.removeEventListener('focus',load);};},[editor,node.attrs.pageId,node.attrs.id]);
  return <NodeViewWrapper contentEditable={false} className="reference-block"><a href={`/pages/${encodeURIComponent(node.attrs.pageId)}`} onClick={event=>{if(!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();event.stopPropagation();window.location.assign(event.currentTarget.href);}}}><span aria-hidden>↗</span> {title}</a></NodeViewWrapper>;
}
export const PageLink = Node.create({name:"pageLink",addOptions(){return {sourcePageId:""};},group:"block",atom:true,draggable:true,addAttributes(){return {pageId:{default:null}};},parseHTML:()=>[{tag:"div[data-hs-reference]"}],renderHTML({HTMLAttributes}){return ["div",mergeAttributes(HTMLAttributes,{"data-hs-reference":""})];},addNodeView(){return ReactNodeViewRenderer(ReferenceView);}});

function FileView({node,editor,getPos}:NodeViewProps){
  const [metadata,setMetadata]=useState<{name:string;size:number;mime:string}|null>(null);
  useEffect(()=>{let active=true,generation=0;const load=async()=>{const token=++generation;setMetadata(null);publishFindLabel(editor,node.attrs.id,'');try{const response=await fetch(`/api/media/${node.attrs.attachmentId}/metadata`,{cache:'no-store'}),data=response.ok?await response.json():null;if(!active||token!==generation)return;setMetadata(data);publishFindLabel(editor,node.attrs.id,data?.name??'');}catch{if(active&&token===generation){setMetadata(null);publishFindLabel(editor,node.attrs.id,'');}}};void load();window.addEventListener('focus',load);return()=>{active=false;window.removeEventListener('focus',load);};},[editor,node.attrs.attachmentId,node.attrs.id]);
  return <NodeViewWrapper className="file-block" contentEditable={false}>{metadata?<a href={`/api/media/${node.attrs.attachmentId}`} download><span aria-hidden>↓</span><span><strong>{metadata.name}</strong><small>{metadata.mime} · {(metadata.size/1_000_000).toFixed(2)} MB</small></span></a>:<span>File unavailable</span>}{editor.isEditable&&<button aria-label="Select file block for actions" onMouseDown={e=>e.preventDefault()} onClick={()=>{const pos=getPos();if(typeof pos==='number')editor.chain().focus().setNodeSelection(pos).run();}}>Actions</button>}</NodeViewWrapper>;
}
export const FileBlock = Node.create({name:"file",group:"block",atom:true,draggable:true,addAttributes(){return {attachmentId:{default:null},title:{default:''}};},parseHTML:()=>[{tag:"div[data-hs-file]"}],renderHTML({HTMLAttributes}){return ["div",mergeAttributes(HTMLAttributes,{"data-hs-file":""})];},addNodeView(){return ReactNodeViewRenderer(FileView);}});

export type FindState = {labels:Record<string,string>;query:string;matchCase:boolean;matches:{from:number;to:number}[];decorations:DecorationSet};
export const findKey = new PluginKey<FindState>("holy-find");
function publishFindLabel(editor:Editor,id:unknown,label:string){if(typeof id==='string'&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta(findKey,{labels:{[id]:label}}).setMeta('addToHistory',false));}
export function collectMatches(doc:PMNode,query:string,matchCase=false,labels:Record<string,string>={}){
  const matches:{from:number;to:number}[]=[];if([...query.trim()].length<2)return matches;
  // Unicode regex matching retains source UTF-16 offsets; lowercasing whole strings can change length.
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'gu':'giu');
  doc.descendants((node,pos)=>{
    if(['image','file','pageLink'].includes(node.type.name)){
      const label=node.type.name==='image'?[node.attrs.alt,node.attrs.caption].filter(Boolean).join('\n'):(labels[String(node.attrs.id)]??(node.type.name==='file'?String(node.attrs.title??''):''));
      pattern.lastIndex=0;for(const _ of label.matchAll(pattern))matches.push({from:pos,to:pos+node.nodeSize});return false;
    }
    if(!node.isTextblock)return true;
    let hay='';node.forEach(child=>{hay+=child.isText?child.text:child.type.name==='hardBreak'?'\n':'\uFFFC';});
    pattern.lastIndex=0;for(const hit of hay.matchAll(pattern))matches.push({from:pos+1+hit.index!,to:pos+1+hit.index!+hit[0].length});return false;
  });return matches;
}
export const FindExtension = Extension.create({name:"holyFind",addProseMirrorPlugins(){return [new Plugin<FindState>({key:findKey,state:{init:()=>({labels:{},query:"",matchCase:false,matches:[],decorations:DecorationSet.empty}),apply(tr,old){const meta=tr.getMeta(findKey) as Partial<FindState>|undefined;const query=meta?.query??old.query, matchCase=meta?.matchCase??old.matchCase;if(!tr.docChanged&&!meta)return old;const labels={...old.labels,...meta?.labels};const visible=new Set<string>();tr.doc.descendants(node=>{if(['file','pageLink'].includes(node.type.name))visible.add(String(node.attrs.id));});for(const id of Object.keys(labels))if(!visible.has(id))delete labels[id];const matches=collectMatches(tr.doc,query,matchCase,labels);return {labels,query,matchCase,matches,decorations:DecorationSet.create(tr.doc,matches.map(m=>{const node=tr.doc.nodeAt(m.from);return node?.isAtom&&!node.isText?Decoration.node(m.from,m.to,{class:'find-match'}):Decoration.inline(m.from,m.to,{class:"find-match"});}))};}},props:{decorations:state=>findKey.getState(state)?.decorations}})];}});
