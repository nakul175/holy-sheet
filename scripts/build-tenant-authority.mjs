import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source='integrations/central/tenant-authority.ts',out='artifacts/central-tenant-authority';
await mkdir(out,{recursive:true});
await build({entryPoints:[source],outfile:out+'/tenant-authority.mjs',bundle:true,platform:'node',format:'esm',target:'node22',packages:'external'});
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
await writeFile(out+'/provenance.json',JSON.stringify({source,sourceSha256:await sha(source),moduleSha256:await sha(out+'/tenant-authority.mjs'),liveDeployment:false},null,2)+'\n');
