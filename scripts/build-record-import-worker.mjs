import {build} from 'esbuild';
await build({entryPoints:['scripts/import-record-worker.ts'],outfile:'scripts/dist/import-record-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',sourcemap:false});
console.log('Built isolated shared-record import parser.');
