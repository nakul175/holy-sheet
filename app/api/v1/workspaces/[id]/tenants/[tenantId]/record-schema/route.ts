import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {recordFieldDefinition,SharedRecordSchemaRepository} from '../../../../../../../../lib/shared-record-schema';

const id=z.string().uuid();
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const preview=z.object({kind:z.literal('preview'),prepareId:id,collection:z.string().min(1).max(100),fieldKey:id.optional(),expectedSchemaVersion:z.number().int().positive(),definition:recordFieldDefinition}).strict();
const apply=z.object({kind:z.literal('apply'),previewId:id,operationId:id,reviewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const command=z.discriminatedUnion('kind',[preview,apply]);

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url);
  const query=z.object({collection:z.string().min(1).max(100)}).strict().safeParse({collection:url.searchParams.get('collection')??''});
  if(!query.success)throw new DocumentError('Review the schema request.','record_schema_validation',400);
  const repo=new SharedRecordSchemaRepository(await repository(),authority);
  return Response.json(await repo.describeSchema({actor,workspaceId,tenantId},query.data.collection),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,c:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,128_000));
  if(!parsed.success)throw new DocumentError('Invalid schema request.','record_schema_validation',400);
  const {id:workspaceId,tenantId}=await c.params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordSchemaRepository(await repository(),authority),ctx={actor,workspaceId,tenantId},data=parsed.data;
  if(data.kind==='preview'){const {kind:_,...input}=data;return Response.json(await repo.previewSchema(ctx,input),{headers});}
  const {kind:_,...input}=data;
  return Response.json(await repo.applySchema(ctx,input),{headers});
 }catch(e){return failure(e);}
}

function failure(e:unknown){
 if(e instanceof DocumentError)return Response.json({error:e.message,code:e.code,retryable:e.status>=500},{status:e.status,headers});
 return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
}
