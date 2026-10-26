"use client";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useState } from "react";

export const Callout = Node.create({
  name:"callout",group:"block",content:"paragraph+",defining:true,
  addAttributes(){return {theme:{default:"neutral",parseHTML:e=>e.getAttribute("data-theme")},icon:{default:"✦"}};},
  parseHTML(){return [{tag:"aside[data-hs-callout]"}];},
  renderHTML({HTMLAttributes}){return ["aside",mergeAttributes(HTMLAttributes,{"data-hs-callout":"","data-theme":HTMLAttributes.theme}),0];},
});

function ContentsView({editor}:NodeViewProps) {
  const [headings,setHeadings]=useState<{id:string;level:number;text:string}[]>([]);
  useEffect(()=>{const collect=()=>{const next:typeof headings=[];editor.state.doc.descendants(n=>{if(n.type.name==="heading")next.push({id:n.attrs.id,level:n.attrs.level,text:n.textContent||"Untitled heading"});});setHeadings(next);};collect();editor.on("update",collect);return()=>{editor.off("update",collect);};},[editor]);
  function navigate(id:string) {
    const target=editor.view.dom.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if(!target)return;
    let ancestor=target.parentElement;
    while(ancestor){if(ancestor.getAttribute("data-type")==="details")ancestor.classList.add("is-open");ancestor=ancestor.parentElement;}
    target.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth",block:"center"});
    target.setAttribute("tabindex","-1");(target as HTMLElement).focus({preventScroll:true});
  }
  return <NodeViewWrapper className="contents-block" contentEditable={false}><span className="block-eyebrow">On this page</span><nav aria-label="Table of contents">{headings.length?headings.map(h=><a key={h.id} href={`#${h.id}`} style={{paddingInlineStart:(h.level-1)*16}} onClick={e=>{e.preventDefault();navigate(h.id);}}>{h.text}</a>):<p>Add a heading to build your contents.</p>}</nav></NodeViewWrapper>;
}
export const TableOfContents = Node.create({name:"tableOfContents",group:"block",atom:true,draggable:true,parseHTML:()=>[{tag:"nav[data-hs-toc]"}],renderHTML:()=>["nav",{"data-hs-toc":""}],addNodeView(){return ReactNodeViewRenderer(ContentsView);}});

function ReferenceView({node}:NodeViewProps){
  const [title,setTitle]=useState("Restricted or unavailable page");
  useEffect(()=>{let active=true;const load=async()=>{try{const r=await fetch(`/api/v1/references/${encodeURIComponent(node.attrs.pageId)}`,{cache:"no-store"});const d=await r.json();if(active)setTitle(r.ok?d.title:"Restricted or unavailable page");}catch{if(active)setTitle("Restricted or unavailable page");}};void load();window.addEventListener("focus",load);return()=>{active=false;window.removeEventListener("focus",load);};},[node.attrs.pageId]);
  return <NodeViewWrapper contentEditable={false} className="reference-block"><a href={`/pages/${encodeURIComponent(node.attrs.pageId)}`}><span aria-hidden>↗</span> {title}</a></NodeViewWrapper>;
}
export const PageLink = Node.create({name:"pageLink",group:"block",atom:true,draggable:true,addAttributes(){return {pageId:{default:null}};},parseHTML:()=>[{tag:"div[data-hs-reference]"}],renderHTML({HTMLAttributes}){return ["div",mergeAttributes(HTMLAttributes,{"data-hs-reference":""})];},addNodeView(){return ReactNodeViewRenderer(ReferenceView);}});

function FileView({node}:NodeViewProps){
  const [metadata,setMetadata]=useState<{name:string;size:number;mime:string}|null>(null);
  useEffect(()=>{let active=true;fetch(`/api/media/${node.attrs.attachmentId}/metadata`,{cache:"no-store"}).then(async r=>r.ok?r.json():null).then(d=>{if(active)setMetadata(d);}).catch(()=>{});return()=>{active=false;};},[node.attrs.attachmentId]);
  return <NodeViewWrapper className="file-block" contentEditable={false}>{metadata?<a href={`/api/media/${node.attrs.attachmentId}`} download><span aria-hidden>↓</span><span><strong>{metadata.name}</strong><small>{metadata.mime} · {(metadata.size/1_000_000).toFixed(2)} MB</small></span></a>:<span>File unavailable</span>}</NodeViewWrapper>;
}
export const FileBlock = Node.create({name:"file",group:"block",atom:true,draggable:true,addAttributes(){return {attachmentId:{default:null},title:{default:''}};},parseHTML:()=>[{tag:"div[data-hs-file]"}],renderHTML({HTMLAttributes}){return ["div",mergeAttributes(HTMLAttributes,{"data-hs-file":""})];},addNodeView(){return ReactNodeViewRenderer(FileView);}});

export type FindState = {query:string;matchCase:boolean;matches:{from:number;to:number}[];decorations:DecorationSet};
export const findKey = new PluginKey<FindState>("holy-find");
export function collectMatches(doc:PMNode,query:string,matchCase=false){
  const matches:{from:number;to:number}[]=[];if([...query.trim()].length<2)return matches;
  // Unicode regex matching retains source UTF-16 offsets; lowercasing whole strings can change length.
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),matchCase?'gu':'giu');
  doc.descendants((node,pos)=>{
    if(['image','file'].includes(node.type.name)){
      const label=node.type.name==='image'?[node.attrs.alt,node.attrs.caption].filter(Boolean).join('\n'):String(node.attrs.title??'');
      pattern.lastIndex=0;for(const _ of label.matchAll(pattern))matches.push({from:pos,to:pos+node.nodeSize});return false;
    }
    if(!node.isTextblock)return true;
    let hay='';node.forEach(child=>{hay+=child.isText?child.text:child.type.name==='hardBreak'?'\n':'\uFFFC';});
    pattern.lastIndex=0;for(const hit of hay.matchAll(pattern))matches.push({from:pos+1+hit.index!,to:pos+1+hit.index!+hit[0].length});return false;
  });return matches;
}
export const FindExtension = Extension.create({name:"holyFind",addProseMirrorPlugins(){return [new Plugin<FindState>({key:findKey,state:{init:()=>({query:"",matchCase:false,matches:[],decorations:DecorationSet.empty}),apply(tr,old){const meta=tr.getMeta(findKey) as Partial<FindState>|undefined;const query=meta?.query??old.query, matchCase=meta?.matchCase??old.matchCase;if(!tr.docChanged&&!meta)return old;const matches=collectMatches(tr.doc,query,matchCase);return {query,matchCase,matches,decorations:DecorationSet.create(tr.doc,matches.map(m=>{const node=tr.doc.nodeAt(m.from);return node?.isAtom&&!node.isText?Decoration.node(m.from,m.to,{class:'find-match'}):Decoration.inline(m.from,m.to,{class:"find-match"});}))};}},props:{decorations:state=>findKey.getState(state)?.decorations}})];}});
