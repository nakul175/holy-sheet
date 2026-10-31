import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {SharedRecordCollectionRepository} from '../../../../../../../../lib/shared-record-collections';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const id=z.string().uuid();
const proposal=z.object({
 id,
 name:z.string().min(1).max(100),
 description:z.string().max(2000).default(''),
 ownerId:z.string().min(1).max(200),
 expectedVersion:z.number().int().nonnegative(),
 expectedSchemaVersion:z.number().int().positive(),
 deprecated:z.boolean().default(false),
 initialFields:z.array(z.object({key:id,definition:z.unknown()}).strict()).max(100).default([]),
}).strict();
const review={previewId:id,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:id};
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('preview'),proposal}).strict(),
 z.object({kind:z.literal('apply'),...review,confirm:z.literal('save-custom-collection'),proposal}).strict(),
 z.object({kind:z.literal('preview-removal'),collection:id,expectedVersion:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('remove'),...review,confirm:z.literal('remove-empty-custom-collection')}).strict(),
]);

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const query=z.object({includeDeprecated:z.literal('1').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!query.success)throw new DocumentError('Invalid collection request.','record_collection_validation',400);
  // No owner-directory or dependency-inventory adapter. Another owner and every removal fail closed in the repository.
  const repo=new SharedRecordCollectionRepository(await repository(),authority);
  return Response.json(await repo.listCollections({actor,workspaceId,tenantId},query.data.includeDeprecated==='1'),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const parsed=command.safeParse(await readJson(request,128_000));
  if(!parsed.success)throw new DocumentError('Invalid collection request.','record_collection_validation',400);
  const repo=new SharedRecordCollectionRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='preview')return Response.json(await repo.previewCollection(ctx,data.proposal),{headers});
  if(data.kind==='preview-removal')return Response.json(await repo.previewCollectionRemoval(ctx,data.collection,data.expectedVersion),{headers});
  if(data.kind==='apply'){const {kind:_,...input}=data;return Response.json(await repo.applyCollection(ctx,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.removeCollection(ctx,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
}
