import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordHistoryRepository} from '../../../../../../../../../../lib/shared-record-history';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};
const uuid=z.string().uuid();
const cursor=/^[A-Za-z0-9_-]{43}$/;
const preview=z.object({
  kind:z.literal('preview'),
  eventId:uuid,
  side:z.enum(['before','after']),
  fields:z.array(z.string().min(1).max(100)).min(1).max(100),
  expectedVersion:z.number().int().positive(),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.fields).size!==value.fields.length)ctx.addIssue({code:'custom',message:'Choose each field once.'});
});
const apply=z.object({
  kind:z.literal('apply'),
  previewId:uuid,
  reviewHash:z.string().regex(/^[a-f0-9]{64}$/),
  operationId:uuid,
  confirm:z.literal('restore-selected-values'),
}).strict();
const command=z.discriminatedUnion('kind',[preview,apply]);

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,recordId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const cursorValue=new URL(request.url).searchParams.get('cursor');
  if(cursorValue!==null&&!cursor.test(cursorValue))throw new DocumentError('The history page expired or belongs to another view. Reload the newest changes.','record_history_cursor',400);
  // No historical reference adapter is configured. Nonempty record and attachment values are omitted and cannot be restored.
  const repo=new SharedRecordHistoryRepository(await repository(),authority);
  return Response.json(await repo.listRecordHistory({actor,workspaceId,tenantId},recordId,cursorValue??undefined),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the historical selection.','record_history_selection',400);
  const {id:workspaceId,tenantId,recordId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordHistoryRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='preview'){const {kind:_,...input}=data;return Response.json(await repo.previewValueRestore(ctx,recordId,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.applyValueRestore(ctx,{...input,recordId}),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
