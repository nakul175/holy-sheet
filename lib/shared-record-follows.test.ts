import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner,type Actor} from './auth';
import {drainRecordNotifications,SharedRecordNotificationsRepository} from './record-notifications';
import {SharedRecordCommentsRepository} from './shared-record-comments';
import {SharedRecordFollowsRepository} from './shared-record-follows';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {recordCapabilities} from './shared-record-types';

let db:Database,pages:Repository,ctx:RecordContext;
const viewer:Actor={id:'follow-viewer'},hidden:Actor={id:'follow-hidden'},editOnly:Actor={id:'follow-edit-only'},outsider:Actor={id:'follow-outsider'};
const authority={verify:vi.fn(async(c:RecordContext)=>({subject:c.actor.id,tenantId:c.tenantId,workspaceId:c.workspaceId,active:true,tenantAdministrator:c.actor.id===owner.id,revision:'synthetic-follow-authority-v1'}))};
const follows=()=>new SharedRecordFollowsRepository(pages,authority);
const comments=()=>new SharedRecordCommentsRepository(pages,authority);
const notes=()=>new SharedRecordNotificationsRepository(pages,authority);
const records=()=>new SharedRecordRepository(pages,authority);
const as=(actor:Actor)=>({...ctx,actor});
beforeAll(async()=>{db=await createDatabase(':memory:');pages=new Repository(db);await pages.seedLocal();for(const [actor,name] of [[viewer,'Ada Viewer'],[hidden,'Secret colleague'],[editOnly,'Edit Only'],[outsider,'Outside Person']] as const)await db.query('INSERT INTO hs_users(id,name) VALUES($1,$2)',[actor.id,name]);});
beforeEach(async()=>{vi.mocked(authority.verify).mockClear();ctx={actor:owner,tenantId:crypto.randomUUID(),workspaceId:'follows-'+crypto.randomUUID()};await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$1)',[ctx.workspaceId]);for(const actor of [owner,viewer,hidden,editOnly])await db.query('INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)',[ctx.workspaceId,actor.id]);await db.query('INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)',[ctx.tenantId,'Synthetic tenant']);await db.query('INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)',[ctx.workspaceId,ctx.tenantId,'Synthetic fixture only']);await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)",[ctx.tenantId]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,owner.id,[...recordCapabilities]]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,viewer.id,['view']]);});
afterAll(async()=>db.close());

async function organisation(){return (await records().create(ctx,{operationId:crypto.randomUUID(),collection:'organisations',name:'Northwind',schemaVersion:1,values:{}})).record;}
async function grant(recordId:string,actor:Actor,capabilities:string[]){await db.query('INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)',[ctx.tenantId,recordId,actor.id,capabilities]);}
async function accessRows(){const grants=await db.query<{n:number}>('SELECT ((SELECT count(*) FROM hs_data_collection_grants WHERE tenant_id=$1)+(SELECT count(*) FROM hs_data_record_grants WHERE tenant_id=$1))::int AS n',[ctx.tenantId]);return Number(grants.rows[0].n);}
async function followRows(recordId:string,actor:Actor){return Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_record_follows WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,recordId,actor.id])).rows[0].n);}
async function notificationsFor(actor:Actor){return (await db.query<{recipient_id:string;reason:string}>('SELECT recipient_id,reason FROM hs_data_record_notifications WHERE tenant_id=$1 AND recipient_id=$2',[ctx.tenantId,actor.id])).rows;}

it('lets a viewer follow and unfollow without granting access or changing the record',async()=>{
 const record=await organisation(),before=await accessRows(),version=record.version;
 expect(await follows().followState(as(viewer),record.id)).toEqual({following:false});
 expect(await follows().follow(as(viewer),record.id)).toEqual({following:true});
 expect(await follows().follow(as(viewer),record.id)).toEqual({following:true});
 expect(await followRows(record.id,viewer)).toBe(1);
 expect(await follows().followState(as(viewer),record.id)).toEqual({following:true});
 expect((await records().get(as(viewer),record.id)).capabilities).toEqual(['view']);
 expect((await records().get(as(viewer),record.id)).version).toBe(version);
 expect(await accessRows()).toBe(before);
 const audit=(await db.query<{value:string}>("SELECT after_value::text AS value FROM hs_audit WHERE actor_id=$1 AND action='shared-record.follow'",[viewer.id])).rows.at(-1)!.value;
 expect(audit).toContain(record.id);
 expect(audit).not.toContain('view');
 expect(await follows().unfollow(as(viewer),record.id)).toEqual({following:false});
 expect(await follows().unfollow(as(viewer),record.id)).toEqual({following:false});
 expect(await followRows(record.id,viewer)).toBe(0);
 expect(await follows().followState(as(viewer),record.id)).toEqual({following:false});
 expect(await accessRows()).toBe(before);
});

it('denies follow to people who cannot view and keeps a stored follow from becoming access',async()=>{
 const record=await organisation();
 await grant(record.id,editOnly,['edit']);
 for(const actor of [hidden,editOnly,outsider]){
  await expect(follows().followState(as(actor),record.id)).rejects.toMatchObject({code:'record_not_found',status:404});
  await expect(follows().follow(as(actor),record.id)).rejects.toMatchObject({status:404});
  await expect(follows().unfollow(as(actor),record.id)).rejects.toMatchObject({status:404});
  expect(await followRows(record.id,actor)).toBe(0);
 }
 await db.query('INSERT INTO hs_data_record_follows(tenant_id,record_id,user_id) VALUES($1,$2,$3)',[ctx.tenantId,record.id,hidden.id]);
 await expect(records().get(as(hidden),record.id)).rejects.toMatchObject({status:404});
 await expect(comments().listComments(as(hidden),record.id)).rejects.toMatchObject({status:404});
 const phrase='orchid-follow-secret';
 await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:`Note ${phrase}`,mentionIds:[]});
 expect(await notificationsFor(hidden)).toEqual([]);
 expect(JSON.stringify(await notes().listNotifications(as(hidden)).catch((error:unknown)=>error))).not.toContain(phrase);
 await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,viewer.id]);
 await expect(follows().follow(as(viewer),record.id)).rejects.toMatchObject({status:404});
});

it('notifies a follower and a mentioned person once, and does not notify the author',async()=>{
 const record=await organisation(),phrase='orchid-comment-notice';
 await follows().follow(as(viewer),record.id);
 await follows().follow(ctx,record.id);
 const saved=await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:`Hello @Ada Viewer ${phrase}`,mentionIds:[viewer.id]});
 expect(await notificationsFor(owner)).toEqual([]);
 expect(await notificationsFor(viewer)).toEqual([{recipient_id:viewer.id,reason:'mention'}]);
 const listed=await notes().listNotifications(as(viewer));
 expect(listed.notifications).toHaveLength(1);
 expect(listed.notifications[0]).toMatchObject({recordId:record.id,recordName:'Northwind',commentId:saved.comment.id,authorName:'Your workspace',reason:'mention',readAt:null});
 expect(listed.notifications[0].body).toContain(phrase);
 expect(Object.keys(listed.notifications[0]).sort()).toEqual(['authorName','body','commentId','createdAt','id','readAt','reason','recordId','recordName']);
 expect(listed.notifications[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 const input={operationId:crypto.randomUUID(),body:`Hello @Ada Viewer ${phrase}`,mentionIds:[viewer.id]};
 const again=await comments().createComment(ctx,record.id,input);
 const same=await comments().createComment(ctx,record.id,input);
 expect(same.replayed).toBe(true);
 expect(same.comment.id).toBe(again.comment.id);
 expect(await notificationsFor(viewer)).toHaveLength(2);
 expect(Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_record_notification_events WHERE comment_id=$1',[again.comment.id])).rows[0].n)).toBe(1);
 await drainRecordNotifications(db);
 expect(await notificationsFor(viewer)).toHaveLength(2);
 expect(saved.comment.id).not.toBe(again.comment.id);
});

it('notifies a follower who was not mentioned and skips the author',async()=>{
 const record=await organisation();
 await follows().follow(as(viewer),record.id);
 const followed=await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'A quiet update',mentionIds:[]});
 expect((await notes().listNotifications(as(viewer))).notifications.map(item=>item.reason)).toEqual(['follow']);
 expect((await notes().listNotifications(as(viewer))).notifications[0].commentId).toBe(followed.comment.id);
 const recordOnly=await organisation();
 await follows().follow(as(viewer),recordOnly.id);
 await comments().createComment(as(viewer),recordOnly.id,{operationId:crypto.randomUUID(),body:'My own note',mentionIds:[]});
 expect(await notificationsFor(viewer)).toHaveLength(1);
});

it('lists and marks a notification read, then hides it when view is removed',async()=>{
 const record=await organisation(),phrase='orchid-inbox-secret';
 await follows().follow(as(viewer),record.id);
 await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:phrase,mentionIds:[]});
 const item=(await notes().listNotifications(as(viewer))).notifications[0];
 const read=await notes().readNotification(as(viewer),item.id);
 expect(read).toEqual({id:item.id,read:true});
 const stamped=(await db.query<{read_at:string}>('SELECT read_at FROM hs_data_record_notifications WHERE id=$1',[item.id])).rows[0].read_at;
 expect(await notes().readNotification(as(viewer),item.id)).toEqual({id:item.id,read:true});
 expect((await db.query<{read_at:string}>('SELECT read_at FROM hs_data_record_notifications WHERE id=$1',[item.id])).rows[0].read_at).toEqual(stamped);
 expect((await notes().listNotifications(as(viewer))).notifications[0].readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 await expect(notes().readNotification(ctx,item.id)).rejects.toMatchObject({code:'not_found',status:404});
 expect((await db.query<{read_at:string}>('SELECT read_at FROM hs_data_record_notifications WHERE id=$1',[item.id])).rows[0].read_at).toEqual(stamped);
 await expect(notes().readNotification(as(outsider),item.id)).rejects.toMatchObject({status:404});
 await expect(notes().listNotifications(as(outsider))).rejects.toMatchObject({code:'record_not_found',status:404});
 await db.query('DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,viewer.id]);
 expect(await followRows(record.id,viewer)).toBe(1);
 await expect(records().get(as(viewer),record.id)).rejects.toMatchObject({status:404});
 const hiddenList=await notes().listNotifications(as(viewer));
 expect(hiddenList.notifications).toEqual([]);
 expect(JSON.stringify(hiddenList)).not.toContain(phrase);
 await expect(notes().readNotification(as(viewer),item.id)).rejects.toMatchObject({status:404});
 await expect(follows().unfollow(as(viewer),record.id)).rejects.toMatchObject({status:404});
});

it('does not deliver a pending notification to someone who cannot view',async()=>{
 const record=await organisation();
 const saved=await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Already delivered',mentionIds:[]});
 const eventId=crypto.randomUUID();
 await db.query('INSERT INTO hs_data_record_notification_events(id,tenant_id,workspace_id,record_id,comment_id,actor_id,recipients) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,ctx.tenantId,ctx.workspaceId,record.id,saved.comment.id,owner.id,JSON.stringify([{id:hidden.id,reason:'follow'},{id:viewer.id,reason:'mention'}])]);
 expect(await drainRecordNotifications(db)).toBe(1);
 expect(await notificationsFor(hidden)).toEqual([]);
 expect(await notificationsFor(viewer)).toEqual([{recipient_id:viewer.id,reason:'mention'}]);
 expect((await db.query<{delivered_at:string|null}>('SELECT delivered_at FROM hs_data_record_notification_events WHERE id=$1',[eventId])).rows[0].delivered_at).toBeTruthy();
 await follows().unfollow(as(viewer),record.id);
 const quiet=await organisation();
 await comments().createComment(ctx,quiet.id,{operationId:crypto.randomUUID(),body:'After unfollow',mentionIds:[]});
 expect((await notes().listNotifications(as(viewer))).notifications.map(item=>item.recordId)).toEqual([record.id]);
});
