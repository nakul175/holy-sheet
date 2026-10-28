"""Prepare hash-pinned review patches; never edits or executes deployed source."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--accounts-source', required=True)
parser.add_argument('--directory-source', required=True)
parser.add_argument('--out-dir', required=True)
args = parser.parse_args()
accounts = Path(args.accounts_source).resolve() / 'src' / 'app.mjs'
models = Path(args.directory_source).resolve() / 'directory' / 'models.py'
local = Path(__file__).resolve().parent
if (models.parent / 'migrations' / '0005_tenant_administrator.py').exists():
    raise SystemExit('Migration name already exists; review and rebase before preparing patches.')
out = Path(args.out_dir).resolve()
expected_accounts = 'a7f8f28adfb81afbb0882d1719bc007c7bb6331308b1b1a9d7b79391ea7d828d'
expected_models = '3db0468a9ab74c7d3f4cea0496bf3e457eb51caab30a3b0da178b443971b0eb6'
for path, expected in [(accounts, expected_accounts), (models, expected_models)]:
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit('Source changed: review and rebase the adapter patch.')
original = accounts.read_text()
start = original.index("  app.post('/internal/session/status',")
end = original.index('  // The provider owns RP-initiated logout', start)
old = original[start:end]
# Preserve the existing source-session, grant and client-link checks verbatim,
# while sharing them with the tenant endpoint. No signing key or token minting.
if "session.grantIdFor(c.client_id)" not in old or 'sourceActive(account,binding.sourceSessionId)' not in old:
    raise SystemExit('Existing session checks changed; review the integration first.')
replacement = '''  async function currentClientSession(clientId,sub,uid) {
    const account=store.account(sub),session=await provider.Session.findByUid(uid),local=store.link(clientId,sub);
    const binding=store.get('SourceSession',uid);
    const active=!!(account&&session?.accountId===sub&&session.grantIdFor(clientId)&&local&&binding?.accountId===sub&&await sourceActive(account,binding.sourceSessionId));
    return {active,...(active?{sub,local_id:local}:{})};
  }
  app.post('/internal/session/status',express.json({limit:'4kb'}),async(req,res)=>{
    const c=config.clients.find(c=>c.client_id===req.body.client_id);
    if(!c||!same(c.client_secret,req.body.client_secret))return res.sendStatus(401);
    const {sub,uid}=req.body;
    if(typeof sub!=='string'||typeof uid!=='string'||sub.length>200||uid.length>200)return res.sendStatus(400);
    return res.json(await currentClientSession(c.client_id,sub,uid));
  });
  app.post('/internal/tenant/status',express.json({limit:'4kb'}),tenantStatusHandler({
    enabled:process.env.APLYD_TENANT_AUTHORITY_ENABLED==='1',
    directoryFile:process.env.APLYD_TENANT_DIRECTORY_DB,
    issuer:config.issuer,clients:config.clients,verifySession:currentClientSession,
  }));
'''
modified = original[:start] + replacement + original[end:]
modified = modified.replace("import { Store } from './store.mjs';", "import { Store } from './store.mjs';\nimport { tenantStatusHandler } from './tenant-authority.mjs';", 1)
model_before = models.read_text()
model_after = model_before + (local / 'tenant-administrator-model.py').read_text()
out.mkdir(parents=True, exist_ok=True)
for name, before, after, relative in [('accounts-app.patch', original, modified, 'src/app.mjs'), ('directory-models.patch', model_before, model_after, 'directory/models.py')]:
    patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/' + relative, tofile='b/' + relative))
    (out / name).write_text(patch)
manifest = {'accountsBeforeSha256': expected_accounts, 'modelsBeforeSha256': expected_models, 'accountsAfterSha256': hashlib.sha256(modified.encode()).hexdigest(), 'modelsAfterSha256': hashlib.sha256(model_after.encode()).hexdigest(), 'liveDeployment': False, 'automaticGrants': 0}
(out / 'patch-provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
