import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Actor} from './auth';
import type {Repository} from './repository';
import {DocumentError} from './document';
import {parseQuery,searchPages} from './search';
import type {Page,SearchResult} from './types';

export type WorkspaceSearchInput={query:string;workspaceId:string;spaceId?:string;cursor?:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const missing=()=>new DocumentError('Search scope is unavailable.','not_found',404);
const invalid=()=>new DocumentError('Search changed or expired. Retry from the first page.','search_cursor_invalid',409);
const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export async function workspaceSearch(r:Repository,actor:Actor,input:WorkspaceSearchInput){
 return r.db.transaction(async tx=>{
  // Serialize with native grant/move/delete transactions. Never trust cursor ACLs.
  const member=(await tx.query<{name:string}>(`SELECT w.name FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2 AND m.active=true FOR SHARE OF w,m`,[input.workspaceId,actor.id])).rows[0];
  if(!member)throw missing();
  if(input.spaceId&&!(await tx.query('SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2',[input.spaceId,input.workspaceId])).rows.length)throw missing();
  const parsed=parseQuery(input.query),queryHash=hash(JSON.stringify([input.query.trim(),input.workspaceId,input.spaceId??null]));
  if(input.query.trim().length<2||!parsed.terms.length&&!parsed.phrases.length)return {results:[],nextCursor:null,workspace:{id:input.workspaceId,name:member.name}};
  const values:unknown[]=[input.workspaceId,actor.id,input.spaceId??null];
  const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
  const matches=(expression:string)=>{
   const clauses=parsed.phrases.map(phrase=>`lower(${expression}) ~ ${bind('(^|[^[:alnum:]])'+escapeRegex(phrase)+'([^[:alnum:]]|$)')}`);
   parsed.terms.forEach((term,i)=>clauses.push(`lower(${expression}) ~ ${bind('(^|[^[:alnum:]])'+escapeRegex(term)+(i===parsed.terms.length-1?'':'([^[:alnum:]]|$)'))}`));
   return clauses.length?clauses.join(' AND '):'false';
  };
  const titleMatch=matches('p.title'),allMatch=matches("p.title||E'\\n'||COALESCE(x.body,'')"),exact=bind(input.query.trim().toLocaleLowerCase());
  // The index only narrows candidates; exact matching and current ACLs remain authoritative.
  const lexemes=[...parsed.phrases.flatMap(p=>p.match(/[\p{L}\p{N}]+/gu)??[]),...parsed.terms];
  const tsquery=lexemes.map((word,i)=>"'"+word.replace(/'/g,"''")+"'"+(parsed.prefix&&i===lexemes.length-1?':*':'')).join(' & ');
  const indexMatch=tsquery?`x.search_vector @@ to_tsquery('simple',${bind(tsquery)})`:'true';
  // A single scoped permission closure avoids one document/ACL query per page.
  const permitted=`WITH RECURSIVE permitted(id) AS (
   SELECT p.id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
   WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND (m.role IN ('owner','admin') OR p.owner_id=$2 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$2 OR (p.visibility='space' AND g.subject='space'))))
   UNION SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.parent_id WHERE p.workspace_id=$1 AND p.deleted_at IS NULL
  )`;
  const ranked=(await tx.query<{id:string}>(`${permitted} SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.id LEFT JOIN hs_workspace_search x ON x.page_id=p.id WHERE ($3::text IS NULL OR p.space_id=$3) AND (${indexMatch}) AND (${allMatch}) ORDER BY CASE WHEN lower(p.title)=${exact} THEN 0 WHEN ${titleMatch} THEN 1 ELSE 2 END,p.updated_at DESC,p.id COLLATE "C"`,values)).rows.map(row=>row.id);
  let ids=ranked,position=0;let snapshotId:string=randomUUID();
  if(input.cursor){
   const snapshot=(await tx.query<{id:string;page_ids:string[];next_position:number;query_hash:string;user_id:string;workspace_id:string}>(`SELECT s.*,c.next_position FROM hs_search_cursors c JOIN hs_search_snapshots s ON s.id=c.snapshot_id WHERE c.token_hash=$1 AND s.expires_at>clock_timestamp()`,[hash(input.cursor)])).rows[0];
   if(!snapshot||snapshot.user_id!==actor.id||snapshot.workspace_id!==input.workspaceId||snapshot.query_hash!==queryHash)throw invalid();
   ids=snapshot.page_ids;position=snapshot.next_position;snapshotId=snapshot.id;
  }else if(ids.length>20)await tx.query('INSERT INTO hs_search_snapshots(id,user_id,workspace_id,query_hash,space_id,page_ids) VALUES($1,$2,$3,$4,$5,$6)',[snapshotId,actor.id,input.workspaceId,queryHash,input.spaceId??null,JSON.stringify(ids)]);
  const current=new Set(ranked),selected:string[]=[];
  while(position<ids.length&&selected.length<20){const id=ids[position++];if(current.has(id))selected.push(id);}
  const results:SearchResult[]=[];
  for(const id of selected){
   // Recheck native authority, and construct paths only from authorised ancestors.
   const page=await r.get(id,actor,tx);if(page.workspaceId!==input.workspaceId)continue;
   const ancestry:string[]=[];let parent=page.parentPageId;const seen=new Set([id]);
   while(parent&&!seen.has(parent)){seen.add(parent);try{const ancestor=await r.get(parent,actor,tx);if(ancestor.workspaceId!==input.workspaceId)break;ancestry.unshift(ancestor.title);parent=ancestor.parentPageId;}catch(error){if(error instanceof DocumentError&&error.status===404)break;throw error;}}
   const result=searchPages([page],input.query,input.spaceId)[0];if(result){result.path=[page.spaceName,...ancestry];results.push(result);}
  }
  let nextCursor:string|null=null;
  if(position<ids.length){nextCursor=randomBytes(32).toString('base64url');await tx.query('INSERT INTO hs_search_cursors(token_hash,snapshot_id,next_position) VALUES($1,$2,$3)',[hash(nextCursor),snapshotId,position]);}
  return {results,nextCursor,workspace:{id:input.workspaceId,name:member.name}};
 });
}
