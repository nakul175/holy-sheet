import {z} from 'zod';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordViewRepository} from '../../../../../../../../../../lib/shared-record-views';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;viewId:string}>};
const id=z.string().uuid();

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!id.safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordViewRepository(await repository(),authority);
  return Response.json(await repo.queryDashboard({actor,workspaceId,tenantId},viewId),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
