import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordLifecycleRepository} from '../../../../../../../../../../lib/shared-record-lifecycle';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const id=z.string().uuid();
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};
const archive=z.object({kind:z.literal('archive'),operationId:id,expectedVersion:z.number().int().positive(),archived:z.boolean()}).strict();
const preview=z.object({kind:z.literal('preview-delete'),expectedVersion:z.number().int().positive()}).strict();
const trash=z.object({kind:z.literal('trash'),operationId:id,previewId:id,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal('move-to-tenant-trash')}).strict();
const restore=z.object({kind:z.literal('restore'),operationId:id,expectedVersion:z.number().int().positive()}).strict();
const command=z.discriminatedUnion('kind',[archive,preview,trash,restore]);

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,16_000));
  if(!parsed.success)throw new DocumentError('Review the record lifecycle request.','record_validation',400);
  const {id:workspaceId,tenantId,recordId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordLifecycleRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='archive'){const {kind:_,...input}=data;return Response.json(await repo.archiveRecord(ctx,recordId,input),{headers});}
  if(data.kind==='preview-delete')return Response.json(await repo.previewDelete(ctx,recordId,data.expectedVersion),{headers});
  if(data.kind==='trash'){const {kind:_,...input}=data;return Response.json(await repo.trashRecord(ctx,recordId,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.restoreRecord(ctx,recordId,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
