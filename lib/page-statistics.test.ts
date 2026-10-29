import {describe,it,expect} from 'vitest';
import {calculatePageStatistics,pageStatisticsJob,readingTime} from './page-statistics';
const text=(value:string)=>({type:'text',text:value});
const p=(value:string)=>({type:'paragraph',content:[text(value)]});
const doc=(...content:unknown[])=>({type:'doc',content});
function counts(value:unknown,segmenter:typeof Intl.Segmenter|null=Intl.Segmenter){const result=calculatePageStatistics(value,true,segmenter);expect(result.status).toBe('ready');if(result.status!=='ready')throw Error(result.reason);return result.counts;}
describe('authorized body extraction',()=>{
 it('joins inline runs, separates rich blocks/table cells/rows/hard breaks and counts the same exact body',()=>{
  const rich=doc({type:'heading',content:[text('A'),text('B')]},{type:'bulletList',content:[{type:'listItem',content:[p('CD')]}]},{type:'table',content:[{type:'tableRow',content:[{type:'tableCell',content:[p('EF')]},{type:'tableHeader',content:[p('GH')]}]}]},{type:'codeBlock',content:[text('IJ'),{type:'hardBreak'},text('KL')]});
  // AB\nCD\nEF\tGH\nIJ\nKL
  expect(counts(rich)).toEqual({words:6,characters:17,charactersWithoutWhitespace:12,approximate:false});
 });
 it('never expands referenced/service/attachment content or counts attributes, marks, root metadata/title',()=>{
  expect(counts({...doc(p('Visible'),{type:'pageLink',attrs:{title:'secret'},content:[text('secret')]},{type:'file',attrs:{caption:'secret'},content:[text('secret')]},{type:'tableOfContents',content:[text('secret')]}),title:'secret',comments:[text('secret')],attrs:{hidden:'secret'}})).toEqual({words:1,characters:10,charactersWithoutWhitespace:7,approximate:false});
 });
 it('includes authorized collapsible document text, never its attributes',()=>expect(counts(doc({type:'details',attrs:{open:false,title:'metadata'},content:[{type:'detailsSummary',content:[text('Summary')]},{type:'detailsContent',content:[p('Body')]}]})).words).toBe(2));
 it('does not parse unknown versions or unknown nested source nodes',()=>{
  expect(calculatePageStatistics(doc(p('secret')),false).status).toBe('unavailable');
  expect(calculatePageStatistics(doc({type:'futureHidden',content:[text('secret')]})).status).toBe('unavailable');
  expect(calculatePageStatistics({type:'futureRoot',content:[p('secret')]}).status).toBe('unavailable');
 });
 it('fails closed on malformed/cyclic/oversized input without mutation',()=>{
  const cyclic:any=doc();cyclic.content=[cyclic];
  for(const value of [null,{},doc({type:'text',text:12}),doc({type:'paragraph',content:'secret'}),cyclic,doc(p('a'.repeat(25_000_001)))])expect(calculatePageStatistics(value).status).toBe('unavailable');
 });
});
describe('Unicode and estimates',()=>{
 it.each(['', '... — !', ' \t\n\u00a0'])('handles empty/punctuation-only bodies %j',value=>expect(counts(doc(p(value))).words).toBe(0));
 it('uses language dictionary segmentation for text without whitespace and mixed scripts',()=>{
  const c=counts(doc(p('你好世界 日本語 ภาษาไทย hello 123')));expect(c.words).toBeGreaterThan(5);expect(c.approximate).toBe(false);
 });
 it('does not count emoji as words and counts ZWJ/flags/modifiers/combining marks as graphemes',()=>expect(counts(doc(p('👨‍👩‍👧‍👦 🇮🇳 👍🏽 e\u0301')))).toEqual({words:1,characters:7,charactersWithoutWhitespace:4,approximate:false}));
 it('removes whitespace before the second grapheme count and preserves repeated spaces/newlines/tabs in the first',()=>expect(counts(doc(p('a \u0301\t\r\nb')))).toEqual({words:2,characters:5,charactersWithoutWhitespace:2,approximate:false}));
 it('uses a deterministic explicitly approximate no-Segmenter fallback',()=>expect(counts(doc(p('Hello, 世界! e\u0301 👨‍👩‍👧‍👦')),null)).toEqual({words:3,characters:21,charactersWithoutWhitespace:18,approximate:true}));
 it('falls back explicitly if the segmenter constructor is unavailable/throws',()=>{
  class Broken{constructor(){throw Error('unsupported');}}
  expect(counts(doc(p('A')),Broken as unknown as typeof Intl.Segmenter).approximate).toBe(true);
 });
 it.each([[0,'0 minutes'],[1,'Less than 1 minute'],[199,'Less than 1 minute'],[200,'1 minute'],[201,'2 minutes'],[400,'2 minutes']])('defines reading estimate for %i words',(n,label)=>expect(readingTime(n as number)).toBe(label));
 it('processes a large synthetic body with cooperative yields and leaves the source unchanged',()=>{
  const document=doc(...Array.from({length:1000},()=>p('word '.repeat(40))));const before=JSON.stringify(document);const job=pageStatisticsJob(document,true);let yields=0,result=job.next();while(!result.done){yields++;result=job.next();}expect(yields).toBeGreaterThan(1000);expect(result.value.status).toBe('ready');if(result.value.status==='ready')expect(result.value.counts.words).toBe(40_000);expect(JSON.stringify(document)).toBe(before);
 });
});
