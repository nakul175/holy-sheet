import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Actor} from './auth';
import type {Repository} from './repository';
import type {Sql} from './database';
import {DocumentError} from './document';
import {parseQuery,searchPages} from './search';
import type {SearchResult} from './types';

export type SearchWork={check():void};
export function createSearchWork(duration=5000,signal?:AbortSignal):SearchWork{
 const deadline=performance.now()+duration;
 return {check(){if(signal?.aborted||performance.now()>=deadline)throw new DocumentError('Search is temporarily busy. Retry or choose a space.','search_busy',503);}};
}

export type WorkspaceSearchInput={query:string;workspaceId:string;spaceId?:string;cursor?:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const missing=()=>new DocumentError('Search scope is unavailable.','not_found',404);
const invalid=()=>new DocumentError('Search changed or expired. Retry from the first page.','search_cursor_invalid',409);
const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export async function workspaceSearch(r:Repository,actor:Actor,input:WorkspaceSearchInput,signal?:AbortSignal){
 const entered=performance.now(),work=createSearchWork(5000,signal);work.check();
 const bounded=(raw:Sql):Sql=>({query:async<T>(sql:string,values?:unknown[])=>{
  work.check();
  await raw.query("SELECT set_config('statement_timeout',$1,true)",[Math.max(1,Math.floor(5000-(performance.now()-entered)))+'ms']);
  work.check();
  try{const result=await raw.query<T>(sql,values);work.check();return result;}
  catch(error){if((error as {code?:string}).code==='57014')throw new DocumentError('Search is temporarily busy. Retry or choose a space.','search_busy',503);throw error;}
 }});
 // Commit admission separately so rejected searches cannot reset their own limit.
 const admitted=await r.db.transaction(async raw=>{
  const tx=bounded(raw);
  await tx.query('INSERT INTO hs_search_rate(user_id) SELECT id FROM hs_users WHERE id=$1 ON CONFLICT DO NOTHING',[actor.id]);
  return (await tx.query<{requests:number}>(`UPDATE hs_search_rate SET requests=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN 1 ELSE LEAST(requests+1,61) END,window_started=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE window_started END WHERE user_id=$1 RETURNING requests`,[actor.id])).rows[0];
 });
 work.check();
 if(!admitted)throw missing();
 if(admitted.requests>60)throw new DocumentError('Search request limit reached. Retry after one minute.','search_rate_limited',429);
 return r.db.transaction(async raw=>{
  const tx=bounded(raw);
  work.check();
  // Serialize this actor's snapshot allocation, including searches in other workspaces.
  await tx.query('SELECT user_id FROM hs_search_rate WHERE user_id=$1 FOR UPDATE',[actor.id]);
  // Serialize with native grant/move/delete transactions. Never trust cursor ACLs.
  const member=(await tx.query<{name:string}>(`SELECT w.name FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id WHERE w.id=$1 AND m.user_id=$2 AND m.active=true FOR SHARE OF w,m`,[input.workspaceId,actor.id])).rows[0];
  work.check();
  if(!member)throw missing();
  if(input.spaceId&&!(await tx.query('SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2',[input.spaceId,input.workspaceId])).rows.length)throw missing();
  const parsed=parseQuery(input.query),queryHash=hash(JSON.stringify([input.query.trim(),input.workspaceId,input.spaceId??null]));
  if(input.query.trim().length<2||!parsed.terms.length&&!parsed.phrases.length)return {results:[],nextCursor:null,workspace:{id:input.workspaceId,name:member.name}};
  const budget=()=>work.check();
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
  const indexMatch=[...new Set(lexemes.map(word=>Array.from(word).slice(0,128).join('')))].map(word=>
   `EXISTS(SELECT 1 FROM hs_workspace_search_terms t WHERE t.page_id=p.id AND t.search_vector @@ ${bind("'"+word.replace(/'/g,"''")+"':*")}::tsquery)`
  ).join(' AND ')||'true';
  // A single scoped permission closure avoids one document/ACL query per page.
  const permitted=`WITH RECURSIVE permitted(id) AS (
   SELECT p.id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
   WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND (m.role IN ('owner','admin') OR p.owner_id=$2 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$2 OR (p.visibility='space' AND g.subject='space'))))
   UNION SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.parent_id WHERE p.workspace_id=$1 AND p.deleted_at IS NULL
  )`;
  // ASCII text has the same word/case semantics in JS and SQL. Unicode text
  // must be matched in JS before rank/pagination: POSIX classes and lowercase
  // are not Unicode-equivalent (numbers, dotted-I, final sigma, new case pairs).
  const ordinary=(await tx.query<{id:string;rank:number;updated_at:string}>(`${permitted} SELECT p.id,CASE WHEN lower(p.title)=${exact} THEN 0 WHEN ${titleMatch} THEN 1 ELSE 2 END AS rank,p.updated_at FROM hs_pages p JOIN permitted a ON a.id=p.id JOIN hs_workspace_search x ON x.page_id=p.id WHERE x.ascii_only AND ($3::text IS NULL OR p.space_id=$3) AND (${indexMatch}) AND (${allMatch}) ORDER BY rank,p.updated_at DESC,p.id COLLATE "C" LIMIT 20001`,values)).rows;
  budget();
  const unicode:SearchResult[]=[];let after='';
  for(;;){
   budget();
   const batch=(await tx.query<{id:string}>(`${permitted} SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.id JOIN hs_workspace_search x ON x.page_id=p.id WHERE NOT x.ascii_only AND ($3::text IS NULL OR p.space_id=$3) AND p.id COLLATE "C">$4 COLLATE "C" ORDER BY p.id COLLATE "C" LIMIT 128`,[input.workspaceId,actor.id,input.spaceId??null,after])).rows;
   for(const row of batch){
    budget();const page=await r.get(row.id,actor,tx);budget();
    if(page.workspaceId!==input.workspaceId)continue;
    const match=searchPages([page],input.query,input.spaceId)[0];if(match)unicode.push(match);
    if(unicode.length+ordinary.length>20000)throw new DocumentError('Too many pages match. Refine your query or choose a space.','search_too_broad',422);
   }
   if(batch.length<128)break;after=batch.at(-1)!.id;
  }
  budget();
  const weights={'title-exact':0,title:1,content:2};
  const ranked=[...ordinary.map(row=>({id:row.id,rank:row.rank,updatedAt:new Date(row.updated_at).toISOString()})),...unicode.map(row=>({id:row.id,rank:weights[row.match],updatedAt:row.updatedAt}))].sort((a,b)=>a.rank-b.rank||b.updatedAt.localeCompare(a.updatedAt)||(a.id<b.id?-1:a.id>b.id?1:0)).map(row=>row.id);
  budget();
  if(ranked.length>20000)throw new DocumentError('Too many pages match. Refine your query or choose a space.','search_too_broad',422);
  let ids=ranked,position=0;let snapshotId:string=randomUUID();
  if(input.cursor){
   const snapshot=(await tx.query<{id:string;page_ids:string[];next_position:number;query_hash:string;user_id:string;workspace_id:string}>(`SELECT s.*,c.next_position FROM hs_search_cursors c JOIN hs_search_snapshots s ON s.id=c.snapshot_id WHERE c.token_hash=$1 AND s.expires_at>clock_timestamp()`,[hash(input.cursor)])).rows[0];
   if(!snapshot||snapshot.user_id!==actor.id||snapshot.workspace_id!==input.workspaceId||snapshot.query_hash!==queryHash)throw invalid();
   ids=snapshot.page_ids;position=snapshot.next_position;snapshotId=snapshot.id;
  }else if(ids.length>20){
   await tx.query('DELETE FROM hs_search_snapshots WHERE id IN(SELECT id FROM hs_search_snapshots WHERE user_id=$1 AND expires_at<=clock_timestamp() LIMIT 100)',[actor.id]);
   const active=(await tx.query<{count:number}>('SELECT count(*)::integer AS count FROM hs_search_snapshots WHERE user_id=$1 AND expires_at>clock_timestamp()',[actor.id])).rows[0].count;
   if(active>=32)throw new DocumentError('Too many active searches. Retry when an earlier search expires.','search_snapshot_limit',429);
   await tx.query('INSERT INTO hs_search_snapshots(id,user_id,workspace_id,query_hash,space_id,page_ids) VALUES($1,$2,$3,$4,$5,$6)',[snapshotId,actor.id,input.workspaceId,queryHash,input.spaceId??null,JSON.stringify(ids)]);
  }
  const current=new Set(ranked),selected:string[]=[];
  while(position<ids.length&&selected.length<20){const id=ids[position++];if(current.has(id))selected.push(id);}
  const results:SearchResult[]=[];
  for(const id of selected){
   budget();
   // Recheck native authority, and construct paths only from authorised ancestors.
   const page=await r.get(id,actor,tx);budget();if(page.workspaceId!==input.workspaceId)continue;
   const ancestry:string[]=[];let parent=page.parentPageId;const seen=new Set([id]);
   while(parent&&!seen.has(parent)){budget();seen.add(parent);try{const ancestor=await r.get(parent,actor,tx);budget();if(ancestor.workspaceId!==input.workspaceId)break;ancestry.unshift(ancestor.title);parent=ancestor.parentPageId;}catch(error){if(error instanceof DocumentError&&error.status===404)break;throw error;}}
   const result=searchPages([page],input.query,input.spaceId)[0];budget();if(result){result.path=[page.spaceName,...ancestry];results.push(result);}
  }
  let nextCursor:string|null=null;
  if(position<ids.length){nextCursor=randomBytes(32).toString('base64url');await tx.query('INSERT INTO hs_search_cursors(token_hash,snapshot_id,next_position) VALUES($1,$2,$3)',[hash(nextCursor),snapshotId,position]);}
  budget();
  return {results,nextCursor,workspace:{id:input.workspaceId,name:member.name}};
 });
}
