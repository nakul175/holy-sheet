import { Mapping,type Step } from '@tiptap/pm/transform';
import type { Node } from '@tiptap/pm/model';
import { DocumentError,type RichNode } from './document';
import type { Sql } from './database';
import { richSchema } from './rich-schema';

export type AnchorStatus='attached'|'changed'|'detached';
export type Anchor={blockId:string;start:number;end:number;quote:string;status:AnchorStatus};
export type AnchorInput=Pick<Anchor,'blockId'|'start'|'end'>;
const textTypes=new Set(['paragraph','heading','codeBlock','detailsSummary']);
export function blockTexts(document:RichNode){
  const out=new Map<string,string>();
  function text(n:RichNode):string{return n.type==='text'?n.text??'':n.type==='hardBreak'?'\n':(n.content??[]).map(text).join('');}
  function walk(n:RichNode){if(textTypes.has(n.type)&&typeof n.attrs?.id==='string')out.set(n.attrs.id,text(n));n.content?.forEach(walk);}
  walk(document);return out;
}
export function createAnchors(document:RichNode,input:AnchorInput[]):Anchor[]{
  if(input.length>100)throw new DocumentError('Select a passage within 100 text blocks');
  const texts=blockTexts(document);let total=0;
  return input.map(a=>{const text=texts.get(a.blockId);if(text===undefined||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end<=a.start||a.end>text.length)throw new DocumentError('The selected passage changed. Select it again.','anchor_changed',409);const quote=text.slice(a.start,a.end);total+=[...quote].length;if(total>10000)throw new DocumentError('Select a shorter passage, up to 10,000 characters');return {...a,quote,status:'attached'};});
}

function lost(anchor:Anchor,status:AnchorStatus):Anchor{return {...anchor,status};}
/** Map only edits demonstrably outside the selected range. Deleted text becomes Detached and keeps its quote. */
export function mapAnchors(anchors:Anchor[],before:RichNode,after:RichNode):Anchor[]{
  const oldTexts=blockTexts(before),newTexts=blockTexts(after);
  return anchors.map(a=>{
    if(a.status!=='attached')return a;
    const old=oldTexts.get(a.blockId),next=newTexts.get(a.blockId);
    if(old===undefined||next===undefined)return lost(a,'detached');
    if(old.slice(a.start,a.end)!==a.quote)return lost(a,next.includes(a.quote)?'changed':'detached');
    if(old===next)return a;
    let prefix=0;while(prefix<Math.min(old.length,next.length)&&old[prefix]===next[prefix])prefix++;
    let suffix=0;while(suffix<old.length-prefix&&suffix<next.length-prefix&&old[old.length-suffix-1]===next[next.length-suffix-1])suffix++;
    const oldEnd=old.length-suffix,newEnd=next.length-suffix;
    if(oldEnd<=a.start){const delta=newEnd-oldEnd;return {...a,start:a.start+delta,end:a.end+delta};}
    if(prefix>=a.end)return a;
    return lost(a,next.includes(a.quote)?'changed':'detached');
  });
}

function absoluteOffset(doc:Node,blockId:string,offset:number){
  let found:number|null=null;
  doc.descendants((node,pos)=>{
    if(found!==null)return false;
    if(node.isTextblock&&node.attrs.id===blockId){found=offset>=0&&offset<=node.content.size?pos+1+offset:-1;return false;}
  });
  return found;
}
function place(doc:Node,from:number,to:number){
  if(to<from||from<0||to>doc.content.size)return null;
  const $from=doc.resolve(from);
  for(let depth=$from.depth;depth>0;depth--){
    const node=$from.node(depth);
    if(!node.isTextblock||typeof node.attrs.id!=='string')continue;
    const start=from-$from.start(depth),end=to-$from.start(depth);
    if(start<0||end>node.content.size||to>$from.end(depth))return null;
    return {blockId:node.attrs.id,start,end,text:node.textBetween(start,end,'','\n')};
  }
  return null;
}
/** Remap block-local anchors through ProseMirror collaboration steps. Null means the steps could not be replayed. */
export function mapAnchorsThroughSteps(anchors:Anchor[],before:RichNode,steps:Step[]):Anchor[]|null{
  if(!steps.length)return anchors;
  try{
    const schema=richSchema();
    const source=schema.nodeFromJSON(before);
    let doc=source;
    const mapping=new Mapping();
    for(const step of steps){
      mapping.appendMap(step.getMap());
      const result=step.apply(doc);
      if(result.failed||!result.doc)return null;
      doc=result.doc;
    }
    return anchors.map(anchor=>{
      if(anchor.status!=='attached')return anchor;
      const from=absoluteOffset(source,anchor.blockId,anchor.start);
      const to=absoluteOffset(source,anchor.blockId,anchor.end);
      if(from==null||to==null||from<0||to<0||to<=from)return lost(anchor,'detached');
      let removed=false;
      for(let pos=from;pos<to;pos++)if(mapping.mapResult(pos,1).deleted){removed=true;break;}
      if(removed)return lost(anchor,'detached');
      const placed=place(doc,mapping.map(from,1),mapping.map(to,-1));
      if(!placed||placed.blockId!==anchor.blockId)return lost(anchor,'detached');
      if(placed.text===anchor.quote)return {...anchor,start:placed.start,end:placed.end,status:'attached'};
      if(!placed.text)return lost(anchor,'detached');
      return {...anchor,start:placed.start,end:placed.end,quote:placed.text,status:'attached'};
    });
  }catch{return null;}
}
export async function updateCommentAnchors(tx:Sql,pageId:string,before:RichNode,after:RichNode){
  const result=await tx.query<{id:string;anchors:Anchor[]}>('SELECT id,anchors FROM hs_threads WHERE page_id=$1 FOR UPDATE',[pageId]);
  for(const t of result.rows){const mapped=mapAnchors(t.anchors,before,after);if(JSON.stringify(mapped)!==JSON.stringify(t.anchors))await tx.query('UPDATE hs_threads SET anchors=$2 WHERE id=$1',[t.id,JSON.stringify(mapped)]);}
}
