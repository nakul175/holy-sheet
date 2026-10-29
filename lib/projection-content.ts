import {DocumentError,documentLimits,idTypes,type RichNode} from './document';
import type {ProjectionBudget} from './publication-projection';
type Size={bytes:number;blocks:number};
const identified=new Set(idTypes);
const tooLarge=()=>new DocumentError('Published content exceeds the document resource limit. Split the page or reduce its source blocks.','publication_resource_limit',422);
const cap=(value:number|undefined,maximum:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(Math.floor(value),maximum):maximum;

// Count JSON incrementally, including escapes and surrogate pairs. Neither a
// whole expanded document nor a large escaped string is allocated to measure it.
function measure(value:unknown,maxBytes:number,maxBlocks:number,work?:ProjectionBudget):Size{
 let bytes=0,blocks=0;
 const add=(n:number)=>{bytes+=n;if(bytes>maxBytes)throw tooLarge();};
 function visit(item:unknown):void{
  work?.check();
  if(typeof item==='string'){
   add(2);
   for(let i=0;i<item.length;i++){
    if((i&255)===0)work?.check();const c=item.charCodeAt(i);
    if(c===34||c===92)add(2);
    else if(c<32)add([8,9,10,12,13].includes(c)?2:6);
    else if(c<128)add(1);
    else if(c<2048)add(2);
    else if(c>=0xd800&&c<=0xdbff&&item.charCodeAt(i+1)>=0xdc00&&item.charCodeAt(i+1)<=0xdfff){add(4);i++;}
    else if(c>=0xd800&&c<=0xdfff)add(6);
    else add(3);
   }
   work?.check();return;
  }
  if(Array.isArray(item)){add(2+Math.max(0,item.length-1));for(const child of item)visit(child??null);return;}
  if(item&&typeof item==='object'){
   const node=item as RichNode;if(identified.has(node.type)&&++blocks>maxBlocks)throw tooLarge();
   const fields=Object.entries(item).filter(([,v])=>v!==undefined);add(2+Math.max(0,fields.length-1));
   for(const [key,child]of fields){visit(key);add(1);visit(child);}return;
  }
  add((JSON.stringify(item)??'null').length);
 }
 visit(value);work?.check();return {bytes,blocks};
}
export class ProjectedContent{
 private size:Size={bytes:0,blocks:0};
 private readonly bytes:number;private readonly blocks:number;
 constructor(private readonly work?:ProjectionBudget){this.bytes=cap(work?.contentLimits?.bytes,documentLimits.bytes);this.blocks=cap(work?.contentLimits?.blocks,documentLimits.blocks);}
 reserveTree(node:RichNode){const n=measure(node,this.bytes-this.size.bytes,this.blocks-this.size.blocks,this.work);this.size={bytes:this.size.bytes+n.bytes,blocks:this.size.blocks+n.blocks};}
 replace(before:RichNode,after:RichNode){const old=measure(before,this.bytes,this.blocks,this.work),next=measure(after,this.bytes-this.size.bytes+old.bytes,this.blocks-this.size.blocks+old.blocks,this.work);this.size={bytes:this.size.bytes-old.bytes+next.bytes,blocks:this.size.blocks-old.blocks+next.blocks};}
 reserveShallow(node:RichNode){const shell=node.content?{...node,content:[]}:node;const extra=node.content?Math.max(0,node.content.length-1):0;const n=measure(shell,this.bytes-this.size.bytes-extra,this.blocks-this.size.blocks,this.work);this.size={bytes:this.size.bytes+n.bytes+extra,blocks:this.size.blocks+n.blocks};}
}

// Reserve each node and its array separators BEFORE cloning/appending it. A
// replacement's descendants are already resolved source content, not new pins.
export function cloneProjection(document:RichNode,work?:ProjectionBudget,transform:(n:RichNode)=>RichNode=n=>n){
 const resources=new ProjectedContent(work);
 function walk(node:RichNode,apply=true):RichNode{
  work?.check();const selected=apply?transform(node):node;resources.reserveShallow(selected);
  const copy=structuredClone(selected.content?{...selected,content:[]}:selected);work?.check();
  if(selected.content)for(const child of selected.content){const projected=walk(child,apply&&selected===node);work?.check();copy.content!.push(projected);}
  return copy;
 }
 return walk(document);
}
