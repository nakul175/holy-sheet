import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner,type Actor} from './auth';
import {SharedRecordSchemaRepository,type SchemaPrepare} from './shared-record-schema';
import type {RecordContext,CurrentSuiteTenantAuthority} from './shared-records';
import {recordCapabilities} from './shared-record-types';
let db:Database,pages:Repository,data:SharedRecordSchemaRepository,ctx:RecordContext;
const viewer:Actor={id:'schema-test-viewer'};
const proof=(c:RecordContext)=>({subject:c.actor.id,tenantId:c.tenantId,workspaceId:c.workspaceId,active:true,tenantAdministrator:c.actor.id===owner.id,revision:'synthetic-schema-authority-v1'});
const authority:CurrentSuiteTenantAuthority={verify:vi.fn(async c=>proof(c))};
const definition=(patch:Record<string,unknown>={})=>({label:'Synthetic field',kind:'text' as const,...patch});
const input=(patch:Record<string,unknown>={}):SchemaPrepare=>({prepareId:crypto.randomUUID(),collection:'organisations',expectedSchemaVersion:1,definition:definition(),...patch});
async function currentVersion(){return Number((await db.query<{schema_version:number}>('SELECT schema_version FROM hs_data_tenants WHERE id=$1',[ctx.tenantId])).rows[0].schema_version);}
async function preview(patch:Record<string,unknown>={}){return data.previewSchema(ctx,input({expectedSchemaVersion:await currentVersion(),...patch}));}
async function apply(p:Awaited<ReturnType<typeof preview>>,operationId=crypto.randomUUID()){return data.applySchema(ctx,{previewId:p.previewId,reviewHash:p.reviewHash,operationId});}
async function add(patch:Record<string,unknown>={}){const p=await preview({definition:definition(patch)});await apply(p);return p;}
async function record(values:Record<string,unknown>={}){return (await data.create(ctx,{operationId:crypto.randomUUID(),collection:'organisations',name:'Synthetic record '+crypto.randomUUID(),schemaVersion:await currentVersion(),values})).record;}
beforeAll(async()=>{db=await createDatabase(':memory:');pages=new Repository(db);await pages.seedLocal();await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[viewer.id]);data=new SharedRecordSchemaRepository(pages,authority);});
beforeEach(async()=>{vi.mocked(authority.verify).mockReset().mockImplementation(async c=>proof(c));const tenantId=crypto.randomUUID(),workspaceId='schema-'+crypto.randomUUID();ctx={actor:owner,tenantId,workspaceId};await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$1)',[workspaceId]);for(const actor of [owner,viewer])await db.query('INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)',[workspaceId,actor.id]);await db.query('INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)',[tenantId,'Synthetic tenant']);await db.query('INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)',[workspaceId,tenantId,'Synthetic fixture only']);await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)",[tenantId]);for(const actor of [owner,viewer])await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[tenantId,actor.id,actor.id===owner.id?[...recordCapabilities]:['view','schema']]);});
afterAll(async()=>db.close());
it('requires both current tenant administration and explicit collection schema permission',async()=>{
 await expect(data.previewSchema({...ctx,actor:{...viewer,role:'admin'} as Actor},input())).rejects.toMatchObject({code:'record_schema_forbidden'});
 await db.query("UPDATE hs_data_collection_grants SET capabilities=ARRAY['view'] WHERE tenant_id=$1 AND user_id=$2",[ctx.tenantId,owner.id]);
 await expect(preview()).rejects.toMatchObject({status:403});
});
it('previews once, applies idempotently, keeps stable IDs on rename and defaults only new records',async()=>{
 const old=await record(),request=input({definition:definition({defaultValue:'Future default'})}),p=await data.previewSchema(ctx,request),again=await data.previewSchema(ctx,request);
 expect(again).toEqual(p);expect(p.impact.defaultBehavior).toContain('future');expect(p.impact.recordCount).toBe(1);const operation=crypto.randomUUID(),result=await apply(p,operation);expect(result.appliedSchemaVersion).toBe(2);expect((await apply(p,operation)).replayed).toBe(true);
 expect((await data.get(ctx,old.id)).values).not.toHaveProperty(p.fieldKey);expect((await record()).values[p.fieldKey]).toBe('Future default');
 const rename=await preview({fieldKey:p.fieldKey,definition:definition({label:'Renamed field',defaultValue:'Future default'})});await apply(rename);expect(rename.fieldKey).toBe(p.fieldKey);expect((await apply(p,operation)).currentSchemaVersion).toBe(3);
 const history=await db.query('SELECT definition FROM hs_data_schema_versions WHERE tenant_id=$1 ORDER BY version',[ctx.tenantId]);expect(history.rows).toHaveLength(2);
 const audit=JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='shared-record.schema' AND after_value::text LIKE $1",['%'+ctx.tenantId+'%'])).rows);expect(audit).not.toContain('Future default');expect(audit).not.toContain('Renamed field');
});
it('validates immutable core field identity, typed defaults, select choice uniqueness and unsupported computed fields',async()=>{
 for(const request of [input({fieldKey:'core:domain'}),input({definition:definition({kind:'formula'})}),input({definition:definition({kind:'number',defaultValue:'text'})}),input({definition:definition({kind:'single-select',choices:['a','a']})}),input({definition:definition({choices:['not-a-select']})}),input({definition:definition({kind:'date',defaultValue:'2026-02-30'})})])await expect(data.previewSchema(ctx,request)).rejects.toBeDefined();
 await expect(preview({definition:definition({kind:'record',defaultValue:[crypto.randomUUID()]})})).rejects.toMatchObject({code:'record_reference_unavailable'});
});
it('invalidates reviewed data and schema revisions instead of applying stale rules',async()=>{
 const p=await preview();await record();await expect(apply(p)).rejects.toMatchObject({code:'record_schema_conflict'});expect((await db.query('SELECT * FROM hs_data_fields WHERE tenant_id=$1',[ctx.tenantId])).rows).toHaveLength(0);
 const next=await preview();await add({label:'Different field'});await expect(apply(next)).rejects.toMatchObject({code:'record_schema_conflict'});
});
it('lists registered dependency impact and blocks deprecation until resolved, while safe rename remains possible',async()=>{
 const f=await add();await db.query('INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label) VALUES($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),ctx.tenantId,'organisations',f.fieldKey,'view','Synthetic saved view']);
 const blocked=await preview({fieldKey:f.fieldKey,definition:definition({deprecated:true})});expect(blocked.impact.dependencies).toEqual([{kind:'view',label:'Synthetic saved view',version:1}]);expect(blocked.impact.blockers.join(' ')).toContain('Resolve');await expect(apply(blocked)).rejects.toMatchObject({code:'schema_change_blocked'});
 const safe=await preview({fieldKey:f.fieldKey,definition:definition({label:'Safe rename'})});await apply(safe);
 const stale=await preview({fieldKey:f.fieldKey,definition:definition({label:'Another rename'})});await db.query('UPDATE hs_data_schema_dependencies SET version=version+1 WHERE tenant_id=$1',[ctx.tenantId]);await expect(apply(stale)).rejects.toMatchObject({code:'record_schema_conflict'});
});
it('requires required-field backfill and duplicate cleanup without exposing matching record IDs or values',async()=>{
 const f=await add(),a=await record(),b=await record();const required=await preview({fieldKey:f.fieldKey,definition:definition({required:true,defaultValue:'Does not backfill'})});expect(required.impact.missingCount).toBe(2);await expect(apply(required)).rejects.toMatchObject({code:'schema_change_blocked'});
 for(const r of [a,b])await data.update(ctx,r.id,{operationId:crypto.randomUUID(),expectedVersion:1,schemaVersion:await currentVersion(),values:{[f.fieldKey]:'Private duplicate'}});
 const unique=await preview({fieldKey:f.fieldKey,definition:definition({unique:true})});expect(unique.impact.duplicateValues).toBe(1);expect(JSON.stringify(unique.impact)).not.toContain(a.id);expect(JSON.stringify(unique.impact)).not.toContain('Private duplicate');await expect(apply(unique)).rejects.toMatchObject({code:'schema_change_blocked'});
 await data.update(ctx,b.id,{operationId:crypto.randomUUID(),expectedVersion:2,schemaVersion:await currentVersion(),values:{[f.fieldKey]:'Distinct'}});await apply(await preview({fieldKey:f.fieldKey,definition:definition({unique:true,required:true})}));
 await expect(record({[f.fieldKey]:'Distinct'})).rejects.toMatchObject({code:'record_unique_conflict'});
});
it('blocks populated type conversion and removed select choices instead of coercing records',async()=>{
 const f=await add({kind:'single-select',choices:['one','two']}),r=await record({[f.fieldKey]:'one'});
 for(const d of [definition({kind:'number'}),definition({kind:'single-select',choices:['two']})]){const p=await preview({fieldKey:f.fieldKey,definition:d});expect(p.impact.blockers.length).toBeGreaterThan(0);await expect(apply(p)).rejects.toMatchObject({code:'schema_change_blocked'});}
 expect((await data.get(ctx,r.id)).values[f.fieldKey]).toBe('one');
});
it('elevates sensitivity immediately without granting schema admins value access, and prevents lowering it',async()=>{
 const f=await add(),r=await record({[f.fieldKey]:'Private before elevation'});await apply(await preview({fieldKey:f.fieldKey,definition:definition({sensitive:true})}));expect((await data.get(ctx,r.id)).values).not.toHaveProperty(f.fieldKey);expect(JSON.stringify(await data.history(ctx,r.id))).not.toContain('Private before elevation');
 const lower=await preview({fieldKey:f.fieldKey,definition:definition({sensitive:false})});await expect(apply(lower)).rejects.toMatchObject({code:'schema_change_blocked'});
 expect((await db.query('SELECT * FROM hs_data_field_permissions WHERE tenant_id=$1',[ctx.tenantId])).rows).toHaveLength(0);
});
it('keeps deprecated data readable and prevents editing or applying its old default to new records',async()=>{
 const f=await add({defaultValue:'Original default'}),r=await record();await apply(await preview({fieldKey:f.fieldKey,definition:definition({deprecated:true,defaultValue:'Original default'})}));expect((await data.get(ctx,r.id)).values[f.fieldKey]).toBe('Original default');expect((await record()).values).not.toHaveProperty(f.fieldKey);
 await expect(data.update(ctx,r.id,{operationId:crypto.randomUUID(),expectedVersion:1,schemaVersion:await currentVersion(),values:{[f.fieldKey]:'Changed'}})).rejects.toMatchObject({code:'record_field_unavailable'});
});
it('rechecks current schema rights, exact actor/workspace, expiry and changed operation input',async()=>{
 const p=await preview(),operation=crypto.randomUUID();await expect(data.applySchema({...ctx,actor:viewer},{previewId:p.previewId,reviewHash:p.reviewHash,operationId:operation})).rejects.toMatchObject({status:404});
 await expect(data.previewSchema(ctx,input({prepareId:(await db.query<{prepare_id:string}>('SELECT prepare_id FROM hs_data_schema_previews WHERE id=$1',[p.previewId])).rows[0].prepare_id,definition:definition({label:'Changed'})}))).rejects.toMatchObject({code:'operation_mismatch'});
 await db.query("UPDATE hs_data_collection_grants SET capabilities=ARRAY['view'] WHERE tenant_id=$1 AND user_id=$2",[ctx.tenantId,owner.id]);await expect(apply(p)).rejects.toMatchObject({status:403});await db.query('UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,owner.id,[...recordCapabilities]]);
 await db.query("UPDATE hs_data_schema_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[p.previewId]);await expect(apply(p)).rejects.toMatchObject({code:'schema_preview_expired'});
 const fresh=await preview();await apply(fresh,operation);await expect(data.applySchema(ctx,{previewId:fresh.previewId,reviewHash:'0'.repeat(64),operationId:operation})).rejects.toMatchObject({code:'operation_mismatch'});
});
it('rolls back field, schema history and audit when tenant administration changes before commit',async()=>{
 const p=await preview();vi.mocked(authority.verify).mockResolvedValueOnce(proof(ctx)).mockResolvedValueOnce({...proof(ctx),tenantAdministrator:false});await expect(apply(p)).rejects.toMatchObject({code:'record_authority_changed'});expect(await currentVersion()).toBe(1);expect((await db.query('SELECT * FROM hs_data_fields WHERE tenant_id=$1',[ctx.tenantId])).rows).toHaveLength(0);expect((await db.query('SELECT * FROM hs_data_schema_versions WHERE tenant_id=$1',[ctx.tenantId])).rows).toHaveLength(0);
});
it('enforces 100 custom fields and 100 select choices without counting built-in fields against the cap',async()=>{
 await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,created_by) SELECT $1,'organisations',gen_random_uuid()::text,'Synthetic '||i,'text',$2 FROM generate_series(1,100) i",[ctx.tenantId,owner.id]);await expect(preview()).rejects.toMatchObject({code:'schema_field_limit'});
 const key=(await db.query<{field_key:string}>('SELECT field_key FROM hs_data_fields WHERE tenant_id=$1 LIMIT 1',[ctx.tenantId])).rows[0].field_key;await expect(preview({fieldKey:key,definition:definition({kind:'single-select',choices:Array.from({length:101},(_,i)=>String(i))})})).rejects.toMatchObject({code:'record_schema_validation'});
 const p=await preview({fieldKey:key,definition:definition({kind:'single-select',choices:Array.from({length:100},(_,i)=>String(i))})});expect(p.impact.blockers).toEqual([]);await apply(p);
});
it('guards field identity and immutable historical definitions at the database boundary',async()=>{
 const p=await add();await expect(db.query('UPDATE hs_data_fields SET field_key=$3 WHERE tenant_id=$1 AND field_key=$2',[ctx.tenantId,p.fieldKey,crypto.randomUUID()])).rejects.toThrow('immutable');await expect(db.query("UPDATE hs_data_schema_versions SET definition='{}' WHERE tenant_id=$1",[ctx.tenantId])).rejects.toThrow('immutable');await expect(db.query('DELETE FROM hs_data_schema_versions WHERE tenant_id=$1',[ctx.tenantId])).rejects.toThrow('immutable');
});
