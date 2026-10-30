import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordPermissionRepository,recordPermissionCommand} from '../../../../../../../../lib/shared-record-permissions';

const uuid=z.string().uuid();
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const query=z.object({collection:z.string().min(1).max(100),recordId:uuid.optional(),manage:z.literal('1').optional()}).strict().safeParse({collection:url.searchParams.get('collection')??'',...(url.searchParams.get('recordId')?{recordId:url.searchParams.get('recordId')}:{}),...(url.searchParams.get('manage')?{manage:url.searchParams.get('manage')}:{})});
  if(!query.success)throw new DocumentError('Review the permission request.','record_permission_validation',400);
  const repo=new SharedRecordPermissionRepository(await repository(),authority),ctx={actor,workspaceId,tenantId};
  const result=query.data.manage==='1'?await repo.readMatrix(ctx,query.data.collection,query.data.recordId):await repo.describe(ctx,query.data.collection,query.data.recordId);
  return Response.json(result,{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),parsed=recordPermissionCommand.safeParse(await readJson(request,64_000));
  if(!parsed.success||!parsed.data.collectionGrant&&!parsed.data.recordGrant&&!parsed.data.fields?.length)throw new DocumentError('Review the permission change.','record_permission_validation',400);
  const repo=new SharedRecordPermissionRepository(await repository(),authority);
  return Response.json(await repo.apply({actor,workspaceId,tenantId},parsed.data),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
