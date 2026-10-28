// Isolated old-image rehearsal only. Never touches staging, production, grants or existing containers.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,chmod,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
const exec=promisify(execFile),docker=process.env.HS_TEST_DOCKER??'docker';
const image=process.env.HS_TEST_ROLLBACK_IMAGE,revision=process.env.HS_TEST_ROLLBACK_REVISION;
assert.match(image??'',/^sha256:[a-f0-9]{64}$/,'Supply an immutable, locally available OLD test image ID.');
assert.match(revision??'',/^[a-f0-9]{40}$/,'Supply its verified source revision.');
const origin='http://127.0.0.1:53106',issuer='https://holy63-synthetic-issuer.invalid';
await mkdir('artifacts/holy63',{recursive:true});
const app='holy63-rollback-guard-test',jwks='holy63-rollback-jwks-test',directory=await mkdtemp(path.resolve('artifacts/holy63/rollback-'));
const checks:{path:string;status:number;code?:string}[]=[];
let appCreated=false,jwksCreated=false;
try{
 const inspected=JSON.parse((await exec(docker,['image','inspect',image!])).stdout)[0];
 assert.equal(inspected.Config.Labels['org.opencontainers.image.revision'],revision);
 const routes=(await exec('git',['ls-tree','-r','--name-only',revision!,'app/api'])).stdout.split('\n').filter(p=>p.endsWith('/route.ts')).map(p=>p.replace(/^app/,'').replace(/\/route.ts$/,''));
 const routeExists=(endpoint:string)=>{const parts=endpoint.split('?')[0].split('/');return routes.some(route=>{const segments=route.split('/');return segments.length===parts.length&&segments.every((segment,i)=>segment===parts[i]||/^\[[^\]]+\]$/.test(segment));});};
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'tls.key'),'-out',path.join(directory,'ca.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
 await chmod(directory,0o755);await chmod(path.join(directory,'ca.pem'),0o644);
 const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'holy63-synthetic-test',alg:'RS256',use:'sig'};
 await writeFile(path.join(directory,'jwks.json'),JSON.stringify({keys:[jwk]}));
 await writeFile(path.join(directory,'server.cjs'),"const fs=require('node:fs'),https=require('node:https');https.createServer({key:fs.readFileSync('/qa/tls.key'),cert:fs.readFileSync('/qa/ca.pem')},(req,res)=>{res.setHeader('content-type','application/json');res.end(fs.readFileSync('/qa/jwks.json'));}).listen(3443,'0.0.0.0');");
 const appArgs=['run','--detach','--name',app,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','100','--memory','512m','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--publish','127.0.0.1:53106:3000','--mount',`type=bind,source=${directory},target=/qa,readonly`,
  '--env','HS_LOCAL_PREVIEW=0','--env','HS_RICH_EDITOR_ENABLED=0','--env','HS_MAINTENANCE_TOKEN=','--env','HS_OIDC_ENABLED=0','--env',`HS_ORIGIN=${origin}`,'--env',`HS_IDENTITY_ISSUER=${issuer}`,'--env','HS_IDENTITY_JWKS_URL=https://localhost:3443/jwks','--env','HS_IDENTITY_AUDIENCE=holy-sheet','--env','NODE_EXTRA_CA_CERTS=/qa/ca.pem',image!];
 await exec(docker,appArgs);appCreated=true;
 // The flag is supplied at container creation, before old application code starts serving.
 const receipt=JSON.parse((await exec(docker,['inspect',app])).stdout)[0];
 assert.ok(receipt.Config.Env.includes('HS_RICH_EDITOR_ENABLED=0'));
 assert.equal(receipt.Image,image);
 await exec(docker,['run','--detach','--name',jwks,'--network',`container:${app}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--mount',`type=bind,source=${directory},target=/qa,readonly`,'--entrypoint','node','node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205','/qa/server.cjs']);jwksCreated=true;
 for(let attempt=0;;attempt++){try{const ready=await fetch(origin,{signal:AbortSignal.timeout(1000)});if(ready.ok)break;}catch{}assert.ok(attempt<40,'Old test image did not become ready');await new Promise(resolve=>setTimeout(resolve,250));}
 const token=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience('holy-sheet').setSubject('holy63-synthetic-authenticated-viewer').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
 const headers={authorization:`Bearer ${token}`,origin,'content-type':'application/json'};
 const authenticated=await fetch(origin+'/auth/session',{headers,signal:AbortSignal.timeout(10000)});assert.equal(authenticated.status,200,'Synthetic JWT must actually authenticate');assert.equal((await authenticated.json()).authenticated,true);checks.push({path:'/auth/session (valid synthetic identity)',status:200});
 const page='holy63-governed-synthetic',uuid='11111111-1111-4111-8111-111111111111';
 const paths=['/api/pages',`/api/pages/${page}`,`/api/v1/pages/${page}/document`,`/api/v1/pages/${page}/access`,`/api/v1/pages/${page}/history`,`/api/v1/pages/${page}/history/1`,`/api/v1/pages/${page}/exports?format=markdown`,`/api/v1/exports/${uuid}`,'/api/search?q=holy63','/api/v1/search?workspaceId=ws-aplyd&q=holy63','/api/v1/integrations/sho/picker?workspaceId=ws-aplyd','/api/v1/personal-navigation',`/api/media/${uuid}`];
 for(const endpoint of paths){const response=await fetch(origin+endpoint,{headers,signal:AbortSignal.timeout(10000)});if(response.status===404&&!routeExists(endpoint)){checks.push({path:endpoint,status:404,code:'absent-in-exact-source-tree'});continue;}assert.equal(response.status,503,endpoint);assert.match(response.headers.get('cache-control')??'',/no-store/,endpoint);const body=await response.json();assert.equal(body.code,'feature_disabled',endpoint);checks.push({path:endpoint,status:response.status,code:body.code});}
 const downloadPath=`/api/v1/exports/${uuid}/download`,download=await fetch(origin+downloadPath,{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(10000)});if(download.status===404&&!routeExists(downloadPath))checks.push({path:'export download (POST)',status:404,code:'absent-in-exact-source-tree'});else{assert.equal(download.status,503);assert.equal((await download.json()).code,'feature_disabled');checks.push({path:'export download (POST)',status:503,code:'feature_disabled'});}
 const maintenance=await fetch(origin+'/api/internal/maintenance',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(10000)});assert.equal(maintenance.status,503);checks.push({path:'maintenance disabled before old code starts',status:503});
 for(const endpoint of [`/pages/${page}`,`/embed/pages/${page}`]){const response=await fetch(origin+endpoint,{headers,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('HOLY63-UNAPPROVED-BODY'));assert.match(response.headers.get('cache-control')??'',/no-store/);checks.push({path:endpoint+' (content-free shell)',status:200});}
 const invalid=await fetch(origin+'/auth/session',{headers:{authorization:'Bearer invalid'},signal:AbortSignal.timeout(10000)});assert.equal(invalid.status,401);checks.push({path:'/auth/session (invalid identity)',status:401});
 const final=JSON.parse((await exec(docker,['inspect',app])).stdout)[0];assert.ok(final.Config.Env.includes('HS_RICH_EDITOR_ENABLED=0'));
 await mkdir('artifacts/holy63',{recursive:true});await writeFile('artifacts/holy63/rollback-old-image.json',JSON.stringify({kind:'isolated-old-image-authenticated-feature-off',image,revision,created:receipt.Created,startedAt:receipt.State.StartedAt,flagSetAtCreation:true,flagStillOffAtEnd:true,checks,limitations:'Exact local old image only; not a deployed rollback. No live identity/storage/proxy or retained browser copies qualified. Re-run against the exact pinned operational fallback image.'},null,2)+'\n');
 console.log(JSON.stringify({image,revision,checks:checks.length,flagSetAtCreation:true,flagStillOffAtEnd:true}));
}finally{
 if(jwksCreated)await exec(docker,['rm','--force',jwks]);
 if(appCreated)await exec(docker,['rm','--force',app]);
 await rm(directory,{recursive:true,force:true});
}
