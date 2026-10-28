import assert from 'node:assert/strict';
const args=process.argv.slice(2),origin=args.find(a=>a.startsWith('http'))??'https://staging.holysheet.aplyd.org';
assert.ok(['http://127.0.0.1:53104','https://staging.holysheet.aplyd.org'].includes(origin),'Use the isolated container port or approved HS staging origin.');
const bridge=args.includes('--oidc'),framing=args.includes('--require-framing'),picker=args.includes('--picker'),checks=[];
async function check(name,path,status,options={}){
  const started=performance.now(),response=await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(10000),...options});
  assert.equal(response.status,status,`${name}: expected ${status}, got ${response.status}`);
  if(path.startsWith('/api/')||path==='/auth/session')assert.match(response.headers.get('cache-control')??'',/no-store/);
  const body=await response.text();
  for(const probe of ['Search token: orchid','HOLY3-open-revoke-UNSAVED','QA sync probe'])assert.ok(!body.includes(probe),`${name}: restricted fixture data appeared`);
  checks.push({name,status,durationMs:Math.round(performance.now()-started)});return response;
}
await check('Public landing','/',200);
await check('Local-only synthetic record preview','/qualification/record-layout',404);
const documentShell=await check('Standalone public shell','/pages/welcome',200),embedShell=await check('Embedded public shell','/embed/pages/11111111-1111-4111-8111-111111111111',200);
if(framing){
  assert.match(documentShell.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
  assert.equal(embedShell.headers.get('content-security-policy'),"frame-ancestors 'self' https://sheethappensofficer.aplyd.org https://sho-qa.aplyd.org");
  checks.push({name:'Reviewed standalone/embed frame policy',status:'verified'});
}
if(picker){
  const pickerShell=await check('HS-owned picker public shell','/embed/picker',200);
  if(framing)assert.equal(pickerShell.headers.get('content-security-policy'),embedShell.headers.get('content-security-policy'));
  await check('Picker metadata requires verified identity','/api/v1/integrations/sho/picker',401);
  await check('Picker actor hint cannot authenticate','/api/v1/integrations/sho/picker',401,{headers:{'x-hs-actor':'local-owner'}});
  await check('Picker creation requires verified identity','/api/v1/integrations/sho/picker',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json','x-hs-actor':'local-owner'},body:'{}'});
}
const login=await check('Sign-in bridge readiness','/auth/sign-in',bridge?303:503);
if(bridge){
  assert.equal(new URL(login.headers.get('location')).origin,'https://accounts.aplyd.org');
  const cookie=login.headers.get('set-cookie')??'';
  for(const flag of ['__Host-hs_login=','HttpOnly','Secure','SameSite=Lax'])assert.ok(cookie.includes(flag),`Missing login cookie flag ${flag}`);
}
await check('Callback without transaction fails closed','/auth/callback?code=synthetic&state=synthetic',bridge?400:503);
for(const [name,path] of [
  ['Export current snapshot','/api/v1/pages/welcome/exports?format=pdf'],['Private export job','/api/v1/exports/11111111-1111-4111-8111-111111111111'],['Export policy','/api/v1/workspaces/ws-aplyd/export-policy'],['Document import','/api/v1/imports/11111111-1111-4111-8111-111111111111'],['Session','/auth/session'],['Pages','/api/pages'],['Spaces','/api/spaces'],['Global search','/api/search?q=orchid'],
  ['Document','/api/v1/pages/welcome/document'],['Page access','/api/v1/pages/welcome/access'],
  ['Sharing audit','/api/v1/pages/welcome/sharing/audit'],['History','/api/v1/pages/welcome/history'],
  ['Trash','/api/v1/workspaces/ws-aplyd/trash'],['Workspace membership','/api/v1/workspaces/ws-aplyd/members'],['Personal navigation','/api/v1/personal-navigation'],['Templates','/api/v1/templates?workspaceId=ws-aplyd'],
  ['Media','/api/media/11111111-1111-4111-8111-111111111111'],['Upload recovery','/api/uploads/11111111-1111-4111-8111-111111111111'],
])await check(`${name} requires verified identity`,path,401);
await check('Trash mutation requires identity','/api/v1/pages/welcome/trash',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
await check('Recovery mutation rejects foreign origin','/api/v1/workspaces/ws-aplyd/trash',403,{method:'POST',headers:{origin:'https://untrusted.example.invalid','content-type':'application/json'},body:'{}'});
await check('Page move requires identity','/api/v1/pages/welcome/location',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
await check('Page move rejects foreign origin','/api/v1/pages/welcome/location',403,{method:'POST',headers:{origin:'https://untrusted.example.invalid','content-type':'application/json'},body:'{}'});
await check('Private export download requires identity','/api/v1/exports/11111111-1111-4111-8111-111111111111/download',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
await check('Import preparation requires identity','/api/v1/imports',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/octet-stream'},body:'synthetic'});
await check('Workspace mutation requires identity','/api/v1/workspaces/ws-aplyd/members',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
await check('Workspace mutation rejects foreign origin','/api/v1/workspaces/ws-aplyd/members',403,{method:'POST',headers:{origin:'https://untrusted.example.invalid','content-type':'application/json'},body:'{}'});
await check('Forged actor headers rejected','/api/pages',401,{headers:{'x-user-id':'local-owner','x-hs-local-preview':'1'}});
await check('Foreign-origin mutation rejected','/api/pages',403,{method:'POST',headers:{origin:'https://untrusted.example.invalid','content-type':'application/json'},body:'{}'});
await check('Same-origin mutation requires identity','/api/pages',401,{method:'POST',headers:{origin:'https://staging.holysheet.aplyd.org','content-type':'application/json'},body:'{}'});
for(const path of ['/.env','/.git/config','/.holy-sheet/recovery.key'])await check('Private file unavailable '+path,path,404);
console.log(JSON.stringify({kind:'HOLY-3-unauthenticated-rollout-boundaries',origin,bridgeEnabled:bridge,framingRequired:framing,passed:checks.length,scope:'Unauthenticated readiness only; no authenticated/product acceptance.',checks},null,2));
