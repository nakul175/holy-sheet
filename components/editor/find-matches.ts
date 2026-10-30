export type LiteralMatchOptions={matchCase?:boolean;wholeWords?:boolean};

const wordCharacter=/[\p{L}\p{M}\p{N}\p{Pc}]/u;
const escapeLiteral=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function codePointBefore(value:string,index:number){
  if(index<=0)return '';
  const tail=value.charCodeAt(index-1);
  const start=tail>=0xdc00&&tail<=0xdfff&&index>1?index-2:index-1;
  return value.slice(start,index);
}

function codePointAt(value:string,index:number){
  if(index>=value.length)return '';
  const point=value.codePointAt(index);
  return point===undefined?'':String.fromCodePoint(point);
}

export function findLiteralRanges(value:string,query:string,{matchCase=false,wholeWords=false}:LiteralMatchOptions={}){
  const ranges:{index:number;length:number}[]=[];
  if(!query)return ranges;
  const pattern=new RegExp(escapeLiteral(query),matchCase?'gu':'giu');
  for(const hit of value.matchAll(pattern)){
    const index=hit.index??0,end=index+hit[0].length;
    if(wholeWords&&(wordCharacter.test(codePointBefore(value,index))||wordCharacter.test(codePointAt(value,end))))continue;
    ranges.push({index,length:hit[0].length});
  }
  return ranges;
}
