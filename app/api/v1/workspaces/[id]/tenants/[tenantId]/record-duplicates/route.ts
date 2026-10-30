import {z} from 'zod';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {nativeRecordMergeRepository} from '../../../../../../../../lib/shared-record-merges';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const query=z.object({collection:z.string().min(1).max(100),name:z.string().min(1).max(200),email:z.string().email().max(320).optional(),domain:z.string().min(1).max(2000).optional(),excludeId:z.string().uuid().optional(),includeArchived:z.boolean()}).strict();

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const email=url.searchParams.get('email'),domain=url.searchParams.get('domain'),excludeId=url.searchParams.get('excludeId');
  const parsed=query.safeParse({collection:url.searchParams.get('collection')??'',name:url.searchParams.get('name')??'',...(email?{email}:{}),...(domain?{domain}:{}),...(excludeId?{excludeId}:{}),includeArchived:url.searchParams.get('includeArchived')==='1'});
  if(!parsed.success)throw new DocumentError('Invalid duplicate query.','record_validation',400);
  const repo=nativeRecordMergeRepository(await repository(),authority);
  return Response.json(await repo.duplicateSuggestions({actor,workspaceId,tenantId},parsed.data),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
