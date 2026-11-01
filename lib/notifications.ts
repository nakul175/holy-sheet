import { randomUUID } from 'node:crypto';
import type { Repository } from './repository';
import type { Actor } from './auth';
import { DocumentError } from './document';
import type {Anchor} from './comment-anchors';
import {threadVisible} from './discussion-visibility';

/** Durable event delivery is separate from the saved comment transaction. No schedule is installed. */
export async function drainNotifications(r:Repository){
  return r.db.transaction(async tx=>{
    const events=await tx.query<{id:string;page_id:string;thread_id:string;comment_id:string;actor_id:string;recipients:string[]}>("SELECT * FROM hs_notification_events WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED");
    for(const event of events.rows){
      for(const recipient of new Set(event.recipients)){
        if(recipient===event.actor_id)continue;
        try{await r.access(tx,event.page_id,{id:recipient},false,true);}catch(e){if(e instanceof DocumentError&&e.status===404)continue;throw e;}
        await tx.query('INSERT INTO hs_notifications(id,event_id,recipient_id,page_id,thread_id,comment_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id,recipient_id) DO NOTHING',[randomUUID(),event.id,recipient,event.page_id,event.thread_id,event.comment_id]);
      }
      await tx.query('UPDATE hs_notification_events SET delivered_at=clock_timestamp() WHERE id=$1',[event.id]);
    }
    return events.rows.length;
  });
}
export async function inbox(r:Repository,actor:Actor){
  try{await drainNotifications(r);}catch{ /* Saved events remain pending for a later request. */ }
  const result=await r.db.query<{id:string;page_id:string;thread_id:string;comment_id:string;created_at:string;read_at:string|null;body:string|null;author_name:string;anchors:Anchor[];publication_anchors:Anchor[]|null;anchor_publication_id:string|null}>(`SELECT n.*,t.anchors,b.anchors AS publication_anchors,b.publication_id AS anchor_publication_id,CASE WHEN c.deleted_at IS NULL THEN c.body ELSE NULL END AS body,u.name AS author_name FROM hs_notifications n JOIN hs_comments c ON c.id=n.comment_id JOIN hs_threads t ON t.id=n.thread_id LEFT JOIN hs_document_workflows w ON w.page_id=n.page_id LEFT JOIN hs_publication_thread_anchors b ON b.thread_id=t.id AND b.publication_id=w.publication_id JOIN hs_users u ON u.id=c.author_id WHERE n.recipient_id=$1 ORDER BY n.created_at DESC,n.id`,[actor.id]);
  const notifications:{id:string;pageId:string;pageTitle:string;threadId:string;commentId:string;body:string|null;authorName:string;createdAt:string;readAt:string|null;kind?:string}[]=[];
  for(const n of result.rows){
    try{const page=await r.get(n.page_id,actor);if(!threadVisible(page,n))continue;notifications.push({id:n.id,pageId:n.page_id,pageTitle:page.title,threadId:n.thread_id,commentId:n.comment_id,body:n.body,authorName:n.author_name,createdAt:new Date(n.created_at).toISOString(),readAt:n.read_at?new Date(n.read_at).toISOString():null});}
    catch(e){if(!(e instanceof DocumentError&&e.status===404))throw e;}
  }
  const ack=await r.db.query<{id:string;page_id:string;kind:string;summary:string|null;created_at:string;read_at:string|null}>("SELECT id,page_id,kind,summary,created_at,read_at FROM hs_notifications WHERE recipient_id=$1 AND kind<>'discussion' ORDER BY created_at DESC,id",[actor.id]);
  for(const n of ack.rows){
    let pageTitle='Page is restricted or unavailable',body:string|null=null;
    try{const page=await r.get(n.page_id,actor);pageTitle=page.title;body=n.summary;}
    catch(e){if(!(e instanceof DocumentError&&e.status===404))throw e;}
    notifications.push({id:n.id,pageId:n.page_id,pageTitle,threadId:'',commentId:'',body,authorName:'Holy Sheet',createdAt:new Date(n.created_at).toISOString(),readAt:n.read_at?new Date(n.read_at).toISOString():null,kind:n.kind});
  }
  notifications.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  return {notifications};
}
export async function readNotification(r:Repository,actor:Actor,id:string){
  const kind=await r.db.query<{kind:string|null;page_id:string}>('SELECT kind,page_id FROM hs_notifications WHERE id=$1 AND recipient_id=$2',[id,actor.id]);
  if(!kind.rows.length)throw new DocumentError('Notification unavailable','not_found',404);
  if(kind.rows[0].kind&&kind.rows[0].kind!=='discussion'){
    try{await r.get(kind.rows[0].page_id,actor);}catch(e){if(e instanceof DocumentError&&e.status===404)throw new DocumentError('Notification unavailable','not_found',404);throw e;}
    await r.db.query('UPDATE hs_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND recipient_id=$2',[id,actor.id]);
    return {id,read:true,pageId:kind.rows[0].page_id};
  }
  const n=await r.db.query<{page_id:string;anchors:Anchor[];publication_anchors:Anchor[]|null;anchor_publication_id:string|null}>('SELECT n.page_id,t.anchors,b.anchors AS publication_anchors,b.publication_id AS anchor_publication_id FROM hs_notifications n JOIN hs_threads t ON t.id=n.thread_id LEFT JOIN hs_document_workflows w ON w.page_id=n.page_id LEFT JOIN hs_publication_thread_anchors b ON b.thread_id=t.id AND b.publication_id=w.publication_id WHERE n.id=$1 AND n.recipient_id=$2',[id,actor.id]);
  if(!n.rows.length)throw new DocumentError('Notification unavailable','not_found',404);
  const page=await r.get(n.rows[0].page_id,actor);if(!threadVisible(page,n.rows[0]))throw new DocumentError('Notification unavailable','not_found',404);
  await r.db.query('UPDATE hs_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1 AND recipient_id=$2',[id,actor.id]);return {id,read:true};
}
