import mammoth from 'mammoth';
import {crc32} from 'node:zlib';
import MarkdownIt from 'markdown-it';
import yauzl from 'yauzl';
import {parseDocument} from 'htmlparser2';
import type {AnyNode,Element} from 'domhandler';
import type {RichNode} from './document';

export class ImportConversionError extends Error {}
export const importLimits={sourceBytes:20*1024*1024,expandedBytes:100*1024*1024,blocks:10_000,entries:5000};
export type ImportFormat='txt'|'md'|'docx';
export type ImportConversion={document:RichNode;warnings:string[];omittedImages:number;expandedBytes:number;blocks:number};
function utf8(data:Uint8Array){try{return new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new ImportConversionError('Only valid UTF-8 text/XML is supported.');}}
function href(value:string){if(!value||/[\u0000-\u0020\u007f]/.test(value)||value.startsWith('//'))return false;try{return ['https:','http:','mailto:','tel:'].includes(new URL(value).protocol);}catch{return false;}}
function tag(n:AnyNode){return 'name' in n&&typeof n.name==='string'?n.name.toLowerCase():'';}
function children(n:AnyNode):AnyNode[]{return 'children' in n?n.children:[];}
function text(n:AnyNode):string{return n.type==='text'?n.data:tag(n)==='br'?'\n':children(n).map(text).join('');}
const unsafe=new Set(['script','style','iframe','object','embed','svg','math','form','input','button','textarea','link','meta','template']);

// Source HTML is never rendered. This inert parser emits only a small structured-node
// allowlist; the parent validates that result against HS's authoritative rich schema.
export function convertImportHtml(html:string){
 const warnings=new Set<string>();let omittedImages=0,blocks=0;
 const warn=(message:string)=>warnings.add(message),block=(type:string,content?:RichNode[],attrs?:Record<string,unknown>):RichNode=>{if(++blocks>importLimits.blocks)throw new ImportConversionError('More than 10,000 parsed blocks. Split the source first.');return {type,...(attrs?{attrs}:{}),...(content?{content}:{})};};
 function inline(nodes:AnyNode[],marks:NonNullable<RichNode['marks']>=[],depth=0):RichNode[]{if(depth>24)throw new ImportConversionError('Source nesting is too deep.');return nodes.flatMap(n=>{
  if(n.type==='text')return n.data?[{type:'text',text:n.data,...(marks.length?{marks}: {})}]:[];
  const name=tag(n);if(unsafe.has(name)){warn('Active or unsupported HTML elements were omitted.');return [];}
  if(name==='br')return [{type:'hardBreak'}];
  if(name==='img'){omittedImages++;warn('Images were omitted and were not downloaded or uploaded.');const alt=(n as Element).attribs.alt?.slice(0,500);return [{type:'text',text:`[Image omitted${alt?': '+alt:''}]`}];}
  const mark=({strong:'bold',b:'bold',em:'italic',i:'italic',u:'underline',s:'strike',del:'strike',strike:'strike',code:'code'} as Record<string,string>)[name];let next=marks;
  if(mark&&!marks.some(m=>m.type===mark))next=[...marks,{type:mark}];
  if(name==='a'){const url=(n as Element).attribs.href??'';if(href(url))next=[...marks.filter(m=>m.type!=='link'),{type:'link',attrs:{href:url,target:'_blank',rel:'noopener noreferrer'}}];else if(url)warn('Unsafe or relative links became plain text.');}
  return inline(children(n),next,depth+1);
 });}
 function table(n:AnyNode,depth:number):RichNode{
  const sourceRows:AnyNode[]=[];function findRows(x:AnyNode){for(const c of children(x)){if(tag(c)==='table')throw new ImportConversionError('Nested tables must be simplified before import.');if(tag(c)==='tr')sourceRows.push(c);else findRows(c);}}findRows(n);
  const rows:RichNode[][]=[];if(sourceRows.length>100)throw new ImportConversionError('Tables support at most 100 rows.');
  for(let y=0;y<sourceRows.length;y++){rows[y]??=[];let x=0;for(const cell of children(sourceRows[y]).filter(c=>['td','th'].includes(tag(c)))){
   while(rows[y][x])x++;const a=(cell as Element).attribs,span=(v:string|undefined)=>v===undefined?1:Number(v),cols=span(a.colspan),height=span(a.rowspan);
   if(!Number.isInteger(cols)||!Number.isInteger(height)||cols<1||height<1||x+cols>20||y+height>100)throw new ImportConversionError('Table expansion exceeds 100 rows or 20 columns.');
   if(cols>1||height>1)warn('Merged table cells were split; text remains in their first cell.');
   const nested=children(cell).some(c=>['ul','ol','table','h1','h2','h3','pre','blockquote'].includes(tag(c)));if(nested)warn('Complex table-cell formatting became readable text.');
   const content=nested?[block('paragraph',text(cell)?[{type:'text',text:text(cell)}]:[])]:[block('paragraph',inline(children(cell),[],depth+1))];
   for(let dy=0;dy<height;dy++)for(let dx=0;dx<cols;dx++){rows[y+dy]??=[];if(rows[y+dy][x+dx])throw new ImportConversionError('Overlapping table spans are unsupported.');rows[y+dy][x+dx]=block(tag(cell)==='th'?'tableHeader':'tableCell',!dy&&!dx?content:[block('paragraph',[])],{colspan:1,rowspan:1});}x+=cols;
  }}
  const width=Math.max(0,...rows.map(r=>r.length));if(!width)throw new ImportConversionError('The table has no readable cells.');return block('table',rows.map(row=>block('tableRow',Array.from({length:width},(_,x)=>row[x]??block('tableCell',[block('paragraph',[])],{colspan:1,rowspan:1})))));
 }
 function list(n:AnyNode,depth:number):RichNode[]{
  const result:RichNode[]=[];let group:RichNode[]=[];let kind='';let consumed=0;
  const flush=()=>{if(group.length){result.push(block(kind,group,kind==='orderedList'?{start:Math.max(1,Number((n as Element).attribs.start)||1)+consumed-group.length}:undefined));group=[];}};
  for(const child of children(n).filter(c=>tag(c)==='li')){
   const parsed=flow(children(child),depth+1);if(!parsed.length)parsed.push(block('paragraph',[]));const first=parsed[0],firstText=first.type==='paragraph'?first.content?.[0]:undefined,match=firstText?.type==='text'?/^\[([ xX])\]\s+/.exec(firstText.text??''):null;
   const next=match?'taskList':tag(n)==='ol'?'orderedList':'bulletList';if(kind!==next){flush();kind=next;}if(match){firstText!.text=firstText!.text!.slice(match[0].length);if(!firstText!.text)first.content!.shift();}
   group.push(block(match?'taskItem':'listItem',parsed,match?{checked:match[1].toLowerCase()==='x'}:undefined));consumed++;
  }flush();return result;
 }
 function flow(nodes:AnyNode[],depth=0):RichNode[]{if(depth>10)throw new ImportConversionError('Source nesting exceeds the supported document depth.');const out:RichNode[]=[];let pending:AnyNode[]=[];
  const flush=()=>{if(pending.length){const content=inline(pending);if(content.some(c=>c.type!=='text'||c.text?.trim()))out.push(block('paragraph',content));pending=[];}};
  for(const n of nodes){const name=tag(n);if(n.type==='comment'||n.type==='directive')continue;if(unsafe.has(name)){flush();warn('Active or unsupported HTML elements were omitted.');continue;}
   if(['p','h1','h2','h3','h4','h5','h6','pre','ul','ol','blockquote','hr','table','div','section','article'].includes(name)){
    flush();if(/^h[1-6]$/.test(name)){const level=Math.min(3,Number(name[1]));if(Number(name[1])>3)warn('Headings below level three became level-three headings.');out.push(block('heading',inline(children(n)),{level}));}
    else if(name==='p')out.push(block('paragraph',inline(children(n))));
    else if(name==='pre'){let language='plaintext';const code=children(n).find(c=>tag(c)==='code'),match=code&&/\blanguage-([a-z0-9+#-]+)/i.exec((code as Element).attribs.class??'');const supported=['plaintext','bash','javascript','typescript','json','html','css','sql','python','java','csharp','cpp','go','rust','php','ruby','yaml','markdown'];if(match&&supported.includes(match[1]))language=match[1];else if(match)warn('Unsupported code languages became plain text code.');out.push(block('codeBlock',text(n)?[{type:'text',text:text(n).replace(/\n$/,'')}]:[],{language}));}
    else if(name==='ul'||name==='ol')out.push(...list(n,depth));
    else if(name==='blockquote')out.push(block('blockquote',flow(children(n),depth+1)));
    else if(name==='hr')out.push(block('horizontalRule'));
    else if(name==='table')out.push(table(n,depth));
    else out.push(...flow(children(n),depth+1));
   }else pending.push(n);
  }flush();return out;
 }
 const content=flow(parseDocument(html,{decodeEntities:true}).children);if(!content.length)content.push(block('paragraph',[]));return {document:{type:'doc',content} as RichNode,warnings:[...warnings],omittedImages,blocks};
}

async function inspectWord(buffer:Buffer){return new Promise<{expandedBytes:number}>((resolve,reject)=>{
 yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,zip)=>{
  if(error||!zip){reject(new ImportConversionError('Corrupt, encrypted or unsupported Word archive.'));return;}
  let total=0,entries=0,actual=0,failed=false,contentTypes='',hasDocument=false;const names=new Set<string>();
  const fail=(message:string)=>{if(failed)return;failed=true;zip.close();reject(new ImportConversionError(message));};zip.on('error',()=>fail('Corrupt Word archive.'));
  zip.on('end',()=>{if(!failed){if(!hasDocument||!contentTypes.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')||/macroenabled|vba/i.test(contentTypes))fail('Only non-macro Word .docx documents are supported.');else resolve({expandedBytes:actual});}});
  zip.on('entry',entry=>{
   const name=String(entry.fileName),key=name.toLowerCase();if(++entries>importLimits.entries||names.has(key)||name.includes('\\')||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.')||/^[a-z]:/i.test(name)){fail('Unsupported duplicate, unsafe path or excessive Word archive entries.');return;}names.add(key);
   if((entry.generalPurposeBitFlag&1)||![0,8].includes(entry.compressionMethod)||/vbaproject|activex|(?:^|\/)embeddings\//i.test(name)){fail('Encrypted files, macros and embedded active objects are not supported.');return;}
   total+=entry.uncompressedSize;if(total>importLimits.expandedBytes||entry.uncompressedSize>importLimits.expandedBytes){fail('Expanded source exceeds 100 MiB.');return;}
   if(name.endsWith('/')){zip.readEntry();return;}
   zip.openReadStream(entry,(error,stream)=>{
    if(error||!stream){fail('Corrupt Word archive entry.');return;}let read=0,checksum=0;const xml=/\.(xml|rels)$/i.test(name),parts:Buffer[]=[];
    stream.on('data',(part:Buffer)=>{read+=part.length;actual+=part.length;checksum=crc32(part,checksum);if(actual>importLimits.expandedBytes||(xml&&read>25_000_000)){stream.destroy();fail('Expanded source or XML document exceeds the supported size.');return;}if(xml)parts.push(part);});
    stream.on('error',()=>fail('Corrupt Word archive data or size.'));
    stream.on('end',()=>{if(failed)return;if(checksum!==entry.crc32){fail('Corrupt Word archive checksum.');return;}try{if(xml){const value=utf8(Buffer.concat(parts));if(/<!DOCTYPE|<!ENTITY/i.test(value)||value.includes('\u0000'))throw new ImportConversionError('DTD, external entities and non-UTF-8 Word XML are not supported.');if(name==='[Content_Types].xml')contentTypes=value;if(name==='word/document.xml')hasDocument=true;}}catch(e){fail(e instanceof Error?e.message:'Unsupported Word XML.');return;}zip.readEntry();});
   });
  });zip.readEntry();
 });
});}
export async function convertImport(buffer:Buffer,format:ImportFormat):Promise<ImportConversion>{
 if(!buffer.length||buffer.length>importLimits.sourceBytes)throw new ImportConversionError('Choose one non-empty file of at most 20 MiB.');let expandedBytes=buffer.length,html:string,warnings:string[]=[];
 if(format==='txt'){
  const source=utf8(buffer);if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source))throw new ImportConversionError('The source is not a supported plain text document.');const lines=source.replace(/\r\n?/g,'\n').split('\n');if(lines.length>importLimits.blocks)throw new ImportConversionError('More than 10,000 parsed blocks. Split the source first.');return {document:{type:'doc',content:lines.map(line=>({type:'paragraph',...(line?{content:[{type:'text',text:line}]}:{})}))},warnings:[],omittedImages:0,expandedBytes,blocks:lines.length};
 }
 if(format==='md'){const source=utf8(buffer);if(source.includes('\u0000'))throw new ImportConversionError('The source is not a supported Markdown document.');html=new MarkdownIt({html:false,linkify:false,typographer:false,maxNesting:12}).render(source);warnings.push('Raw HTML remains literal text; remote images are never fetched.');}
 else if(format==='docx'){
  ({expandedBytes}=await inspectWord(buffer));const result=await mammoth.convertToHtml({buffer},{externalFileAccess:false,convertImage:mammoth.images.imgElement(async()=>({src:''}))});html=result.value;warnings.push('Word layout, comments, tracked-change history and document permissions are not imported.');if(result.messages.length)warnings.push('Word conversion reported unsupported formatting; review the complete preview.');
 }else throw new ImportConversionError('Choose .docx, .md or .txt.');
 const converted=convertImportHtml(html);return {...converted,expandedBytes,warnings:[...new Set([...warnings,...converted.warnings])]};
}
