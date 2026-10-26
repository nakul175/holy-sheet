import assert from 'node:assert/strict';
const origin=process.argv[2]??'http://127.0.0.1:53104';
assert.equal(origin,'http://127.0.0.1:53104','Use the dedicated isolated package acceptance port.');
const checks=[];
async function check(name,path,status,options={}){const start=performance.now();const response=await fetch(origin+path,{redirect:'manual',...options});assert.equal(response.status,status,`${name}: expected ${status}, received ${response.status}`);if(path.startsWith('/api/')&&path!='/api/internal/maintenance')assert.match(response.headers.get('cache-control')??'',/no-store/);const body=await response.text();assert.ok(!body.includes('Search token: orchid'),'Private fixture content leaked');checks.push({name,status,durationMs:Math.round(performance.now()-start)});}
await check('Public landing shell','/',200);
await check('Document data requires identity','/api/v1/pages/welcome/document',401);
await check('Page listing requires identity','/api/pages',401);
await check('Search requires identity','/api/search?q=orchid',401);
await check('Template library requires identity','/api/v1/templates?workspaceId=ws-aplyd',401);
await check('Protected media requires identity','/api/media/11111111-1111-4111-8111-111111111111',401);
await check('Forged user header is not an identity','/api/pages',401,{headers:{'x-user-id':'local-owner','x-hs-local-preview':'1'}});
await check('Foreign mutation origin denied','/api/pages',403,{method:'POST',headers:{origin:'https://untrusted.example.invalid','content-type':'application/json'},body:'{}'});
await check('Same-origin mutation still requires identity','/api/pages',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
await check('Unconfigured maintenance fails closed','/api/internal/maintenance',503,{method:'POST'});
await check('Environment file is not served','/.env',404);
await check('Recovery key file is not served','/.holy-sheet/recovery-key',404);
await check('Git metadata is not served','/.git/config',404);
console.log(JSON.stringify({kind:'disabled-package-smoke',passed:checks.length,checks},null,2));
