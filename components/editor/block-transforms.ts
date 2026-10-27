import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { plainText,stableStringify,validateDocument,type RichNode } from '../../lib/document';
export const transformTargets=['paragraph','heading-1','heading-2','heading-3','bullet','number','checklist','quote'] as const;
export type TransformTarget=typeof transformTargets[number];
type ShortcutEvent=Pick<KeyboardEvent,'key'|'code'|'metaKey'|'ctrlKey'|'shiftKey'|'altKey'|'isComposing'>&{keyCode?:number;getModifierState?:(key:string)=>boolean};
export function transformShortcut(event:ShortcutEvent,active:{heading?:number;quote?:boolean;bullet?:boolean;number?:boolean;checklist?:boolean}={}):TransformTarget|null{
 if(event.isComposing||event.getModifierState?.('AltGraph')||!(event.metaKey||event.ctrlKey))return null;const shifted:Record<string,string>={'&':'Digit7','*':'Digit8','(':'Digit9'},code=event.code||(/^\d$/.test(event.key)?'Digit'+event.key:shifted[event.key]??(event.keyCode&&event.keyCode>=48&&event.keyCode<=57?'Digit'+(event.keyCode-48):''));
 if(event.altKey&&!event.shiftKey&&/^Digit[0-3]$/.test(code)){const level=Number(code.at(-1));return !level||active.heading===level?'paragraph':`heading-${level}` as TransformTarget;}
 if(event.shiftKey&&!event.altKey){if(code==='Digit7')return active.number?'paragraph':'number';if(code==='Digit8')return active.bullet?'paragraph':'bullet';if(code==='Digit9')return active.checklist?'paragraph':'checklist';if(code==='KeyB'||event.key.toLowerCase()==='b'||event.keyCode===66)return active.quote?'paragraph':'quote';}
 return null;
}
export const transformLabels:Record<TransformTarget,string>={paragraph:'Paragraph','heading-1':'Heading 1','heading-2':'Heading 2','heading-3':'Heading 3',bullet:'Bulleted item',number:'Numbered item',checklist:'Checklist item',quote:'Quote'};
export type TransformPlan={from:number;to:number;expected:string;replacement:RichNode[];warnings:string[];text:string;blockId:string;target:TransformTarget;noop:boolean};
type Normalizer=(document:RichNode)=>RichNode;
const identity:Normalizer=d=>d;
const fresh=()=>crypto.randomUUID();
const listType=(target:TransformTarget)=>target==='bullet'?'bulletList':target==='number'?'orderedList':target==='checklist'?'taskList':null;
export function planBlockTransform(editor:Editor,target:TransformTarget,normalize:Normalizer=identity):TransformPlan{
 if(!editor.isEditable)throw Error('This page is read only.');
 const {$from,$to}=editor.state.selection;
 if(!$from.sameParent($to))throw Error('Choose text in one block to transform. No content changed.');
 let depth=$from.depth;
 if(!['paragraph','heading'].includes($from.node(depth).type.name))throw Error('Only text, headings, list items and quotes can be transformed. Tables, code and media are kept intact.');
 if(depth>1&&['listItem','taskItem','blockquote'].includes($from.node(depth-1).type.name)){
  if($from.index(depth-1)!==0)throw Error('Select the first text block of this item or quote to review its transform.');depth--;
 }
 const unit=$from.node(depth),source=unit.toJSON() as RichNode,blockId=String(unit.attrs.id??'');if(!blockId)throw Error('Wait for this block to receive its stable identity.');
 const wrapped=['listItem','taskItem','blockquote'].includes(source.type),first=wrapped?source.content?.[0]:source;
 if(!first||!['paragraph','heading'].includes(first.type))throw Error('This block cannot be converted without unsupported content loss.');
 const children=wrapped?(source.content??[]).slice(1):[],warnings:string[]=[];
 const destinationList=listType(target),inline=structuredClone(first.content??[]);
 const paragraph:RichNode={type:'paragraph',attrs:{id:wrapped?String(first.attrs?.id??fresh()):fresh()},...(inline.length?{content:inline}:{})};
 let replacement:RichNode[];
 if(destinationList){const item:RichNode={type:target==='checklist'?'taskItem':'listItem',attrs:{id:blockId,...(target==='checklist'?{checked:source.type==='taskItem'&&!!source.attrs?.checked}:{})},content:[paragraph,...structuredClone(children)]};replacement=[{type:destinationList,attrs:{id:fresh(),...(destinationList==='orderedList'?{start:1}:{})},content:[item]}];}
 else if(target==='quote')replacement=[{type:'blockquote',attrs:{id:blockId},content:[paragraph,...structuredClone(children)]}];
 else{replacement=[{type:target==='paragraph'?'paragraph':'heading',attrs:{id:blockId,...(target!=='paragraph'?{level:Number(target.at(-1))}:{})},...(inline.length?{content:inline}:{})},...structuredClone(children)];if(children.length)warnings.push(`${children.length} child block${children.length===1?' will':'s will'} be lifted immediately after the transformed text. Their content and links will be kept.`);}
 if(source.type==='taskItem'&&target!=='checklist')warnings.push('The checklist checked marker will be removed. Undo restores it.');
 let from=$from.before(depth),to=$from.after(depth),noop=(source.type==='paragraph'&&target==='paragraph')||(source.type==='heading'&&target===`heading-${source.attrs?.level}`)||(source.type==='blockquote'&&target==='quote');
 if(['listItem','taskItem'].includes(source.type)){
  const parent=$from.node(depth-1),index=$from.index(depth-1),parentJson=parent.toJSON() as RichNode;
  noop=parent.type.name===destinationList;
  if(noop)replacement=[source];
  else{
   const before=parentJson.content!.slice(0,index),after=parentJson.content!.slice(index+1);
   const segments:RichNode[]=[];
   if(before.length)segments.push({...parentJson,content:before});
   if(!before.length&&!after.length&&destinationList)replacement[0].attrs={...replacement[0].attrs,id:parent.attrs.id};
   segments.push(...replacement);
   if(after.length)segments.push({...parentJson,attrs:{...parentJson.attrs,id:before.length?fresh():parent.attrs.id,...(parent.type.name==='orderedList'?{start:Number(parent.attrs.start??1)+index+1}:{})},content:after});
   replacement=segments;from=$from.before(depth-1);to=$from.after(depth-1);
  }
 }
 const expected=stableStringify(editor.state.doc.slice(from,to).content.toJSON()),plan={from,to,expected,replacement,warnings,text:plainText(first),blockId,target,noop};
 if(!noop){const nodes=replacement.map(n=>editor.schema.nodeFromJSON(n)),tr=editor.state.tr.replaceWith(from,to,Fragment.fromArray(nodes));validateDocument(normalize(tr.doc.toJSON()));}
 return plan;
}
export function applyBlockTransform(editor:Editor,plan:TransformPlan,normalize:Normalizer=identity){
 if(editor.isDestroyed||!editor.isEditable)throw Error('The page is no longer editable. No content changed.');
 if(plan.to>editor.state.doc.content.size||stableStringify(editor.state.doc.slice(plan.from,plan.to).content.toJSON())!==plan.expected)throw Error('The source changed while this preview was open. Review the transform again.');
 if(plan.noop)return;
 const nodes=plan.replacement.map(n=>editor.schema.nodeFromJSON(n));let tr=editor.state.tr.replaceWith(plan.from,plan.to,Fragment.fromArray(nodes));validateDocument(normalize(tr.doc.toJSON()));
 let position=plan.from;tr.doc.descendants((node,pos)=>{if(node.attrs.id===plan.blockId)position=pos;});tr=tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(position+1,tr.doc.content.size))));
 editor.view.dispatch(closeHistory(tr).scrollIntoView());editor.view.dispatch(closeHistory(editor.state.tr));editor.view.focus();
}
