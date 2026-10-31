import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../lib/repository';
import {SharedRecordExportRepository} from '../../../../../../../../../lib/shared-record-exports';
import {authenticateRecordAuthority} from '../../../../../../../../../lib/suite-tenant-authority';

export const maxDuration=30;
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;jobId:string}>};
const cancel=z.object({kind:z.literal('cancel')}).strict();

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordExportRepository(await repository(),authority);
  return Response.json(await repo.getRecordExport({actor,workspaceId,tenantId},jobId),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=cancel.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the record export request.','record_export_validation',400);
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordExportRepository(await repository(),authority);
  return Response.json(await repo.cancelRecordExport({actor,workspaceId,tenantId},jobId),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
