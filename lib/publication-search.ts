import {createHash} from 'node:crypto';
import type {Actor} from './auth';
import type {Sql} from './database';
import type {Repository} from './repository';
import {DocumentError} from './document';
import {revisionDigest} from './revision';
import {searchPages} from './search';
import type {SearchResult} from './types';
import {projectionSql,type ProjectionBudget} from './publication-projection';
import {expandedDocumentHits} from './unified-search';

export type PublicationSearchOptions={ownerId?:string;updatedFrom?:string;updatedTo?:string;blocks?:boolean;attachments?:boolean};

// Governed documents must enter search through the reader's authorised revision,
// before matching or allocating snapshots. The draft index is never a prefilter.
export async function publicationSearchCandidates(r:Repository,tx:Sql,actor:Actor,input:{query:string;workspaceId:string;spaceId?:string},permitted:string,work:ProjectionBudget,options?:PublicationSearchOptions){
 const results:SearchResult[]=[],extras:SearchResult[]=[],revisions:[string,string][]=[];
 tx=projectionSql(tx,work);
 const base:unknown[]=[input.workspaceId,actor.id,input.spaceId??null],filters:string[]=[];
 if(options?.ownerId){base.push(options.ownerId);filters.push(`p.owner_id=$${base.length}`);}
 if(options?.updatedFrom){base.push(options.updatedFrom);filters.push(`(p.updated_at AT TIME ZONE 'UTC')::date>=$${base.length}::date`);}
 if(options?.updatedTo){base.push(options.updatedTo);filters.push(`(p.updated_at AT TIME ZONE 'UTC')::date<=$${base.length}::date`);}
 const filterSql=filters.length?` AND ${filters.join(' AND ')}`:'',afterParam=base.length+1;
 // A page with no publication is unavailable to readers. Exclude it before
 // traversal/resource accounting; authoring access uses the native role ceiling.
 const authoring=`m.role<>'observer' AND (m.role IN ('owner','admin') OR p.owner_id=$2 OR EXISTS(
  WITH RECURSIVE ancestors AS (
   SELECT p.id,p.parent_id,p.visibility,p.owner_id,ARRAY[p.id] AS path
   UNION ALL SELECT parent.id,parent.parent_id,parent.visibility,parent.owner_id,a.path||parent.id
   FROM hs_pages parent JOIN ancestors a ON parent.id=a.parent_id
   WHERE parent.workspace_id=$1 AND parent.deleted_at IS NULL AND NOT parent.id=ANY(a.path)
  ) SELECT 1 FROM ancestors a LEFT JOIN hs_grants g ON g.page_id=a.id AND (g.subject=$2 OR (a.visibility='space' AND g.subject='space')) WHERE a.owner_id=$2 OR g.role='editor'
 ))`;
 let after='';
 for(;;){
  const batch=(await tx.query<{id:string}>(`${permitted} SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.id JOIN hs_document_workflows w ON w.page_id=p.id JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true WHERE (w.publication_id IS NOT NULL OR (${authoring})) AND ($3::text IS NULL OR p.space_id=$3)${filterSql} AND p.id COLLATE "C">$${afterParam} COLLATE "C" ORDER BY p.id COLLATE "C" LIMIT 128`,[...base,after])).rows;
  for(const {id} of batch){
   try{
    const page=await r.get(id,actor,tx,work);if(page.workspaceId!==input.workspaceId)continue;
    const match=searchPages([page],input.query,input.spaceId)[0];
    work.check();
    if(match){results.push(match);revisions.push([id,page.publicationFingerprint??revisionDigest(page.title,page.document)]);work.check();}
    if(options?.blocks||options?.attachments){
     const expanded=expandedDocumentHits(page,input.query,{blocks:!!options.blocks&&!!match,attachments:!!options.attachments});
     if(expanded.length){extras.push(...expanded);if(!match)revisions.push([id,page.publicationFingerprint??revisionDigest(page.title,page.document)]);work.check();}
    }
   }catch(error){if(!(error instanceof DocumentError)||error.status!==404)throw error;}
   work.check();
   if(results.length>20000)throw new DocumentError('Too many pages match. Refine your query or choose a space.','search_too_broad',422);
  }
  if(batch.length<128)break;
  after=batch.at(-1)!.id;
  work.check();
 }
 return {results,extras,revisionHash:createHash('sha256').update(JSON.stringify(revisions)).digest('hex')};
}
