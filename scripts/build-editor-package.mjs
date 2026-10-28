import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const out='packages/editor/dist';await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
const entryPoints={local:'packages/editor/src/local.tsx',hosted:'packages/editor/src/hosted.tsx',boundary:'packages/editor/src/boundary.tsx'};
// Optional independent asset: other editor features do not require page statistics.
try{await access('lib/page-statistics-worker.ts');entryPoints['page-statistics-worker']='lib/page-statistics-worker.ts';}catch(error){if(error.code!=='ENOENT')throw error;}
const result=await build({entryPoints,outdir:out,bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',packages:'external',jsx:'automatic',metafile:true,define:{__HS_PAGE_STATISTICS_PACKAGE_BASE__:'import.meta.url'},banner:{js:'"use client";'},logLevel:'warning'});
const metadata=JSON.parse(await readFile('packages/editor/package.json','utf8'));
const declared={...metadata.dependencies,...metadata.peerDependencies};
for(const output of Object.values(result.metafile.outputs))for(const item of output.imports)if(item.external){const name=item.path.startsWith('@')?item.path.split('/').slice(0,2).join('/'):item.path.split('/')[0];if(!declared[name])throw new Error(`Undeclared editor dependency: ${name}`);}
const sources=Object.keys(result.metafile.inputs).sort();
if(sources.includes('components/page-statistics.tsx')&&!entryPoints['page-statistics-worker'])throw new Error('Page statistics worker asset is missing');
for(const file of sources)if(/(?:^|\/)(?:auth|database|repository|storage|oidc|suite-session)\.(?:ts|tsx)$/.test(file))throw new Error(`Server module in editor package: ${file}`);
for(const output of Object.values(result.metafile.outputs))for(const item of output.imports)if(item.external&&/^(?:node:|pg$|@aws-sdk\/|@electric-sql\/|openid-client|jose$)/.test(item.path))throw new Error(`Server dependency in editor package: ${item.path}`);
const entries=[];for(const file of [...sources,'app/globals.css','packages/editor/src/contracts.ts','packages/editor/package.json','packages/editor/README.md','scripts/build-editor-package.mjs'].sort())entries.push({path:file,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
await writeFile(`${out}/source-manifest.json`,JSON.stringify({package:'@aplyd/holy-sheet-editor',protocolVersion:1,sources:entries},null,2)+'\n');
const bundledStyles=await Promise.all([...new Set(Object.values(result.metafile.outputs).map(output=>output.cssBundle).filter(Boolean))].sort().map(file=>readFile(file,'utf8')));
await writeFile(`${out}/styles.css`,[await readFile('app/globals.css','utf8'),...bundledStyles].join('\n'));
await copyFile('packages/editor/src/contracts.ts',`${out}/contracts.d.ts`);
await writeFile(`${out}/local.d.ts`,"import type {JSX} from 'react';\nimport type {LocalEditorProps} from './contracts';\nexport type {LocalEditorProps,SessionProvider,ViewContext} from './contracts';\nexport {createHolySheetSessionProvider} from './boundary';\nexport declare function HolySheetEditor(props:LocalEditorProps):JSX.Element;\n");
await writeFile(`${out}/hosted.d.ts`,"import type {JSX} from 'react';\nimport type {HostedEditorProps} from './contracts';\nexport type {HostedEditorProps,HostSessionProvider,HostSession} from './contracts';\nexport declare const editorProtocolVersion=1;\nexport declare function HolySheetEditor(props:HostedEditorProps):JSX.Element;\n");
await writeFile(`${out}/boundary.d.ts`,"import type {JSX} from 'react';\nimport type {SessionGateProps,SessionProvider} from './contracts';\nexport type {SessionProvider,SessionResult,ViewContext} from './contracts';\nexport declare function createHolySheetSessionProvider():SessionProvider;\nexport declare function SessionGate(props:SessionGateProps):JSX.Element;\n");
console.log(`Built editor package from ${sources.length} client modules; server modules excluded.`);
