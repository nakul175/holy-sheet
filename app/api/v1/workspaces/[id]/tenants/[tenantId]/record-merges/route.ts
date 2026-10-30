import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {nativeRecordMergeRepository} from '../../../../../../../../lib/shared-record-merges';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const id=z.string().uuid(),side=z.enum(['source','survivor']);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const preview=z.object({kind:z.literal('preview'),sourceId:id,survivorId:id,sourceVersion:z.number().int().positive(),survivorVersion:z.number().int().positive(),nameFrom:side,fieldFrom:z.record(z.string(),side).default({}),relationshipFrom:z.record(z.string(),side).default({}),parentFrom:side.optional()}).strict();
const apply=z.object({kind:z.literal('apply'),operationId:id,previewId:id,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.literal('merge-and-retain-source-history')}).strict();
const command=z.discriminatedUnion('kind',[preview,apply]);

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the merge selections.','record_merge_validation',400);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=nativeRecordMergeRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='preview'){const {kind:_,...input}=data;return Response.json(await repo.previewMerge(ctx,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.applyMerge(ctx,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
