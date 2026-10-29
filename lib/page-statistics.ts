/** Current authorized body only. Never examines attributes, marks, title, DOM or linked pages. */
export type PageStatistics = { words:number; characters:number; charactersWithoutWhitespace:number; approximate:boolean };
export type StatisticsResult = { status:'ready'; counts:PageStatistics } | { status:'unavailable'; reason:string };
const containers=new Set(['doc','bulletList','orderedList','listItem','taskList','taskItem','blockquote','callout','table','tableRow','tableCell','tableHeader','details','detailsContent']);
const inlineContainers=new Set(['paragraph','heading','detailsSummary','codeBlock']);
const excluded=new Set(['image','file','pageLink','tableOfContents','horizontalRule']);
export const statisticsLocale='en';
export const readingWordsPerMinute=200;
export function readingTime(words:number){return words===0?'0 minutes':words<readingWordsPerMinute?'Less than 1 minute':`${Math.ceil(words/readingWordsPerMinute).toLocaleString('en')} ${words<=readingWordsPerMinute?'minute':'minutes'}`;}

/** Yields bounded batches so a no-Worker browser can cooperate with input/permission changes.
 * Blocks/rows use LF, table cells TAB, hard breaks LF; adjacent inline runs concatenate.
 * Character counts segment this exact text, then the same text with JS Unicode whitespace removed.
 * Locale en is fixed for deterministic locale selection; dictionary boundaries follow the browser's ICU.
 * Without Segmenter, Unicode letter/number runs and code points are explicitly approximate.
 */
export function* pageStatisticsJob(document:unknown,supportedSchema:boolean,Segmenter:typeof Intl.Segmenter|null|undefined=Intl.Segmenter):Generator<void,StatisticsResult>{
 if(!supportedSchema)return {status:'unavailable',reason:'Statistics are unavailable for this document version.'};
 const parts:string[]=[];let nodes=0,units=0,invalid=false;
 function* walk(value:unknown,depth:number):Generator<void>{
  if(invalid)return;
  if(++nodes%128===0)yield;
  if(nodes>1_000_000||depth>32||!value||typeof value!=='object'||Array.isArray(value)){invalid=true;return;}
  const node=value as {type?:unknown;text?:unknown;content?:unknown};
  if(excluded.has(String(node.type)))return;
  if(node.type==='text'){
   if(typeof node.text!=='string'||node.content!==undefined){invalid=true;return;}
   units+=node.text.length;if(units>25_000_000){invalid=true;return;}parts.push(node.text);return;
  }
  if(node.type==='hardBreak'){parts.push('\n');return;}
  if(!containers.has(String(node.type))&&!inlineContainers.has(String(node.type))){invalid=true;return;}
  if(node.content!==undefined&&!Array.isArray(node.content)){invalid=true;return;}
  const children=(node.content??[]) as unknown[];
  const separator=inlineContainers.has(String(node.type))?'':node.type==='tableRow'?'\t':'\n';
  for(let i=0;i<children.length;i++){if(i)parts.push(separator);yield* walk(children[i],depth+1);if(invalid)return;}
 }
 if(!document||typeof document!=='object'||(document as {type?:unknown}).type!=='doc')return {status:'unavailable',reason:'Statistics are unavailable for unsupported document content.'};
 yield* walk(document,0);
 if(invalid)return {status:'unavailable',reason:'Statistics are unavailable for unsupported or oversized document content.'};
 const text=parts.join('');yield;
 let words=0,characters=0,charactersWithoutWhitespace=0,steps=0;
 let wordSegmenter:Intl.Segmenter|undefined,graphemeSegmenter:Intl.Segmenter|undefined;
 try{if(Segmenter){wordSegmenter=new Segmenter(statisticsLocale,{granularity:'word'});graphemeSegmenter=new Segmenter(statisticsLocale,{granularity:'grapheme'});}}catch{wordSegmenter=undefined;graphemeSegmenter=undefined;}
 if(wordSegmenter&&graphemeSegmenter){
  for(const part of wordSegmenter.segment(text)){if(part.isWordLike)words++;if(++steps%128===0)yield;}
  for(const _ of graphemeSegmenter.segment(text)){characters++;if(++steps%128===0)yield;}
  for(const _ of graphemeSegmenter.segment(text.replace(/\s/gu,''))){charactersWithoutWhitespace++;if(++steps%128===0)yield;}
 }else{
  const matches=text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu);
  for(const _ of matches){words++;if(++steps%128===0)yield;}
  for(const char of text){characters++;if(!/\s/u.test(char))charactersWithoutWhitespace++;if(++steps%128===0)yield;}
 }
 return {status:'ready',counts:{words,characters,charactersWithoutWhitespace,approximate:!wordSegmenter||!graphemeSegmenter}};
}
export function calculatePageStatistics(document:unknown,supportedSchema=true,Segmenter:typeof Intl.Segmenter|null|undefined=Intl.Segmenter):StatisticsResult{
 const job=pageStatisticsJob(document,supportedSchema,Segmenter);for(;;){const result=job.next();if(result.done)return result.value;}
}
