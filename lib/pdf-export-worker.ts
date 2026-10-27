import {spawn} from 'node:child_process';
import path from 'node:path';
import {DocumentError} from './document';
import {claimDocumentWorker} from './document-worker-gate';
import type {ExportInput} from './export-plan';
export async function generatePrivatePdf(input:ExportInput):Promise<Buffer>{
 const release=claimDocumentWorker();try{return await new Promise((resolve,reject)=>{
  const file=path.join(process.cwd(),'scripts/dist/export-document-worker.cjs'),child=spawn(process.execPath,['--max-old-space-size=256','--disallow-code-generation-from-strings','--permission','--allow-fs-read='+file,file],{cwd:process.cwd(),env:{NODE_ENV:'production',NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','ignore']});let finished=false,size=0;const chunks:Buffer[]=[];
  const finish=(error?:DocumentError,bytes?:Buffer)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(bytes!);};const timer=setTimeout(()=>finish(new DocumentError('PDF generation exceeded its time budget. Split the page or choose Markdown.','export_timeout',422)),15000);
  child.on('error',()=>finish(new DocumentError('The PDF renderer is temporarily unavailable. Retry the same job.','export_unavailable',503)));child.stdin.on('error',()=>{});child.stdout.on('data',(part:Buffer)=>{size+=part.length;if(size>25_000_000)finish(new DocumentError('PDF exceeds 25 MB. Split the page or choose Markdown.','export_size',413));else chunks.push(part);});child.on('close',code=>{if(finished)return;const bytes=Buffer.concat(chunks);if(code!==0||bytes.subarray(0,5).toString()!=='%PDF-')finish(new DocumentError('PDF could not be rendered within the supported limits. Choose Markdown or split the page.','export_render',422));else finish(undefined,bytes);});const payload=JSON.stringify(input);if(Buffer.byteLength(payload)>25_500_000){finish(new DocumentError('The snapshot exceeds the export size limit.','export_size',413));return;}child.stdin.end(payload);
 });}finally{release();}
}
