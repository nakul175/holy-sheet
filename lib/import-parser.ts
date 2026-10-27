import {spawn} from 'node:child_process';
import path from 'node:path';
import {DocumentError,ensureIds,validateDocument} from './document';
import type {ImportConversion,ImportFormat} from './import-conversion';
let busy=false;
export async function parseImport(bytes:Buffer,format:ImportFormat):Promise<ImportConversion>{
 if(busy)throw new DocumentError('The document parser is busy. Keep this file selected and retry.','import_busy',503);
 if(!bytes.length||bytes.length>20*1024*1024)throw new DocumentError('Choose one non-empty file of at most 20 MiB.','import_size',413);
 if(!['txt','md','docx'].includes(format))throw new DocumentError('Choose .docx, .md or .txt.','import_format');
 busy=true;
 try{return await new Promise((resolve,reject)=>{
  const worker=path.join(process.cwd(),'scripts/dist/import-document-worker.cjs');
  // No application environment, credentials, filesystem writes, child processes,
  // native addons or evaluated strings are available to the bundled parser.
  // This is process/resource isolation, not a claim of an OS network sandbox.
  const child=spawn(process.execPath,['--max-old-space-size=256','--disallow-code-generation-from-strings','--permission','--allow-fs-read='+worker,worker,format],{cwd:process.cwd(),env:{NODE_ENV:'production',NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','ignore']});
  const chunks:Buffer[]=[];let size=0,finished=false;
  const finish=(error?:DocumentError,value?:ImportConversion)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(value!);};
  const timer=setTimeout(()=>finish(new DocumentError('Conversion exceeded its time budget. Split the source and retry.','import_timeout',422)),15000);
  child.on('error',()=>finish(new DocumentError('The isolated document parser is unavailable. Keep the file selected and retry.','import_unavailable',503)));
  child.stdin.on('error',()=>{});
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>25_000_000)finish(new DocumentError('Converted document exceeds the supported size. Split the source.','import_size',413));else chunks.push(chunk);});
  child.on('close',()=>{if(finished)return;try{
   const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof reply.error==='string'){finish(new DocumentError(reply.error.slice(0,240),'import_conversion',422));return;}
   const result=reply.result as ImportConversion;let nodes=0;const check=(value:unknown,depth=0)=>{if(!value||typeof value!=='object'||depth>12||++nodes>100_000)throw Error('Invalid parser output');const n=value as {content?:unknown[]};if(n.content){if(!Array.isArray(n.content))throw Error('Invalid parser output');for(const c of n.content)check(c,depth+1);}};check(result?.document);
   if(!Array.isArray(result.warnings)||result.warnings.length>30||result.warnings.some(w=>typeof w!=='string'||w.length>240)||!Number.isInteger(result.omittedImages)||result.omittedImages<0||!Number.isInteger(result.blocks)||result.blocks>10000||!Number.isInteger(result.expandedBytes)||result.expandedBytes>100*1024*1024)throw Error('Invalid parser output');
   result.document=validateDocument(ensureIds(result.document,true));finish(undefined,result);
  }catch(error){finish(error instanceof DocumentError?error:new DocumentError('The source could not be converted safely. Split it or choose a supported document.','import_conversion',422));}});
  child.stdin.end(bytes);
 });}finally{busy=false;}
}
