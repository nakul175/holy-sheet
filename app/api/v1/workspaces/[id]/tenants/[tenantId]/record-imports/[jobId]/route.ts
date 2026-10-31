import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../lib/repository';
import {recordImportMapping} from '../../../../../../../../../lib/shared-record-import-values';
import {SharedRecordImportRepository} from '../../../../../../../../../lib/shared-record-imports';
import {authenticateRecordAuthority} from '../../../../../../../../../lib/suite-tenant-authority';

export const maxDuration=30;
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;jobId:string}>};
const version=z.number().int().positive();
const configure=z.object({kind:z.literal('configure'),expectedVersion:version,mapping:recordImportMapping}).strict();
const review=z.object({kind:z.literal('review'),expectedVersion:version}).strict();
const commit=z.object({kind:z.literal('commit'),id:z.string().uuid(),expectedVersion:version,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),confirm:z.enum(['create-records','update-records']),allowValidSubset:z.boolean(),allowDuplicates:z.boolean(),acknowledgeWarnings:z.boolean()}).strict();
const cancel=z.object({kind:z.literal('cancel'),expectedVersion:version}).strict();
const command=z.discriminatedUnion('kind',[configure,review,commit,cancel]);

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const raw=url.searchParams.get('offset');
  const offset=raw===null?0:Number(raw);
  if(!Number.isSafeInteger(offset))throw new DocumentError('Invalid preview page.','record_import_validation',400);
  const repo=new SharedRecordImportRepository(await repository(),authority);
  return Response.json(await repo.getImport({actor,workspaceId,tenantId},jobId,offset),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the import request.','record_import_validation',400);
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordImportRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='configure')return Response.json(await repo.configureImport(ctx,jobId,{expectedVersion:data.expectedVersion,mapping:data.mapping}),{headers});
  if(data.kind==='review')return Response.json(await repo.reviewImportBatch(ctx,jobId,{expectedVersion:data.expectedVersion}),{headers});
  if(data.kind==='cancel')return Response.json(await repo.cancelImport(ctx,jobId,data.expectedVersion),{headers});
  const {kind:_,...input}=data;
  return Response.json(await repo.commitImportBatch(ctx,jobId,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
