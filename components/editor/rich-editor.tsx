"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import { LazyCodeBlock,largeCode } from "./lazy-code-highlight";
import Image from "@tiptap/extension-image";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import UniqueID from "@tiptap/extension-unique-id";
import { sanitizePaste } from "../../lib/editor-paste";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { ensureIds, highlights, idTypes, languages, palette, plainText, safeUrl, stableStringify, type RichNode } from "../../lib/document";
import { Callout, FileBlock, FindExtension, PageLink, TableOfContents, findKey } from "./extensions";
import { requestJson } from "./use-document-session";
import UploadDialog from "./upload-dialog";
import TransformDialog from './transform-dialog';
import { PasteReviewDialog,PlainPasteDialog } from './paste-dialog';
import { parseTablePasteSource,type TablePasteSource } from './table-paste-source';
import { capturePastePoint,applyTablePaste,type PastePoint } from './table-paste-plan';
import { normalizeRichDocument } from "../../lib/editor-document";
import { captureMediaPlacement,applyReadyMedia,mediaTypeForFile,type MediaPlacement } from "./media-placement";
import type { RecoveredUpload } from "../../lib/upload-recovery-types";
import { rehydrateMediaPlacement } from "../../lib/upload-placement-recovery";
import { leaveBlock, reorderTable, selectedTable } from './table-actions';
import { DiscussionAnchors,discussionKey } from './discussion-anchors';
import { applyRemoteDocument } from './history-boundary';
import { openSectionsForNavigation,restoreTemporarySections,markSectionInteraction,setSectionOpen,type TemporarySection } from './section-navigation';
import type { ThreadView } from '../../lib/discussion-types';
import type { AnchorInput } from '../../lib/comment-anchors';

const noThreads:ThreadView[]=[];
const ProtectedImage=Image.extend({
  addAttributes(){return {...this.parent?.(),attachmentId:{default:null},caption:{default:""},width:{default:640}};},
  renderHTML({HTMLAttributes}){const {caption,...attrs}=HTMLAttributes;return ["figure",{"data-hs-image":""},["img",attrs],...(caption?[["figcaption",{},String(caption)]]:[])];},
});
type Insert = {name:string;description:string;type:string;level?:number};
const catalogue:Insert[]=[
  {name:"Text",description:"A simple paragraph",type:"paragraph"},
  ...[1,2,3].map(level=>({name:`Heading ${level}`,description:"Give your document structure",type:"heading",level})),
  {name:"Bulleted list",description:"Unordered ideas",type:"bulletList"},{name:"Numbered list",description:"A sequence of steps",type:"orderedList"},{name:"Checklist",description:"Track what is done",type:"taskList"},
  {name:"Quote",description:"A passage worth calling out",type:"blockquote"},{name:"Callout",description:"An important note",type:"callout"},{name:"Divider",description:"A quiet visual break",type:"horizontalRule"},
  {name:"Code",description:"Code with syntax highlighting",type:"codeBlock"},{name:"Table",description:"Rows, columns and checklists",type:"table"},{name:"Collapsible section",description:"A title with nested content",type:"details"},
  {name:"Table of contents",description:"Navigate the page headings",type:"tableOfContents"},{name:"Page link",description:"Reference a Holy Sheet page",type:"pageLink"},{name:"Image",description:"PNG, JPEG, WebP or GIF · up to 10 MB",type:"image"},{name:"File",description:"Documents and text · up to 25 MB",type:"file"},
];
export { normalizeRichDocument } from "../../lib/editor-document";

export { sanitizePaste } from "../../lib/editor-paste";


export function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  const ref=useRef<HTMLDivElement>(null),previous=useRef<Element|null>(null);
  useEffect(()=>{previous.current=document.activeElement;ref.current?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();return()=>{(previous.current as HTMLElement|null)?.focus?.();};},[]);
  return <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className="modal editor-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();onClose();}if(e.key==="Tab"){const items=Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea,a[href]")??[]);if(!items.length)return;if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===items.at(-1)){e.preventDefault();items[0].focus();}}}}><div className="dialog-heading"><h2>{title}</h2><button aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</div></div>;
}

function blockRange(editor:Editor){
  const {$from}=editor.state.selection;let depth=$from.depth;
  if(editor.state.selection instanceof NodeSelection)return {node:editor.state.selection.node,from:editor.state.selection.from,to:editor.state.selection.to,parent:$from.parent,index:$from.index(),parentStart:$from.start()};
  for(let d=1;d<=$from.depth;d++){const name=$from.node(d).type.name;if(name==="table"){depth=d;break;}if(["listItem","taskItem"].includes(name))depth=d;else if(name==="detailsSummary"){depth=d-1;break;}}
  if(!depth)return null;
  return {node:$from.node(depth),from:$from.before(depth),to:$from.after(depth),parent:$from.node(depth-1),index:$from.index(depth-1),parentStart:depth===1?0:$from.start(depth-1)};
}

export default function RichEditor({document,editable,onChange,pageId,preferenceKey,onComment,commentsReady=true,threads=noThreads,activeThreadId=null,onOpenThread,navigateThread=0,mediaEnabled=true,recoveryActorId,resumeUpload,onRecoveryClosed}:{document:RichNode;editable:boolean;onChange:(doc:RichNode)=>void;pageId:string;preferenceKey:string;onComment?:(anchors:AnchorInput[],quote:string)=>void;commentsReady?:boolean;threads?:ThreadView[];activeThreadId?:string|null;onOpenThread?:(id:string)=>void;navigateThread?:number;mediaEnabled?:boolean;recoveryActorId?:string;resumeUpload?:RecoveredUpload|null;onRecoveryClosed?:()=>void}){
  const [insertOpen,setInsertOpen]=useState(false),[query,setQuery]=useState(""),[active,setActive]=useState(0),[notice,setNotice]=useState(""),[linkOpen,setLinkOpen]=useState(false),[pageOpen,setPageOpen]=useState(false),[media,setMedia]=useState<"image"|"file"|null>(null),[findOpen,setFindOpen]=useState(false),[findQuery,setFindQuery]=useState(""),[matchCase,setMatchCase]=useState(false),[matchIndex,setMatchIndex]=useState(0);
  const [transformOpen,setTransformOpen]=useState(false);
  const [pasteReview,setPasteReview]=useState<{source:TablePasteSource;point:PastePoint}|null>(null),[plainPoint,setPlainPoint]=useState<PastePoint|null>(null);
  const plainPasteUntil=useRef(0);
  const [mediaFile,setMediaFile]=useState<File|null>(null),[mediaTarget,setMediaTarget]=useState<MediaPlacement|null>(null),[mediaRecovered,setMediaRecovered]=useState<RecoveredUpload|null>(null);
  useEffect(()=>{const logout=()=>{closeMedia();setTransformOpen(false);setPasteReview(null);setPlainPoint(null);};window.addEventListener('holy-sheet:logout',logout);return()=>window.removeEventListener('holy-sheet:logout',logout);},[]);
  const slash=useRef(false),insertAt=useRef<number|null>(null),onChangeRef=useRef(onChange),lastEmitted=useRef(stableStringify(document)),restoring=useRef(false),savedFindSelection=useRef<{from:number;to:number}|null>(null),temporaryOpen=useRef<TemporarySection[]>([]),discussionOpen=useRef<TemporarySection[]>([]);
  onChangeRef.current=onChange;
  const editor=useEditor({immediatelyRender:false,editable,content:document,extensions:[
    StarterKit.configure({heading:{levels:[1,2,3]},codeBlock:false,undoRedo:{depth:100,newGroupDelay:750},link:{openOnClick:false,autolink:false,linkOnPaste:false,isAllowedUri:url=>safeUrl(url),HTMLAttributes:{target:"_blank",rel:"noopener noreferrer"}}}),
    TextStyle,Color,Highlight.configure({multicolor:true}),TaskList,TaskItem.configure({nested:true}),TableKit.configure({table:{resizable:true,allowTableNodeSelection:true}}),
    LazyCodeBlock.configure({defaultLanguage:"plaintext"}),ProtectedImage.configure({allowBase64:false}),Details.configure({persist:false}),DetailsSummary,DetailsContent,Callout,TableOfContents,PageLink.configure({sourcePageId:pageId}),FileBlock,FindExtension,DiscussionAnchors.configure({onOpen:id=>onOpenThread?.(id)}),
    UniqueID.configure({types:idTypes,attributeName:"id",generateID:()=>crypto.randomUUID()}),
  ],editorProps:{attributes:{class:"rich-prose",role:"textbox","aria-label":"Document content","aria-multiline":"true",spellcheck:"true"},transformPastedHTML:sanitizePaste,
    handleKeyDown:(view,event)=>{
      if(event.isComposing)return false;
      if(!view.editable){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();savedFindSelection.current={from:view.state.selection.from,to:view.state.selection.to};setFindOpen(true);return true;}return false;}
      if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='v')plainPasteUntil.current=Date.now()+2000;
      if(event.key==='Tab'&&!event.shiftKey&&editor){const table=selectedTable(editor);if(table&&table.node.childCount===100&&table.row===99&&table.column===table.node.lastChild!.childCount-1){event.preventDefault();leaveBlock(editor,'table');setNotice('Maximum 100 rows reached. Continued below the table.');return true;}}
      if(event.key==='Tab'&&view.state.selection.$from.parent.type.name==='codeBlock'){
        event.preventDefault();const {from,to,$from}=view.state.selection,start=$from.start();const text=$from.parent.textContent;
        if(from===to&&!event.shiftKey){view.dispatch(view.state.tr.insertText('  ',from));return true;}
        const first=text.lastIndexOf('\n',Math.max(-1,from-start-1))+1,positions=[first];
        for(let at=text.indexOf('\n',first);at>=0&&start+at<to;at=text.indexOf('\n',at+1))positions.push(at+1);
        const tr=view.state.tr;for(const pos of positions.reverse()){if(event.shiftKey){const spaces=/^ {1,2}/.exec(text.slice(pos))?.[0].length??0;if(spaces)tr.delete(start+pos,start+pos+spaces);}else tr.insertText('  ',start+pos);}
        view.dispatch(tr.scrollIntoView());return true;
      }
      if(event.key==="/"&&view.state.selection.empty&&view.state.selection.$from.parent.type.name==="paragraph"&&!view.state.selection.$from.parent.textContent){event.preventDefault();slash.current=true;insertAt.current=view.state.selection.from;setQuery("");setActive(0);setInsertOpen(true);return true;}
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="f"){event.preventDefault();savedFindSelection.current={from:view.state.selection.from,to:view.state.selection.to};setFindOpen(true);return true;}
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k"&&(!view.state.selection.empty||view.state.selection.$from.marks().some(m=>m.type.name==="link"))){event.preventDefault();setLinkOpen(true);return true;}
      if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==="s"){event.preventDefault();editor?.chain().focus().toggleStrike().run();return true;}
      if((event.metaKey||event.ctrlKey)&&event.key==="\\"){event.preventDefault();clearFormatting(editor);return true;}
      return false;
    },
    handlePaste:(view,event)=>{if(!editor||!view.editable)return false;const clipboard=event.clipboardData,text=clipboard?.getData('text/plain')??'',html=clipboard?.getData('text/html')??'';
      if(plainPasteUntil.current>Date.now()||view.state.selection.$from.parent.type.name==='codeBlock'){plainPasteUntil.current=0;event.preventDefault();try{applyTablePaste(editor,{grids:[],warnings:[],text},capturePastePoint(editor),'plain');}catch(e){setNotice(e instanceof Error?e.message:'Literal paste could not be applied.');}return true;}
      if(clipboard?.files.length){event.preventDefault();openFileIntent(Array.from(clipboard.files));return true;}
      if(/<table[\s>]/i.test(html)||text.includes('\t')){event.preventDefault();try{const point=capturePastePoint(editor),source=parseTablePasteSource(editor,html,text);setPasteReview({source,point});}catch(e){setNotice(e instanceof Error?e.message:'Paste could not be prepared; existing content is unchanged.');}return true;}
      if(html&&new Blob([html]).size>25_000_000){event.preventDefault();setPasteReview({point:capturePastePoint(editor),source:{grids:[],text,warnings:['The rich source is too large. Review literal text or split the source first.']}});return true;}return false;},
    handleDrop:(view,event)=>{if(event.dataTransfer?.files.length){event.preventDefault();openFileIntent(Array.from(event.dataTransfer.files),view.posAtCoords({left:event.clientX,top:event.clientY})?.pos);return true;}return false;},
  },onUpdate:({editor:e,transaction})=>{if(restoring.current||!e.isEditable)return;if(transaction.docChanged)markSectionInteraction(e.view.domAtPos(e.state.selection.from).node);const value=normalizeRichDocument(e.getJSON() as RichNode);lastEmitted.current=stableStringify(value);onChangeRef.current(value);}});
  useEffect(()=>{if(!editor||!resumeUpload)return;let active=true,handed=false;void(async()=>{try{const target=resumeUpload.newPlacement?captureMediaPlacement(editor,resumeUpload.payload.type):await rehydrateMediaPlacement(editor,resumeUpload.payload.target);if(!active){await resumeUpload.release?.();return;}setMediaTarget(target);setMediaFile(null);setMediaRecovered(resumeUpload);setMedia(resumeUpload.payload.type);handed=true;}catch(e){if(active){setNotice(e instanceof Error?e.message:'The upload placement needs review.');onRecoveryClosed?.();}await resumeUpload.release?.();}})();return()=>{active=false;if(!handed)void resumeUpload.release?.();};},[editor,resumeUpload]);
  const state=useEditorState({editor,selector:({editor:e})=>e?{selection:e.state.selection.from,selectionEnd:e.state.selection.to,find:findKey.getState(e.state),undo:e.can().undo(),redo:e.can().redo(),table:e.isActive("table"),code:e.isActive("codeBlock"),image:e.isActive("image"),file:e.isActive("file"),callout:e.isActive("callout"),bold:e.isActive("bold"),italic:e.isActive("italic"),underline:e.isActive("underline"),strike:e.isActive("strike")}:null});
  useEffect(()=>{if(editor){editor.setEditable(editable);editor.view.dom.setAttribute('aria-readonly',String(!editable));}},[editor,editable]);
  useEffect(()=>{if(editor)editor.view.dispatch(editor.state.tr.setMeta(discussionKey,{threads,activeId:activeThreadId}));},[editor,threads,activeThreadId]);
  useEffect(()=>{if(!editor||!navigateThread||!activeThreadId)return;const t=threads.find(t=>t.id===activeThreadId),anchor=t?.anchors.find(a=>a.status==='attached');if(!anchor)return;let pos:number|undefined;editor.state.doc.descendants((n,p)=>{if(n.attrs.id===anchor.blockId)pos=p+1+anchor.start;});if(pos!==undefined){editor.commands.setTextSelection({from:pos,to:pos+anchor.end-anchor.start});const target=editor.view.dom.querySelector(`[data-id="${CSS.escape(anchor.blockId)}"]`);openSectionsForNavigation(target,preferenceKey,discussionOpen.current);target?.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});editor.view.focus();}},[editor,navigateThread]);
  useEffect(()=>{const json=stableStringify(document);if(editor&&json!==lastEmitted.current){restoring.current=true;const reset=applyRemoteDocument(editor,document);lastEmitted.current=json;restoring.current=false;if(reset)setNotice('The page received a saved update. Undo history starts from this version.');}},[editor,document]);
  useEffect(()=>{if(editor)editor.view.dispatch(editor.state.tr.setMeta(findKey,{query:findQuery,matchCase}));setMatchIndex(0);},[editor,findQuery,matchCase]);
  useEffect(()=>{setMatchIndex(i=>Math.min(i,Math.max(0,(state?.find?.matches.length??0)-1)));},[state?.find?.matches.length]);
  useEffect(()=>{if(!editor)return;const click=(e:Event)=>{const target=e.target as HTMLElement;if(e.isTrusted)markSectionInteraction(target);const details=target.closest<HTMLElement>("[data-type='details']");if(e.isTrusted&&details&&target.closest("button")===details.querySelector(":scope > button"))queueMicrotask(()=>{try{localStorage.setItem(`hs-collapse:${preferenceKey}:${details.getAttribute('data-id')}`,details.classList.contains("is-open")?"open":"closed");}catch{}});};editor.view.dom.addEventListener("click",click);const restore=()=>{editor.view.dom.querySelectorAll<HTMLElement>("[data-type='details']").forEach(d=>{try{const value=localStorage.getItem(`hs-collapse:${preferenceKey}:${d.getAttribute('data-id')}`);if(value==="open"&&!d.classList.contains("is-open"))setSectionOpen(d,true);}catch{}});};restore();return()=>editor.view.dom.removeEventListener("click",click);},[editor,preferenceKey]);
  useEffect(()=>{const outside=(event:MouseEvent)=>{if(discussionOpen.current.some(e=>e.element.contains(event.target as Node)))return;discussionOpen.current=restoreTemporarySections(discussionOpen.current);};window.document.addEventListener("click",outside);return()=>window.document.removeEventListener("click",outside);},[]);
  const filtered=catalogue.filter(c=>(mediaEnabled||!['image','file'].includes(c.type))&&(c.name+" "+c.description).toLowerCase().includes(query.toLowerCase()));
  function closeInsert(){if(slash.current&&query)editor?.chain().focus().insertContent('/'+query).run();else if(slash.current)editor?.chain().focus().insertContent('/').run();slash.current=false;setInsertOpen(false);}
  function insert(item:Insert){
    if(!editor||!editable)return;setInsertOpen(false);slash.current=false;
    if(item.type==="pageLink"){setPageOpen(true);return;}if(item.type==="image"||item.type==="file"){openMedia(item.type);return;}
    const chain=editor.chain().focus();if(insertAt.current!==null)chain.setTextSelection(insertAt.current);
    if(item.type==="paragraph")chain.setParagraph().run();
    else if(item.type==="heading")chain.setHeading({level:item.level as 1|2|3}).run();
    else if(item.type==="bulletList")chain.toggleBulletList().run();else if(item.type==="orderedList")chain.toggleOrderedList().run();else if(item.type==="taskList")chain.toggleTaskList().run();
    else if(item.type==="blockquote")chain.toggleBlockquote().run();else if(item.type==="codeBlock")chain.setCodeBlock({language:"plaintext"}).run();
    else if(item.type==="table")chain.insertTable({rows:3,cols:3,withHeaderRow:true}).run();
    else if(item.type==="horizontalRule")chain.setHorizontalRule().run();
    else if(item.type==="details")chain.insertContent(ensureIds({type:"doc",content:[{type:"details",content:[{type:"detailsSummary",content:[{type:"text",text:"Untitled section"}]},{type:"detailsContent",content:[{type:"paragraph"}]}]}]}).content!).run();
    else chain.insertContent(ensureIds({type:"doc",content:[item.type==="callout"?{type:"callout",attrs:{theme:"neutral",icon:"✦"},content:[{type:"paragraph"}]}:{type:item.type}]}).content!).run();
  }
  function openMedia(type:'image'|'file',file?:File,replace=false,position?:number){if(!editor||!editor.isEditable||!mediaEnabled){setNotice('Uploads are unavailable in this read-only or template context.');return;}try{setMediaRecovered(null);setMediaTarget(captureMediaPlacement(editor,type,replace,position));setMediaFile(file??null);setMedia(type);}catch(e){setNotice(e instanceof Error?e.message:'Choose a media location again.');}}
  function closeMedia(){setMedia(null);setMediaFile(null);setMediaTarget(null);setMediaRecovered(null);onRecoveryClosed?.();}
  function openFileIntent(files:File[],position?:number){if(files.length!==1){setNotice('No files added. Paste or drop one file at a time so its type, placement and description can be reviewed.');return;}const type=mediaTypeForFile(files[0]);if(!type){setNotice('Unsupported file type. No document content changed.');return;}openMedia(type,files[0],false,position);}
  function addBlock(){if(!editor)return;const range=blockRange(editor);if(range){editor.commands.insertContentAt(range.to,{type:"paragraph"});editor.commands.setTextSelection(Math.min(range.to+1,editor.state.doc.content.size));}insertAt.current=editor.state.selection.from;slash.current=false;setQuery("");setActive(0);setInsertOpen(true);}
  function commentSelection(){if(!editor||!onComment)return;const {from,to}=editor.state.selection;const anchors:AnchorInput[]=[],quotes:string[]=[];let unsupported=false;editor.state.doc.nodesBetween(from,to,(node,pos)=>{if(node.isAtom&&!node.isText&&node.type.name!=='hardBreak'){unsupported=true;return false;}if(!node.isTextblock)return true;const start=Math.max(0,from-pos-1),end=Math.min(node.content.size,to-pos-1);if(end>start&&node.attrs.id){anchors.push({blockId:node.attrs.id,start,end});quotes.push(node.textBetween(start,end,'','\n'));}return false;});if(unsupported){setNotice('Select text only, or start a general page discussion.');return;}onComment(anchors,quotes.join('\n'));}
  function act(action:"up"|"down"|"duplicate"|"delete"){
    if(!editor)return;const range=blockRange(editor);if(!range)return;
    const {from,to,node,parent,index,parentStart}=range;
    if(action==="duplicate"){editor.chain().focus().insertContentAt(to,ensureIds(node.toJSON() as RichNode,true)).run();return;}
    if(action==="delete"){editor.chain().focus().deleteRange({from,to}).run();return;}
    const direction=action==="up"?-1:1,target=index+direction;if(target<0||target>=parent.childCount){setNotice("This block is already at the boundary of its section.");return;}
    let destination=parentStart;for(let i=0;i<(direction<0?target:target+1);i++)destination+=parent.child(i).nodeSize;
    const tr=editor.state.tr.delete(from,to);const mapped=tr.mapping.map(destination);tr.insert(mapped,node);tr.setSelection(TextSelection.near(tr.doc.resolve(mapped+1)));editor.view.dispatch(tr);editor.commands.focus();setNotice(`Block moved ${action}.`);
  }
  function navigateFind(delta:number){const matches=state?.find?.matches??[];if(!editor||!matches.length)return;const next=(matchIndex+delta+matches.length)%matches.length;setMatchIndex(next);const m=matches[next];editor.commands.setTextSelection(m);const node=editor.state.doc.nodeAt(m.from),raw=node?.isAtom&&!node.isText?editor.view.nodeDOM(m.from):editor.view.domAtPos(m.from).node;const dom=raw?.nodeType===1?raw as HTMLElement:raw?.parentElement;openSectionsForNavigation(dom??null,preferenceKey,temporaryOpen.current);dom?.scrollIntoView({block:"center"});}
  function closeFind(){setFindOpen(false);setFindQuery("");if(editor&&savedFindSelection.current){const {from,to}=savedFindSelection.current;if(to<=editor.state.doc.content.size)editor.commands.setTextSelection({from,to});editor.commands.focus();}temporaryOpen.current=restoreTemporarySections(temporaryOpen.current);}
  if(!editor)return <div className="editor-skeleton" aria-label="Loading editor"/>;
  const button=(label:string,children:ReactNode,run:()=>void,pressed=false,disabled=false)=><button type="button" key={label} aria-label={label} title={label} aria-pressed={pressed} disabled={!editable||disabled} onMouseDown={e=>e.preventDefault()} onClick={run}>{children}</button>;
  function toolbar(){if(!editor)return null;return <div className="format-tools" role="toolbar" aria-label="Text formatting">
    {button("Bold","B",()=>editor.chain().focus().toggleBold().run(),!!state?.bold)}{button("Italic",<i>I</i>,()=>editor.chain().focus().toggleItalic().run(),!!state?.italic)}{button("Underline",<u>U</u>,()=>editor.chain().focus().toggleUnderline().run(),!!state?.underline)}{button("Strikethrough",<s>S</s>,()=>editor.chain().focus().toggleStrike().run(),!!state?.strike)}
    {button("Edit link","↗",()=>setLinkOpen(true))}{button("Clear formatting","Tx",()=>clearFormatting(editor))}
    <label className="colour-control">Text colour<select aria-label="Text colour" disabled={!editable} value={palette.includes(editor.getAttributes('textStyle').color)?editor.getAttributes('textStyle').color:""} onChange={e=>e.target.value?editor.chain().focus().setColor(e.target.value).run():editor.chain().focus().unsetColor().run()}><option value="">Default</option>{palette.map((c,i)=><option key={c} value={c}>{["Black","Grey","Blue","Green","Amber","Red","Purple"][i]}</option>)}</select></label>
    <label className="colour-control">Highlight<select aria-label="Text highlight" disabled={!editable} defaultValue="" onChange={e=>e.target.value?editor.chain().focus().setHighlight({color:e.target.value}).run():editor.chain().focus().unsetHighlight().run()}><option value="">None</option>{highlights.map((c,i)=><option key={c} value={c}>{["Amber","Blue","Green","Red","Purple"][i]}</option>)}</select></label>
  </div>;}
  return <div className="rich-editor" data-editable={editable} data-preference-key={preferenceKey} data-has-selection={!editor.state.selection.empty}>
    <div className="editor-actions" role="toolbar" aria-label="Document tools">
      <button onClick={addBlock} disabled={!editable}>＋ Insert</button>
      {onComment&&<button disabled={!commentsReady} onClick={commentSelection} title={!commentsReady?'Wait for the document save before anchoring a comment':undefined}>Comment on selection</button>}
      {button("Undo","↶",()=>editor.chain().focus().undo().run(),false,!state?.undo)}{button("Redo","↷",()=>editor.chain().focus().redo().run(),false,!state?.redo)}
      <details className="block-actions"><summary aria-label="Block actions">⋮ Block</summary><div role="group" aria-label="Block actions"><button disabled={!editable} onClick={()=>act('up')}>Move up</button><button disabled={!editable} onClick={()=>act('down')}>Move down</button><button disabled={!editable} onClick={()=>act('duplicate')}>Duplicate block</button><button disabled={!editable} onClick={()=>act('delete')}>Delete block and contents</button><button disabled={!editable} onClick={()=>editor.chain().focus().sinkListItem(editor.isActive('taskItem')?'taskItem':'listItem').run()}>Indent list item</button><button disabled={!editable} onClick={()=>editor.chain().focus().liftListItem(editor.isActive('taskItem')?'taskItem':'listItem').run()}>Outdent list item</button><button disabled={!editable} onClick={()=>setTransformOpen(true)}>Turn into…</button></div></details>
      <button disabled={!editable} onClick={()=>setPlainPoint(capturePastePoint(editor))}>Paste literal text</button>
      <button className="find-button" onClick={()=>{savedFindSelection.current={from:editor.state.selection.from,to:editor.state.selection.to};setFindOpen(true);}}>⌕ Find</button>
    </div>
    <div className="persistent-format">{toolbar()}</div>
    <BubbleMenu editor={editor} className="floating-format" shouldShow={()=>editable&&editor.state.selection instanceof TextSelection&&!editor.state.selection.empty&&!editor.isActive('codeBlock')&&(editor.isFocused||!!window.document.activeElement?.closest('.floating-format'))&&matchMedia('(min-width: 761px)').matches}>{toolbar()}</BubbleMenu>
    {state?.code&&<div className="context-tools"><label>Language <select aria-label="Code language" disabled={!editable} value={editor.getAttributes('codeBlock').language??"plaintext"} onChange={e=>editor.chain().focus().updateAttributes('codeBlock',{language:e.target.value}).run()}>{languages.map(l=><option key={l}>{l}</option>)}</select></label><button onClick={()=>{const range=blockRange(editor);if(range)navigator.clipboard.writeText(range.node.textContent).then(()=>setNotice("Code copied."),()=>setNotice("Clipboard unavailable. Select and copy the code manually."));}}>Copy code</button><button disabled={!editable} onClick={()=>leaveBlock(editor,'codeBlock')}>Continue below code</button></div>}
    {state?.table&&<div className="context-tools" role="group" aria-label="Reorder table"><button disabled={!editable} onClick={()=>reorderTable(editor,'row',-1)}>Row up</button><button disabled={!editable} onClick={()=>reorderTable(editor,'row',1)}>Row down</button><button disabled={!editable} onClick={()=>reorderTable(editor,'column',-1)}>Column left</button><button disabled={!editable} onClick={()=>reorderTable(editor,'column',1)}>Column right</button></div>}
    {state?.table&&<div className="context-tools" role="toolbar" aria-label="Table tools">{button("Insert row","＋ Row",()=>{const row=editor.state.selection.$from;let n:PMNode|null=null;for(let i=1;i<=row.depth;i++)if(row.node(i).type.name==='table')n=row.node(i);if(n&&n.childCount>=100){setNotice('Tables support at most 100 rows.');return;}editor.chain().focus().addRowAfter().run();})}{button("Insert column","＋ Column",()=>{const p=editor.state.selection.$from;for(let i=1;i<=p.depth;i++)if(p.node(i).type.name==='table'&&p.node(i).firstChild!.childCount>=20){setNotice('Tables support at most 20 columns.');return;}editor.chain().focus().addColumnAfter().run();})}{button("Delete row","− Row",()=>{if(window.confirm("Delete the current row? If this is the last row, the table will be removed."))editor.chain().focus().deleteRow().run();})}{button("Delete column","− Column",()=>{if(window.confirm("Delete the current column? If this is the last column, the table will be removed."))editor.chain().focus().deleteColumn().run();})}{button("Toggle header row","Header",()=>editor.chain().focus().toggleHeaderRow().run())}{button("Checklist in cell","☑",()=>editor.chain().focus().toggleTaskList().run())}</div>}
    {state?.callout&&<div className="context-tools"><label>Callout theme <select aria-label="Callout theme" disabled={!editable} value={editor.getAttributes('callout').theme} onChange={e=>editor.chain().focus().updateAttributes('callout',{theme:e.target.value}).run()}>{["neutral","blue","green","amber","red"].map(t=><option key={t}>{t}</option>)}</select></label></div>}
    {state?.image&&<div className="context-tools"><label>Image size <select aria-label="Image size" disabled={!editable} value={editor.getAttributes('image').width??640} onChange={e=>editor.commands.updateAttributes('image',{width:Number(e.target.value)})}>{[[240,"Small"],[400,"Medium"],[640,"Large"],[1000,"Full width"]].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label><label>Alternative text<input aria-label="Image alternative text" disabled={!editable} value={editor.getAttributes('image').alt??""} onChange={e=>editor.commands.updateAttributes('image',{alt:e.target.value})}/></label><label>Caption<input aria-label="Image caption" disabled={!editable} value={editor.getAttributes('image').caption??""} onChange={e=>editor.commands.updateAttributes('image',{caption:e.target.value})}/></label></div>}
    {(state?.image||state?.file)&&mediaEnabled&&<div className="context-tools"><button disabled={!editable||!commentsReady} onClick={()=>openMedia(state.image?'image':'file',undefined,true)}>Replace {state.image?'image':'file'}</button>{!commentsReady&&<small>Save current changes before replacing media.</small>}</div>}
    {findOpen&&<div className="page-find" role="search" aria-label="Find within page" onKeyDown={e=>{if(e.key==='Escape')closeFind();if(e.key==='Enter'){e.preventDefault();navigateFind(e.shiftKey?-1:1);}}}><input autoFocus aria-label="Find in this page" value={findQuery} onChange={e=>setFindQuery(e.target.value)} placeholder="Find in this page…"/><label><input type="checkbox" checked={matchCase} onChange={e=>setMatchCase(e.target.checked)}/>Match case</label><span role="status">{state?.find?.matches.length?`${matchIndex+1} of ${state.find.matches.length}`:findQuery.length<2?'2 characters minimum':'No matches'}</span><button aria-label="Previous match" onClick={()=>navigateFind(-1)}>↑</button><button aria-label="Next match" onClick={()=>navigateFind(1)}>↓</button><button aria-label="Close find" onClick={closeFind}>×</button></div>}
    {state?.code&&largeCode(blockRange(editor)?.node.textContent??'')&&<p className="code-fallback" role="status">Large code block · {editor.getAttributes('codeBlock').language??'plaintext'} · shown as plain text. All text and whitespace are preserved.</p>}
    <EditorContent editor={editor}/>
    {editable&&<button className="add-block" onClick={addBlock}>＋ Add block <span>or type / on an empty line</span></button>}
    {notice&&<div className="editor-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={()=>setNotice("")}>×</button></div>}
    {insertOpen&&<Dialog title="Insert a block" onClose={closeInsert}><input className="command-input" aria-label="Search block types" placeholder="Search blocks…" value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setActive(i=>Math.min(filtered.length-1,i+1));}if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(0,i-1));}if(e.key==='Enter'&&filtered[active]){e.preventDefault();insert(filtered[active]);}}}/><div className="insert-results" role="listbox" aria-label="Block types">{filtered.map((item,i)=><button key={item.name} role="option" aria-selected={i===active} onMouseEnter={()=>setActive(i)} onClick={()=>insert(item)}><strong>{item.name}</strong><small>{item.description}</small></button>)}{!filtered.length&&<p>No matching block types. Try another name.</p>}</div></Dialog>}
    {pasteReview&&<PasteReviewDialog editor={editor} source={pasteReview.source} point={pasteReview.point} onClose={()=>setPasteReview(null)}/>}
    {plainPoint&&<PlainPasteDialog editor={editor} point={plainPoint} onClose={()=>setPlainPoint(null)}/>}
    {transformOpen&&<TransformDialog editor={editor} onClose={()=>setTransformOpen(false)}/>}
    {linkOpen&&<LinkDialog editor={editor} onClose={()=>setLinkOpen(false)}/>}
    {pageOpen&&<PageDialog sourcePageId={pageId} onClose={()=>setPageOpen(false)} onSelect={id=>{editor.chain().focus().insertContent({type:'pageLink',attrs:{id:crypto.randomUUID(),pageId:id}}).run();setPageOpen(false);}}/>}
    {media&&mediaTarget&&<UploadDialog key={mediaRecovered?.recordId??mediaTarget.insertId??`${media}:${mediaTarget.blockId}`} pageId={pageId} actorId={recoveryActorId} type={media} initialFile={mediaFile} target={mediaTarget} recovered={mediaRecovered} writable={editable} onClose={closeMedia} onReady={(id,alt,caption,name)=>{applyReadyMedia(editor,mediaTarget,{id,alt,caption,name});closeMedia();}}/>}
  </div>;
}

function clearFormatting(editor:Editor|null){if(!editor)return;const chain=editor.chain().focus();for(const mark of ["bold","italic","underline","strike","textStyle","highlight","code"])chain.unsetMark(mark);chain.run();}
function LinkDialog({editor,onClose}:{editor:Editor;onClose:()=>void}){const [url,setUrl]=useState(String(editor.getAttributes('link').href??"")),[label,setLabel]=useState(""),[error,setError]=useState("");return <Dialog title="Edit link" onClose={onClose}><form onSubmit={e=>{e.preventDefault();if(!safeUrl(url)){setError('Use an https, http, mailto, tel or Holy Sheet page link.');return;}if(label.trim())editor.chain().focus().insertContent({type:'text',text:label,marks:[{type:'link',attrs:{href:url,target:'_blank',rel:'noopener noreferrer'}}]}).run();else editor.chain().focus().extendMarkRange('link').setLink({href:url}).run();onClose();}}><label>Destination<input aria-label="Link destination" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…"/></label><label>Display text (optional)<input aria-label="Link display text" value={label} onChange={e=>setLabel(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<div className="actions"><button type="button" onClick={()=>{editor.chain().focus().extendMarkRange('link').unsetLink().run();onClose();}}>Remove link</button><button className="primary">Save link</button></div></form></Dialog>;}
function PageDialog({sourcePageId,onClose,onSelect}:{sourcePageId:string;onClose:()=>void;onSelect:(id:string)=>void}){const [pages,setPages]=useState<{id:string;title:string}[]>([]),[q,setQ]=useState(""),[error,setError]=useState("");useEffect(()=>{requestJson<{pages:{id:string;title:string;workspaceId:string}[]}>("/api/pages").then(d=>{const source=d.pages.find(p=>p.id===sourcePageId);if(!source)throw Error("Source page is unavailable");setPages(d.pages.filter(p=>p.workspaceId===source.workspaceId));}).catch(()=>setError('Pages could not be loaded. Retry by reopening this dialog.'));},[]);return <Dialog title="Link a page" onClose={onClose}><input className="command-input" aria-label="Find an accessible page" value={q} onChange={e=>setQ(e.target.value)} placeholder="Find a page…"/>{error&&<p role="alert">{error}</p>}<div className="insert-results">{pages.filter(p=>p.title.toLowerCase().includes(q.toLowerCase())).map(p=><button key={p.id} onClick={()=>onSelect(p.id)}>{p.title}</button>)}</div></Dialog>;}
