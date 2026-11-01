import pdfmake from 'pdfmake';
import fonts from 'pdfmake/build/fonts/Roboto.js';
import type {Content,ContentText,TDocumentDefinitions} from 'pdfmake/interfaces';
import type {RichNode} from './document';
import {exportHref,exportText,pdfSafeText,type ExportInput} from './export-plan';
import {formatPrintedAtIst} from './record-page-refs';
type Renderer=typeof pdfmake&{virtualfs:{writeFileSync:(name:string,data:string,encoding:'base64')=>void}};
const renderer=pdfmake as Renderer;
for(const [name,value] of Object.entries(fonts.vfs))renderer.virtualfs.writeFileSync(name,value.data,value.encoding);
renderer.addFonts(fonts.fonts);renderer.setUrlAccessPolicy(()=>false);renderer.setLocalAccessPolicy(()=>false);
export async function renderPdf(input:ExportInput):Promise<Buffer>{
 let wide=false;const headings:string[]=[];const visit=(n:RichNode)=>{if(n.type==='table'&&(n.content?.[0]?.content?.length??0)>6)wide=true;if(n.type==='heading')headings.push(exportText(n));n.content?.forEach(visit);};visit(input.document);
 const inline=(nodes:RichNode[],cell=false):ContentText[]=>nodes.flatMap(n=>{
  if(n.type==='hardBreak')return [{text:'\n'}];if(n.type!=='text')return inline(n.content??[],cell);const marks=n.marks??[],decoration:('underline'|'lineThrough')[]=[];if(marks.some(m=>m.type==='underline'))decoration.push('underline');if(marks.some(m=>m.type==='strike'))decoration.push('lineThrough');const link=marks.find(m=>m.type==='link'),url=link&&exportHref(String(link.attrs?.href??''),input.origin),color=marks.find(m=>m.type==='textStyle')?.attrs?.color,highlight=marks.find(m=>m.type==='highlight')?.attrs?.color;
  return [{text:pdfSafeText(n.text??'',cell),...(marks.some(m=>m.type==='bold')?{bold:true}:{}),...(marks.some(m=>m.type==='italic')?{italics:true}:{}),...(decoration.length?{decoration}:{}),...(url?{link:url}:{}),...(typeof color==='string'?{color}:{}),...(typeof highlight==='string'?{background:highlight}:{}),...(marks.some(m=>m.type==='code')?{background:'#f3f4f6'}:{})}];
 });
 function blocks(nodes:RichNode[],cell=false,depth=0):Content[]{const out:Content[]=[];for(const n of nodes){
  if(n.type==='paragraph'||n.type==='detailsSummary'){out.push({text:inline(n.content??[],cell),margin:[0,0,0,cell?4:8],preserveLeadingSpaces:true});continue;}
  if(n.type==='heading'){const level=Number(n.attrs?.level)||1;out.push({text:inline(n.content??[],cell),fontSize:level===1?20:level===2?16:13,bold:true,headlineLevel:level,margin:[0,12,0,7]});continue;}
  if(n.type==='codeBlock'){out.push({text:pdfSafeText(exportText(n),cell)||' ',fontSize:9,lineHeight:1.1,preserveLeadingSpaces:true,preserveTrailingSpaces:true,background:'#f3f4f6',margin:[0,4,0,10]});continue;}
  if(n.type==='horizontalRule'){out.push({canvas:[{type:'line',x1:0,y1:0,x2:350,y2:0,lineWidth:.5,lineColor:'#cbd5e1'}],margin:[0,8,0,10]});continue;}
  if(['bulletList','orderedList','taskList'].includes(n.type)){
   const start=Number.isSafeInteger(Number(n.attrs?.start))?Number(n.attrs?.start):1;for(const [index,item] of (n.content??[]).entries()){
    const prefix=n.type==='taskList'?`[${item.attrs?.checked?'x':' '}] `:n.type==='orderedList'?`${start+index}. `:'- ',first=item.content?.[0];
    out.push({text:[{text:prefix},...inline(first?.content??[],cell)],margin:[cell?0:depth*12,0,0,4],preserveLeadingSpaces:true});out.push(...blocks(item.content?.slice(1)??[],cell,depth+1));
   }continue;
  }
  if(n.type==='blockquote'||n.type==='callout'){out.push({stack:blocks(n.content??[],cell,depth),margin:[cell?0:12,4,0,8],...(n.type==='callout'?{color:'#334155'}:{italics:true})});continue;}
  if(n.type==='details'){out.push(...blocks(n.content??[],cell,depth));continue;}
  if(n.type==='detailsContent'){out.push(...blocks(n.content??[],cell,depth));continue;}
  if(n.type==='table'){
   const rows=n.content??[],columns=rows[0]?.content?.length??1,headerRows=rows[0]?.content?.every(c=>c.type==='tableHeader')?1:0;
   out.push({table:{widths:Array.from({length:columns},()=>'*' as const),headerRows,dontBreakRows:false,body:rows.map(row=>(row.content??[]).map(c=>({stack:blocks(c.content??[],true),fontSize:9,lineHeight:1.1,...(c.type==='tableHeader'?{bold:true,fillColor:'#edf1f6'}:{})})))},layout:'lightHorizontalLines',margin:[0,5,0,12]});continue;
  }
  if(n.type==='image'||n.type==='file'){const label=n.type==='image'?'Image':'File',description=String(n.attrs?.[n.type==='image'?'alt':'title']??'');out.push({text:pdfSafeText(`[${label} omitted${description?': '+description:''}]`,cell),italics:true,color:'#475569',margin:[0,3,0,8]});if(n.attrs?.caption)out.push({text:pdfSafeText(String(n.attrs.caption),cell),fontSize:10,margin:[0,0,0,8]});continue;}
  if(n.type==='pageLink'){const ref=input.references[String(n.attrs?.pageId)],url=ref?.available&&ref.url&&exportHref(ref.url,input.origin);out.push({text:pdfSafeText(ref?.available?ref.title??'Page':'[Page reference unavailable]',cell),...(url?{link:url,color:'#2453a6',decoration:'underline' as const}:{}),margin:[0,0,0,8]});continue;}
  if(n.type==='recordRef'||n.type==='recordView'){out.push(...renderRecordPdf(n,input,cell));continue;}
  if(n.type==='tableOfContents'){out.push({stack:[{text:'Contents',bold:true},...headings.map(h=>({text:pdfSafeText('- '+h,cell),margin:[0,2,0,2] as [number,number,number,number]}))],margin:[0,5,0,12]});continue;}
  out.push(...blocks(n.content??[],cell,depth));
 }return out;}
 const definition:TDocumentDefinitions={pageSize:'A4',pageOrientation:wide?'landscape':'portrait',pageMargins:[40,40,40,44],defaultStyle:{font:'Roboto',fontSize:11,lineHeight:1.2,color:'#172033'},info:{title:input.title,creator:'Holy Sheet',producer:'Holy Sheet',creationDate:new Date(input.createdAt),modDate:new Date(input.createdAt)},content:[{text:pdfSafeText(input.title),fontSize:26,bold:true,margin:[0,0,0,18]},...blocks(input.document.content??[])],footer:(page,pages)=>({text:`Saved version ${input.version}  |  ${page} / ${pages}`,fontSize:8,color:'#475569',alignment:'center',margin:[0,12,0,0]}),pageBreakBefore:(node,container)=>!!node.headlineLevel&&container.getFollowingNodesOnPage().length===0&&container.getNodesOnNextPage().length>0};
 return Buffer.from(await renderer.createPdf(definition).getBuffer());
}
function renderRecordPdf(node:RichNode,input:ExportInput,cell:boolean):Content[]{
 const key=node.type==='recordRef'?String(node.attrs?.recordId??''):`view:${String(node.attrs?.viewId??'')}`;
 const slice=input.recordReferences?.[key];
 const printed={text:pdfSafeText(formatPrintedAtIst(new Date(input.createdAt)),cell),fontSize:8,color:'#475569',margin:[0,2,0,8] as [number,number,number,number]};
 if(!slice?.available)return [{text:'Restricted record',italics:true,color:'#475569',margin:[0,0,0,4]},printed];
 if(slice.kind==='record'){const url=exportHref(slice.url,input.origin);const lines:Content[]=[{text:pdfSafeText(`Record: ${slice.title}`,cell),...(url?{link:url,color:'#2453a6',decoration:'underline' as const}:{}),margin:[0,0,0,4]}];for(const field of slice.fields)lines.push({text:pdfSafeText(`${field.label}: ${field.value??'—'}`,cell),margin:[0,0,0,2]});lines.push(printed);return lines;}
 const body=slice.rows.map(row=>row.cells.map((value,index)=>({text:pdfSafeText(value===null||slice.columns[index]?.hidden?'—':value,true),fontSize:9})));
 const header=slice.columns.map(column=>({text:pdfSafeText(column.label,true),bold:true,fontSize:9,fillColor:'#edf1f6'}));
 const url=exportHref(slice.url,input.origin);
 return [{text:pdfSafeText(slice.collectionName,cell),...(url?{link:url,color:'#2453a6',decoration:'underline' as const}:{}),margin:[0,0,0,4] as [number,number,number,number]},...(header.length?[{table:{widths:header.map(()=>'*' as const),headerRows:1,body:[header,...body]},layout:'lightHorizontalLines' as const,margin:[0,0,0,4] as [number,number,number,number]}]:[]),{text:pdfSafeText(slice.countLabel,cell),fontSize:9,margin:[0,0,0,2] as [number,number,number,number]},printed];
}
