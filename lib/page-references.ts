import type { Repository } from './repository';
import type { Sql } from './database';
import type { Actor } from './auth';
import { documentBlocks,DocumentError,type RichNode } from './document';
export function pageReferences(document:RichNode){return new Map(documentBlocks(document).filter(b=>b.type==='pageLink').map(b=>[b.id,String(b.node.attrs?.pageId)]));}
export async function validateNewPageReferences(r:Repository,tx:Sql,actor:Actor,workspaceId:string,next:RichNode,previous:RichNode){const old=pageReferences(previous);for(const [block,target] of pageReferences(next)){if(old.get(block)===target)continue;const p=await r.access(tx,target,actor);if(p.workspace_id!==workspaceId)throw new DocumentError('Choose an accessible page in this workspace.','reference_unavailable',422);}}
export async function referenceLabel(r:Repository,actor:Actor,sourceId:string,targetId:string){const source=await r.access(r.db,sourceId,actor),target=await r.access(r.db,targetId,actor);if(source.workspace_id!==target.workspace_id)throw new DocumentError('Linked page is restricted or unavailable','not_found',404);return {id:target.id,title:target.title};}
export async function backlinks(r:Repository,actor:Actor,targetId:string,after?:string){
 const target=await r.access(r.db,targetId,actor);
 const {rows}=await r.db.query<{id:string;title:string;occurrences:number;spaceName:string}>(`WITH RECURSIVE reachable AS (
  SELECT p.id,p.workspace_id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$1 AND m.active=true
  WHERE p.deleted_at IS NULL AND p.workspace_id=$2 AND (m.role IN ('owner','admin') OR p.owner_id=$1 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$1 OR (p.visibility='space' AND g.subject='space'))))
  UNION SELECT c.id,c.workspace_id FROM hs_pages c JOIN reachable a ON c.parent_id=a.id AND c.workspace_id=a.workspace_id WHERE c.deleted_at IS NULL
 ), permitted AS (SELECT DISTINCT id,workspace_id FROM reachable) SELECT p.id,p.title,count(*)::integer AS occurrences,s.name AS "spaceName"
 FROM hs_blocks b JOIN hs_pages p ON p.id=b.page_id JOIN permitted a ON a.id=p.id JOIN hs_spaces s ON s.id=p.space_id
 WHERE b.type='pageLink' AND b.node->'attrs'->>'pageId'=$3 AND p.deleted_at IS NULL AND ($4::text IS NULL OR p.id>$4)
 AND EXISTS(SELECT 1 FROM permitted t WHERE t.id=$3)
 GROUP BY p.id,p.title,s.name ORDER BY p.id LIMIT 21`,[actor.id,target.workspace_id,targetId,after??null]);
 // Recheck the target after the index read, including revocation during that read.
 await r.access(r.db,targetId,actor);
 return {items:rows.slice(0,20),nextCursor:rows.length>20?rows[19].id:null};
}
