import type {Actor} from './auth';
import type {Sql} from './database';
import {canEdit,type PageRole} from './types';
import {DocumentError} from './document';
import {createSearchWork} from './search-work';

export type ProjectionBudget={check():void;consistentRead?:boolean;contentLimits?:{bytes?:number;blocks?:number};remainingMs?():number};
export function publicationWork(signal?:AbortSignal):ProjectionBudget{
 const entered=performance.now(),base=createSearchWork(5000,signal);
 return {check(){try{base.check();}catch(error){if(error instanceof DocumentError&&error.code==='search_busy')throw new DocumentError('Publishing is temporarily busy. Refresh and retry the same operation.','publication_busy',503);throw error;}},remainingMs:()=>Math.max(1,Math.floor(5000-(performance.now()-entered)))};
}
// Keep checks on both sides of every awaited query, including nested projection
// reads. An expired request cannot continue hashing/rendering or return partial data.
export function projectionSql(tx:Sql,work?:ProjectionBudget):Sql{
 if(!work)return tx;
 return {query:async<T>(sql:string,values?:unknown[])=>{
  work.check();if(work.remainingMs){await tx.query("SELECT set_config('statement_timeout',$1,true)",[work.remainingMs()+'ms']);work.check();}
  try{const result=await tx.query<T>(sql,values);work.check();return result;}
  catch(error){if(work.remainingMs&&(error as {code?:string}).code==='57014')throw new DocumentError('Publishing is temporarily busy. Refresh and retry the same operation.','publication_busy',503);throw error;}
 }};
}
// This narrow governed-draft clamp is independent of the separately owned native
// authority hotfix. Raw ownership and retained grants never bypass Observer.
export async function governedAuthoringAllowed(tx:Sql,actor:Actor,page:{workspace_id:string;role:PageRole}){
 if(!canEdit(page.role))return false;
 const member=(await tx.query<{role:string}>('SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true',[page.workspace_id,actor.id])).rows[0];
 return !!member&&member.role!=='observer';
}
