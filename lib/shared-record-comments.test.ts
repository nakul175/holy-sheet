import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner,type Actor} from './auth';
import {bodyIncludesMention,commentBodyParts} from './record-comments-contract';
import {SharedRecordCommentsRepository} from './shared-record-comments';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {recordCapabilities} from './shared-record-types';

let db:Database,pages:Repository,ctx:RecordContext;
const viewer:Actor={id:'comments-viewer'},hidden:Actor={id:'comments-hidden'},limited:Actor={id:'comments-limited'},editOnly:Actor={id:'comments-edit-only'},outsider:Actor={id:'comments-outsider'};
const authority={verify:vi.fn(async(c:RecordContext)=>({subject:c.actor.id,tenantId:c.tenantId,workspaceId:c.workspaceId,active:true,tenantAdministrator:c.actor.id===owner.id,revision:'synthetic-comment-authority-v1'}))};
const comments=()=>new SharedRecordCommentsRepository(pages,authority);
const records=()=>new SharedRecordRepository(pages,authority);
const as=(actor:Actor)=>({...ctx,actor});
beforeAll(async()=>{db=await createDatabase(':memory:');pages=new Repository(db);await pages.seedLocal();for(const [actor,name] of [[viewer,'Ada Viewer'],[hidden,'Secret colleague'],[limited,'Limited Grant'],[editOnly,'Edit Only'],[outsider,'Outside Person']] as const)await db.query('INSERT INTO hs_users(id,name) VALUES($1,$2)',[actor.id,name]);});
beforeEach(async()=>{vi.mocked(authority.verify).mockClear();ctx={actor:owner,tenantId:crypto.randomUUID(),workspaceId:'comments-'+crypto.randomUUID()};await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$1)',[ctx.workspaceId]);for(const actor of [owner,viewer,hidden,limited,editOnly])await db.query('INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)',[ctx.workspaceId,actor.id]);await db.query('INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)',[ctx.tenantId,'Synthetic tenant']);await db.query('INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)',[ctx.workspaceId,ctx.tenantId,'Synthetic fixture only']);await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)",[ctx.tenantId]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,owner.id,[...recordCapabilities]]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,viewer.id,['view']]);});
afterAll(async()=>db.close());

async function organisation(){return (await records().create(ctx,{operationId:crypto.randomUUID(),collection:'organisations',name:'Northwind',schemaVersion:1,values:{}})).record;}
async function grant(recordId:string,actor:Actor,capabilities:string[]){await db.query('INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)',[ctx.tenantId,recordId,actor.id,capabilities]);}
async function accessRows(){const grants=await db.query<{n:number}>('SELECT ((SELECT count(*) FROM hs_data_collection_grants WHERE tenant_id=$1)+(SELECT count(*) FROM hs_data_record_grants WHERE tenant_id=$1))::int AS n',[ctx.tenantId]);const members=await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_members WHERE workspace_id=$1',[ctx.workspaceId]);return {grants:Number(grants.rows[0].n),members:Number(members.rows[0].n)};}
async function commentCount(recordId:string){return Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_record_comments WHERE tenant_id=$1 AND record_id=$2',[ctx.tenantId,recordId])).rows[0].n);}

it('parses an @mention without treating a shorter name as the longer one',()=>{
 expect(bodyIncludesMention('Thanks @Ada Viewer','Ada Viewer')).toBe(true);
 expect(bodyIncludesMention('Thanks @Ada Viewer','Ada')).toBe(true);
 expect(bodyIncludesMention('Thanks @Ada Viewer','')).toBe(false);
 expect(bodyIncludesMention('Thanks @Ada Viewer','Ada@Viewer')).toBe(false);
 expect(bodyIncludesMention('Thanks @Ada','Ada\nViewer')).toBe(false);
 const parts=commentBodyParts('Thanks @Ada Viewer',[{id:'long',name:'Ada Viewer'},{id:'short',name:'Ada'}]);
 expect(parts).toEqual([{text:'Thanks '},{text:'@Ada Viewer',mentionId:'long'}]);
 expect(commentBodyParts('Hi @Ada',[{id:'long',name:'Ada Viewer'},{id:'short',name:'Ada'}])).toEqual([{text:'Hi '},{text:'@Ada',mentionId:'short'}]);
});

it('creates and lists a comment for a viewer without edit, and keeps the mention',async()=>{
 const record=await organisation(),before=await accessRows(),phrase='orchid-comment-secret',operationId=crypto.randomUUID();
 const saved=await comments().createComment(as(viewer),record.id,{operationId,body:`Thanks @Your workspace for ${phrase}`,mentionIds:[owner.id]});
 expect(saved.replayed).toBe(false);
 expect(saved.comment).toMatchObject({authorId:viewer.id,authorName:'Ada Viewer',body:`Thanks @Your workspace for ${phrase}`,mentions:[{id:owner.id,name:'Your workspace'}]});
 expect(saved.comment.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 const listed=await comments().listComments(ctx,record.id);
 expect(listed.truncated).toBe(false);
 expect(listed.comments.map(comment=>comment.id)).toEqual([saved.comment.id]);
 expect(listed.comments[0].mentions).toEqual([{id:owner.id,name:'Your workspace'}]);
 expect((await records().get(ctx,record.id)).version).toBe(record.version);
 expect(await accessRows()).toEqual(before);
 const audit=(await db.query<{value:string}>('SELECT after_value::text AS value FROM hs_audit WHERE correlation_id=$1',[operationId])).rows[0].value;
 expect(audit).toContain(saved.comment.id);
 expect(audit).not.toContain(phrase);
 expect(Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_events WHERE record_id=$1',[record.id])).rows[0].n)).toBe(1);
 await expect(db.query('UPDATE hs_data_record_comments SET body=$2 WHERE id=$1',[saved.comment.id,'tampered'])).rejects.toThrow(/immutable/);
 expect((await comments().listComments(as(viewer),record.id)).comments[0].body).toContain(phrase);
});

it('resolves mention search to members who can view and ignores wildcard characters',async()=>{
 const record=await organisation();
 expect((await comments().mentionPeople(ctx,record.id,'ada')).people).toEqual([{id:viewer.id,name:'Ada Viewer'}]);
 expect((await comments().mentionPeople(ctx,record.id,'Secret')).people).toEqual([]);
 expect((await comments().mentionPeople(ctx,record.id,'A')).people).toEqual([]);
 expect((await comments().mentionPeople(ctx,record.id,'%')).people).toEqual([]);
 expect((await comments().mentionPeople(ctx,record.id,'_')).people).toEqual([]);
 await expect(comments().mentionPeople(as(hidden),record.id,'Ada')).rejects.toMatchObject({code:'record_not_found',status:404});
});

it('rejects a mention of a member who cannot view and does not grant access',async()=>{
 const record=await organisation(),before=await accessRows();
 await expect(comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Hello @Secret colleague',mentionIds:[hidden.id]})).rejects.toMatchObject({code:'mention_unavailable',status:422});
 await expect(comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Hello @Outside Person',mentionIds:[outsider.id]})).rejects.toMatchObject({code:'mention_unavailable'});
 await expect(comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Hello there',mentionIds:[viewer.id]})).rejects.toMatchObject({code:'mention_changed'});
 expect(await commentCount(record.id)).toBe(0);
 expect(await accessRows()).toEqual(before);
 await expect(comments().listComments(as(hidden),record.id)).rejects.toMatchObject({code:'record_not_found',status:404});
 await expect(comments().createComment(as(hidden),record.id,{operationId:crypto.randomUUID(),body:' ',mentionIds:[]})).rejects.toMatchObject({status:404});
 await expect(comments().listComments(as(outsider),record.id)).rejects.toMatchObject({status:404});
});

it('lets a record-level viewer comment and be mentioned, and denies edit without view',async()=>{
 const record=await organisation();
 await grant(record.id,limited,['view']);
 await grant(record.id,editOnly,['edit']);
 const saved=await comments().createComment(as(limited),record.id,{operationId:crypto.randomUUID(),body:'Noted @Ada Viewer',mentionIds:[viewer.id]});
 expect(saved.comment.authorId).toBe(limited.id);
 expect(saved.comment.mentions).toEqual([{id:viewer.id,name:'Ada Viewer'}]);
 expect((await comments().mentionPeople(ctx,record.id,'Limited')).people).toEqual([{id:limited.id,name:'Limited Grant'}]);
 expect((await comments().mentionPeople(ctx,record.id,'Edit Only')).people).toEqual([]);
 await expect(comments().listComments(as(editOnly),record.id)).rejects.toMatchObject({status:404});
 await expect(comments().createComment(as(editOnly),record.id,{operationId:crypto.randomUUID(),body:'Should not post',mentionIds:[]})).rejects.toMatchObject({status:404});
 await expect(comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Hello @Edit Only',mentionIds:[editOnly.id]})).rejects.toMatchObject({code:'mention_unavailable'});
 const grants=await db.query<{capabilities:string[]}>('SELECT capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,record.id,editOnly.id]);
 expect(grants.rows[0].capabilities).toEqual(['edit']);
});

it('replays the same comment once and rejects a reused operation',async()=>{
 const record=await organisation(),operationId=crypto.randomUUID(),input={operationId,body:'First note @Ada Viewer',mentionIds:[viewer.id,viewer.id]};
 const first=await comments().createComment(ctx,record.id,input);
 const replay=await comments().createComment(ctx,record.id,{...input,mentionIds:[viewer.id]});
 expect(replay.replayed).toBe(true);
 expect(replay.comment.id).toBe(first.comment.id);
 expect(await commentCount(record.id)).toBe(1);
 expect(Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_record_comment_mentions WHERE comment_id=$1',[first.comment.id])).rows[0].n)).toBe(1);
 await expect(comments().createComment(ctx,record.id,{...input,body:'Different note @Ada Viewer'})).rejects.toMatchObject({code:'operation_mismatch',status:409});
 expect((await comments().listComments(ctx,record.id)).comments).toHaveLength(1);
 const second=await comments().createComment(as(viewer),record.id,{operationId:crypto.randomUUID(),body:'Second note',mentionIds:[]});
 expect((await comments().listComments(ctx,record.id)).comments.map(comment=>comment.id)).toEqual([first.comment.id,second.comment.id]);
});

it('stops at twenty mentions without storing the comment or echoing an id',async()=>{
 const record=await organisation(),secret='secret-mention-target',mentionIds=[secret,...Array.from({length:20},()=>crypto.randomUUID())];
 const denied=await comments().createComment(ctx,record.id,{operationId:crypto.randomUUID(),body:'Too many',mentionIds}).then(()=>{throw new Error('expected mention limit');},(error:unknown)=>error);
 expect(denied).toMatchObject({code:'mention_limit',status:422});
 expect(JSON.stringify(denied)).not.toContain(secret);
 expect(await commentCount(record.id)).toBe(0);
 await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,viewer.id]);
 await expect(comments().listComments(as(viewer),record.id)).rejects.toMatchObject({status:404});
});
