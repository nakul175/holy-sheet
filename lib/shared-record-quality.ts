import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import {compileRecordConditions,evaluateRecordConditions,RecordConditionError} from './record-conditions';
import {recordLayoutDefinition,type RecordLayoutDefinition} from './record-layout-definition';
import {referenceChoices} from './record-reference-fields';
import {SharedRecordRepository,type RecordContext,type Stored} from './shared-records';
import {recordHash,recordName,recordValueEmpty,typedRecordValue,type RecordField} from './shared-record-types';

const id=z.string().uuid();
const clause=z.object({field:z.string().min(1).max(100),operator:z.enum(['is-empty','is-not-empty','equals','not-equals','greater-than','less-than','contains-any','contains-all']),value:z.unknown().optional()}).strict();
const when=z.union([z.object({all:z.array(clause).min(1).max(5)}).strict(),z.object({any:z.array(clause).min(1).max(5)}).strict()]);
const predicate=z.object({operator:z.enum(['is-not-empty','equals','not-equals','greater-than','less-than','min-length','max-length']),value:z.unknown().optional()}).strict();
const check=z.discriminatedUnion('kind',[
 z.object({id,field:z.string().min(1).max(100),kind:z.literal('required'),when:when.optional()}).strict(),
 z.object({id,field:z.string().min(1).max(100),kind:z.literal('quality'),predicate,when:when.optional()}).strict(),
]);
const definition=z.object({layoutId:z.string().uuid().nullable().default(null),enforcement:z.enum(['advisory','block']).default('advisory'),checks:z.array(check).min(1).max(40)}).strict();
const save=z.object({id,operationId:id,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict();
type Definition=z.infer<typeof definition>;
type Check=Definition['checks'][number];
type When=NonNullable<Check['when']>;
type Predicate=z.infer<typeof predicate>;
type RuleRow={id:string;tenant_id:string;collection:string;name:string;name_search:string;version:number;deprecated:boolean;definition:unknown};
type Shown={label:string;status:'pass'|'fail'|'skipped';detail:string};
const messages:Record<string,string>={
 record_quality_validation:'Review the quality rule and try again.',
 record_quality_field_unavailable:'A field is restricted or unavailable.',
 record_quality_forbidden:'This record action is not permitted.',
 record_quality_name_conflict:'A quality rule with this name already exists.',
 record_quality_limit:'This collection has reached its quality rule limit.',
};
const fail=(code='record_quality_conflict',status=409)=>new DocumentError(messages[code]??'The quality rule is unavailable or changed. Review the current catalogue.',code,status);
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);
const withheldMessage='A field is restricted or unavailable.';

/** Collection `schema` already gates field requiredness, layouts and conditional policies.
 * Quality rules use that grant. view, edit and review do not imply it. */
export class SharedRecordQualityRepository extends SharedRecordRepository {
 private async visible(tx:Sql,ctx:RecordContext,collection:string){
  const caps=await this.collectionCaps(tx,ctx,collection);
  if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,collection])).rows[0]?.deprecated)throw fail('record_quality_unavailable',404);
  if(caps.includes('view'))return caps;
  const any=await tx.query(`SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=$1 AND g.user_id=$2 AND r.collection=$3 AND r.state<>'trashed' AND r.merged_into_id IS NULL AND 'view'=ANY(g.capabilities) LIMIT 1`,[ctx.tenantId,ctx.actor.id,collection]);
  if(!any.rows.length)throw fail('record_quality_unavailable',404);
  return caps;
 }
 private async lock(tx:Sql,ctx:RecordContext,ruleId:string){
  if(!id.safeParse(ruleId).success)throw fail('record_quality_unavailable',404);
  const row=(await tx.query<RuleRow>('SELECT * FROM hs_data_quality_rules WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,ruleId])).rows[0];
  if(!row)throw fail('record_quality_unavailable',404);
  await this.visible(tx,ctx,row.collection);
  return {...row,version:Number(row.version)};
 }
 private async exact(tx:Sql,ctx:RecordContext,recordId:string){
  if(!id.safeParse(recordId).success)throw missing();
  const record=(await tx.query<Stored>("SELECT * FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed' FOR UPDATE",[recordId,ctx.tenantId])).rows[0];
  if(!record)throw missing();
  record.version=Number(record.version);
  record.field_values=asObject(record.field_values);
  const caps=await this.caps(tx,ctx,record);
  if(!caps.includes('view'))throw missing();
  if(record.merged_into_id)throw new DocumentError('This record was merged. Open the current record.','record_merged',409);
  return {record,caps};
 }
 private async publishedLayout(tx:Sql,ctx:RecordContext,collection:string){
  const row=(await tx.query<{definition:unknown}>('SELECT v.definition FROM hs_data_layouts l JOIN hs_data_layout_versions v ON v.tenant_id=l.tenant_id AND v.collection=l.collection AND v.version=l.published_version WHERE l.tenant_id=$1 AND l.collection=$2 AND l.published_version IS NOT NULL',[ctx.tenantId,collection])).rows[0];
  if(!row)return;
  const parsed=recordLayoutDefinition.safeParse(typeof row.definition==='string'?safeJson(row.definition):row.definition);
  return parsed.success?parsed.data:undefined;
 }
 private predicateOf(field:RecordField,input:Predicate){
  if(input.operator==='is-not-empty'){if(input.value!==undefined)throw fail('record_quality_validation',400);return {operator:input.operator};}
  if(input.operator==='min-length'||input.operator==='max-length'){
   const limit=field.kind==='long-text'?20000:field.kind==='email'?320:field.kind==='phone'?40:2000;
   if(!['text','long-text','email','phone','url'].includes(field.kind)||typeof input.value!=='number'||!Number.isInteger(input.value)||input.value<0||input.value>limit)throw fail('record_quality_validation',400);
   return {operator:input.operator,value:input.value};
  }
  if((input.operator==='greater-than'||input.operator==='less-than')&&!['number','date'].includes(field.kind))throw fail('record_quality_validation',400);
  if(input.value===undefined)throw fail('record_quality_validation',400);
  try{return {operator:input.operator,value:typedRecordValue(field,input.value,{historical:true})};}catch{throw fail('record_quality_validation',400);}
 }
 private async normalize(tx:Sql,ctx:RecordContext,collection:string,input:unknown){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success||Buffer.byteLength(JSON.stringify(parsed.data))>64000)throw fail('record_quality_validation',400);
  const form=parsed.data;
  if(new Set(form.checks.map(item=>item.id)).size!==form.checks.length)throw fail('record_quality_validation',400);
  const required=form.checks.filter(item=>item.kind==='required').map(item=>item.field);
  if(new Set(required).size!==required.length)throw fail('record_quality_validation',400);
  if(form.layoutId){
   const layout=await this.publishedLayout(tx,ctx,collection);
   if(!layout||!layoutFields(layout,form.layoutId))throw fail('record_quality_validation',400);
  }
  const fields=await this.fields(tx,ctx,collection);
  const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(row=>row.field_key));
  const checks=[];
  for(const item of form.checks){
   if(formulas.has(item.field))throw fail('record_quality_field_unavailable',403);
   const field=fields.find(candidate=>candidate.key===item.field);
   if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))throw fail('record_quality_field_unavailable',403);
   const next:Check=item.kind==='quality'?{...item,predicate:this.predicateOf(field,item.predicate)}:{...item};
   if(item.when){
    const typed=structuredClone(item.when);
    for(const key of whenFields(typed)){
     if(formulas.has(key))throw fail('record_quality_field_unavailable',403);
     const source=fields.find(candidate=>candidate.key===key);
     if(!source||source.deprecated||source.kind==='attachment'||source.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,source,'view'))throw fail('record_quality_field_unavailable',403);
    }
    try{compileRecordConditions([{id:item.id,target:item.field,requiredWhen:typed}],fields);}catch(error){if(error instanceof RecordConditionError||error instanceof DocumentError)throw fail('record_quality_validation',400);throw error;}
    next.when=typed;
   }
   checks.push(next);
  }
  return {...form,checks};
 }
 private parse(input:unknown){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success)throw fail('record_quality_unavailable',503);
  return parsed.data;
 }
 private async visibility(tx:Sql,ctx:RecordContext,collection:string,fields:RecordField[],values:Record<string,unknown>){
  const row=(await tx.query<{rules:unknown}>('SELECT rules FROM hs_data_condition_policies WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0];
  if(!row)return {hidden:new Set<string>(),opaque:new Set<string>()};
  let rules;
  try{rules=compileRecordConditions(typeof row.rules==='string'?safeJson(row.rules):row.rules,fields);}catch(error){if(error instanceof RecordConditionError)throw fail('record_quality_unavailable',503);throw error;}
  const opaque=new Set<string>();
  for(const rule of rules){
   const sources=('showWhen' in rule?whenFields(rule.showWhen):[]).concat('requiredWhen' in rule?whenFields(rule.requiredWhen):[]);
   let blocked=false;
   for(const key of sources){
    const field=fields.find(candidate=>candidate.key===key);
    if(!field||field.deprecated||!await this.fieldAllowed(tx,ctx,collection,field,'view'))blocked=true;
   }
   if(blocked)opaque.add(rule.target);
  }
  try{return {hidden:new Set(evaluateRecordConditions(rules,values).filter(state=>!state.visible).map(state=>state.field)),opaque};}catch(error){if(error instanceof RecordConditionError)throw fail('record_quality_unavailable',503);throw error;}
 }
 private matches(value:unknown,predicate:Predicate){
  const empty=recordValueEmpty(value);
  if(predicate.operator==='is-not-empty')return !empty;
  if(predicate.operator==='min-length'||predicate.operator==='max-length'){
   if(typeof value!=='string'||typeof predicate.value!=='number')return false;
   const length=Array.from(value).length;
   return predicate.operator==='min-length'?length>=predicate.value:length<=predicate.value;
  }
  if(predicate.operator==='greater-than'||predicate.operator==='less-than'){
   if(empty||typeof value!==typeof predicate.value)return false;
   if(typeof value==='number'&&typeof predicate.value==='number')return predicate.operator==='greater-than'?value>predicate.value:value<predicate.value;
   if(typeof value==='string'&&typeof predicate.value==='string')return predicate.operator==='greater-than'?value>predicate.value:value<predicate.value;
   return false;
  }
  if(empty)return predicate.operator==='not-equals';
  const equal=recordHash(value)===recordHash(predicate.value);
  return predicate.operator==='equals'?equal:!equal;
 }
 private async judge(tx:Sql,ctx:RecordContext,collection:string,check:Check,fields:RecordField[],formulas:Set<string>,values:Record<string,unknown>,visibility:{hidden:Set<string>;opaque:Set<string>},placement:Set<string>|null):Promise<Shown|'withhold'>{
  if(formulas.has(check.field))return 'withhold';
  const field=fields.find(candidate=>candidate.key===check.field);
  if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))return 'withhold';
  if(check.when)for(const key of whenFields(check.when)){
   if(formulas.has(key))return 'withhold';
   const source=fields.find(candidate=>candidate.key===key);
   if(!source||source.deprecated||!await this.fieldAllowed(tx,ctx,collection,source,'view'))return 'withhold';
  }
  if(visibility.opaque.has(check.field))return 'withhold';
  if(placement&&!placement.has(check.field))return {label:field.label,status:'skipped',detail:'Not on the selected layout'};
  if(visibility.hidden.has(check.field))return {label:field.label,status:'skipped',detail:'Not required while this field is hidden'};
  if(check.when){
   try{if(evaluateRecordConditions(compileRecordConditions([{id:check.id,target:check.field,requiredWhen:structuredClone(check.when)}],fields),values)[0]?.required!==true)return {label:field.label,status:'skipped',detail:'Not required under the current conditions'};}
   catch(error){if(error instanceof RecordConditionError)throw fail('record_quality_unavailable',503);throw error;}
  }
  if(check.kind==='quality'){
   let canonical:Predicate;
   try{canonical=this.predicateOf(field,check.predicate);}catch(error){if(error instanceof DocumentError)return 'withhold';throw error;}
   const pass=this.matches(values[check.field],canonical);
   return {label:field.label,status:pass?'pass':'fail',detail:pass?'Passes':'Does not match the quality check'};
  }
  const pass=!recordValueEmpty(values[check.field]);
  return {label:field.label,status:pass?'pass':'fail',detail:pass?'Passes':'Required'};
 }
 private present(row:RuleRow,form:Definition){return {id:row.id,collection:row.collection,name:row.name,version:Number(row.version),deprecated:row.deprecated,definition:form};}
 private async dependencies(tx:Sql,ctx:RecordContext,collection:string,ruleId:string,form:Definition,deprecated:boolean){
  await tx.query('DELETE FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND quality_rule_id=$2',[ctx.tenantId,ruleId]);
  if(deprecated)return;
  const keys=new Set(form.checks.flatMap(item=>[item.field,...whenFields(item.when)]));
  for(const field of await this.fields(tx,ctx,collection))if(!field.core&&keys.has(field.key))await tx.query('INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label,quality_rule_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.tenantId,collection,field.key,'quality','Record quality rule',ruleId]);
 }
 private async bump(tx:Sql,ctx:RecordContext,collection:string){
  await tx.query('INSERT INTO hs_data_quality_catalogues(tenant_id,collection) VALUES($1,$2) ON CONFLICT(tenant_id,collection) DO UPDATE SET revision=hs_data_quality_catalogues.revision+1',[ctx.tenantId,collection]);
 }
 private async scopeOf(tx:Sql,ctx:RecordContext,tenant:{schema_version:number;policy_version:number},proof:{revision:string},collection:string){
  const revision=(await tx.query<{revision:number}>('SELECT revision FROM hs_data_quality_catalogues WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0]?.revision??0;
  return recordHash({kind:'record-quality-catalogue',collection,revision:Number(revision),schema:Number(tenant.schema_version),policy:Number(tenant.policy_version),authority:proof.revision});
 }
 private async place(tx:Sql,ctx:RecordContext,cursor:string|undefined,scope:string){
  if(!cursor)return {afterName:null as string|null,afterId:null as string|null};
  const current=(await tx.query<{last_name:string;last_id:string}>('SELECT last_name,last_id FROM hs_data_query_cursors WHERE token_hash=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND scope_hash=$5 AND expires_at>clock_timestamp()',[recordHash(cursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope])).rows[0];
  if(!current)throw fail('record_quality_cursor');
  return {afterName:current.last_name,afterId:current.last_id};
 }
 private async next(tx:Sql,ctx:RecordContext,scope:string,lastName:string,lastId:string){
  const token=randomBytes(32).toString('base64url');
  await tx.query('INSERT INTO hs_data_query_cursors(token_hash,tenant_id,workspace_id,actor_id,scope_hash,last_name,last_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[recordHash(token),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope,lastName,lastId]);
  return token;
 }
 async saveQualityRule(ctx:RecordContext,input:z.input<typeof save>){
  const parsed=save.safeParse(input);
  if(!parsed.success)throw fail('record_quality_validation',400);
  const command=parsed.data;
  let name:string;
  try{name=recordName(command.name);}catch(error){if(error instanceof DocumentError)throw fail('record_quality_validation',400);throw error;}
  if(Array.from(name).length>100)throw fail('record_quality_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,command.collection);
   if(!caps.includes('view')||!caps.includes('schema'))throw fail('record_quality_forbidden',403);
   if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.collection])).rows[0]?.deprecated)throw fail('record_quality_unavailable',404);
   const form=await this.normalize(tx,ctx,command.collection,command.definition);
   const hash=recordHash({...command,name,definition:form});
   const existing=(await tx.query<{request_hash:string;rule_id:string;applied_version:number}>('SELECT request_hash,rule_id,applied_version FROM hs_data_quality_rule_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(existing){
    if(existing.request_hash!==hash)throw fail('operation_mismatch');
    const saved=await this.lock(tx,ctx,existing.rule_id);
    return {rule:this.present(saved,form),appliedVersion:Number(existing.applied_version),replayed:true};
   }
   const previous=(await tx.query<RuleRow>('SELECT * FROM hs_data_quality_rules WHERE id=$1 FOR UPDATE',[command.id])).rows[0];
   if(previous&&(previous.tenant_id!==ctx.tenantId||previous.collection!==command.collection))throw fail('record_quality_unavailable',404);
   if(Number(previous?.version??0)!==command.expectedVersion)throw fail();
   if(!previous){const count=(await tx.query<{n:string}>('SELECT count(*)::text AS n FROM hs_data_quality_rules WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,command.collection])).rows[0];if(Number(count?.n)>=100)throw fail('record_quality_limit',429);}
   if((await tx.query('SELECT id FROM hs_data_quality_rules WHERE tenant_id=$1 AND collection=$2 AND name_search=lower($3) AND id<>$4',[ctx.tenantId,command.collection,name,command.id])).rows.length)throw fail('record_quality_name_conflict',409);
   const version=command.expectedVersion+1,stored=JSON.stringify(form);
   if(previous)await tx.query('UPDATE hs_data_quality_rules SET name=$3,version=$4,deprecated=$5,definition=$6 WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.id,name,version,command.deprecated,stored]);
   else await tx.query('INSERT INTO hs_data_quality_rules(id,tenant_id,collection,name,version,deprecated,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[command.id,ctx.tenantId,command.collection,name,version,command.deprecated,stored,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_quality_rule_versions(tenant_id,rule_id,version,name,deprecated,definition,schema_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,command.id,version,name,command.deprecated,stored,tenant.schema_version,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_quality_rule_operations(tenant_id,actor_id,operation_id,request_hash,rule_id,applied_version) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,command.operationId,hash,command.id,version]);
   await this.dependencies(tx,ctx,command.collection,command.id,form,command.deprecated);
   await this.bump(tx,ctx,command.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.quality-saved',JSON.stringify({tenantId:ctx.tenantId,ruleId:command.id,collection:command.collection,version,deprecated:command.deprecated,sourceApp:'holy-sheet'}),command.operationId]);
   return {rule:this.present(await this.lock(tx,ctx,command.id),form),appliedVersion:version,replayed:false};
  });
 }
 async qualityFieldCatalogue(ctx:RecordContext,collection:string){
  if(typeof collection!=='string'||!collection||collection.length>100)throw fail('record_quality_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.visible(tx,ctx,collection),fields=[];
   const all=await this.fields(tx,ctx,collection);
   for(const field of all){
    if(field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))continue;
    const catalogue=referenceChoices(field);
    fields.push({key:field.key,label:field.label,kind:field.kind,sensitive:field.sensitive,choices:catalogue??field.choices.map(value=>({id:value,label:value,deprecated:false}))});
   }
   const calculated=await this.visibleCalculatedFields(tx,ctx,collection,all);
   return {schemaVersion:Number(tenant.schema_version),canManage:caps.includes('view')&&caps.includes('schema'),hasCalculated:calculated.length>0,fields};
  });
 }
 async listQualityRules(ctx:RecordContext,collection:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_quality_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   await this.visible(tx,ctx,collection);
   const scope=await this.scopeOf(tx,ctx,tenant,proof,collection);
   const place=await this.place(tx,ctx,cursor,scope);
   const rows=(await tx.query<RuleRow>('SELECT * FROM hs_data_quality_rules WHERE tenant_id=$1 AND collection=$2 AND deprecated=false AND ($3::text IS NULL OR (name_search COLLATE "C",id)>($3 COLLATE "C",$4::uuid)) ORDER BY name_search COLLATE "C",id LIMIT 51',[ctx.tenantId,collection,place.afterName,place.afterId])).rows;
   const page=rows.slice(0,50),rules=[];
   for(const row of page){
    let available=true;
    try{await this.normalize(tx,ctx,collection,row.definition);}catch(error){if(!(error instanceof DocumentError)||!['record_quality_field_unavailable','record_quality_validation','record_quality_unavailable'].includes(error.code))throw error;available=false;}
    rules.push({id:row.id,name:row.name,version:Number(row.version),available});
   }
   const last=page.at(-1);
   return {rules,nextCursor:rows.length>50&&last?await this.next(tx,ctx,scope,last.name_search,last.id):null};
  });
 }
 async openQualityRule(ctx:RecordContext,ruleId:string){
  return this.transaction(ctx,async(tx,tenant)=>{
   const row=await this.lock(tx,ctx,ruleId);
   const form=await this.normalize(tx,ctx,row.collection,row.definition);
   const caps=await this.collectionCaps(tx,ctx,row.collection);
   return {...this.present(row,form),schemaVersion:Number(tenant.schema_version),canManage:caps.includes('view')&&caps.includes('schema')};
  });
 }
 async evaluateQuality(ctx:RecordContext,collection:string,recordId:string){
  if(typeof collection!=='string'||!collection||collection.length>100)throw fail('record_quality_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const {record}=await this.exact(tx,ctx,recordId);
   if(record.collection!==collection)throw missing();
   await this.visible(tx,ctx,collection);
   const fields=await this.fields(tx,ctx,collection);
   const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(row=>row.field_key));
   const visibility=await this.visibility(tx,ctx,collection,fields,record.field_values);
   const rows=(await tx.query<RuleRow>('SELECT * FROM hs_data_quality_rules WHERE tenant_id=$1 AND collection=$2 AND deprecated=false ORDER BY name_search COLLATE "C",id',[ctx.tenantId,collection])).rows;
   const rules=[];
   let withheld=false,complete=true,blocked=false;
   for(const row of rows){
    const form=this.parse(row.definition);
    let placement:Set<string>|null=null;
    if(form.layoutId){
     const layout=await this.publishedLayout(tx,ctx,collection);
     const bound=layout?layoutFields(layout,form.layoutId):undefined;
     if(!bound)continue;
     placement=bound;
    }
    const checks=[];
    for(const item of form.checks){
     const judged=await this.judge(tx,ctx,collection,item,fields,formulas,record.field_values,visibility,placement);
     if(judged==='withhold'){withheld=true;continue;}
     checks.push(judged);
     if(judged.status==='fail'){complete=false;if(form.enforcement==='block')blocked=true;}
    }
    rules.push({id:row.id,name:row.name,enforcement:form.enforcement,checks});
   }
   const caps=await this.collectionCaps(tx,ctx,collection);
   return {record:{id:record.id,name:record.name,version:record.version},schemaVersion:Number(tenant.schema_version),canManage:caps.includes('view')&&caps.includes('schema'),complete,blocked,withheld,...(withheld?{message:withheldMessage}:{}),rules};
  });
 }
}
function whenFields(when?:When|null){if(!when)return [];return ('all' in when?when.all:when.any).map(item=>item.field);}
function layoutFields(layout:RecordLayoutDefinition,layoutId:string){
 for(const tab of layout.tabs){
  if(tab.id===layoutId)return new Set(tab.sections.flatMap(section=>section.fields.map(slot=>slot.field)));
  for(const section of tab.sections)if(section.id===layoutId)return new Set(section.fields.map(slot=>slot.field));
 }
}
function safeJson(value:string){try{return JSON.parse(value) as unknown;}catch{return undefined;}}
function asObject(value:unknown):Record<string,unknown>{if(typeof value==='string'){const parsed=safeJson(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};}return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
