import { DocumentError,type RichNode } from './document';
import type { Sql } from './database';

export type Anchor={blockId:string;start:number;end:number;quote:string;status:'attached'|'changed'};
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

/** Map only edits demonstrably outside the selected range; ambiguous changes become detached. */
export function mapAnchors(anchors:Anchor[],before:RichNode,after:RichNode):Anchor[]{
  const oldTexts=blockTexts(before),newTexts=blockTexts(after);
  return anchors.map(a=>{
    if(a.status!=='attached')return a;
    const old=oldTexts.get(a.blockId),next=newTexts.get(a.blockId);
    if(old===undefined||next===undefined||old.slice(a.start,a.end)!==a.quote)return {...a,status:'changed'};
    if(old===next)return a;
    let prefix=0;while(prefix<Math.min(old.length,next.length)&&old[prefix]===next[prefix])prefix++;
    let suffix=0;while(suffix<old.length-prefix&&suffix<next.length-prefix&&old[old.length-suffix-1]===next[next.length-suffix-1])suffix++;
    const oldEnd=old.length-suffix,newEnd=next.length-suffix;
    if(oldEnd<=a.start){const delta=newEnd-oldEnd;return {...a,start:a.start+delta,end:a.end+delta};}
    if(prefix>=a.end)return a;
    return {...a,status:'changed'};
  });
}
export async function updateCommentAnchors(tx:Sql,pageId:string,before:RichNode,after:RichNode){
  const result=await tx.query<{id:string;anchors:Anchor[]}>('SELECT id,anchors FROM hs_threads WHERE page_id=$1 FOR UPDATE',[pageId]);
  for(const t of result.rows){const mapped=mapAnchors(t.anchors,before,after);if(JSON.stringify(mapped)!==JSON.stringify(t.anchors))await tx.query('UPDATE hs_threads SET anchors=$2 WHERE id=$1',[t.id,JSON.stringify(mapped)]);}
}
