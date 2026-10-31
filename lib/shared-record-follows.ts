import {randomUUID} from 'node:crypto';
import {SharedRecordRepository,type RecordContext} from './shared-records';

/** Following uses the caller's existing record view. It does not grant record, field, or workspace access. */
export class SharedRecordFollowsRepository extends SharedRecordRepository {
 async followState(ctx:RecordContext,recordId:string){
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   const rows=await tx.query('SELECT 1 FROM hs_data_record_follows WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,record.id,ctx.actor.id]);
   return {following:rows.rows.length>0};
  });
 }
 async follow(ctx:RecordContext,recordId:string){return this.change(ctx,recordId,true);}
 async unfollow(ctx:RecordContext,recordId:string){return this.change(ctx,recordId,false);}
 private async change(ctx:RecordContext,recordId:string,following:boolean){
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   const changed=following
    ? await tx.query('INSERT INTO hs_data_record_follows(tenant_id,record_id,user_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,record_id,user_id) DO NOTHING RETURNING user_id',[ctx.tenantId,record.id,ctx.actor.id])
    : await tx.query('DELETE FROM hs_data_record_follows WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3 RETURNING user_id',[ctx.tenantId,record.id,ctx.actor.id]);
   if(changed.rows.length)await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,following?'shared-record.follow':'shared-record.unfollow',JSON.stringify({tenantId:ctx.tenantId,recordId:record.id}),randomUUID()]);
   return {following};
  });
 }
}
