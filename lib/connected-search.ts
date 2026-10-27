import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { Actor } from './auth';
import type { Repository } from './repository';
import { DocumentError } from './document';
import { searchPages } from './search';
import type { SearchResult } from './types';
export type ConnectedSearchInput={query:string;workspaceId:string;spaceId?:string;cursor?:string;requestId:string};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const queryHash=(i:ConnectedSearchInput)=>hash(JSON.stringify([i.query.trim(),i.workspaceId,i.spaceId??null]));
const invalid=()=>new DocumentError('Search cursor is invalid, expired or belongs to a different scope. Start a new search.','search_cursor_invalid',400);
async function scope(r:Repository,actor:Actor,input:ConnectedSearchInput){const membership=await r.db.query('SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true',[input.workspaceId,actor.id]);if(!membership.rows.length)throw new DocumentError('Search workspace is unavailable','not_found',404);if(input.spaceId){const space=await r.db.query('SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2',[input.spaceId,input.workspaceId]);if(!space.rows.length)throw new DocumentError('Search space is unavailable','not_found',404);}}
async function rateLimit(r:Repository,actor:Actor,requestId:string){const requests=await r.db.transaction(async tx=>{await tx.query('INSERT INTO hs_search_rate(user_id) SELECT id FROM hs_users WHERE id=$1 ON CONFLICT DO NOTHING',[actor.id]);const result=await tx.query<{requests:number}>(`UPDATE hs_search_rate SET
 requests=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN 1 ELSE LEAST(requests+1,61) END,
 denied_count=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN 0 WHEN requests>=60 THEN denied_count+1 ELSE denied_count END,
 last_denied_request_id=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN NULL WHEN requests>=60 THEN $2::uuid ELSE last_denied_request_id END,
 window_started=CASE WHEN window_started<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE window_started END
 WHERE user_id=$1 RETURNING requests`,[actor.id,requestId]);if(!result.rows.length)throw new DocumentError('Search account is unavailable','not_found',404);return result.rows[0].requests;});if(requests>60)throw new DocumentError('Search rate limit reached. Retry after one minute.','search_rate_limited',429);}
async function executeSearch(r:Repository,actor:Actor,input:ConnectedSearchInput){
 await rateLimit(r,actor,input.requestId);await scope(r,actor,input);
 // Stored snapshots/cursors contain IDs and hashes, never snippets or raw queries.
 const results=searchPages((await r.list(actor)).filter(p=>p.workspaceId===input.workspaceId),input.query,input.spaceId);
 let ids:string[],snapshotId:string,position=0;
 if(input.cursor){if(!/^[A-Za-z0-9_-]{43}$/.test(input.cursor))throw invalid();const found=await r.db.query<{id:string;user_id:string;workspace_id:string;query_hash:string;space_id:string|null;page_ids:string[];next_position:number}>(`SELECT s.*,c.next_position FROM hs_search_cursors c JOIN hs_search_snapshots s ON s.id=c.snapshot_id WHERE c.token_hash=$1 AND s.expires_at>clock_timestamp()`,[hash(input.cursor)]),s=found.rows[0];if(!s||s.user_id!==actor.id||s.workspace_id!==input.workspaceId||s.query_hash!==queryHash(input)||s.space_id!==(input.spaceId??null))throw invalid();ids=s.page_ids;snapshotId=s.id;position=s.next_position;}
 else{if(results.length>1000)throw new DocumentError('More than 1000 pages match. Refine the query or filter by space.','search_too_broad',422);ids=results.map(p=>p.id);snapshotId=randomUUID();if(ids.length>20)await r.db.query('INSERT INTO hs_search_snapshots(id,user_id,workspace_id,query_hash,space_id,page_ids) VALUES($1,$2,$3,$4,$5,$6)',[snapshotId,actor.id,input.workspaceId,queryHash(input),input.spaceId??null,JSON.stringify(ids)]);}
 const permitted=new Map(results.map(p=>[p.id,p])),items:SearchResult[]=[];
 while(position<ids.length&&items.length<20){const item=permitted.get(ids[position++]);if(item){try{const page=await r.get(item.id,actor);const fresh=searchPages([page],input.query,input.spaceId)[0];if(fresh&&page.workspaceId===input.workspaceId)items.push(fresh);}catch(e){if(!(e instanceof DocumentError&&e.status===404))throw e;}}}
 let nextCursor:string|null=null;if(position<ids.length){nextCursor=randomBytes(32).toString('base64url');await r.db.query('INSERT INTO hs_search_cursors(token_hash,snapshot_id,next_position) VALUES($1,$2,$3)',[hash(nextCursor),snapshotId,position]);}
 await scope(r,actor,input);
 return {requestId:input.requestId,results:items,nextCursor};
}
export async function connectedSearch(r:Repository,actor:Actor,input:ConnectedSearchInput){
 try{const result=await executeSearch(r,actor,input);await r.db.query('INSERT INTO hs_search_audit(id,request_id,user_id,outcome,result_count) VALUES($1,$2,$3,$4,$5)',[randomUUID(),input.requestId,actor.id,'ok',result.results.length]);return result;}
 catch(error){const code=error instanceof DocumentError?error.code:'service_unavailable';if(code==='search_rate_limited')throw error;try{await r.db.query('INSERT INTO hs_search_audit(id,request_id,user_id,outcome) SELECT $1,$2,id,$4 FROM hs_users WHERE id=$3',[randomUUID(),input.requestId,actor.id,code]);}catch{/* A failed audit never makes a failed search successful. */}throw error;}
}
