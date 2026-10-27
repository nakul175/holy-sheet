import {build} from 'esbuild';
await build({entryPoints:['scripts/import-document-worker.ts'],outfile:'scripts/dist/import-document-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',sourcemap:false});
console.log('Built isolated document import parser.');
