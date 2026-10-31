import {randomUUID} from 'node:crypto';
import type {Database,Sql} from './database';
import {DocumentError} from './document';
import type {RecordNotification,RecordNotificationReason} from './record-notifications-contract';
import {SharedRecordRepository,type RecordContext} from './shared-records';

const followerLimit=500;
type Recipient={id:string;reason:RecordNotificationReason};
type EventRow={id:string;tenant_id:string;workspace_id:string;record_id:string;comment_id:string;actor_id:string;recipients:unknown};
type InboxRow={id:string;record_id:string;record_name:string;comment_id:string;body:string;author_name:string;reason:string;created_at:string;read_at:string|null};
const missing=()=>new DocumentError('Notification unavailable.','not_found',404);

/** Current record view: active workspace membership plus a collection or record view grant. A follow row is not access. */
function canView(userId:string,workspace:string,tenant:string,collection:string,record:string){
 return `EXISTS(SELECT 1 FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=${workspace} AND m.active=true WHERE u.id=${userId} AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=${tenant} AND g.user_id=u.id AND g.collection=${collection} AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=${tenant} AND g.record_id=${record} AND g.user_id=u.id AND 'view'=ANY(g.capabilities))))`;
}

function recipients(value:unknown):Recipient[]{
 const source=typeof value==='string'?parsed(value):value;
 if(!Array.isArray(source))return [];
 const found=new Map<string,RecordNotificationReason>();
 for(const item of source){
  if(!item||typeof item!=='object')continue;
  const row=item as Record<string,unknown>;
  if(typeof row.id!=='string'||row.id.length<1||row.id.length>200)continue;
  if(row.reason!=='mention'&&row.reason!=='follow')continue;
  if(!found.has(row.id)||row.reason==='mention')found.set(row.id,row.reason);
 }
 return [...found].map(([id,reason])=>({id,reason}));
}
function parsed(value:string){try{return JSON.parse(value) as unknown;}catch{return [];}}

/** Durable event in the comment transaction. Delivery is a separate transaction. */
export async function enqueueRecordCommentNotification(tx:Sql,input:{tenantId:string;workspaceId:string;recordId:string;collection:string;commentId:string;actorId:string;mentionIds:string[]}){
 const followed=await tx.query<{user_id:string}>(`SELECT f.user_id FROM hs_data_record_follows f WHERE f.tenant_id=$2 AND f.record_id=$3 AND f.user_id<>$4 AND ${canView('f.user_id','$1','$2','$5','$3')} ORDER BY f.user_id LIMIT $6`,[input.workspaceId,input.tenantId,input.recordId,input.actorId,input.collection,followerLimit]);
 const people=new Map<string,RecordNotificationReason>();
 for(const id of input.mentionIds)if(id!==input.actorId)people.set(id,'mention');
 for(const row of followed.rows)if(!people.has(row.user_id))people.set(row.user_id,'follow');
 await tx.query('INSERT INTO hs_data_record_notification_events(id,tenant_id,workspace_id,record_id,comment_id,actor_id,recipients) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),input.tenantId,input.workspaceId,input.recordId,input.commentId,input.actorId,JSON.stringify([...people].map(([id,reason])=>({id,reason})))]);
}

/** Saved comment events stay pending when delivery fails. No schedule is installed. */
export async function drainRecordNotifications(db:Database){
 return db.transaction(async tx=>{
  const events=await tx.query<EventRow>('SELECT id,tenant_id,workspace_id,record_id,comment_id,actor_id,recipients FROM hs_data_record_notification_events WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED');
  for(const event of events.rows){
   const record=await tx.query<{collection:string;state:string}>('SELECT collection,state FROM hs_data_records WHERE tenant_id=$1 AND id=$2',[event.tenant_id,event.record_id]);
   const comment=await tx.query('SELECT id FROM hs_data_record_comments WHERE id=$1 AND tenant_id=$2 AND record_id=$3',[event.comment_id,event.tenant_id,event.record_id]);
   const current=record.rows[0];
   if(current&&current.state!=='trashed'&&comment.rows.length){
    for(const recipient of recipients(event.recipients)){
     if(recipient.id===event.actor_id)continue;
     const allowed=await tx.query<{ok:boolean}>(`SELECT ${canView('$1','$2','$3','$4','$5')} AS ok`,[recipient.id,event.workspace_id,event.tenant_id,current.collection,event.record_id]);
     if(!allowed.rows[0]?.ok)continue;
     await tx.query('INSERT INTO hs_data_record_notifications(id,event_id,recipient_id,tenant_id,workspace_id,record_id,comment_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id,recipient_id) DO NOTHING',[randomUUID(),event.id,recipient.id,event.tenant_id,event.workspace_id,event.record_id,event.comment_id,recipient.reason]);
    }
   }
   await tx.query('UPDATE hs_data_record_notification_events SET delivered_at=clock_timestamp() WHERE id=$1',[event.id]);
  }
  return events.rows.length;
 });
}

const visible=`n.recipient_id=$1 AND n.tenant_id=$2 AND r.state<>'trashed' AND ${canView('n.recipient_id','$3','n.tenant_id','r.collection','n.record_id')}`;
const inboxSql=`SELECT n.id,n.record_id,r.name AS record_name,n.comment_id,c.body,u.name AS author_name,n.reason,n.created_at,n.read_at FROM hs_data_record_notifications n JOIN hs_data_record_comments c ON c.id=n.comment_id AND c.tenant_id=n.tenant_id AND c.record_id=n.record_id JOIN hs_users u ON u.id=c.author_id JOIN hs_data_records r ON r.tenant_id=n.tenant_id AND r.id=n.record_id WHERE ${visible}`;

function shown(row:InboxRow):RecordNotification|null{
 if(row.reason!=='mention'&&row.reason!=='follow')return null;
 return {id:row.id,recordId:row.record_id,recordName:row.record_name,commentId:row.comment_id,body:row.body,authorName:row.author_name,reason:row.reason,createdAt:new Date(row.created_at).toISOString(),readAt:row.read_at?new Date(row.read_at).toISOString():null};
}

export class SharedRecordNotificationsRepository extends SharedRecordRepository {
 async listNotifications(ctx:RecordContext){
  try{await drainRecordNotifications(this.pages.db);}catch{ /* Saved events remain pending for a later request. */ }
  return this.transaction(ctx,async tx=>{
   const rows=await tx.query<InboxRow>(`${inboxSql} ORDER BY n.created_at DESC,n.id DESC LIMIT 100`,[ctx.actor.id,ctx.tenantId,ctx.workspaceId]);
   return {notifications:rows.rows.map(shown).filter((item):item is RecordNotification=>!!item)};
  });
 }
 async readNotification(ctx:RecordContext,id:string){
  return this.transaction(ctx,async tx=>{
   const rows=await tx.query<{id:string}>(`SELECT n.id FROM hs_data_record_notifications n JOIN hs_data_records r ON r.tenant_id=n.tenant_id AND r.id=n.record_id WHERE n.id=$4 AND ${visible}`,[ctx.actor.id,ctx.tenantId,ctx.workspaceId,id]);
   if(!rows.rows[0])throw missing();
   await tx.query('UPDATE hs_data_record_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND recipient_id=$2',[id,ctx.actor.id]);
   return {id,read:true as const};
  });
 }
}
