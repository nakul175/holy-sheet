import {createHash,randomUUID} from 'node:crypto';
import {Step} from '@tiptap/pm/transform';
import type {Actor} from './auth';
import {DocumentError,documentBlocks,stableStringify,validateDocument,type RichNode} from './document';
import {richSchema} from './rich-schema';
import type {Repository} from './repository';
import type {Sql} from './database';

type PageState={page_id:string;epoch:string;step_version:number;document_version:number;document:RichNode};
type Session={id:string;page_id:string;epoch:string;actor_id:string;client_id:string;active:boolean;expires_at:string};
export type PresenceInput={anchorBlockId?:string|null;anchorOffset?:number|null;headBlockId?:string|null;headOffset?:number|null};
export type SubmitInput={sessionId:string;epoch:string;clientId:string;operationId:string;baseStepVersion:number;steps:unknown[]};
const digest=(value:unknown)=>createHash('sha256').update(stableStringify(value)).digest('hex');
const unavailable=()=>new DocumentError('The collaboration session changed. Reopen this page.','collaboration_stale',409);

function identities(document:RichNode){return new Map(documentBlocks(document).map(block=>[block.id,block.type]));}
function protectedAtoms(document:RichNode){const schema=richSchema();return documentBlocks(document).filter(block=>['image','file','pageLink'].includes(block.type)).map(block=>stableStringify(schema.nodeFromJSON(block.node).toJSON())).sort();}
async function reset(tx:Sql,pageId:string,documentVersion:number,document:RichNode){
 const epoch=randomUUID();
 await tx.query('DELETE FROM hs_collaboration_presence WHERE session_id IN (SELECT id FROM hs_collaboration_sessions WHERE page_id=$1)',[pageId]);
 await tx.query('DELETE FROM hs_collaboration_sessions WHERE page_id=$1',[pageId]);
 await tx.query('DELETE FROM hs_collaboration_steps WHERE page_id=$1',[pageId]);
 await tx.query('DELETE FROM hs_collaboration_batches WHERE page_id=$1',[pageId]);
 // A history restore is an explicit new authority epoch and may intentionally restore old IDs.
 await tx.query('DELETE FROM hs_collaboration_tombstones WHERE page_id=$1',[pageId]);
 await tx.query(`INSERT INTO hs_collaboration_pages(page_id,epoch,step_version,document_version,document)
  VALUES($1,$2,0,$3,$4) ON CONFLICT(page_id) DO UPDATE SET epoch=excluded.epoch,step_version=0,document_version=excluded.document_version,document=excluded.document,updated_at=clock_timestamp()`,[pageId,epoch,documentVersion,JSON.stringify(document)]);
 return {page_id:pageId,epoch,step_version:0,document_version:documentVersion,document} satisfies PageState;
}
async function current(tx:Sql,r:Repository,actor:Actor,pageId:string,edit=true){
 const page=await r.access(tx,pageId,actor,edit,true),view=await r.get(pageId,actor,tx);
 let state=(await tx.query<PageState>('SELECT * FROM hs_collaboration_pages WHERE page_id=$1 FOR UPDATE',[pageId])).rows[0];
 if(!state||state.document_version!==page.version||stableStringify(state.document)!==stableStringify(view.document))state=await reset(tx,pageId,page.version,view.document);
 return {page,view,state};
}
async function session(tx:Sql,actor:Actor,pageId:string,input:{sessionId:string;epoch:string;clientId:string}){
 const found=(await tx.query<Session>(`SELECT * FROM hs_collaboration_sessions WHERE id=$1 AND page_id=$2 AND epoch=$3 AND actor_id=$4 AND client_id=$5 AND active=true AND expires_at>clock_timestamp() FOR UPDATE`,[input.sessionId,pageId,input.epoch,actor.id,input.clientId])).rows[0];
 if(!found)throw unavailable();
 await tx.query('UPDATE hs_collaboration_sessions SET last_seen=clock_timestamp() WHERE id=$1',[found.id]);return found;
}
async function presence(tx:Sql,pageId:string,epoch:string){
 return (await tx.query<{session_id:string;actor_id:string;name:string;client_id:string;anchor_block_id:string|null;anchor_offset:number|null;head_block_id:string|null;head_offset:number|null}>(`SELECT s.id AS session_id,s.actor_id,u.name,s.client_id,p.anchor_block_id,p.anchor_offset,p.head_block_id,p.head_offset
  FROM hs_collaboration_sessions s JOIN hs_users u ON u.id=s.actor_id LEFT JOIN hs_collaboration_presence p ON p.session_id=s.id
  WHERE s.page_id=$1 AND s.epoch=$2 AND s.active=true AND s.expires_at>clock_timestamp() AND s.last_seen>clock_timestamp()-interval '30 seconds' ORDER BY s.actor_id,s.client_id`,[pageId,epoch])).rows.map(row=>({sessionId:row.session_id,actorId:row.actor_id,name:row.name,clientId:row.client_id,anchorBlockId:row.anchor_block_id,anchorOffset:row.anchor_offset,headBlockId:row.head_block_id,headOffset:row.head_offset}));
}
async function stepsAfter(tx:Sql,pageId:string,epoch:string,version:number){
 const rows=(await tx.query<{step_version:number;step:unknown;actor_id:string;client_id:string;operation_id:string}>(`SELECT step_version,step,actor_id,client_id,operation_id FROM hs_collaboration_steps WHERE page_id=$1 AND epoch=$2 AND step_version>$3 ORDER BY step_version LIMIT 101`,[pageId,epoch,version])).rows;
 if(rows.length>100)throw new DocumentError('Too many collaboration changes are pending. Reload the current page.','collaboration_reload_required',409);
 return rows.map(row=>({version:row.step_version,step:row.step,actorId:row.actor_id,clientId:row.client_id,operationId:row.operation_id}));
}

export async function beginCollaboration(r:Repository,actor:Actor,pageId:string,clientId:string){return r.db.transaction(async tx=>{
 const {view,state}=await current(tx,r,actor,pageId,true),id=randomUUID();
 const prior=(await tx.query<{id:string}>('SELECT id FROM hs_collaboration_sessions WHERE page_id=$1 AND epoch=$2 AND actor_id=$3 AND client_id=$4',[pageId,state.epoch,actor.id,clientId])).rows[0];
 if(prior)await tx.query("UPDATE hs_collaboration_sessions SET active=true,last_seen=clock_timestamp(),expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[prior.id]);
 else await tx.query('INSERT INTO hs_collaboration_sessions(id,page_id,epoch,actor_id,client_id) VALUES($1,$2,$3,$4,$5)',[id,pageId,state.epoch,actor.id,clientId]);
 const sessionId=prior?.id??id;return {sessionId,epoch:state.epoch,stepVersion:state.step_version,pageVersion:state.document_version,document:view.document,collaborators:await presence(tx,pageId,state.epoch)};
});}

export async function pullCollaboration(r:Repository,actor:Actor,pageId:string,input:{sessionId:string;epoch:string;clientId:string;afterVersion:number}){return r.db.transaction(async tx=>{
 const {state}=await current(tx,r,actor,pageId,true);if(state.epoch!==input.epoch)throw unavailable();await session(tx,actor,pageId,input);
 if(input.afterVersion<0||input.afterVersion>state.step_version)throw unavailable();
 return {epoch:state.epoch,stepVersion:state.step_version,pageVersion:state.document_version,steps:await stepsAfter(tx,pageId,state.epoch,input.afterVersion),collaborators:await presence(tx,pageId,state.epoch)};
});}

export async function submitCollaboration(r:Repository,actor:Actor,pageId:string,input:SubmitInput){return r.db.transaction(async tx=>{
 const {page,state}=await current(tx,r,actor,pageId,true);if(state.epoch!==input.epoch)throw unavailable();await session(tx,actor,pageId,input);
 const hash=digest(input),prior=(await tx.query<{request_hash:string;last_step_version:number;document_version:number}>('SELECT request_hash,last_step_version,document_version FROM hs_collaboration_batches WHERE page_id=$1 AND operation_id=$2',[pageId,input.operationId])).rows[0];
 if(prior){if(prior.request_hash!==hash)throw new DocumentError('Operation ID was reused with different collaboration steps.','operation_mismatch',409);return {epoch:state.epoch,stepVersion:prior.last_step_version,pageVersion:prior.document_version,replayed:true,steps:await stepsAfter(tx,pageId,state.epoch,input.baseStepVersion)};}
 if(input.baseStepVersion!==state.step_version)throw new DocumentError('New collaboration changes are available. Receive and rebase them first.','collaboration_out_of_date',409);
 if(!input.steps.length||input.steps.length>100||Buffer.byteLength(JSON.stringify(input.steps))>256_000)throw new DocumentError('Send between 1 and 100 bounded collaboration steps.','collaboration_steps_invalid',422);
 const schema=richSchema();let document=schema.nodeFromJSON(state.document);const decoded:Step[]=[];
 try{for(const raw of input.steps){const step=Step.fromJSON(schema,raw),result=step.apply(document);if(result.failed||!result.doc)throw new Error('step rejected');document=result.doc;decoded.push(step);}}catch{throw new DocumentError('The collaboration change cannot be applied to this page.','collaboration_steps_invalid',422);}
 const next=validateDocument(document.toJSON()),before=identities(state.document),after=identities(next),removed=[...before.keys()].filter(id=>!after.has(id));
 for(const [id,type] of after){if(before.has(id)&&before.get(id)!==type)throw new DocumentError('Stable block identity cannot change type.','collaboration_identity_invalid',422);}
 if(stableStringify(protectedAtoms(state.document))!==stableStringify(protectedAtoms(next)))throw new DocumentError('Add or remove protected files and page links outside a collaboration session.','collaboration_protected_atom',422);
 if(after.size){const reused=await tx.query<{block_id:string}>('SELECT block_id FROM hs_collaboration_tombstones WHERE page_id=$1 AND block_id=ANY($2::text[])',[pageId,[...after.keys()]]);if(reused.rows.length)throw new DocumentError('A deleted block identity cannot be revived.','collaboration_resurrection',409);}
 const nextPageVersion=page.version+1,first=state.step_version+1,last=state.step_version+decoded.length;
 await r.writeDocument(tx,pageId,next,nextPageVersion,page.title,actor.id,'collaboration');
 await tx.query('UPDATE hs_pages SET version=$2,updated_at=clock_timestamp() WHERE id=$1',[pageId,nextPageVersion]);
 await tx.query('INSERT INTO hs_collaboration_batches(page_id,epoch,operation_id,actor_id,client_id,request_hash,base_step_version,first_step_version,last_step_version,document_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[pageId,state.epoch,input.operationId,actor.id,input.clientId,hash,input.baseStepVersion,first,last,nextPageVersion]);
 for(let i=0;i<input.steps.length;i++)await tx.query('INSERT INTO hs_collaboration_steps(page_id,epoch,step_version,operation_id,actor_id,client_id,step) VALUES($1,$2,$3,$4,$5,$6,$7)',[pageId,state.epoch,first+i,input.operationId,actor.id,input.clientId,JSON.stringify(input.steps[i])]);
 for(const id of removed)await tx.query('INSERT INTO hs_collaboration_tombstones(page_id,block_id,removed_epoch,removed_step_version) VALUES($1,$2,$3,$4) ON CONFLICT(page_id,block_id) DO NOTHING',[pageId,id,state.epoch,last]);
 await tx.query('UPDATE hs_collaboration_pages SET step_version=$2,document_version=$3,document=$4,updated_at=clock_timestamp() WHERE page_id=$1',[pageId,last,nextPageVersion,JSON.stringify(next)]);
 await tx.query('INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),actor.id,'collaboration.batch',pageId,JSON.stringify({epoch:state.epoch,firstStepVersion:first,lastStepVersion:last,pageVersion:nextPageVersion,stepCount:decoded.length}),input.operationId]);
 return {epoch:state.epoch,stepVersion:last,pageVersion:nextPageVersion,replayed:false,steps:await stepsAfter(tx,pageId,state.epoch,input.baseStepVersion)};
});}

export async function updateCollaborationPresence(r:Repository,actor:Actor,pageId:string,input:{sessionId:string;epoch:string;clientId:string;presence:PresenceInput}){return r.db.transaction(async tx=>{
 const {state}=await current(tx,r,actor,pageId,true);if(state.epoch!==input.epoch)throw unavailable();const s=await session(tx,actor,pageId,input),ids=identities(state.document),p=input.presence;
 for(const id of [p.anchorBlockId,p.headBlockId])if(id!=null&&!ids.has(id))throw new DocumentError('Presence must refer to a current block.','collaboration_presence_invalid',422);
 for(const offset of [p.anchorOffset,p.headOffset])if(offset!=null&&(!Number.isSafeInteger(offset)||offset<0||offset>1_000_000))throw new DocumentError('Presence offset is invalid.','collaboration_presence_invalid',422);
 await tx.query(`INSERT INTO hs_collaboration_presence(session_id,anchor_block_id,anchor_offset,head_block_id,head_offset) VALUES($1,$2,$3,$4,$5)
  ON CONFLICT(session_id) DO UPDATE SET anchor_block_id=excluded.anchor_block_id,anchor_offset=excluded.anchor_offset,head_block_id=excluded.head_block_id,head_offset=excluded.head_offset,updated_at=clock_timestamp()`,[s.id,p.anchorBlockId??null,p.anchorOffset??null,p.headBlockId??null,p.headOffset??null]);
 return {collaborators:await presence(tx,pageId,state.epoch)};
});}

export async function leaveCollaboration(r:Repository,actor:Actor,pageId:string,input:{sessionId:string;epoch:string;clientId:string}){return r.db.transaction(async tx=>{
 await r.access(tx,pageId,actor,false,true);const s=await session(tx,actor,pageId,input);await tx.query('UPDATE hs_collaboration_sessions SET active=false,last_seen=clock_timestamp() WHERE id=$1',[s.id]);await tx.query('DELETE FROM hs_collaboration_presence WHERE session_id=$1',[s.id]);return {left:true};
});}
