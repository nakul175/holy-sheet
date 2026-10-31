import type {Actor} from './auth';
import type {Sql} from './database';
import type {RichNode} from './document';
import {DocumentError} from './document';
import {includesParsed,parseQuery,searchPreview,type ParsedQuery} from './search';
import type {SearchKind,SearchResult} from './types';

export type UnifiedSearchInput={
 query:string;
 workspaceId:string;
 spaceId?:string;
 kinds?:SearchKind[];
 collection?:string;
 ownerId?:string;
 updatedFrom?:string;
 updatedTo?:string;
};

const escapeRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const stamp=(value:string|Date)=>new Date(value).toISOString();

type HitPage={id:string;title:string;spaceId:string;spaceName:string;updatedAt:string;blocks:{id:string;text:string}[];document:RichNode};

export function expandedDocumentHits(page:HitPage,query:string,options:{blocks?:boolean;attachments?:boolean}){
 const parsed=parseQuery(query),hits:SearchResult[]=[];
 if(options.blocks)page.blocks.forEach((block,index)=>{
  if(!block.text||!includesParsed(block.text,parsed))return;
  hits.push({id:`block:${page.id}:${block.id||index}`,kind:'block',title:page.title,spaceId:page.spaceId,path:[page.spaceName,page.title],preview:searchPreview(block.text,parsed),updatedAt:page.updatedAt,match:'content',href:`/pages/${encodeURIComponent(page.id)}`});
 });
 if(options.attachments){
  const visit=(node:RichNode)=>{
   if((node.type==='file'||node.type==='image')&&node.attrs){
    const name=[node.attrs.title,node.attrs.alt,node.attrs.caption].find(value=>typeof value==='string'&&value.trim()) as string|undefined;
    const mediaId=typeof node.attrs.attachmentId==='string'?node.attrs.attachmentId:'';
    if(name&&mediaId&&includesParsed(name,parsed))hits.push({id:`attachment:${mediaId}`,kind:'attachment',title:name,spaceId:page.spaceId,path:[page.spaceName,page.title],preview:searchPreview(name,parsed),updatedAt:page.updatedAt,match:'attachment',href:`/pages/${encodeURIComponent(page.id)}`});
   }
   node.content?.forEach(visit);
  };
  visit(page.document);
 }
 return hits;
}

type Row={
 block_id?:string;media_id?:string;page_id?:string;name?:string;body?:string;title?:string;space_id?:string;space_name?:string;updated_at:string|Date;
 record_id?:string;tenant_id?:string;kind?:string;field_key?:string;source_id?:string;collection?:string;record_name?:string;ascii_only?:boolean;
};

export async function unifiedSearchHits(tx:Sql,actor:Actor,input:UnifiedSearchInput,permitted:string,budget:()=>void){
 const kinds=new Set(input.kinds??[]);
 const parsed=parseQuery(input.query);
 if(!parsed.terms.length&&!parsed.phrases.length)return [];
 const hits:SearchResult[]=[];
 const scope=(withSpace=true)=>{
  const values:unknown[]=withSpace?[input.workspaceId,actor.id,input.spaceId??null]:[input.workspaceId,actor.id];
  const bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
  const matches=(expression:string)=>{
   const clauses=parsed.phrases.map(phrase=>`lower(${expression}) ~ ${bind('(^|[^[:alnum:]])'+escapeRegex(phrase)+'([^[:alnum:]]|$)')}`);
   parsed.terms.forEach((term,index)=>clauses.push(`lower(${expression}) ~ ${bind('(^|[^[:alnum:]])'+escapeRegex(term)+(index===parsed.terms.length-1?'':'([^[:alnum:]]|$)'))}`));
   return clauses.length?clauses.join(' AND '):'false';
  };
  const owned=(column:string)=>input.ownerId?` AND ${column}=${bind(input.ownerId)}`:'';
  const dated=(column:string)=>{
   const parts:string[]=[];
   if(input.updatedFrom)parts.push(`(${column} AT TIME ZONE 'UTC')::date>=${bind(input.updatedFrom)}::date`);
   if(input.updatedTo)parts.push(`(${column} AT TIME ZONE 'UTC')::date<=${bind(input.updatedTo)}::date`);
   return parts.length?` AND ${parts.join(' AND ')}`:'';
  };
  return {values,bind,matches,owned,dated};
 };
 const tooMany=()=>{throw new DocumentError('Too many pages match. Refine your query or choose a space.','search_too_broad',422);};
 const push=(hit:SearchResult)=>{hits.push(hit);if(hits.length>2000)tooMany();};
 if(kinds.has('block')&&!input.collection){
  budget();
  const q=scope();
  const rows=(await tx.query<Row>(`${permitted} SELECT b.block_id,b.body,p.id AS page_id,p.title,p.space_id,sp.name AS space_name,p.updated_at FROM hs_block_search b JOIN hs_pages p ON p.id=b.page_id JOIN permitted a ON a.id=p.id JOIN hs_spaces sp ON sp.id=p.space_id WHERE NOT EXISTS(SELECT 1 FROM hs_document_workflows w WHERE w.page_id=p.id) AND b.ascii_only AND ($3::text IS NULL OR p.space_id=$3)${q.owned('p.owner_id')}${q.dated('p.updated_at')} AND (${q.matches('b.body')}) ORDER BY p.updated_at DESC,b.block_id LIMIT 2001`,q.values)).rows;
  budget();
  if(rows.length>2000)tooMany();
  for(const row of rows)push({id:`block:${row.block_id}`,kind:'block',title:row.title??'',spaceId:row.space_id??'',path:[row.space_name??'',row.title??''],preview:searchPreview(row.body??'',parsed),updatedAt:stamp(row.updated_at),match:'content',href:`/pages/${encodeURIComponent(row.page_id??'')}`});
  await scanUnicode(tx,actor.id,input,permitted,budget,parsed,'block',push);
 }
 if(kinds.has('attachment')&&!input.collection){
  budget();
  const q=scope();
  const rows=(await tx.query<Row>(`${permitted} SELECT a.media_id,a.name,p.id AS page_id,p.title,p.space_id,sp.name AS space_name,p.updated_at FROM hs_attachment_search a JOIN hs_pages p ON p.id=a.page_id JOIN permitted perm ON perm.id=p.id JOIN hs_spaces sp ON sp.id=p.space_id WHERE a.active AND NOT EXISTS(SELECT 1 FROM hs_document_workflows w WHERE w.page_id=p.id) AND EXISTS(SELECT 1 FROM hs_blocks b WHERE b.page_id=p.id AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=a.media_id::text) AND a.ascii_only AND ($3::text IS NULL OR p.space_id=$3)${q.owned('p.owner_id')}${q.dated('p.updated_at')} AND (${q.matches('a.name')}) ORDER BY p.updated_at DESC,a.media_id LIMIT 2001`,q.values)).rows;
  budget();
  if(rows.length>2000)tooMany();
  for(const row of rows)push({id:`attachment:${row.media_id}`,kind:'attachment',title:row.name??'',spaceId:row.space_id??'',path:[row.space_name??'',row.title??''],preview:searchPreview(row.name??'',parsed),updatedAt:stamp(row.updated_at),match:'attachment',href:`/pages/${encodeURIComponent(row.page_id??'')}`});
  await scanUnicode(tx,actor.id,input,permitted,budget,parsed,'attachment',push);
 }
 const recordKinds=(['record','field','attachment'] as const).filter(kind=>kinds.has(kind));
 if(recordKinds.length&&!input.spaceId){
  budget();
  const q=scope(false);
  const kindBind=q.bind(recordKinds);
  const rows=(await tx.query<Row>(`${permitted} SELECT s.record_id,s.tenant_id,s.kind,s.field_key,s.source_id,s.title,s.body,s.collection,r.name AS record_name,r.updated_at,s.ascii_only FROM hs_record_search s JOIN hs_data_records r ON r.tenant_id=s.tenant_id AND r.id=s.record_id JOIN hs_data_workspaces w ON w.tenant_id=s.tenant_id AND w.workspace_id=$1 JOIN hs_members m ON m.workspace_id=w.workspace_id AND m.user_id=$2 AND m.active=true WHERE r.deleted_at IS NULL AND r.state<>'trashed' AND r.merged_into_id IS NULL AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$2 AND g.collection=r.collection AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$2 AND 'view'=ANY(g.capabilities))) AND hs_record_search_field_visible(s.tenant_id,r.collection,s.field_key,s.kind,$2) AND (s.kind<>'attachment' OR EXISTS(SELECT 1 FROM hs_media media JOIN permitted seen ON seen.id=media.page_id WHERE media.id::text=s.source_id AND media.state='ready' AND media.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hs_document_workflows wf WHERE wf.page_id=media.page_id))) AND s.kind=ANY(${kindBind}::text[]) AND s.ascii_only ${input.collection?`AND r.collection=${q.bind(input.collection)}`:''}${q.owned('r.created_by')}${q.dated('r.updated_at')} AND (${q.matches("s.title||E'\\n'||s.body")}) ORDER BY r.updated_at DESC,s.record_id,s.field_key LIMIT 2001`,q.values)).rows;
  budget();
  if(rows.length>2000)tooMany();
  for(const row of rows){const hit=recordHit(row,input.workspaceId,parsed,input.query);if(hit)push(hit);}
  await scanUnicode(tx,actor.id,input,permitted,budget,parsed,'record',push,recordKinds);
 }
 budget();
 return hits;
}

function recordHit(row:Row,workspaceId:string,parsed:ParsedQuery,query:string):SearchResult|null{
 const kind=row.kind as SearchKind;
 const recordName=row.record_name??'';
 const label=row.title??'';
 const body=kind==='record'?recordName:row.body??'';
 const visible=kind==='record'?recordName:`${label}\n${body}`;
 if(!includesParsed(visible,parsed))return null;
 const exact=recordName.toLocaleLowerCase()===query.trim().toLocaleLowerCase();
 const titleMatch=includesParsed(kind==='attachment'?body:kind==='field'?label:recordName,parsed);
 const bodyMatch=includesParsed(body,parsed);
 const match:SearchResult['match']=kind==='attachment'?'attachment':kind==='field'?'field':exact?'title-exact':titleMatch?'title':'content';
 const preview=kind==='record'||!bodyMatch?searchPreview(kind==='field'?label:recordName,parsed):searchPreview(body,parsed);
 const id=kind==='record'?`record:${row.record_id}`:kind==='field'?`field:${row.record_id}:${row.field_key}`:`attachment:record:${row.record_id}:${row.field_key}:${row.source_id}`;
 return {id,kind,title:kind==='field'?`${recordName} · ${label}`:kind==='attachment'?body:recordName,spaceId:'',path:kind==='field'?[row.collection??'',recordName,label]:[row.collection??'',recordName],preview,updatedAt:stamp(row.updated_at),match,href:`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(row.tenant_id??'')}/records?collection=${encodeURIComponent(row.collection??'')}&record=${encodeURIComponent(row.record_id??'')}`,collection:row.collection};
}

async function scanUnicode(tx:Sql,actorId:string,input:UnifiedSearchInput,permitted:string,budget:()=>void,parsed:ParsedQuery,mode:'block'|'attachment'|'record',push:(hit:SearchResult)=>void,recordKinds:SearchKind[]=[]){
 let after='';
 for(let examined=0;examined<20000;){
  budget();
  const values:unknown[]=mode==='record'?[input.workspaceId,actorId,after]:[input.workspaceId,actorId,input.spaceId??null,after];
  const cursor=mode==='record'?'$3':'$4';
  const add=(value:unknown)=>{values.push(value);return '$'+values.length;};
  const owned=(column:string)=>input.ownerId?` AND ${column}=${add(input.ownerId)}`:'';
  const dated=(column:string)=>{const parts:string[]=[];if(input.updatedFrom)parts.push(`(${column} AT TIME ZONE 'UTC')::date>=${add(input.updatedFrom)}::date`);if(input.updatedTo)parts.push(`(${column} AT TIME ZONE 'UTC')::date<=${add(input.updatedTo)}::date`);return parts.length?` AND ${parts.join(' AND ')}`:'';};
  let sql:string;
  if(mode==='block')sql=`${permitted} SELECT b.block_id,b.body,p.id AS page_id,p.title,p.space_id,sp.name AS space_name,p.updated_at FROM hs_block_search b JOIN hs_pages p ON p.id=b.page_id JOIN permitted a ON a.id=p.id JOIN hs_spaces sp ON sp.id=p.space_id WHERE NOT EXISTS(SELECT 1 FROM hs_document_workflows w WHERE w.page_id=p.id) AND NOT b.ascii_only AND ($3::text IS NULL OR p.space_id=$3)${owned('p.owner_id')}${dated('p.updated_at')} AND b.block_id COLLATE "C">${cursor} COLLATE "C" ORDER BY b.block_id COLLATE "C" LIMIT 128`;
  else if(mode==='attachment')sql=`${permitted} SELECT a.media_id::text AS media_id,a.name,p.id AS page_id,p.title,p.space_id,sp.name AS space_name,p.updated_at FROM hs_attachment_search a JOIN hs_pages p ON p.id=a.page_id JOIN permitted perm ON perm.id=p.id JOIN hs_spaces sp ON sp.id=p.space_id WHERE a.active AND NOT a.ascii_only AND NOT EXISTS(SELECT 1 FROM hs_document_workflows w WHERE w.page_id=p.id) AND EXISTS(SELECT 1 FROM hs_blocks b WHERE b.page_id=p.id AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=a.media_id::text) AND ($3::text IS NULL OR p.space_id=$3)${owned('p.owner_id')}${dated('p.updated_at')} AND a.media_id::text COLLATE "C">${cursor} COLLATE "C" ORDER BY a.media_id::text COLLATE "C" LIMIT 128`;
  else sql=`${permitted} SELECT s.record_id::text AS record_id,s.tenant_id::text AS tenant_id,s.kind,s.field_key,s.source_id,s.title,s.body,s.collection,r.name AS record_name,r.updated_at FROM hs_record_search s JOIN hs_data_records r ON r.tenant_id=s.tenant_id AND r.id=s.record_id JOIN hs_data_workspaces w ON w.tenant_id=s.tenant_id AND w.workspace_id=$1 JOIN hs_members m ON m.workspace_id=w.workspace_id AND m.user_id=$2 AND m.active=true WHERE NOT s.ascii_only AND r.deleted_at IS NULL AND r.state<>'trashed' AND r.merged_into_id IS NULL AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$2 AND g.collection=r.collection AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$2 AND 'view'=ANY(g.capabilities))) AND hs_record_search_field_visible(s.tenant_id,r.collection,s.field_key,s.kind,$2) AND (s.kind<>'attachment' OR EXISTS(SELECT 1 FROM hs_media media JOIN permitted seen ON seen.id=media.page_id WHERE media.id::text=s.source_id AND media.state='ready' AND media.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hs_document_workflows wf WHERE wf.page_id=media.page_id))) AND s.kind=ANY(${add(recordKinds)}::text[]) ${input.collection?`AND r.collection=${add(input.collection)}`:''}${owned('r.created_by')}${dated('r.updated_at')} AND (s.record_id::text||':'||s.kind||':'||s.field_key||':'||s.source_id) COLLATE "C">${cursor} COLLATE "C" ORDER BY (s.record_id::text||':'||s.kind||':'||s.field_key||':'||s.source_id) COLLATE "C" LIMIT 128`;
  const rows=(await tx.query<Row>(sql,values)).rows;
  budget();
  for(const row of rows){
   examined++;
   if(mode==='block'&&includesParsed(row.body??'',parsed))push({id:`block:${row.block_id}`,kind:'block',title:row.title??'',spaceId:row.space_id??'',path:[row.space_name??'',row.title??''],preview:searchPreview(row.body??'',parsed),updatedAt:stamp(row.updated_at),match:'content',href:`/pages/${encodeURIComponent(row.page_id??'')}`});
   if(mode==='attachment'&&includesParsed(row.name??'',parsed))push({id:`attachment:${row.media_id}`,kind:'attachment',title:row.name??'',spaceId:row.space_id??'',path:[row.space_name??'',row.title??''],preview:searchPreview(row.name??'',parsed),updatedAt:stamp(row.updated_at),match:'attachment',href:`/pages/${encodeURIComponent(row.page_id??'')}`});
   if(mode==='record'){const hit=recordHit(row,input.workspaceId,parsed,input.query);if(hit)push(hit);}
  }
  if(rows.length<128)break;
  const last=rows.at(-1)!;
  after=mode==='block'?last.block_id??'':mode==='attachment'?String(last.media_id??''):`${last.record_id}:${last.kind}:${last.field_key}:${last.source_id}`;
 }
}
