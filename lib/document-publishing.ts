import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Actor} from './auth';
import type {Sql} from './database';
import type {Repository} from './repository';
import {DocumentError,documentBlocks,stableStringify,validateDocument,type RichNode} from './document';
import {revisionDigest} from './revision';
import {bindPublicationThreads} from './discussion-visibility';
import {publicationWork,projectionSql,type ProjectionBudget} from './publication-projection';
import {ProjectedContent,cloneProjection} from './projection-content';

const hash=(v:unknown)=>createHash('sha256').update(stableStringify(v)).digest('hex');
const checkedHash=(v:unknown,work?:ProjectionBudget)=>{work?.check();const result=hash(v);work?.check();return result;};
const fail=(code='publication_conflict',status=409)=>new DocumentError('Publishing state changed or is unavailable. Refresh and review before retrying.',code,status);
const identity=z.string().min(1).max(200),version=z.number().int().positive();
const base={operationId:z.string().uuid(),expectedVersion:z.number().int().nonnegative()};
const blockId=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const referenceBinding=z.object({blockId,sourceBlockId:blockId}).strict();
type ReferenceBinding=z.infer<typeof referenceBinding>;
export const publishingCommand=z.discriminatedUnion('action',[
 z.object({...base,action:z.literal('configure'),reviewers:z.array(identity).min(1).max(20)}).strict(),
 z.object({...base,action:z.literal('submit'),sourceVersion:version,bindings:z.array(referenceBinding).max(100).optional()}).strict(),
 z.object({...base,action:z.enum(['approve','reject']),reviewId:z.string().uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(1000)}).strict(),
 z.object({...base,action:z.literal('publish'),reviewId:z.string().uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({...base,action:z.literal('withdraw'),reason:z.string().trim().min(1).max(1000)}).strict(),
]);
type Workflow={version:number;policy_version:number;reviewers:string[];publication_id:string|null};
type Pin={blockId:string;kind:'page'|'block'|'attachment';targetId:string;version:number|string;sourceBlockId?:string;title?:string;size?:number;mime?:string};
type Snapshot={title:string;document:RichNode;manifest:Pin[]};
type Review=Snapshot&{id:string;source_actor_id:string|null;reference_bindings:ReferenceBinding[];source_version:number;policy_version:number;submitted_by:string;snapshot_hash:string;state:'pending'|'approved'|'rejected';decided_by:string|null;decided_at:string|null;submitted_at:string;reason:string|null};
type Publication=Snapshot&{id:string;source_version:number;snapshot_hash:string;published_by:string;published_at:string};

async function workflow(tx:Sql,pageId:string){return (await tx.query<Workflow>('SELECT version,policy_version,reviewers,publication_id FROM hs_document_workflows WHERE page_id=$1',[pageId])).rows[0];}
async function reviewer(r:Repository,tx:Sql,pageId:string,actor:Actor,w:Workflow){
 if(!w.reviewers.includes(actor.id))throw fail('publication_reviewer_required',403);
 await r.access(tx,pageId,actor,true,true);
}
async function eligible(r:Repository,tx:Sql,pageId:string,reviewers:string[]){for(const id of reviewers)await r.access(tx,pageId,{id},true,true);}
function externalBlock(snapshot:Snapshot,id:string,work?:ProjectionBudget){
 const external=new Set(snapshot.manifest.filter(p=>p.kind==='page'||p.kind==='block').map(p=>p.blockId));
 let found=false,derived=false;
 function walk(n:RichNode,inherited=false){work?.check();const next=inherited||external.has(String(n.attrs?.id));if(n.attrs?.id===id){found=true;derived=next;}n.content?.forEach(child=>walk(child,next));}
 walk(snapshot.document);return !found||derived;
}
async function exactPublication(tx:Sql,pageId:string,id:string,work?:ProjectionBudget){
 work?.check();
 if(!z.string().uuid().safeParse(id).success)return null;
 const s=(await tx.query<Publication>('SELECT * FROM hs_document_publications WHERE id=$1 AND page_id=$2',[id,pageId])).rows[0];
 if(!s||checkedHash({title:s.title,document:s.document,manifest:s.manifest},work)!==s.snapshot_hash)return null;
 return s;
}
async function snapshot(r:Repository,tx:Sql,pageId:string,actor:Actor,sourceVersion:number,bindings:ReferenceBinding[]=[],work?:ProjectionBudget):Promise<Snapshot>{
 work?.check();
 const p=await r.access(tx,pageId,actor,true,true);
 if(p.version!==sourceVersion)throw fail();
 const revision=(await tx.query<{title:string;document:RichNode;content_hash:string|null}>('SELECT title,document,content_hash FROM hs_revisions WHERE page_id=$1 AND version=$2',[pageId,sourceVersion])).rows[0];
 if(!revision)throw fail();
 const document=validateDocument(revision.document);
 work?.check();if(!revision.content_hash||revisionDigest(revision.title,document)!==revision.content_hash)throw fail('publication_integrity');work?.check();
 const manifest:Pin[]=[];
 const resources=new ProjectedContent(work);resources.reserveTree(document);
 const replacements=new Map<string,RichNode>(),bindingMap=new Map(bindings.map(b=>[b.blockId,b.sourceBlockId]));
 if(bindingMap.size!==bindings.length)throw fail('publication_reference_validation',422);
 for(const binding of bindings)if(!documentBlocks(document).some(b=>b.id===binding.blockId&&b.type==='pageLink'))throw fail('publication_reference_validation',422);
 for(const b of documentBlocks(document)){
  work?.check();
  if(b.type==='pageLink'){
   const targetId=String(b.node.attrs?.pageId),target=await r.access(tx,targetId,actor,false,true);
   if(target.workspace_id!==p.workspace_id)throw fail('publication_reference_unavailable',422);
   // A reader of a governed source can pin only its published snapshot, never its draft.
   // Governed sources always resolve from an approved publication, including for source editors.
   const sourcePublication=await publishedDocument(r,tx,actor,targetId,work);
   let sourceDocument:RichNode,sourceTitle:string,resolvedVersion:number|string;
   if(sourcePublication){sourceDocument=sourcePublication.document;sourceTitle=sourcePublication.title;resolvedVersion=sourcePublication.publicationId;}
   else{
    const targetRevision=(await tx.query<{title:string;document:RichNode;content_hash:string|null}>('SELECT title,document,content_hash FROM hs_revisions WHERE page_id=$1 AND version=$2',[targetId,target.version])).rows[0];
    if(!targetRevision?.content_hash)throw fail('publication_reference_unavailable',422);
    sourceDocument=validateDocument(targetRevision.document);sourceTitle=targetRevision.title;resolvedVersion=target.version;
    if(revisionDigest(sourceTitle,sourceDocument)!==targetRevision.content_hash)throw fail('publication_reference_unavailable',422);
   }
   const sourceBlockId=bindingMap.get(b.id);
   if(sourceBlockId){
    // A bounded submission payload exercises pinning without adding live-block authoring or a catalogue.
    const source=documentBlocks(sourceDocument).find(n=>n.id===sourceBlockId)?.node;
    if(!source||!['paragraph','heading','codeBlock'].includes(source.type)||(source.content??[]).some(n=>!['text','hardBreak'].includes(n.type)))throw fail('publication_reference_unavailable',422);
    if(sourcePublication){const original=await exactPublication(tx,targetId,sourcePublication.publicationId,work);if(!original||externalBlock(original,sourceBlockId,work))throw fail('publication_transitive_reference',422);}
    const copy={...source,attrs:{...source.attrs,id:hash([b.id,sourceBlockId]).slice(0,40)}};
    const replacement:RichNode={type:'blockquote',attrs:{id:b.id},content:[copy]};
    resources.replace(b.node,replacement); // Reserve BEFORE retaining or cloning expanded source content.
    replacements.set(b.id,replacement);
    manifest.push({blockId:b.id,kind:'block',targetId,sourceBlockId,version:resolvedVersion,title:sourceTitle});continue;
   }
   manifest.push({blockId:b.id,kind:'page',targetId,version:resolvedVersion,title:sourceTitle});
  }else if(b.type==='image'||b.type==='file'){
   const targetId=String(b.node.attrs?.attachmentId),m=(await tx.query<{sha256:string|null;size:string;mime:string}>('SELECT sha256,size,mime FROM hs_media WHERE id=$1 AND page_id=$2 AND state=\'ready\' FOR UPDATE',[targetId,pageId])).rows[0];
   if(!m?.sha256)throw fail('publication_attachment_unavailable',422);
   manifest.push({blockId:b.id,kind:'attachment',targetId,version:m.sha256,size:Number(m.size),mime:m.mime});
  }
 }
 if(manifest.length>500||manifest.filter(p=>p.kind==='attachment').length>100||manifest.reduce((n,p)=>n+(p.size??0),0)>100_000_000)throw fail('publication_reference_limit',422);
 const resolved=cloneProjection(document,work,n=>replacements.get(String(n.attrs?.id))??n);work?.check();
 const normalized=validateDocument(resolved);work?.check();return {title:revision.title,document:normalized,manifest};
}
async function currentReview(r:Repository,tx:Sql,pageId:string,actor:Actor,id:string,w:Workflow,work?:ProjectionBudget){
 const row=(await tx.query<Review>('SELECT * FROM hs_document_reviews WHERE id=$1 AND page_id=$2 FOR UPDATE',[id,pageId])).rows[0];
 if(!row)throw fail('publication_review_unavailable',404);
 if(row.policy_version!==w.policy_version)throw fail('publication_policy_changed');
 const fresh=await snapshot(r,tx,pageId,actor,row.source_version,row.reference_bindings,work);
 if(checkedHash(fresh,work)!==row.snapshot_hash)throw fail('publication_snapshot_changed');
 return row;
}

/** No ACL or membership mutation. Workflow assignments never confer page access. */
export async function changePublishing(r:Repository,actor:Actor,pageId:string,input:unknown,work:ProjectionBudget=publicationWork()){
 work?.check();
 const parsed=publishingCommand.safeParse(input);if(!parsed.success)throw fail('publication_validation',400);
 const c=parsed.data,requestHash=hash(c);
 return r.db.transaction(async raw=>{
  const tx=projectionSql(raw,work);
  const p=await r.access(tx,pageId,actor,true,true),w=await workflow(tx,pageId);
  if(['configure','publish','withdraw'].includes(c.action)&&p.role!=='owner')throw fail('publication_owner_required',403);
  if(c.action==='approve'||c.action==='reject'){if(!w)throw fail();await reviewer(r,tx,pageId,actor,w);}
  const prior=(await tx.query<{actor_id:string;request_hash:string;result:unknown}>('SELECT actor_id,request_hash,result FROM hs_document_workflow_operations WHERE page_id=$1 AND operation_id=$2',[pageId,c.operationId])).rows[0];
  if(prior){if(prior.actor_id!==actor.id||prior.request_hash!==requestHash)throw fail('operation_mismatch');return {applied:prior.result,currentVersion:w?.version??0,replayed:true};}
  if((w?.version??0)!==c.expectedVersion)throw fail();
  const nextVersion=c.expectedVersion+1;let result:Record<string,unknown>={version:nextVersion};
  if(c.action==='configure'){
   if(new Set(c.reviewers).size!==c.reviewers.length)throw fail('publication_validation',400);
   await eligible(r,tx,pageId,c.reviewers);
   await tx.query('INSERT INTO hs_document_workflows(page_id,version,reviewers,policy_version) VALUES($1,$2,$3,$4) ON CONFLICT(page_id) DO UPDATE SET version=$2,reviewers=$3,policy_version=$4,updated_at=clock_timestamp()',[pageId,nextVersion,JSON.stringify(c.reviewers),(w?.policy_version??0)+1]);
  }else{
   if(!w)throw fail('publication_not_configured',404);
   if(c.action==='submit'){
    await eligible(r,tx,pageId,w.reviewers);
    if(!w.reviewers.some(id=>id!==actor.id))throw fail('publication_independent_review_required',422);
    const s=await snapshot(r,tx,pageId,actor,c.sourceVersion,c.bindings,work),id=randomUUID(),snapshotHash=checkedHash(s,work);
    const author=(await tx.query<{actor_id:string|null}>('SELECT actor_id FROM hs_revisions WHERE page_id=$1 AND version=$2',[pageId,c.sourceVersion])).rows[0]?.actor_id;
    if(!author)throw fail('publication_author_unavailable',422);
    await tx.query("INSERT INTO hs_document_reviews(id,page_id,source_version,policy_version,submitted_by,title,document,manifest,snapshot_hash,state,reference_bindings,source_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11)",[id,pageId,c.sourceVersion,w.policy_version,actor.id,s.title,JSON.stringify(s.document),JSON.stringify(s.manifest),snapshotHash,JSON.stringify(c.bindings??[]),author]);
    result={...result,reviewId:id,snapshotHash};
   }else if(c.action==='approve'||c.action==='reject'){
    const row=c.action==='approve'?await currentReview(r,tx,pageId,actor,c.reviewId,w,work):(await tx.query<Review>('SELECT * FROM hs_document_reviews WHERE id=$1 AND page_id=$2 FOR UPDATE',[c.reviewId,pageId])).rows[0];
    if(!row)throw fail('publication_review_unavailable',404);
    if(row.state!=='pending'||row.snapshot_hash!==c.snapshotHash||row.submitted_by===actor.id||!row.source_actor_id||row.source_actor_id===actor.id)throw fail('publication_independent_review_required',403);
    await tx.query('UPDATE hs_document_reviews SET state=$2,decided_by=$3,decided_at=clock_timestamp(),reason=$4 WHERE id=$1',[row.id,c.action==='approve'?'approved':'rejected',actor.id,c.reason]);
    result={...result,reviewId:row.id};
   }else if(c.action==='publish'){
    const row=await currentReview(r,tx,pageId,actor,c.reviewId,w,work);
    if(row.state!=='approved'||row.snapshot_hash!==c.snapshotHash||!row.decided_by||row.decided_by===row.submitted_by)throw fail('publication_approval_required',403);
    await reviewer(r,tx,pageId,{id:row.decided_by},w);
    if((await tx.query('SELECT id FROM hs_document_publications WHERE review_id=$1',[row.id])).rows.length)throw new DocumentError('This review was already published. Submit a new review before publishing again.','publication_already_published',409);
    const id=randomUUID();
    await tx.query('INSERT INTO hs_document_publications(id,page_id,review_id,source_version,title,document,manifest,snapshot_hash,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,pageId,row.id,row.source_version,row.title,JSON.stringify(row.document),JSON.stringify(row.manifest),row.snapshot_hash,actor.id]);
    await bindPublicationThreads(tx,pageId,id,row.document);
    await tx.query('UPDATE hs_document_workflows SET publication_id=$2 WHERE page_id=$1',[pageId,id]);result={...result,publicationId:id,sourceVersion:row.source_version};
   }else{
    await tx.query('UPDATE hs_document_workflows SET publication_id=NULL WHERE page_id=$1',[pageId]);
    result={...result,withdrawnPublicationId:w.publication_id};
   }
   await tx.query('UPDATE hs_document_workflows SET version=$2,updated_at=clock_timestamp() WHERE page_id=$1',[pageId,nextVersion]);
  }
  await tx.query('INSERT INTO hs_document_workflow_operations(page_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',[pageId,c.operationId,actor.id,requestHash,JSON.stringify(result)]);
  // Reasons belong to protected reviews; ordinary audit metadata contains no body or reference titles.
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,`publication.${c.action}`,pageId,JSON.stringify(result),c.operationId]);
  await r.access(tx,pageId,actor,true,true);
  work?.check();return {applied:result,currentVersion:nextVersion,replayed:false};
 });
}

export async function publishingState(r:Repository,actor:Actor,pageId:string){return r.db.transaction(async tx=>{
 const p=await r.access(tx,pageId,actor,true,true),w=await workflow(tx,pageId);
 const rows=await tx.query<Review>('SELECT * FROM hs_document_reviews WHERE page_id=$1 ORDER BY submitted_at DESC,id DESC LIMIT 50',[pageId]);
 const candidates:{id:string;name:string}[]=[];
 if(p.role==='owner'){
  const members=await tx.query<{id:string;name:string}>('SELECT u.id,u.name FROM hs_users u JOIN hs_members m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active=true ORDER BY u.name,u.id',[p.workspace_id]);
  for(const member of members.rows){try{await r.access(tx,pageId,{id:member.id},true);candidates.push(member);}catch(e){if(!(e instanceof DocumentError)||![403,404].includes(e.status))throw e;}}
 }
 const reviews=[];for(const row of rows.rows){const projection=await projectSnapshot(r,tx,actor,pageId,row);reviews.push({...row,...projection});}
 return {version:w?.version??0,reviewers:w?.reviewers??[],publicationId:w?.publication_id??null,canConfigure:p.role==='owner',canPublish:p.role==='owner',canReview:!!w?.reviewers.includes(actor.id),sourceVersion:p.version,candidates,reviews};
});}

/** Null means publishing was never enabled. A configured page without a publication fails closed. */
export async function publishedDocument(r:Repository,tx:Sql,actor:Actor,pageId:string,work?:ProjectionBudget){
 tx=projectionSql(tx,work);work?.check();
 const p=await r.access(tx,pageId,actor),w=await workflow(tx,pageId);if(!w)return null;
 if(!w.publication_id)throw fail('publication_unavailable',404);
 const s=(await tx.query<Publication>('SELECT * FROM hs_document_publications WHERE id=$1 AND page_id=$2',[w.publication_id,pageId])).rows[0];
 if(!s||checkedHash({title:s.title,document:s.document,manifest:s.manifest},work)!==s.snapshot_hash)throw fail('publication_integrity');
 return {publicationId:s.id,version:s.source_version,title:s.title,...await projectSnapshot(r,tx,actor,pageId,s,work),publishedAt:new Date(s.published_at).toISOString(),publishedBy:s.published_by};
}

async function projectSnapshot(r:Repository,tx:Sql,actor:Actor,pageId:string,s:Snapshot,work?:ProjectionBudget){
 tx=projectionSql(tx,work);work?.check();
 const p=await r.access(tx,pageId,actor),visible=new Map<string,Pin>();
 // Immutable source validation can be reused within this projection. Authority
 // is cached only under the search transaction's consistent-read budget.
 const exactSources=new Map<string,Publication|null>(),externalBlocks=new Map<string,boolean>();
 const sourceAuthority=new Map<string,{workspaceId:string;workflow:Workflow|undefined}|null>();
 for(const pin of s.manifest){
  work?.check();
  if(pin.kind==='page'||pin.kind==='block'){
   try{
    let authority=work?.consistentRead?sourceAuthority.get(pin.targetId):undefined;
    if(authority===undefined){const source=await r.access(tx,pin.targetId,actor);authority={workspaceId:source.workspace_id,workflow:await workflow(tx,pin.targetId)};if(work?.consistentRead)sourceAuthority.set(pin.targetId,authority);}
    if(!authority||authority.workspaceId!==p.workspace_id)continue;
    const sourceWorkflow=authority.workflow;
    if(typeof pin.version==='number'){
     // Earlier candidate snapshots could capture a governed source draft. Never expose those pins.
     if(sourceWorkflow)continue;
    }else{
     if(!sourceWorkflow?.publication_id)continue;
     const key=JSON.stringify([pin.targetId,pin.version]);
     if(!exactSources.has(key)){
      const next=await exactPublication(tx,pin.targetId,pin.version,work);
      // Retain only the most recent source, never up to500 source documents.
      exactSources.clear();exactSources.set(key,next);
     }
     const exact=exactSources.get(key);
     if(!exact)continue;
     if(pin.kind==='block'){
      if(!pin.sourceBlockId)continue;
      const blockKey=JSON.stringify([key,pin.sourceBlockId]);
      if(!externalBlocks.has(blockKey))externalBlocks.set(blockKey,externalBlock(exact,pin.sourceBlockId,work));
      if(externalBlocks.get(blockKey))continue;
     }
    }
    visible.set(pin.blockId,pin);
   }catch(e){if(!(e instanceof DocumentError)||![403,404].includes(e.status))throw e;if(work?.consistentRead)sourceAuthority.set(pin.targetId,null);}
  }else{
   const media=(await tx.query<{sha256:string;size:string;mime:string}>("SELECT sha256,size,mime FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready'",[pin.targetId,pageId])).rows[0];
   if(media&&media.sha256===pin.version&&Number(media.size)===pin.size&&media.mime===pin.mime)visible.set(pin.blockId,pin);
  }
 }
 await r.access(tx,pageId,actor);
 function render(n:RichNode):RichNode{
  work?.check();
  const bound=s.manifest.find(pin=>pin.kind==='block'&&pin.blockId===n.attrs?.id);
  if(bound&&!visible.has(bound.blockId))return {type:'paragraph',attrs:{id:n.attrs?.id},content:[{type:'text',text:'Restricted or unavailable source'}]};
  if(n.type==='pageLink'||n.type==='image'||n.type==='file'){
   const pin=visible.get(String(n.attrs?.id));
   if(n.type==='pageLink'||!pin)return {type:'paragraph',attrs:{id:n.attrs?.id},content:[{type:'text',text:pin?`${pin.title} (reviewed version ${pin.version})`:'Restricted or unavailable source'}]};
  }
  return n;
 }
 work?.check();const document=validateDocument(cloneProjection(s.document,work,render));work?.check();
 return {document,manifest:[...visible.values()]};
}
