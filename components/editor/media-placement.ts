import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { stableStringify } from '../../lib/document';
export type MediaPlacement={kind:'after'|'replace';blockId:string;expected:string;expectedHash?:string;type:'image'|'file';attachmentId?:string;alt?:string;caption?:string;insertId?:string};
export function mediaTypeForFile(file:Pick<File,'name'>):'image'|'file'|null{const extension=file.name.split('.').at(-1)?.toLowerCase();if(['png','jpg','jpeg','webp','gif'].includes(extension??''))return 'image';if(['pdf','docx','xlsx','pptx','csv','txt','md','markdown'].includes(extension??''))return 'file';return null;}
export function captureMediaPlacement(editor:Editor,type:'image'|'file',replace=false,position=editor.state.selection.from):MediaPlacement{
 const resolved=editor.state.doc.resolve(Math.max(0,Math.min(position,editor.state.doc.content.size)));
 let node=resolved.depth?resolved.node(1):editor.state.doc.child(Math.min(resolved.index(0),editor.state.doc.childCount-1));
 if(replace){if(!(editor.state.selection instanceof NodeSelection)||!['image','file'].includes(editor.state.selection.node.type.name))throw Error('Select the image or file to replace.');node=editor.state.selection.node;if(node.type.name!==type)throw Error('Choose a replacement of the same media type.');}
 if(!node.attrs.id)throw Error('This block is still receiving its stable identity. Try again after saving.');
 return {kind:replace?'replace':'after',blockId:node.attrs.id,expected:stableStringify(node.toJSON()),type,...(replace?{attachmentId:node.attrs.attachmentId,alt:node.attrs.alt??'',caption:node.attrs.caption??''}:{insertId:crypto.randomUUID()})};
}
export function applyReadyMedia(editor:Editor,target:MediaPlacement,media:{id:string;name:string;alt:string;caption:string}){
 if(editor.isDestroyed||!editor.isEditable)throw Error('The page is no longer editable. The previous content was kept.');
 const attributes=(base:Record<string,unknown>)=>({...base,attachmentId:media.id,...(target.type==='image'?{src:`/api/media/${media.id}`,alt:media.alt,caption:media.caption,width:base.width??640}:{title:media.name})});
 const intendedId=target.kind==='replace'?target.blockId:target.insertId;
 if(intendedId){const matches:NonNullable<ReturnType<typeof editor.state.doc.nodeAt>>[]=[];editor.state.doc.descendants(node=>{if(node.attrs.id===intendedId)matches.push(node);});if(matches.length>1)throw Error('Upload identity is ambiguous. Review the page before retrying.');const existing=matches[0];if(existing&&existing.attrs.attachmentId===media.id){const base=target.kind==='replace'?(JSON.parse(target.expected).attrs??{}):{id:intendedId},expected=editor.schema.nodes[target.type].create(attributes(base));if(stableStringify(existing.toJSON())===stableStringify(expected.toJSON()))return;throw Error('This upload is already present with newer metadata. Review the existing block; no content was replaced.');}if(existing&&target.kind==='after')throw Error('This upload identity is already in use. Review the page before retrying.');}
 let position:number|undefined;editor.state.doc.descendants((n,pos)=>{if(n.attrs.id===target.blockId)position=pos;});
 if(position===undefined)throw Error('The destination block was removed. Cancel and choose a new placement.');
 const original=editor.state.doc.nodeAt(position)!;
 if(stableStringify(original.toJSON())!==target.expected)throw Error('The destination changed while uploading. Cancel and review the current page; no content was replaced.');
 const attrs:Record<string,unknown>=target.kind==='replace'?{...original.attrs}:{id:target.insertId??crypto.randomUUID()};
 const next=attributes(attrs);
 let tr=editor.state.tr;
 if(target.kind==='replace')tr=tr.setNodeMarkup(position,undefined,next);
 else{const at=position+original.nodeSize,node=editor.schema.nodes[target.type].create(next),resolved=tr.doc.resolve(at);if(!resolved.parent.canReplaceWith(resolved.index(),resolved.index(),node.type))throw Error('This location cannot contain media. Choose a top-level block.');tr=tr.insert(at,node).setSelection(NodeSelection.create(tr.doc,at));}
 editor.view.dispatch(closeHistory(tr).scrollIntoView());editor.view.dispatch(closeHistory(editor.state.tr));editor.view.focus();
}
