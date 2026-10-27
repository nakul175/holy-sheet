import type { Actor } from './auth';
import type { Repository } from './repository';
import type { Sql } from './database';
import { DocumentError } from './document';
export type NavigationEntry={id:string;title:string;workspaceId:string;workspaceName:string;spaceId:string;spaceName:string;parentTitle:string|null};
export type PersonalNavigation={version:number;favourites:NavigationEntry[];recents:NavigationEntry[]};
export type NavigationAction={action:'favourite';pageId:string;value:boolean;version:number}|{action:'opened';pageId:string}|{action:'clear';version:number}|{action:'reorder';pageId:string;beforeId:string|null;version:number};
async function state(tx:Sql,actor:Actor){await tx.query('INSERT INTO hs_navigation_state(user_id) SELECT id FROM hs_users WHERE id=$1 ON CONFLICT DO NOTHING',[actor.id]);const {rows}=await tx.query<{version:number}>('SELECT version FROM hs_navigation_state WHERE user_id=$1 FOR UPDATE',[actor.id]);if(!rows.length)throw new DocumentError('Your HS account is unavailable','not_found',404);return rows[0].version;}
export async function personalNavigation(r:Repository,actor:Actor,workspaceId?:string):Promise<PersonalNavigation>{
 const version=await r.db.query<{version:number}>('SELECT version FROM hs_navigation_state WHERE user_id=$1',[actor.id]);
 const read=async(table:'hs_favourites'|'hs_recents',order:string)=>{const {rows}=await r.db.query<NavigationEntry>(`WITH RECURSIVE reachable AS (
  SELECT p.id,p.workspace_id,0 AS depth FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$1 AND m.active=true
  WHERE p.deleted_at IS NULL AND (m.role='admin' OR p.owner_id=$1 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$1 OR (p.visibility='space' AND g.subject='space'))))
  UNION SELECT c.id,c.workspace_id,a.depth+1 FROM hs_pages c JOIN reachable a ON c.parent_id=a.id AND c.workspace_id=a.workspace_id WHERE c.deleted_at IS NULL AND a.depth<99
 ), permitted AS (SELECT DISTINCT id,workspace_id FROM reachable) SELECT p.id,p.title,p.workspace_id AS "workspaceId",w.name AS "workspaceName",p.space_id AS "spaceId",s.name AS "spaceName",parent.title AS "parentTitle"
 FROM ${table} n JOIN permitted a ON a.id=n.page_id JOIN hs_pages p ON p.id=n.page_id JOIN hs_workspaces w ON w.id=p.workspace_id JOIN hs_spaces s ON s.id=p.space_id
 LEFT JOIN hs_pages parent ON parent.id=p.parent_id AND parent.id IN (SELECT id FROM permitted)
 WHERE n.user_id=$1 AND p.deleted_at IS NULL AND ($2::text IS NULL OR p.workspace_id=$2) ORDER BY ${order}`,[actor.id,workspaceId??null]);return rows;};
 // Read current page metadata only after access checks. No stale titles or activity are stored in these tables.
 return {version:version.rows[0]?.version??0,favourites:await read('hs_favourites','n.position,n.page_id'),recents:await read('hs_recents','n.opened_at DESC,n.page_id')};
}
export async function updatePersonalNavigation(r:Repository,actor:Actor,input:NavigationAction){return r.db.transaction(async tx=>{
 if(input.action==='favourite'||input.action==='opened'||input.action==='reorder')await r.access(tx,input.pageId,actor,false,true);
 const current=await state(tx,actor);
 if(input.action==='opened'){
  await tx.query('INSERT INTO hs_recents(user_id,page_id) VALUES($1,$2) ON CONFLICT(user_id,page_id) DO UPDATE SET opened_at=clock_timestamp()',[actor.id,input.pageId]);
  await tx.query('DELETE FROM hs_recents WHERE user_id=$1 AND page_id IN (SELECT page_id FROM hs_recents WHERE user_id=$1 ORDER BY opened_at DESC,page_id OFFSET 50)',[actor.id]);return {version:current};
 }
 const favourites=await tx.query<{page_id:string;position:string}>('SELECT page_id,position FROM hs_favourites WHERE user_id=$1 ORDER BY position,page_id',[actor.id]);
 if(input.action==='favourite'&&favourites.rows.some(f=>f.page_id===input.pageId)===input.value)return {version:current};
 if(input.version!==current)throw new DocumentError('Your personal list changed. Refresh it before retrying.','navigation_conflict',409);
 if(input.action==='favourite'){
  if(input.value){if(favourites.rows.length>=500)throw new DocumentError('The current favourites limit is 500. Remove a favourite before adding another.','favourite_limit',409);await tx.query('INSERT INTO hs_favourites(user_id,page_id,position) VALUES($1,$2,$3)',[actor.id,input.pageId,favourites.rows.length?Number(favourites.rows.at(-1)!.position)+1:0]);}
  else await tx.query('DELETE FROM hs_favourites WHERE user_id=$1 AND page_id=$2',[actor.id,input.pageId]);
 }else if(input.action==='clear')await tx.query('DELETE FROM hs_recents WHERE user_id=$1',[actor.id]);
 else{
  if(input.beforeId===input.pageId)return {version:current};
  if(input.beforeId)await r.access(tx,input.beforeId,actor);
  const ids=favourites.rows.map(f=>f.page_id);if(!ids.includes(input.pageId)||(input.beforeId&&!ids.includes(input.beforeId)))throw new DocumentError('Favourite is unavailable. Refresh the list.','navigation_conflict',409);
  const ordered=ids.filter(id=>id!==input.pageId);ordered.splice(input.beforeId?ordered.indexOf(input.beforeId):ordered.length,0,input.pageId);
  for(let i=0;i<ordered.length;i++)await tx.query('UPDATE hs_favourites SET position=$3 WHERE user_id=$1 AND page_id=$2',[actor.id,ordered[i],i]);
 }
 await tx.query('UPDATE hs_navigation_state SET version=version+1 WHERE user_id=$1',[actor.id]);return {version:current+1};
});}
