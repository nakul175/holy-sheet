import {convertImport,ImportConversionError,type ImportFormat,importLimits} from '../lib/import-conversion';
const parts:Buffer[]=[];let bytes=0;
process.stdin.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>importLimits.sourceBytes){process.stdout.write(JSON.stringify({error:'Source exceeds 20 MiB.'}));process.exit(1);}parts.push(part);});
process.stdin.on('end',async()=>{try{const result=await convertImport(Buffer.concat(parts),process.argv[2] as ImportFormat);process.stdout.write(JSON.stringify({result}));}catch(error){process.stdout.write(JSON.stringify({error:error instanceof ImportConversionError?error.message:'The source could not be parsed safely. Try a supported, unencrypted document.'}));process.exitCode=1;}});
