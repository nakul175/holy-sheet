import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
import {create} from 'fontkit';
import vfs from 'pdfmake/build/vfs_fonts.js';
await mkdir('scripts/dist',{recursive:true});
let codePoints;
for(const data of Object.values(vfs)){const font=create(Buffer.from(data,'base64'));if(!('characterSet' in font))throw Error('Expected embedded single font');const set=new Set(font.characterSet);codePoints=codePoints?codePoints.filter(cp=>set.has(cp)):font.characterSet;}
await writeFile('scripts/dist/export-font-coverage.json',JSON.stringify({profile:'pdfmake-0.3.13-roboto-v1',codePoints:codePoints.sort((a,b)=>a-b)})+'\n');
await build({entryPoints:['scripts/export-document-worker.ts'],outfile:'scripts/dist/export-document-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',sourcemap:false,logLevel:'warning'});
console.log('Built isolated export renderer with embedded fonts.');
