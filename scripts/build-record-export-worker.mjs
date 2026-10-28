import {build} from 'esbuild';
await build({entryPoints:['scripts/export-record-worker.ts'],outfile:'scripts/dist/export-record-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',sourcemap:false});
console.log('Built isolated shared-record export renderer.');
