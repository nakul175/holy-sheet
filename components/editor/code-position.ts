import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection,type EditorState } from '@tiptap/pm/state';

export type CodePoint={line:number;character:number;lineLength:number};
export type CodePosition={blockKey:string;lines:number;from:CodePoint;to:CodePoint;range:boolean};
type Line={length:number;boundaries?:number[]};
export const CODE_POSITION_MAX_UNITS=1_000_000;

const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;

function floorIndex(values:readonly number[],offset:number){
  let low=0,high=values.length;
  while(low<high){const middle=(low+high)>>>1;if(values[middle]<=offset)low=middle+1;else high=middle;}
  return low-1;
}

/** Index one immutable code string. LF/CRLF split lines; a lone CR stays literal. */
export function createCodePositionIndex(text:string){
  // Optional inspection must not allocate unbounded line indexes for a pasted
  // 25 MB document. Larger code remains untouched/readable without a count.
  if(text.length>CODE_POSITION_MAX_UNITS)return {lines:0,pointAt:(_offset:number):CodePoint|null=>null};
  const starts=[0],ends:number[]=[],lines=new Map<number,Line>();
  for(let i=0;i<text.length;i++)if(text.charCodeAt(i)===10){
    ends.push(i>starts.at(-1)!&&text.charCodeAt(i-1)===13?i-1:i);starts.push(i+1);
  }
  ends.push(text.length);
  function pointAt(offset:number):CodePoint|null{
    if(!Number.isInteger(offset)||offset<0||offset>text.length)return null;
    const lineIndex=floorIndex(starts,offset),local=Math.min(offset,ends[lineIndex])-starts[lineIndex];
    let line=lines.get(lineIndex);
    if(!line){
      const value=text.slice(starts[lineIndex],ends[lineIndex]);
      if(/^[\x00-\x7f]*$/.test(value))line={length:value.length};
      else{
        // Never substitute code-unit counts for graphemes on unsupported engines.
        if(!segmenter)return null;
        const boundaries=[0];
        for(const part of segmenter.segment(value))boundaries.push(part.index+part.segment.length);
        line={length:boundaries.length-1,boundaries};
      }
      lines.set(lineIndex,line);
    }
    return {line:lineIndex+1,character:line.boundaries?floorIndex(line.boundaries,local)+1:local+1,lineLength:line.length};
  }
  return {lines:starts.length,pointAt};
}

/** Cache only the currently selected immutable block, scoped to one editor/context. */
export function createCodePositionReader(){
  let cachedNode:PMNode|null=null,index:ReturnType<typeof createCodePositionIndex>|null=null;
  return function codePosition(state:EditorState):CodePosition|null{
  const selection=state.selection;
  if(!(selection instanceof TextSelection)){cachedNode=null;index=null;return null;}
  const {$from,$to}=selection,node=$from.parent;
  if(node.type.name!=='codeBlock'||!$from.sameParent($to)||node.content.size>CODE_POSITION_MAX_UNITS){cachedNode=null;index=null;return null;}
  if(cachedNode!==node||!index){cachedNode=node;index=createCodePositionIndex(node.textContent);}
  const from=index.pointAt($from.parentOffset),to=index.pointAt($to.parentOffset);
  if(!from||!to)return null;
  return {blockKey:String(node.attrs.id??$from.start()),lines:index.lines,from,to,range:!selection.empty};
  };
}

export function codePositionText(value:CodePosition|null){
  if(!value)return '';
  const {from,to,lines}=value;
  if(value.range)return `Code selection: line ${from.line}, character ${from.character} to line ${to.line}, character ${to.character}. ${lines} logical line${lines===1?'':'s'}.`;
  return `Code: line ${from.line} of ${lines}, character position ${from.character}${from.character===from.lineLength+1?' (end of line)':''}. ${from.lineLength} character${from.lineLength===1?'':'s'} in line.`;
}

/** Character-only motion/typing is deliberately excluded from live announcements. */
export function codePositionAnnouncement(value:CodePosition|null){
  if(!value)return {key:'',text:''};
  const {from,to,lines,range,blockKey}=value;
  return {key:JSON.stringify([blockKey,lines,range,from.line,to.line]),text:range
    ?`Code selection, lines ${from.line} to ${to.line} of ${lines}.`
    :`Code block, line ${from.line} of ${lines}.`};
}
