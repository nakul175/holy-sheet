import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import type {RecordResponsibilityPerson,RecordResponsibilityState} from './record-responsibility-contract';
import {SharedRecordRepository,type RecordContext,type Stored} from './shared-records';
import {recordHash,type RecordCapability} from './shared-record-types';

const uuid=z.string().uuid();
const offer=z.object({operationId:uuid,toUserId:z.string().min(1).max(200)}).strict();
const complete=z.object({operationId:uuid}).strict();
export type OfferResponsibilityInput=z.infer<typeof offer>;
export type CompleteResponsibilityInput=z.infer<typeof complete>;
const invalid=()=>new DocumentError('Review the handover and try again.','record_handover_validation',400);
const unavailable=()=>new DocumentError('That person is unavailable or cannot view this record.','handover_target_unavailable',422);
const forbidden=()=>new DocumentError('You cannot change responsibility for this record.','record_handover_forbidden',403);
const pending=()=>new DocumentError('A handover is already waiting.','handover_pending',409);
const notPending=()=>new DocumentError('There is no handover waiting.','handover_not_pending',409);
const mismatch=()=>new DocumentError('Operation identity was reused with changed fields.','operation_mismatch',409);
const viewSql=(tenant:string,collection:string,record:string)=>`EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=${tenant} AND g.user_id=u.id AND g.collection=${collection} AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=${tenant} AND g.record_id=${record} AND g.user_id=u.id AND 'view'=ANY(g.capabilities))`;
type PendingRow={id:string;from_user_id:string;to_user_id:string;created_at:string};
type Loaded={responsibleId:string|null;pending:PendingRow|null;caps:RecordCapability[]};

/** Responsibility uses the caller's existing record view. It does not grant record, field, or workspace access. */
export class SharedRecordResponsibilityRepository extends SharedRecordRepository {
 async state(ctx:RecordContext,recordId:string){
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   return this.present(tx,ctx,await this.load(tx,ctx,record));
  });
 }
 async people(ctx:RecordContext,recordId:string,query:string){
  const q=query.trim();
  if([...q].length>80)throw invalid();
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   if([...q].length<2)return {people:[] as RecordResponsibilityPerson[]};
   const loaded=await this.load(tx,ctx,record);
   const pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
   const rows=await tx.query<RecordResponsibilityPerson>(`SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$1 AND m.active=true WHERE u.id<>$2 AND ($3::text IS NULL OR u.id<>$3) AND u.name ILIKE $4 ESCAPE '\\' AND char_length(btrim(u.name))>0 AND (${viewSql('$5','$6','$7')}) ORDER BY u.name,u.id LIMIT 20`,[ctx.workspaceId,ctx.actor.id,loaded.responsibleId,pattern,ctx.tenantId,record.collection,record.id]);
   const needle=q.toLocaleLowerCase();
   return {people:rows.rows.filter(person=>person.name.toLocaleLowerCase().includes(needle)).slice(0,20)};
  });
 }
 async offer(ctx:RecordContext,recordId:string,input:OfferResponsibilityInput){
  const parsed=offer.safeParse(input);
  if(!parsed.success)throw invalid();
  const requestHash=recordHash({kind:'record-responsibility',action:'offer',recordId,toUserId:parsed.data.toUserId});
  return this.change(ctx,recordId,parsed.data.operationId,requestHash,'offer',async(tx,record,loaded)=>{
   if(loaded.pending)throw pending();
   const holder=loaded.responsibleId===ctx.actor.id;
   const vacant=loaded.responsibleId===null&&loaded.caps.includes('edit');
   if(!holder&&!vacant)throw forbidden();
   if(parsed.data.toUserId===ctx.actor.id||!(await this.canView(tx,ctx,record,parsed.data.toUserId)))throw unavailable();
   const id=randomUUID();
   try{
    await tx.query('INSERT INTO hs_data_record_handovers(id,tenant_id,record_id,from_user_id,to_user_id,state) VALUES($1,$2,$3,$4,$5,$6)',[id,ctx.tenantId,record.id,ctx.actor.id,parsed.data.toUserId,'pending']);
   }catch(error){
    if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')throw pending();
    throw error;
   }
   await this.audit(tx,ctx,'shared-record.responsibility-offer',{tenantId:ctx.tenantId,recordId:record.id,handoverId:id,fromUserId:ctx.actor.id,toUserId:parsed.data.toUserId},parsed.data.operationId);
   return id;
  });
 }
 async accept(ctx:RecordContext,recordId:string,input:CompleteResponsibilityInput){
  const parsed=complete.safeParse(input);
  if(!parsed.success)throw invalid();
  const requestHash=recordHash({kind:'record-responsibility',action:'accept',recordId});
  return this.change(ctx,recordId,parsed.data.operationId,requestHash,'accept',async(tx,record,loaded)=>{
   if(!loaded.pending||loaded.pending.to_user_id!==ctx.actor.id)throw loaded.pending?forbidden():notPending();
   const updated=await tx.query('UPDATE hs_data_record_handovers SET state=$2,resolved_at=clock_timestamp() WHERE id=$1 AND state=$3 RETURNING id',[loaded.pending.id,'accepted','pending']);
   if(!updated.rows.length)throw notPending();
   await tx.query('INSERT INTO hs_data_record_responsibility(tenant_id,record_id,user_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,record_id) DO UPDATE SET user_id=excluded.user_id,assigned_at=clock_timestamp()',[ctx.tenantId,record.id,ctx.actor.id]);
   await this.audit(tx,ctx,'shared-record.responsibility-accept',{tenantId:ctx.tenantId,recordId:record.id,handoverId:loaded.pending.id,fromUserId:loaded.pending.from_user_id,toUserId:ctx.actor.id},parsed.data.operationId);
   return loaded.pending.id;
  });
 }
 async cancel(ctx:RecordContext,recordId:string,input:CompleteResponsibilityInput){
  const parsed=complete.safeParse(input);
  if(!parsed.success)throw invalid();
  const requestHash=recordHash({kind:'record-responsibility',action:'cancel',recordId});
  return this.change(ctx,recordId,parsed.data.operationId,requestHash,'cancel',async(tx,record,loaded)=>{
   if(!loaded.pending||loaded.pending.from_user_id!==ctx.actor.id)throw loaded.pending?forbidden():notPending();
   const updated=await tx.query('UPDATE hs_data_record_handovers SET state=$2,resolved_at=clock_timestamp() WHERE id=$1 AND state=$3 RETURNING id',[loaded.pending.id,'cancelled','pending']);
   if(!updated.rows.length)throw notPending();
   await this.audit(tx,ctx,'shared-record.responsibility-cancel',{tenantId:ctx.tenantId,recordId:record.id,handoverId:loaded.pending.id,fromUserId:ctx.actor.id,toUserId:loaded.pending.to_user_id,reason:'withdrawn'},parsed.data.operationId);
   return loaded.pending.id;
  });
 }
 private async change(ctx:RecordContext,recordId:string,operationId:string,requestHash:string,kind:'offer'|'accept'|'cancel',apply:(tx:Sql,record:Stored,loaded:Loaded)=>Promise<string>){
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   const prior=await tx.query<{request_hash:string;record_id:string}>('SELECT request_hash,record_id FROM hs_data_record_handover_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,operationId]);
   if(prior.rows[0]){
    if(prior.rows[0].request_hash!==requestHash||prior.rows[0].record_id!==record.id)throw mismatch();
    return {...await this.present(tx,ctx,await this.load(tx,ctx,record)),replayed:true};
   }
   const loaded=await this.load(tx,ctx,record);
   const handoverId=await apply(tx,record,loaded);
   await tx.query('INSERT INTO hs_data_record_handover_operations(tenant_id,actor_id,operation_id,request_hash,record_id,handover_id,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,ctx.actor.id,operationId,requestHash,record.id,handoverId,kind]);
   return {...await this.present(tx,ctx,await this.load(tx,ctx,record)),replayed:false};
  });
 }
 private async load(tx:Sql,ctx:RecordContext,record:Stored):Promise<Loaded>{
  const stored=await tx.query<{user_id:string|null}>('SELECT user_id FROM hs_data_record_responsibility WHERE tenant_id=$1 AND record_id=$2 FOR UPDATE',[ctx.tenantId,record.id]);
  let responsibleId:string|null;
  if(stored.rows.length){
   const userId=stored.rows[0].user_id;
   if(userId&&!(await this.canView(tx,ctx,record,userId))){
    await tx.query('UPDATE hs_data_record_responsibility SET user_id=NULL,assigned_at=clock_timestamp() WHERE tenant_id=$1 AND record_id=$2',[ctx.tenantId,record.id]);
    await this.audit(tx,ctx,'shared-record.responsibility-clear',{tenantId:ctx.tenantId,recordId:record.id,previousUserId:userId},randomUUID());
    responsibleId=null;
   }else responsibleId=userId;
  }else responsibleId=await this.canView(tx,ctx,record,record.created_by)?record.created_by:null;
  const waiting=await tx.query<PendingRow>('SELECT id,from_user_id,to_user_id,created_at FROM hs_data_record_handovers WHERE tenant_id=$1 AND record_id=$2 AND state=$3 FOR UPDATE',[ctx.tenantId,record.id,'pending']);
  let open:PendingRow|null=waiting.rows[0]??null;
  if(open){
   const stale=responsibleId!==null&&open.from_user_id!==responsibleId;
   const lost=!(await this.canView(tx,ctx,record,open.from_user_id))||!(await this.canView(tx,ctx,record,open.to_user_id));
   if(stale||lost){
    await tx.query('UPDATE hs_data_record_handovers SET state=$2,resolved_at=clock_timestamp() WHERE id=$1 AND state=$3',[open.id,'cancelled','pending']);
    await this.audit(tx,ctx,'shared-record.responsibility-cancel',{tenantId:ctx.tenantId,recordId:record.id,handoverId:open.id,fromUserId:open.from_user_id,toUserId:open.to_user_id,reason:'access'},randomUUID());
    open=null;
   }
  }
  return {responsibleId,pending:open,caps:await this.caps(tx,ctx,record)};
 }
 private async present(tx:Sql,ctx:RecordContext,loaded:Loaded):Promise<RecordResponsibilityState>{
  const ids=[loaded.responsibleId,loaded.pending?.from_user_id,loaded.pending?.to_user_id].filter((id):id is string=>!!id);
  const names=new Map<string,string>();
  if(ids.length){
   const rows=await tx.query<RecordResponsibilityPerson>('SELECT id,name FROM hs_users WHERE id=ANY($1::text[])',[ids]);
   for(const row of rows.rows)names.set(row.id,row.name);
  }
  const named=(id:string|null|undefined)=>id&&names.get(id)?{id,name:names.get(id)!}:null;
  const responsible=named(loaded.responsibleId);
  const from=named(loaded.pending?.from_user_id),to=named(loaded.pending?.to_user_id);
  const pending=loaded.pending&&from&&to?{id:loaded.pending.id,from,to,createdAt:new Date(loaded.pending.created_at).toISOString()}:null;
  const holder=loaded.responsibleId===ctx.actor.id;
  const vacant=loaded.responsibleId===null&&loaded.caps.includes('edit');
  return {
   responsible:responsible&&responsible.id===loaded.responsibleId?responsible:null,
   pending,
   canOffer:!pending&&(holder||vacant),
   canAccept:!!pending&&pending.to.id===ctx.actor.id,
   canCancel:!!pending&&pending.from.id===ctx.actor.id,
  };
 }
 private async canView(tx:Sql,ctx:RecordContext,record:Stored,userId:string){
  const rows=await tx.query(`SELECT 1 FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true WHERE u.id=$1 AND (${viewSql('$3','$4','$5')})`,[userId,ctx.workspaceId,ctx.tenantId,record.collection,record.id]);
  return rows.rows.length>0;
 }
 private async audit(tx:Sql,ctx:RecordContext,action:string,value:Record<string,string>,correlationId:string){
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,action,JSON.stringify(value),correlationId]);
 }
}
