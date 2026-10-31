import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import {acceptedComment,bodyIncludesMention,type RecordComment} from './record-comments-contract';
import {SharedRecordRepository,type RecordContext,type Stored} from './shared-records';
import {recordHash} from './shared-record-types';

const mentionLimit=20,pageLimit=100;
const uuid=z.string().uuid();
const create=z.object({operationId:uuid,body:z.string().max(10000),mentionIds:z.array(z.string().min(1).max(200)).max(50)}).strict();
export type CreateRecordCommentInput=z.infer<typeof create>;
const invalid=()=>new DocumentError('Review the comment and try again.','record_comment_validation',400);
const unavailable=()=>new DocumentError('A mentioned person is unavailable or cannot view this record.','mention_unavailable',422);
const changed=()=>new DocumentError('A mention changed. Select that person again.','mention_changed',422);
const viewSql=(tenant:string,collection:string,record:string)=>`EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=${tenant} AND g.user_id=u.id AND g.collection=${collection} AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=${tenant} AND g.record_id=${record} AND g.user_id=u.id AND 'view'=ANY(g.capabilities))`;
type CommentRow={id:string;author_id:string;author_name:string;body:string;created_at:string};
type MentionRow={comment_id:string;user_id:string;name:string};

/** Comments use the caller's existing record view. They do not grant record, field, or workspace access. */
export class SharedRecordCommentsRepository extends SharedRecordRepository {
 async listComments(ctx:RecordContext,recordId:string){
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   const rows=await tx.query<CommentRow>(`SELECT c.id,c.author_id,u.name AS author_name,c.body,c.created_at FROM hs_data_record_comments c JOIN hs_users u ON u.id=c.author_id WHERE c.tenant_id=$1 AND c.record_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT $3`,[ctx.tenantId,record.id,pageLimit+1]);
   const selected=rows.rows.slice(0,pageLimit);
   const mentions=await this.mentionRows(tx,selected.map(row=>row.id));
   return {comments:selected.reverse().map(row=>this.comment(row,mentions.get(row.id)??[])),truncated:rows.rows.length>pageLimit};
  });
 }
 async mentionPeople(ctx:RecordContext,recordId:string,query:string){
  const q=query.trim();
  if([...q].length>80)throw invalid();
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   if([...q].length<2)return {people:[] as {id:string;name:string}[]};
   const pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
   const rows=await tx.query<{id:string;name:string}>(`SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$1 AND m.active=true WHERE u.name ILIKE $2 ESCAPE '\\' AND position('@' in u.name)=0 AND position(chr(10) in u.name)=0 AND position(chr(13) in u.name)=0 AND btrim(u.name)=u.name AND char_length(u.name)>0 AND (${viewSql('$3','$4','$5')}) ORDER BY u.name,u.id LIMIT $6`,[ctx.workspaceId,pattern,ctx.tenantId,record.collection,record.id,mentionLimit]);
   const needle=q.toLocaleLowerCase();
   return {people:rows.rows.filter(person=>person.name.toLocaleLowerCase().includes(needle)&&bodyIncludesMention(`@${person.name}`,person.name)).slice(0,mentionLimit)};
  });
 }
 async createComment(ctx:RecordContext,recordId:string,input:CreateRecordCommentInput){
  const parsed=create.safeParse(input);
  if(!parsed.success)throw invalid();
  const body=parsed.data.body,mentionIds=[...new Set(parsed.data.mentionIds)].sort(),requestHash=recordHash({kind:'record-comment',recordId,body,mentionIds});
  return this.transaction(ctx,async tx=>{
   const record=await this.raw(tx,ctx,recordId,'view');
   const prior=await tx.query<{request_hash:string;record_id:string;comment_id:string}>('SELECT request_hash,record_id,comment_id FROM hs_data_record_comment_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,parsed.data.operationId]);
   if(prior.rows[0]){
    if(prior.rows[0].request_hash!==requestHash||prior.rows[0].record_id!==record.id)throw new DocumentError('Operation identity was reused with changed fields.','operation_mismatch',409);
    return {comment:await this.saved(tx,ctx,prior.rows[0].comment_id,record.id),replayed:true};
   }
   if(!body.trim()||body.includes('\0')||[...body].length>10000)throw new DocumentError('Write a nonblank comment of up to 10,000 characters.','invalid_comment',422);
   if(mentionIds.length>mentionLimit)throw new DocumentError('Mention at most 20 people.','mention_limit',422);
   const mentions=await this.resolve(tx,ctx,record,body,mentionIds);
   const id=randomUUID();
   await tx.query('INSERT INTO hs_data_record_comments(id,tenant_id,record_id,author_id,body) VALUES($1,$2,$3,$4,$5)',[id,ctx.tenantId,record.id,ctx.actor.id,body]);
   for(const mention of mentions)await tx.query('INSERT INTO hs_data_record_comment_mentions(comment_id,user_id) VALUES($1,$2)',[id,mention.id]);
   await tx.query('INSERT INTO hs_data_record_comment_operations(tenant_id,actor_id,operation_id,request_hash,record_id,comment_id) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,parsed.data.operationId,requestHash,record.id,id]);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.comment',JSON.stringify({tenantId:ctx.tenantId,recordId:record.id,commentId:id}),parsed.data.operationId]);
   return {comment:await this.saved(tx,ctx,id,record.id),replayed:false};
  });
 }
 private async resolve(tx:Sql,ctx:RecordContext,record:Stored,body:string,mentionIds:string[]){
  const mentions:{id:string;name:string}[]=[];
  for(const userId of mentionIds){
   const rows=await tx.query<{name:string}>(`SELECT u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active=true WHERE u.id=$1 AND (${viewSql('$3','$4','$5')})`,[userId,ctx.workspaceId,ctx.tenantId,record.collection,record.id]);
   const name=rows.rows[0]?.name;
   if(!name||!bodyIncludesMention(`@${name}`,name))throw unavailable();
   if(!bodyIncludesMention(body,name))throw changed();
   mentions.push({id:userId,name});
  }
  return mentions;
 }
 private async mentionRows(tx:Sql,commentIds:string[]){
  const found=new Map<string,RecordComment['mentions']>();
  if(!commentIds.length)return found;
  const rows=await tx.query<MentionRow>('SELECT m.comment_id,m.user_id,u.name FROM hs_data_record_comment_mentions m JOIN hs_users u ON u.id=m.user_id WHERE m.comment_id=ANY($1::uuid[]) ORDER BY u.name,m.user_id',[commentIds]);
  for(const row of rows.rows){
   const list=found.get(row.comment_id)??[];
   list.push({id:row.user_id,name:row.name});
   found.set(row.comment_id,list);
  }
  return found;
 }
 private async saved(tx:Sql,ctx:RecordContext,commentId:string,recordId:string){
  const rows=await tx.query<CommentRow>('SELECT c.id,c.author_id,u.name AS author_name,c.body,c.created_at FROM hs_data_record_comments c JOIN hs_users u ON u.id=c.author_id WHERE c.tenant_id=$1 AND c.record_id=$2 AND c.id=$3',[ctx.tenantId,recordId,commentId]);
  const row=rows.rows[0];
  if(!row)throw new DocumentError('Record is restricted or unavailable.','record_not_found',404);
  const comment=this.comment(row,(await this.mentionRows(tx,[row.id])).get(row.id)??[]);
  if(!acceptedComment(comment))throw new DocumentError('Record is restricted or unavailable.','record_not_found',404);
  return comment;
 }
 private comment(row:CommentRow,mentions:RecordComment['mentions']):RecordComment{
  return {id:row.id,authorId:row.author_id,authorName:row.author_name,body:row.body,createdAt:new Date(row.created_at).toISOString(),mentions};
 }
}
