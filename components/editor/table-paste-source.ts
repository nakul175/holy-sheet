import type { Editor } from '@tiptap/core';
import { DOMParser as PMParser } from '@tiptap/pm/model';
import { ensureIds,type RichNode } from '../../lib/document';
import { normalizeRichDocument } from '../../lib/editor-document';
import { sanitizePaste } from '../../lib/editor-paste';
export type PasteGrid={rows:RichNode[][]};
export type TablePasteSource={grids:PasteGrid[];text:string;warnings:string[]};
const maxCells=10_000;
export function blankPasteCell(header=false,text=''):RichNode{return ensureIds({type:'doc',content:[{type:header?'tableHeader':'tableCell',attrs:{colspan:1,rowspan:1},content:[{type:'paragraph',...(text?{content:[{type:'text',text}]}:{})}]}]}).content![0];}
export function parseTsv(text:string):string[][]{
 const rows:string[][]=[],row:string[]=[];let value='',quoted=false,closedQuote=false,atStart=true,cells=0;
 const cell=()=>{row.push(value);value='';atStart=true;closedQuote=false;if(++cells>maxCells)throw Error('More than 10,000 source cells; use literal text or split the source first.');};
 const line=()=>{cell();rows.push(row.splice(0));};
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'&&atStart){quoted=true;atStart=false;continue;}if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{quoted=false;closedQuote=true;}}else value+=c;continue;}if(closedQuote&&!['\t','\r','\n'].includes(c))throw Error('Ambiguous quoted cells need review as complete literal text.');if(c==='\t'){cell();continue;}if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;line();continue;}value+=c;atStart=false;}
 if(quoted)throw Error('An unclosed quoted cell needs review as literal text.');if(value||row.length||!rows.length)line();return rows;
}
function readable(node:Node):string{
 if(node.nodeType===3)return node.nodeValue??'';if(node.nodeType!==1)return '';const e=node as Element,tag=e.tagName.toLowerCase();
 if(tag==='br')return '\n';
 if(tag==='table')return Array.from(e.querySelectorAll('tr')).filter(r=>r.closest('table')===e).map(r=>Array.from(r.children).filter(c=>['TD','TH'].includes(c.tagName)).map(readable).join('\t')).join('\n');
 if(tag==='ol'||tag==='ul')return Array.from(e.children).map((c,i)=>(tag==='ol'?`${Number(e.getAttribute('start')??1)+i}. `:'• ')+readable(c).replace(/\n$/,'')).join('\n')+'\n';
 const text=Array.from(e.childNodes).map(readable).join('');return text+(['p','div','pre','h1','h2','h3','li','blockquote'].includes(tag)?'\n':'');
}
export function parseTablePasteSource(editor:Editor,html:string,text:string):TablePasteSource{
 const warnings:string[]=[];if(new TextEncoder().encode(html).byteLength>25_000_000)return {grids:[],text,warnings:['The rich source exceeds the 25 MB safety bound. Review the literal text, or split the source first.']};
 if(!html||!/<table[\s>]/i.test(html)){
  try{const rows=parseTsv(text),width=Math.max(...rows.map(r=>r.length));if(rows.length*width>maxCells)throw Error('Rectangular expansion exceeds 10,000 source cells. Use complete literal text or split the source first.');if(rows.some(r=>r.length!==width))warnings.push('Short rows will receive empty cells; no source text is clipped.');return {grids:[{rows:rows.map(r=>Array.from({length:width},(_,i)=>blankPasteCell(false,r[i]??'')))}],text,warnings};}
  catch(e){return {grids:[],text,warnings:[e instanceof Error?e.message:'Review this source as literal text.']};}
 }
 const dom=new DOMParser().parseFromString(sanitizePaste(html),'text/html'),tables=Array.from(dom.querySelectorAll('table')).filter(t=>!t.parentElement?.closest('table'));
 const fallback=text&&text!==html?text:readable(dom.body).replace(/\n$/,'');
 const outside=dom.body.cloneNode(true) as HTMLElement;outside.querySelectorAll('table').forEach(t=>t.remove());if(outside.textContent?.trim())return {grids:[],text:fallback,warnings:['This source mixes tables with surrounding text. Use the complete literal text to avoid dropping content.']};
 if(/<img[\s>]/i.test(html))warnings.push('Images require private upload. Rich table conversion includes readable upload placeholders.');
 let cellCount=0;const grids:PasteGrid[]=[];
 try{for(const table of tables){const startCells=cellCount,rows:RichNode[][]=[];const sourceRows=Array.from(table.querySelectorAll('tr')).filter(row=>row.closest('table')===table);if(sourceRows.length>maxCells)throw Error('Too many source rows. Use complete literal text or split the source first.');
  for(let y=0;y<sourceRows.length;y++){rows[y]??=[];let x=0;for(const cell of Array.from(sourceRows[y].children).filter(c=>['TD','TH'].includes(c.tagName))){while(rows[y][x])x++;const colSpan=Math.max(1,Number(cell.getAttribute('colspan'))||1),rowSpan=Math.max(1,Number(cell.getAttribute('rowspan'))||1);if(!Number.isSafeInteger(colSpan)||!Number.isSafeInteger(rowSpan)||colSpan*rowSpan>maxCells||cellCount+colSpan*rowSpan>maxCells)throw Error('Expanded table exceeds 10,000 source cells. Use complete literal text or split the source first.');
   if(colSpan>1||rowSpan>1)warnings.push('Merged cells will be unmerged. Their text stays in the first cell and covered positions become empty cells.');
   const wrapper=dom.createElement('div');Array.from(cell.childNodes).forEach(n=>wrapper.append(n.cloneNode(true)));let content:RichNode[];
   const nested=!!cell.querySelector('table');const parsed=normalizeRichDocument(PMParser.fromSchema(editor.schema).parse(wrapper).toJSON()).content??[];
   const allowed=(n:RichNode):boolean=>['paragraph','taskList','taskItem','text','hardBreak'].includes(n.type)&&(n.content??[]).every(allowed);
   if(nested||!parsed.every(allowed)){warnings.push('Unsupported or nested cell blocks will become readable literal text inside that cell.');content=blankPasteCell(false,readable(cell).replace(/\n$/,'')).content!;}
   else content=parsed.length?parsed:blankPasteCell().content!;
   for(let dy=0;dy<rowSpan;dy++)for(let dx=0;dx<colSpan;dx++){rows[y+dy]??=[];if(rows[y+dy][x+dx])throw Error('Overlapping merged cells need review as complete literal text.');const value=blankPasteCell(cell.tagName==='TH');if(!dy&&!dx)value.content=content;rows[y+dy][x+dx]=value;cellCount++;}x+=colSpan;
  }}
  const width=Math.max(0,...rows.map(r=>r.length));if(!width)throw Error('This table has no readable cells.');const padded=rows.length*width-(cellCount-startCells);if(cellCount+padded>maxCells)throw Error('Rectangular expansion exceeds 10,000 source cells. Use complete literal text or split the source first.');cellCount+=padded;for(const row of rows)for(let x=0;x<width;x++)row[x]??=blankPasteCell();grids.push({rows});
 }}catch(e){return {grids:[],text:fallback,warnings:[...new Set([...warnings,e instanceof Error?e.message:'Review this source as literal text.'])]};}
 return {grids,text:fallback,warnings:[...new Set(warnings)]};
}
