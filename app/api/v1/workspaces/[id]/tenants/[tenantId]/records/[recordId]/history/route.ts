import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordRepository} from '../../../../../../../../../../lib/shared-records';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,recordId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordRepository(await repository(),authority);
  return Response.json(await repo.history({actor,workspaceId,tenantId},recordId),{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
