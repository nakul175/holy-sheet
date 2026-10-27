import coverage from '../scripts/dist/export-font-coverage.json';
import type {RichNode} from './document';
export type ExportFormat='pdf'|'markdown';
export type ExportReference={available:boolean;title?:string;url?:string};
export type ExportInput={title:string;document:RichNode;version:number;createdAt:string;format:ExportFormat;origin:string;references:Record<string,ExportReference>};
export type ExportReport={blocks:number;omittedAssets:number;unavailableReferences:number;unsupportedCharacters:number;warnings:string[];requiresConfirmation:boolean};
const glyphs=new Set<number>(coverage.codePoints);
export function exportText(n:RichNode):string{return n.type==='text'?n.text??'':n.type==='hardBreak'?'\n':(n.content??[]).map(exportText).join('');}
export function exportHref(raw:string,origin:string){if(!raw||/[\u0000-\u0020\u007f]/.test(raw)||raw.startsWith('//'))return;try{const relative=/^\/pages\/[a-zA-Z0-9_-]+(?:#[a-zA-Z0-9_-]+)?$/.test(raw);const url=relative?new URL(raw,origin):new URL(raw);return ['https:','http:','mailto:','tel:'].includes(url.protocol)?url.href:undefined;}catch{return;}}
export function exportReport(input:ExportInput):ExportReport{
 let blocks=0,omittedAssets=0,unavailableReferences=0,unsupportedCharacters=0,markdownStyles=false,hasSections=false;const strings=[input.title];
 const visit=(n:RichNode)=>{if(!['doc','text','hardBreak'].includes(n.type))blocks++;if(n.type==='text')strings.push(n.text??'');if(n.type==='image'||n.type==='file'){omittedAssets++;strings.push(String(n.attrs?.alt??n.attrs?.title??''),String(n.attrs?.caption??''));}if(n.type==='pageLink'){const ref=input.references[String(n.attrs?.pageId)];if(!ref?.available)unavailableReferences++;else strings.push(ref.title??'Page');}if(n.type==='details')hasSections=true;if(n.marks?.some(m=>['underline','textStyle','highlight'].includes(m.type)))markdownStyles=true;n.content?.forEach(visit);};visit(input.document);
 for(const value of strings)for(const ch of value){const cp=ch.codePointAt(0)!,control=(cp<32||cp===127||cp>=0xD800&&cp<=0xDFFF)&&!['\n','\r','\t'].includes(ch);if(control||(input.format==='pdf'&&!['\n','\r','\t'].includes(ch)&&!glyphs.has(cp)))unsupportedCharacters++;}
 const warnings:string[]=[];if(omittedAssets)warnings.push(`${omittedAssets} image/file references use labelled placeholders; no attachment bytes or private download URLs are included.`);if(unavailableReferences)warnings.push(`${unavailableReferences} unavailable page references use a safe label without their title or URL.`);if(unsupportedCharacters)warnings.push(input.format==='pdf'?`${unsupportedCharacters} characters are unavailable in the PDF font and need labelled U+ placeholders. Choose Markdown for exact Unicode text.`:`${unsupportedCharacters} non-printable or invalid characters need labelled U+ placeholders.`);if(input.format==='markdown'&&markdownStyles)warnings.push('Markdown keeps text and portable emphasis; underline, colours and highlights are omitted.');if(hasSections)warnings.push('Collapsible sections are expanded in the downloaded copy.');warnings.push('Only this saved page title and body are included. Comments, history, child pages and access grants are excluded.');
 return {blocks,omittedAssets,unavailableReferences,unsupportedCharacters,warnings,requiresConfirmation:omittedAssets>0||unsupportedCharacters>0};
}
export function pdfSafeText(value:string,cell=false){const replaced=Array.from(value,ch=>['\n','\r','\t'].includes(ch)?ch==='\t'?'    ':ch:glyphs.has(ch.codePointAt(0)!)?ch:`[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4,'0')}]`).join('');const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),step=cell?2:16;return replaced.replace(/\S+/g,word=>{const parts=Array.from(segmenter.segment(word),x=>x.segment);return parts.map((p,i)=>p+(i<parts.length-1&&(i+1)%step===0?'\u200b':'')).join('');});}
export function exportFilename(title:string,version:number,format:ExportFormat){const clean=Array.from(title.normalize('NFKC').replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu,'-').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'')).slice(0,80).map(ch=>{const cp=ch.codePointAt(0)!;return cp>=0xD800&&cp<=0xDFFF?'-':ch;}).join('')||'Holy Sheet';const name=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)?'HS-'+clean:clean;return `${name}-v${version}.${format==='pdf'?'pdf':'md'}`;}
function portableText(value:string){return Array.from(value,ch=>{const cp=ch.codePointAt(0)!;return ((cp<32||cp===127||cp>=0xD800&&cp<=0xDFFF)&&!['\n','\r','\t'].includes(ch))?`[U+${cp.toString(16).toUpperCase().padStart(4,'0')}]`:ch;}).join('');}
function escape(value:string){return portableText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_[\]{}()#+.!|~-])/g,'\\$1');}
function fence(value:string){return '`'.repeat(Math.max(3,...Array.from(value.matchAll(/`+/g),m=>m[0].length+1)));}
export function renderMarkdown(input:ExportInput){
 const inline=(nodes:RichNode[]):string=>nodes.map(n=>{if(n.type==='hardBreak')return '  \n';if(n.type!=='text')return inline(n.content??[]);let value=escape(n.text??'');if(n.marks?.some(m=>m.type==='code')){const code=portableText(n.text??''),f=fence(code);value=`${f} ${code} ${f}`;}if(n.marks?.some(m=>m.type==='bold'))value=`**${value}**`;if(n.marks?.some(m=>m.type==='italic'))value=`*${value}*`;if(n.marks?.some(m=>m.type==='strike'))value=`~~${value}~~`;const link=n.marks?.find(m=>m.type==='link'),url=link&&exportHref(String(link.attrs?.href??''),input.origin);if(url)value=`[${value}](<${url.replace(/[<>]/g,c=>encodeURIComponent(c))}>)`;return value;}).join('');
 const headings:string[]=[];const collect=(n:RichNode)=>{if(n.type==='heading')headings.push(exportText(n));n.content?.forEach(collect);};collect(input.document);
 function body(nodes:RichNode[]):string{return nodes.map(n=>{
  if(n.type==='paragraph'||n.type==='detailsSummary')return inline(n.content??[]);
  if(n.type==='heading')return '#'.repeat(Number(n.attrs?.level)||1)+' '+inline(n.content??[]);
  if(n.type==='codeBlock'){const value=portableText(exportText(n)),f=fence(value);return `${f}${String(n.attrs?.language??'plaintext')}\n${value}\n${f}`;}
  if(n.type==='horizontalRule')return '---';
  if(['bulletList','orderedList','taskList'].includes(n.type)){const start=Number.isSafeInteger(Number(n.attrs?.start))?Number(n.attrs?.start):1;return (n.content??[]).map((item,i)=>{const prefix=n.type==='taskList'?`- [${item.attrs?.checked?'x':' '}] `:n.type==='orderedList'?`${start+i}. `:'- ',parts=body(item.content??[]).split('\n');return prefix+parts[0]+parts.slice(1).map(line=>'\n'+(line?' '.repeat(prefix.length)+line:'')).join('');}).join('\n');}
  if(n.type==='blockquote'||n.type==='callout')return body(n.content??[]).split('\n').map(line=>'> '+line).join('\n');
  if(n.type==='details')return (n.content??[]).map(child=>child.type==='detailsSummary'?'### '+inline(child.content??[]):body(child.content??[])).join('\n\n');
  if(n.type==='table'){const rows=(n.content??[]).map(row=>(row.content??[]).map(cell=>body(cell.content??[]).replace(/\n/g,'<br>'))),hasHeader=n.content?.[0]?.content?.every(c=>c.type==='tableHeader'),header=hasHeader?rows[0]??[]:(rows[0]??[]).map(()=>''),data=hasHeader?rows.slice(1):rows;return '| '+header.join(' | ')+' |\n| '+header.map(()=>'---').join(' | ')+' |'+data.map(row=>'\n| '+row.join(' | ')+' |').join('');}
  if(n.type==='image')return '[Image omitted'+(n.attrs?.alt?': '+escape(String(n.attrs.alt)):'')+']'+(n.attrs?.caption?'\n\n'+escape(String(n.attrs.caption)):'');
  if(n.type==='file')return '[File omitted'+(n.attrs?.title?': '+escape(String(n.attrs.title)):'')+']'+(n.attrs?.caption?'\n\n'+escape(String(n.attrs.caption)):'');
  if(n.type==='pageLink'){const ref=input.references[String(n.attrs?.pageId)],url=ref?.available&&ref.url&&exportHref(ref.url,input.origin);return ref?.available&&url?`[${escape(ref.title??'Page')}](<${url}>)`:'[Page reference unavailable]';}
  if(n.type==='tableOfContents')return '**Contents**\n\n'+headings.map(h=>'- '+escape(h)).join('\n');
  return body(n.content??[]);
 }).join('\n\n');}
 return '# '+escape(input.title)+'\n\n'+body(input.document.content??[])+'\n';
}
