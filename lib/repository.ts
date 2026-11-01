import { createHash } from "node:crypto";
import { database, type Database, type Sql } from "./database";
import type { Actor } from "./auth";
import { localActor } from "./auth";
import { DocumentError, documentBlocks, fromLegacy, mergeDocuments, plainText, schemaVersion, stableStringify, validateDocument, type RichNode } from "./document";
import { listDemoPages } from "./demo-store";
import { updateCommentAnchors } from './comment-anchors';
import { revisionDigest } from './revision';
import { usableMedia } from './media-authorization';
import { canEdit,type Page,type PageRole } from './types';
import { validateNewPageReferences } from './page-references';
import { validateRecordPageReferences } from './record-page-ref-store';
import { publishedDocument } from './document-publishing';
import {governedAuthoringAllowed,projectionSql,type ProjectionBudget} from './publication-projection';
import {commitSyncedPlacements,overlaySyncedContent,prelockSyncedPages,presentSyncedDocument,stripSyncedContent} from './synced-blocks';
import {commitSnippetPlacements,presentSnippetDocument} from './snippets';
import { provisionSpaceHome } from './space-home';
import { spaceHomeMemberRead } from './space-home-shared';
import { syncRecordReferenceLinks } from './search-jump';

type StoredPage = {id:string;workspace_id:string;space_id:string;parent_id:string|null;owner_id:string;title:string;visibility:"private"|"space";version:number;acl_version:number;schema_version:number;position:number;updated_at:string;workspace_name:string;space_name:string;parent_title:string|null;role:PageRole};
export type DocumentPage = Page & {document:RichNode;schemaVersion:number;role:PageRole;publicationFingerprint?:string};
export class Repository {
  constructor(public db:Database) {}
  async seedLocal() {
    await this.db.transaction(async tx=>{
      await tx.query("INSERT INTO hs_users(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",[localActor.id,localActor.name]);
      await tx.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-aplyd','Aplyd') ON CONFLICT DO NOTHING");
      await tx.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1) ON CONFLICT DO NOTHING",[localActor.id]);
      await tx.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-private','ws-aplyd','My pages'),('space-product','ws-aplyd','Product') ON CONFLICT DO NOTHING");
      const {rows}=await tx.query("SELECT id FROM hs_pages WHERE id='welcome'");
      if(!rows.length){const p=listDemoPages().find(p=>p.id==="welcome")!;await tx.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title) VALUES($1,$2,$3,$4,$5)",[p.id,p.workspaceId,p.spaceId,localActor.id,p.title]);await this.writeDocument(tx,p.id,fromLegacy(p.blocks),1,p.title,localActor.id,'local-preview');}
    });
  }
  async access(tx:Sql, id:string, actor:Actor, edit=false, lock=false):Promise<StoredPage> {
    // Serialize permission changes and document mutations within the workspace. A source grant
    // cannot be revoked between an inherited-access check and the document commit.
    if(lock)await tx.query(`SELECT w.id FROM hs_workspaces w JOIN hs_pages p ON p.workspace_id=w.id
      JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE p.id=$1 FOR UPDATE OF w`,[id,actor.id]);
    const {rows}=await tx.query<StoredPage>(`WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,workspace_id,visibility,owner_id,ARRAY[id] AS path FROM hs_pages WHERE id=$1 AND deleted_at IS NULL
      UNION ALL SELECT p.id,p.parent_id,p.workspace_id,p.visibility,p.owner_id,a.path||p.id FROM hs_pages p JOIN ancestors a ON p.id=a.parent_id AND p.workspace_id=a.workspace_id
      WHERE p.deleted_at IS NULL AND NOT p.id=ANY(a.path)
    ) SELECT p.*,w.name AS workspace_name,s.name AS space_name,parent.title AS parent_title,
      CASE WHEN m.role='observer' THEN 'viewer' WHEN p.owner_id=$2 THEN 'owner' WHEN m.role IN ('owner','admin') THEN 'editor' WHEN m.role<>'observer' AND EXISTS(SELECT 1 FROM ancestors a LEFT JOIN hs_grants g ON g.page_id=a.id AND (g.subject=$2 OR (a.visibility='space' AND g.subject='space')) WHERE a.owner_id=$2 OR g.role='editor') THEN 'editor'
      WHEN EXISTS(SELECT 1 FROM ancestors a JOIN hs_grants g ON g.page_id=a.id AND (g.subject=$2 OR (a.visibility='space' AND g.subject='space')) WHERE g.role='commenter') THEN 'commenter' ELSE 'viewer' END AS role
      FROM hs_pages p JOIN hs_workspaces w ON w.id=p.workspace_id JOIN hs_spaces s ON s.id=p.space_id
      JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
      LEFT JOIN hs_pages parent ON parent.id=p.parent_id AND parent.deleted_at IS NULL AND parent.workspace_id=p.workspace_id AND (parent.owner_id=$2 OR m.role IN ('owner','admin'))
      WHERE p.id=$1 AND p.deleted_at IS NULL AND (m.role IN ('owner','admin') OR EXISTS(SELECT 1 FROM ancestors a LEFT JOIN hs_grants g ON g.page_id=a.id AND (g.subject=$2 OR (a.visibility='space' AND g.subject='space')) WHERE a.owner_id=$2 OR g.subject IS NOT NULL) OR ${spaceHomeMemberRead("$2")}) ${lock ? "FOR UPDATE OF p,m" : ""}`,[id,actor.id]);
    if(!rows.length) throw new DocumentError("Page is restricted or unavailable","not_found",404);
    if(edit && !canEdit(rows[0].role)) throw new DocumentError("This page is read only","read_only",403);
    return rows[0];
  }
  async get(id:string,actor:Actor,tx:Sql=this.db,work?:ProjectionBudget,present=true):Promise<DocumentPage> {
    tx=projectionSql(tx,work);work?.check();
    const p=await this.access(tx,id,actor);
    const mayAuthor=await governedAuthoringAllowed(tx,actor,p);
    const published=mayAuthor?null:await publishedDocument(this,tx,actor,id,work);
    let document:RichNode,publicationFingerprint:string|undefined;
    if(published){document=published.document;p.title=published.title;p.version=published.version;p.updated_at=published.publishedAt;publicationFingerprint=published.publicationId+':'+revisionDigest(published.title,published.document);work?.check();}
    else{
      const {rows}=await tx.query<{node:RichNode}>("SELECT node FROM hs_blocks WHERE page_id=$1 AND parent_id IS NULL ORDER BY position",[id]);
      document={type:"doc",content:rows.map(r=>r.node)};
    }
    if(present){document=await presentSyncedDocument(this,tx,actor,id,document);document=await presentSnippetDocument(this,tx,actor,id,document);}
    const blocks:Page['blocks']=(document.content ?? []).map((n,i)=>{work?.check();const block={id:String(n.attrs?.id),pageId:id,parentBlockId:null,type:n.type==="heading"?"heading" as const:"paragraph" as const,text:plainText(n),position:i};work?.check();return block;});
    work?.check();
    return {id:p.id,workspaceId:p.workspace_id,workspaceName:p.workspace_name,spaceId:p.space_id,spaceName:p.space_name,parentPageId:p.parent_id,parentTitle:p.parent_title,title:p.title,visibility:p.visibility,position:p.position,version:p.version,updatedAt:new Date(p.updated_at).toISOString(),schemaVersion:p.schema_version,role:p.role,publicationFingerprint,document,blocks};
  }
  async list(actor:Actor) {
    const {rows}=await this.db.query<{id:string}>(`WITH RECURSIVE permitted AS (
      SELECT p.id,p.workspace_id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$1 AND m.active=true
      WHERE p.deleted_at IS NULL AND (m.role IN ('owner','admin') OR p.owner_id=$1 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$1 OR (p.visibility='space' AND g.subject='space'))) OR ${spaceHomeMemberRead("$1")})
      UNION SELECT c.id,c.workspace_id FROM hs_pages c JOIN permitted p ON c.parent_id=p.id AND c.workspace_id=p.workspace_id WHERE c.deleted_at IS NULL
    ) SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.id ORDER BY p.position,p.updated_at DESC,p.id`,[actor.id]);
    const pages=await Promise.all(rows.map(async row=>{try{return await this.get(row.id,actor);}catch(e){if(e instanceof DocumentError&&e.status===404)return null;throw e;}}));return pages.filter((p):p is DocumentPage=>p!==null);
  }
  async spaces(actor:Actor) {
    const {rows}=await this.db.query<{id:string;workspaceId:string;name:string}>(`SELECT s.id,s.workspace_id AS "workspaceId",s.name FROM hs_spaces s JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$1 AND m.active=true ORDER BY s.name`,[actor.id]);return rows;
  }
  async createSpace(actor:Actor,name:string,workspaceId:string) {
    if(!name.trim() || name.length>80)throw new DocumentError("Space name must be between 1 and 80 characters");
    const id=crypto.randomUUID();
    return this.db.transaction(async tx=>{await tx.query('SELECT w.id FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1 FOR UPDATE OF w',[workspaceId,actor.id]);const m=await tx.query<{user_id:string;role:string}>("SELECT user_id,role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true FOR UPDATE",[workspaceId,actor.id]);if(!m.rows.length)throw new DocumentError("Workspace unavailable","not_found",404);if(m.rows[0].role==='observer')throw new DocumentError("Observers cannot create spaces","read_only",403);await tx.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES($1,$2,$3)",[id,workspaceId,name.trim()]);await provisionSpaceHome(this,tx,actor,id,workspaceId);return {id,workspaceId,name:name.trim()};});
  }
  async create(actor:Actor,title:string,spaceId:string,parentId?:string|null,operationId?:string) {
    return this.db.transaction(async tx=>{
      const requestHash=createHash('sha256').update(stableStringify({title,spaceId,parentId:parentId??null})).digest('hex');
      if(operationId){
        // Serialize this actor's create intents across locations and concurrent retries.
        await tx.query('SELECT id FROM hs_users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
        const prior=await tx.query<{page_id:string|null;request_hash:string}>('SELECT page_id,request_hash FROM hs_page_creations WHERE actor_id=$1 AND operation_id=$2',[actor.id,operationId]);
        if(prior.rows.length){
          if(prior.rows[0].request_hash!==requestHash)throw new DocumentError('Creation attempt was reused with different fields','operation_mismatch',409);
          if(!prior.rows[0].page_id)throw new DocumentError('Page is restricted or unavailable','not_found',404);
          return this.get(prior.rows[0].page_id,actor,tx);
        }
      }
      await tx.query('SELECT w.id FROM hs_workspaces w JOIN hs_spaces s ON s.workspace_id=w.id JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE s.id=$1 FOR UPDATE OF w',[spaceId,actor.id]);
      const {rows}=await tx.query<{workspace_id:string;role:string}>("SELECT s.workspace_id,m.role FROM hs_spaces s JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$2 AND m.active=true WHERE s.id=$1 FOR UPDATE OF m",[spaceId,actor.id]);
      if(!rows.length)throw new DocumentError("Space unavailable","not_found",404);
      if(rows[0].role==='observer')throw new DocumentError("Observers cannot create pages","read_only",403);
      if(parentId){const parent=await this.access(tx,parentId,actor,true,true);if(parent.space_id!==spaceId)throw new DocumentError("Subpages must use their parent's space");}
      const id=crypto.randomUUID(), actualTitle=title.trim()||"Untitled";
      if(actualTitle.length>240)throw new DocumentError("Title is too long");
      await tx.query("INSERT INTO hs_pages(id,workspace_id,space_id,parent_id,owner_id,title) VALUES($1,$2,$3,$4,$5,$6)",[id,rows[0].workspace_id,spaceId,parentId??null,actor.id,actualTitle]);
      await this.writeDocument(tx,id,fromLegacy([]),1,actualTitle,actor.id,'api');
      if(operationId)await tx.query('INSERT INTO hs_page_creations(actor_id,operation_id,page_id,request_hash) VALUES($1,$2,$3,$4)',[actor.id,operationId,id,requestHash]);
      return this.get(id,actor,tx);
    });
  }
  async writeDocument(tx:Sql,id:string,document:RichNode,version:number,title:string,actorId?:string,surface='api',restoredFrom?:number) {
    document=stripSyncedContent(document);
    const rows=documentBlocks(document);
    const previous=await tx.query<{id:string;version:number;node:RichNode;parent_id:string|null}>("SELECT id,version,node,parent_id FROM hs_blocks WHERE page_id=$1",[id]);
    const byId=new Map(previous.rows.map(b=>[b.id,b]));
    const payload=rows.map(b=>{const old=byId.get(b.id);return {id:b.id,parent_id:b.parentId,position:b.position,type:b.type,node:b.node,version:old?old.version+(stableStringify(old.node)===stableStringify(b.node)?0:1):1};});
    // Retain only current stable IDs for this page. Cross-page ID reuse fails atomically.
    await tx.query("DELETE FROM hs_blocks WHERE page_id=$1",[id]);
    await tx.query("INSERT INTO hs_blocks(id,page_id,parent_id,position,type,node,version) SELECT x.id,$1,x.parent_id,x.position,x.type,x.node,x.version FROM jsonb_to_recordset($2::jsonb) AS x(id text,parent_id text,position integer,type text,node jsonb,version integer)",[id,JSON.stringify(payload)]);
    await updateCommentAnchors(tx,id,{type:'doc',content:previous.rows.filter(b=>b.parent_id===null).map(b=>b.node)},document);
    await tx.query('UPDATE hs_revisions SET superseded_at=clock_timestamp() WHERE page_id=$1 AND version<$2 AND superseded_at IS NULL',[id,version]);
    await tx.query('INSERT INTO hs_revisions(page_id,version,title,document,actor_id,source_surface,schema_version,restored_from,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,version,title,JSON.stringify(document),actorId??null,surface,schemaVersion,restoredFrom??null,revisionDigest(title,document)]);
    const mediaIds=new Set<string>();function media(n:RichNode){if((n.type==='image'||n.type==='file')&&typeof n.attrs?.attachmentId==='string')mediaIds.add(n.attrs.attachmentId);n.content?.forEach(media);}media(document);
    for(const mediaId of mediaIds)await tx.query('INSERT INTO hs_revision_media(page_id,version,media_id) SELECT $1,$2,id FROM hs_media WHERE id=$3 AND page_id=$1 ON CONFLICT DO NOTHING',[id,version,mediaId]);
  }
  async save(id:string,actor:Actor,input:{operationId:string;baseVersion:number;title:string;document:unknown}) {
    const document=validateDocument(input.document), title=input.title.trim()||"Untitled";
    const hash=createHash("sha256").update(stableStringify(input)).digest("hex");
    return this.db.transaction(async tx=>{
      await prelockSyncedPages(tx,document);
      const p=await this.access(tx,id,actor,true,true);
      if(p.schema_version!==schemaVersion)throw new DocumentError("This document requires a newer editor","schema_version",409);
      const existing=await tx.query<{actor_id:string;request_hash:string;version:number}>("SELECT * FROM hs_operations WHERE page_id=$1 AND operation_id=$2",[id,input.operationId]);
      if(existing.rows.length){const op=existing.rows[0];if(op.actor_id!==actor.id||op.request_hash!==hash)throw new DocumentError("Operation ID was reused with different content","operation_mismatch",409);return {page:await this.get(id,actor,tx),acknowledgedOperationId:input.operationId,committedVersion:op.version,replayed:true,merged:false};}
      let next=document, nextTitle=title, merged=false;
      if(p.version!==input.baseVersion){
        const base=await tx.query<{document:RichNode;title:string}>("SELECT document,title FROM hs_revisions WHERE page_id=$1 AND version=$2",[id,input.baseVersion]);
        const latest=await this.get(id,actor,tx,undefined,false);
        if(!base.rows.length)throw new DocumentError("Base revision unavailable; review against the latest saved page","conflict",409);
        const candidate=mergeDocuments(stripSyncedContent(base.rows[0].document),latest.document,stripSyncedContent(document));
        if(!candidate || (title!==base.rows[0].title && latest.title!==base.rows[0].title && title!==latest.title))throw new DocumentError("This page changed elsewhere. Your draft is retained for review.","conflict",409);
        next=overlaySyncedContent(candidate,document); nextTitle=title===base.rows[0].title?latest.title:title;merged=true;
      }
      // A media object cannot be attached by guessing its ID or borrowing another page's object.
      let mediaBytes=0;const mediaIds=new Set<string>(),activeDocument=await this.get(id,actor,tx,undefined,false),activeMedia=new Set(documentBlocks(activeDocument.document).filter(b=>b.type==='image'||b.type==='file').map(b=>String(b.node.attrs?.attachmentId)));
      for(const b of documentBlocks(stripSyncedContent(next)))if(["image","file"].includes(b.type)){
        const media=await tx.query<{id:string;size:string}>("SELECT id,size FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready' FOR UPDATE",[b.node.attrs?.attachmentId,id]);
        if(!media.rows.length||!await usableMedia(tx,id,actor.id,String(b.node.attrs?.attachmentId),activeMedia.has(String(b.node.attrs?.attachmentId))))throw new DocumentError("Attachment is unavailable or still processing");
        if(!mediaIds.has(media.rows[0].id)){mediaIds.add(media.rows[0].id);mediaBytes+=Number(media.rows[0].size);}
      }
      if(mediaIds.size>100||mediaBytes>100_000_000)throw new DocumentError("Active page upload allowance exceeded; your draft is retained","quota_exceeded",422);
      const synced=await commitSyncedPlacements(this,tx,actor,id,next,input.operationId);
      const snippets=await commitSnippetPlacements(this,tx,actor,id,synced.stored,input.operationId);
      next=snippets.stored;
      await validateNewPageReferences(this,tx,actor,p.workspace_id,next,stripSyncedContent(activeDocument.document));
      await validateRecordPageReferences(tx,actor,p.workspace_id,next,stripSyncedContent(activeDocument.document));
      const current=await this.get(id,actor,tx,undefined,false);
      if(stableStringify(next)!==stableStringify(current.document))await syncRecordReferenceLinks(tx,actor,p.workspace_id,id,next,input.operationId);
      if(!synced.contentChanged&&!snippets.changed&&nextTitle===p.title&&stableStringify(next)===stableStringify(current.document)){
        await tx.query('INSERT INTO hs_operations(page_id,operation_id,actor_id,request_hash,version) VALUES($1,$2,$3,$4,$5)',[id,input.operationId,actor.id,hash,p.version]);
        return {page:await this.get(id,actor,tx),acknowledgedOperationId:input.operationId,committedVersion:p.version,replayed:false,merged};
      }
      const version=p.version+1;
      await this.writeDocument(tx,id,next,version,nextTitle,actor.id,synced.surface??'api');
      await tx.query("UPDATE hs_media m SET deleted_at=CASE WHEN EXISTS(SELECT 1 FROM hs_blocks b WHERE b.page_id=$1 AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=m.id::text) THEN NULL ELSE COALESCE(m.deleted_at,now()) END WHERE m.page_id=$1 AND m.state='ready'",[id]);
      await tx.query("UPDATE hs_pages SET title=$2,version=$3,updated_at=clock_timestamp() WHERE id=$1",[id,nextTitle,version]);
      // A title-only revision does not invalidate already-authorized body step sessions.
      // Only advance an exactly matching state; a real snapshot body change still resets
      // the epoch on the next collaboration request, as before.
      if(stableStringify(next)===stableStringify(current.document))await tx.query(
        'UPDATE hs_collaboration_pages SET document_version=$2,updated_at=clock_timestamp() WHERE page_id=$1 AND document_version=$3 AND document=$4::jsonb',
        [id,version,p.version,JSON.stringify(current.document)]);
      await tx.query("INSERT INTO hs_operations(page_id,operation_id,actor_id,request_hash,version) VALUES($1,$2,$3,$4,$5)",[id,input.operationId,actor.id,hash,version]);
      return {page:await this.get(id,actor,tx),acknowledgedOperationId:input.operationId,committedVersion:version,replayed:false,merged};
    });
  }
}
export async function repository(local=false) { const r=new Repository(await database());if(local)await r.seedLocal();return r; }
