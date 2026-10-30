import {z} from 'zod';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {SharedRecordLifecycleRepository} from '../../../../../../../../lib/shared-record-lifecycle';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const query=z.object({collection:z.string().min(1).max(100),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()}).strict().safeParse({collection:url.searchParams.get('collection')??'',...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')??''}:{})});
  if(!query.success)throw new DocumentError('Invalid tenant Trash query.','record_validation',400);
  const repo=new SharedRecordLifecycleRepository(await repository(),authority);
  return Response.json(await repo.listTrash({actor,workspaceId,tenantId},query.data.collection,query.data.cursor),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
