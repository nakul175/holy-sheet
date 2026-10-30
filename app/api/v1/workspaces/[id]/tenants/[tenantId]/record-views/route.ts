import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {recordViewDefinition} from '../../../../../../../../lib/shared-record-view-query';
import {SharedRecordViewRepository} from '../../../../../../../../lib/shared-record-views';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const id=z.string().uuid();
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const name=z.string().trim().min(1).max(100).refine(value=>!/[\p{Cc}]/u.test(value));
const save=z.object({kind:z.literal('save'),id,operationId:id,collection:z.string().min(1).max(100),scope:z.enum(['private','workspace']),name,expectedVersion:z.number().int().nonnegative(),definition:recordViewDefinition}).strict();
const remove=z.object({kind:z.literal('delete'),id,operationId:id,expectedVersion:z.number().int().positive()}).strict();
const command=z.discriminatedUnion('kind',[save,remove]);

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const query=z.object({collection:z.string().min(1).max(100)}).strict().safeParse({collection:url.searchParams.get('collection')??''});
  if(!query.success)throw new DocumentError('Review the view request.','record_view_validation',400);
  const repo=new SharedRecordViewRepository(await repository(),authority);
  return Response.json(await repo.listViews({actor,workspaceId,tenantId},query.data.collection),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the view definition.','record_view_validation',400);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordViewRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='delete'){const {kind:_,...input}=data;return Response.json(await repo.deleteView(ctx,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.saveView(ctx,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
