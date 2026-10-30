import {z} from 'zod';
import {DocumentError} from '../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../lib/repository';
import {SharedRecordViewRepository} from '../../../../../../../../../lib/shared-record-views';
import {authenticateRecordAuthority} from '../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;viewId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!z.string().uuid().safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const url=new URL(request.url),cursor=url.searchParams.get('cursor')??undefined;
  if(cursor!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw new DocumentError('Invalid view cursor.','record_view_cursor_invalid',400);
  const {actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordViewRepository(await repository(),authority);
  return Response.json(await repo.queryView({actor,workspaceId,tenantId},viewId,cursor),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
