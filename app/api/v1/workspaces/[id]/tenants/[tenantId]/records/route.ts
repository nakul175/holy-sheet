import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordRepository} from '../../../../../../../../lib/shared-records';

const uuid=z.string().uuid();
const create=z.object({kind:z.literal('create'),operationId:uuid,collection:z.string().min(1).max(100),name:z.string(),schemaVersion:z.number().int().positive(),values:z.record(z.string(),z.unknown()).default({}),parentOrganisationId:uuid.optional(),legalOrganisationIds:z.array(uuid).min(1).max(100).optional(),accountIds:z.array(uuid).max(100).optional()}).strict();
type Context={params:Promise<{id:string;tenantId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),url=new URL(request.url),collection=url.searchParams.get('collection')??'';
  const repo=new SharedRecordRepository(await repository(),authority);
  return response(await repo.list({actor,workspaceId,tenantId},{collection,query:url.searchParams.get('query')??'',cursor:url.searchParams.get('cursor')??undefined,includeArchived:url.searchParams.get('includeArchived')==='1'}));
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request),parsed=create.safeParse(await readJson(request,128_000));
  if(!parsed.success)throw new DocumentError('Invalid record creation request.','record_validation',400);
  const {kind:_,...input}=parsed.data,repo=new SharedRecordRepository(await repository(),authority);
  return response(await repo.create({actor,workspaceId,tenantId},input));
 }catch(error){return failure(error);}
}

function response(value:unknown){return Response.json(value,{headers:{'Cache-Control':'no-store','Vary':'Cookie, Authorization'}});}
function failure(error:unknown){if(error instanceof DocumentError)return responseError(error.message,error.code,error.status);return responseError('Service temporarily unavailable.','service_unavailable',503);}
function responseError(message:string,code:string,status:number){return Response.json({error:message,code,retryable:status>=500},{status,headers:{'Cache-Control':'no-store','Vary':'Cookie, Authorization'}});}
