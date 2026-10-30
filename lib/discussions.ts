import { createHash,randomUUID } from 'node:crypto';
import type { Actor } from './auth';
import type { Sql } from './database';
import type { Repository } from './repository';
import { canComment,canEdit } from './types';
import { DocumentError,stableStringify,validateDocument,type RichNode } from './document';
import { createAnchors,mapAnchors,type Anchor } from './comment-anchors';
import { drainNotifications } from './notifications';
import type { DiscussionChange,ThreadView,CommentView } from './discussion-types';
import {threadVisible,visibleThreadAnchors,viewedPublicationId,bindThreadPublicationAnchors,type ThreadAnchorView} from './discussion-visibility';

type Thread=ThreadAnchorView&{id:string;page_id:string;creator_id:string;status:'open'|'resolved';version:number;anchors:Anchor[];created_at:string};
type Comment={id:string;thread_id:string;author_id:string;body:string;version:number;deleted_at:string|null;moderated:boolean};
type Result={threadId:string;commentId?:string;eventId?:string;unchanged?:boolean};
const unavailable=()=>new DocumentError('Discussion is restricted or unavailable','not_found',404);
function validateBody(body:string){if(!body.trim()||body.includes('\0')||[...body].length>10000)throw new DocumentError('Write a nonblank comment of up to 10,000 characters','invalid_comment',422);}

export async function discussions(r:Repository,actor:Actor,pageId:string,tx:Sql=r.db){
  const page=await r.access(tx,pageId,actor);
  const visiblePage=await r.get(pageId,actor,tx);
  const threads=await tx.query<Thread>('SELECT t.*,b.anchors AS publication_anchors,b.publication_id AS anchor_publication_id FROM hs_threads t LEFT JOIN hs_publication_thread_anchors b ON b.thread_id=t.id AND b.publication_id=$2 WHERE t.page_id=$1 ORDER BY t.created_at,t.id',[pageId,viewedPublicationId(visiblePage)??null]);
  const comments=await tx.query<{id:string;thread_id:string;author_id:string;author_name:string;body:string|null;version:number;created_at:string;edited_at:string|null;deleted_at:string|null;moderated:boolean;is_root:boolean;restorable:boolean}>(`SELECT c.id,c.thread_id,c.author_id,u.name AS author_name,CASE WHEN c.deleted_at IS NULL THEN c.body ELSE NULL END AS body,c.version,c.created_at,c.edited_at,c.deleted_at,c.moderated,c.is_root,c.deleted_at>clock_timestamp()-interval '30 days' AS restorable FROM hs_comments c JOIN hs_threads t ON t.id=c.thread_id JOIN hs_users u ON u.id=c.author_id WHERE t.page_id=$1 ORDER BY c.created_at,c.id`,[pageId]);
  const result:ThreadView[]=threads.rows.filter(t=>threadVisible(visiblePage,t)).map(t=>{
    const rows=comments.rows.filter(c=>c.thread_id===t.id),rootDeleted=rows.some(c=>c.is_root&&c.deleted_at!==null);
    return {id:t.id,creatorId:t.creator_id,status:t.status,version:t.version,createdAt:new Date(t.created_at).toISOString(),anchors:rootDeleted?[]:visibleThreadAnchors(visiblePage,t)??[],anchorUnavailable:rootDeleted&&t.anchors.length>0,canResolve:canComment(page.role)&&(t.creator_id===actor.id||canEdit(page.role)),comments:rows.map((c):CommentView=>({id:c.id,authorId:c.author_id,authorName:c.author_name,body:c.body,version:c.version,createdAt:new Date(c.created_at).toISOString(),editedAt:c.edited_at?new Date(c.edited_at).toISOString():null,deletedAt:c.deleted_at?new Date(c.deleted_at).toISOString():null,canEdit:canComment(page.role)&&c.author_id===actor.id&&c.deleted_at===null,canDelete:canComment(page.role)&&(c.author_id===actor.id||page.role==='owner')&&c.deleted_at===null,canRestore:canComment(page.role)&&c.deleted_at!==null&&c.restorable&&(c.moderated?page.role==='owner':c.author_id===actor.id)}))};
  });
  return {threads:result,role:page.role};
}
async function thread(tx:Sql,pageId:string,id:string,publicationId?:string){const result=await tx.query<Thread>('SELECT t.*,b.anchors AS publication_anchors,b.publication_id AS anchor_publication_id FROM hs_threads t LEFT JOIN hs_publication_thread_anchors b ON b.thread_id=t.id AND b.publication_id=$3 WHERE t.id=$1 AND t.page_id=$2 FOR UPDATE OF t',[id,pageId,publicationId??null]);if(!result.rows.length)throw unavailable();return result.rows[0];}
async function comment(tx:Sql,pageId:string,id:string){const result=await tx.query<Comment>('SELECT c.* FROM hs_comments c JOIN hs_threads t ON t.id=c.thread_id WHERE c.id=$1 AND t.page_id=$2 FOR UPDATE OF c',[id,pageId]);if(!result.rows.length)throw unavailable();return result.rows[0];}
async function audit(tx:Sql,actor:Actor,pageId:string,input:DiscussionChange,result:Result){await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,before_value,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),actor.id,`discussion.${input.kind}`,pageId,null,JSON.stringify({threadId:result.threadId,commentId:result.commentId??null}),input.operationId]);}

async function mentions(r:Repository,tx:Sql,actor:Actor,pageId:string,commentId:string,body:string,ids:string[]){
  const distinct=[...new Set(ids)];if(distinct.length>50)throw new DocumentError('Mention at most 50 people per comment');
  const existing=await tx.query<{user_id:string}>('SELECT user_id FROM hs_comment_mentions WHERE comment_id=$1',[commentId]),seen=new Set(existing.rows.map(x=>x.user_id)),fresh:string[]=[];
  for(const id of distinct){
    const person=await tx.query<{name:string}>('SELECT name FROM hs_users WHERE id=$1',[id]);
    if(!person.rows.length)throw new DocumentError('A mentioned person is unavailable or lacks page access','mention_unavailable',422);
    try{await r.access(tx,pageId,{id});}catch(e){if(e instanceof DocumentError&&e.status===404)throw new DocumentError('A mentioned person is unavailable or lacks page access','mention_unavailable',422);throw e;}
    if(!body.includes(`@${person.rows[0].name}`))throw new DocumentError('A mention changed. Select that person again.','mention_changed',422);
    if(!seen.has(id)&&id!==actor.id)fresh.push(id);
  }
  await tx.query('UPDATE hs_comment_mentions SET current=false WHERE comment_id=$1',[commentId]);
  for(const id of distinct)await tx.query('INSERT INTO hs_comment_mentions(comment_id,user_id,current) VALUES($1,$2,true) ON CONFLICT(comment_id,user_id) DO UPDATE SET current=true',[commentId,id]);
  return fresh;
}

export async function changeDiscussion(r:Repository,actor:Actor,pageId:string,input:DiscussionChange){
  const hash=createHash('sha256').update(stableStringify(input)).digest('hex');
  const saved=await r.db.transaction(async tx=>{
    const page=await r.access(tx,pageId,actor,false,true);
    const visiblePage=await r.get(pageId,actor,tx);
    const permittedThread=async(id:string)=>{const t=await thread(tx,pageId,id,viewedPublicationId(visiblePage));if(!threadVisible(visiblePage,t))throw unavailable();return t;};
    const old=await tx.query<{actor_id:string;request_hash:string;result:Result}>('SELECT * FROM hs_discussion_operations WHERE page_id=$1 AND operation_id=$2',[pageId,input.operationId]);
    if(old.rows.length){if(old.rows[0].actor_id!==actor.id||old.rows[0].request_hash!==hash)throw new DocumentError('Operation ID reused for different discussion content','operation_mismatch',409);await permittedThread(old.rows[0].result.threadId);return {...old.rows[0].result,replayed:true};}
    if(!canComment(page.role))throw new DocumentError('Commenter access is required to participate','commenter_required',403);
    let result:Result;
    if(input.kind==='create'||input.kind==='reply'){
      validateBody(input.body);let t:Thread;
      if(input.kind==='create'){
        if(input.anchors.length&&input.baseVersion!==visiblePage.version)throw new DocumentError('The page changed. Review and select the passage again.','anchor_changed',409);
        const anchors=createAnchors(visiblePage.document,input.anchors),id=randomUUID(),publicationId=viewedPublicationId(visiblePage);let draftAnchors=anchors;
        if(publicationId&&anchors.length){const raw=(await tx.query<{document:RichNode}>('SELECT document FROM hs_revisions WHERE page_id=$1 AND version=$2',[pageId,page.version])).rows[0];if(!raw)throw new DocumentError('Current draft is unavailable','anchor_changed',409);draftAnchors=mapAnchors(anchors,visiblePage.document,validateDocument(raw.document));}
        await tx.query('INSERT INTO hs_threads(id,page_id,creator_id,anchors) VALUES($1,$2,$3,$4)',[id,pageId,actor.id,JSON.stringify(draftAnchors)]);
        if(publicationId)await bindThreadPublicationAnchors(tx,pageId,publicationId,id,visiblePage.document,anchors);
        else if(anchors.length){const active=(await tx.query<{id:string;document:RichNode}>('SELECT p.id,p.document FROM hs_document_workflows w JOIN hs_document_publications p ON p.id=w.publication_id AND p.page_id=w.page_id WHERE w.page_id=$1 AND p.source_version=$2',[pageId,page.version])).rows[0];if(active)await bindThreadPublicationAnchors(tx,pageId,active.id,id,active.document,anchors);}
        t=await thread(tx,pageId,id);
      }else{t=await permittedThread(input.threadId);if(t.status!=='open')throw new DocumentError('Reopen this discussion before replying','thread_resolved',409);}
      const id=randomUUID();await tx.query('INSERT INTO hs_comments(id,thread_id,author_id,body,is_root) VALUES($1,$2,$3,$4,$5)',[id,t.id,actor.id,input.body,input.kind==='create']);
      const targets=new Set(await mentions(r,tx,actor,pageId,id,input.body,input.mentionIds));
      if(input.kind==='reply'){const prior=await tx.query<{author_id:string}>('SELECT DISTINCT author_id FROM hs_comments WHERE thread_id=$1 AND author_id!=$2',[t.id,actor.id]);prior.rows.forEach(p=>targets.add(p.author_id));targets.add(t.creator_id);}
      targets.delete(actor.id);const eventId=randomUUID();await tx.query('INSERT INTO hs_notification_events(id,page_id,thread_id,comment_id,actor_id,recipients) VALUES($1,$2,$3,$4,$5,$6)',[eventId,pageId,t.id,id,actor.id,JSON.stringify([...targets])]);result={threadId:t.id,commentId:id,eventId};
      await tx.query('UPDATE hs_threads SET updated_at=clock_timestamp() WHERE id=$1',[t.id]);
    }else if(input.kind==='resolve'||input.kind==='reopen'){
      const t=await permittedThread(input.threadId);if(t.creator_id!==actor.id&&!canEdit(page.role))throw new DocumentError('Only the starter, an Editor or the Owner can resolve discussions','resolve_denied',403);
      if(t.version!==input.expectedVersion)throw new DocumentError('Discussion state changed. Refresh before applying.','discussion_conflict',409);
      const status=input.kind==='resolve'?'resolved':'open';if(t.status!==status)await tx.query('UPDATE hs_threads SET status=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[t.id,status]);result={threadId:t.id,...(t.status===status?{unchanged:true}:{})};
    }else{
      const c=await comment(tx,pageId,input.commentId);await permittedThread(c.thread_id);if(c.version!==input.expectedVersion)throw new DocumentError('This comment changed. Review the latest version.','discussion_conflict',409);
      if(input.kind==='edit'){
        if(c.author_id!==actor.id)throw new DocumentError('Only the author can edit this comment','author_required',403);
        if(c.deleted_at)throw new DocumentError('Restore the comment before editing','comment_deleted',409);validateBody(input.body);
        const prior=await tx.query<{user_id:string}>('SELECT user_id FROM hs_comment_mentions WHERE comment_id=$1 AND current=true ORDER BY user_id',[c.id]);
        if(c.body===input.body&&JSON.stringify(prior.rows.map(p=>p.user_id))===JSON.stringify([...new Set(input.mentionIds)].sort()))result={threadId:c.thread_id,commentId:c.id,unchanged:true};
        else{const targets=await mentions(r,tx,actor,pageId,c.id,input.body,input.mentionIds),eventId=randomUUID();
          await tx.query('UPDATE hs_comments SET body=$2,version=version+1,edited_at=clock_timestamp() WHERE id=$1',[c.id,input.body]);
          await tx.query('INSERT INTO hs_notification_events(id,page_id,thread_id,comment_id,actor_id,recipients) VALUES($1,$2,$3,$4,$5,$6)',[eventId,pageId,c.thread_id,c.id,actor.id,JSON.stringify(targets)]);result={threadId:c.thread_id,commentId:c.id,eventId};}
      }else if(input.kind==='delete'){
        if(c.author_id!==actor.id&&page.role!=='owner')throw new DocumentError('Only the author or Owner can delete comments','delete_denied',403);
        if(c.deleted_at)throw new DocumentError('Comment already deleted. Refresh to continue.','discussion_conflict',409);
        await tx.query('UPDATE hs_comments SET deleted_at=clock_timestamp(),deleted_by=$2,moderated=$3,version=version+1 WHERE id=$1',[c.id,actor.id,c.author_id!==actor.id]);result={threadId:c.thread_id,commentId:c.id};
      }else{
        if(!c.deleted_at||(c.moderated?page.role!=='owner':c.author_id!==actor.id))throw new DocumentError('This comment cannot be restored by this account','restore_denied',403);
        const restored=await tx.query("UPDATE hs_comments SET deleted_at=NULL,deleted_by=NULL,moderated=false,version=version+1 WHERE id=$1 AND deleted_at>clock_timestamp()-interval '30 days' RETURNING id",[c.id]);
        if(!restored.rows.length)throw new DocumentError('The 30-day restoration window has expired','restore_expired',409);result={threadId:c.thread_id,commentId:c.id};
      }
    }
    if(!result.unchanged)await audit(tx,actor,pageId,input,result);
    await tx.query('INSERT INTO hs_discussion_operations(page_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',[pageId,input.operationId,actor.id,hash,JSON.stringify(result)]);
    return {...result,replayed:false};
  });
  let notificationPending=!!saved.eventId;try{await drainNotifications(r);if(saved.eventId){const event=await r.db.query<{delivered_at:string|null}>('SELECT delivered_at FROM hs_notification_events WHERE id=$1',[saved.eventId]);notificationPending=!event.rows[0]?.delivered_at;}}catch{ /* The comment is committed; retain pending delivery for retry. */ }
  return {...saved,...await discussions(r,actor,pageId),notificationPending};
}

export async function mentionPeople(r:Repository,actor:Actor,pageId:string,query:string){
  const page=await r.access(r.db,pageId,actor);if(!canComment(page.role))throw new DocumentError('Commenter access required','commenter_required',403);
  if([...query.trim()].length<2)return {people:[]};
  const candidates=await r.db.query<{id:string;name:string}>('SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active=true ORDER BY u.name,u.id',[page.workspace_id]);
  const people=[];for(const person of candidates.rows){if(!person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))continue;try{await r.access(r.db,pageId,{id:person.id});people.push(person);if(people.length===20)break;}catch(e){if(!(e instanceof DocumentError&&e.status===404))throw e;}}
  return {people};
}
