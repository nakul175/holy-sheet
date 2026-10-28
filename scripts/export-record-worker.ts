import {renderRecordExport} from '../lib/shared-record-export-conversion';import type {RecordExportTable} from '../lib/shared-record-export-values';
const parts:Buffer[]=[];let size=0;
process.stdin.on('data',(part:Buffer)=>{size+=part.length;if(size>20*1024*1024){process.stderr.write('Record export input exceeded its budget.');process.exit(1);}parts.push(part);});
process.stdin.on('end',async()=>{try{const table=JSON.parse(Buffer.concat(parts).toString('utf8')) as RecordExportTable,bytes=await renderRecordExport(table,process.argv[2] as 'csv'|'xlsx');if(bytes.length>64*1024*1024)throw new Error('Output budget');process.stdout.write(bytes);}catch{process.stderr.write('The record export could not be rendered safely.');process.exitCode=1;}});
