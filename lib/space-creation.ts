import {createHash} from 'node:crypto';
import type {Actor} from './auth';
import {Repository} from './repository';
import {DocumentError,stableStringify} from './document';

export async function createSpaceIntent(r:Repository,actor:Actor,name:string,workspaceId:string,operationId:string){
 const requestHash=createHash('sha256').update(stableStringify({name,workspaceId})).digest('hex');
 return r.db.transaction(async tx=>{
  await tx.query('SELECT id FROM hs_users WHERE id=$1 FOR NO KEY UPDATE',[actor.id]);
  // Bind ordinary repository checks to this transaction: creation and its
  // acknowledgement must commit together, without duplicating role policy.
  const bound=new Repository({query:tx.query.bind(tx),transaction:fn=>fn(tx),close:async()=>{}});
  const prior=await tx.query<{space_id:string|null;request_hash:string}>('SELECT space_id,request_hash FROM hs_space_creations WHERE actor_id=$1 AND operation_id=$2',[actor.id,operationId]);
  if(prior.rows.length){
   if(prior.rows[0].request_hash!==requestHash)throw new DocumentError('Creation attempt was reused with different fields','operation_mismatch',409);
   const space=prior.rows[0].space_id&&(await bound.spaces(actor)).find(s=>s.id===prior.rows[0].space_id&&s.workspaceId===workspaceId);
   if(!space)throw new DocumentError('Space unavailable','not_found',404);
   return space;
  }
  const space=await bound.createSpace(actor,name,workspaceId);
  await tx.query('INSERT INTO hs_space_creations(actor_id,operation_id,space_id,request_hash) VALUES($1,$2,$3,$4)',[actor.id,operationId,space.id,requestHash]);
  return space;
 });
}
