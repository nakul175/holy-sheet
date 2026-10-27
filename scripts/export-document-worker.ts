import {renderPdf} from '../lib/export-render';
import type {ExportInput} from '../lib/export-plan';
const chunks:Buffer[]=[];let size=0;
process.stdin.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>25_500_000)process.exit(2);chunks.push(chunk);});
process.stdin.on('end',async()=>{try{const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExportInput;const bytes=await renderPdf(input);if(bytes.length>25_000_000)process.exit(2);process.stdout.write(bytes);}catch{process.exitCode=1;}});
