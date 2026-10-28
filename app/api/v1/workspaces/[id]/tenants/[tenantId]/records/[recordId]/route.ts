import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordRepository} from '../../../../../../../../../lib/shared-records';

const uuid=z.string().uuid(),update=z.object({operationId:uuid,expectedVersion:z.number().int().positive(),schemaVersion:z.number().int().positive(),name:z.string().optional(),values:z.record(z.string(),z.unknown()).optional()}).strict();
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};

export async function GET(request:Request,{params}:Context){return handle(request,params,async(repo,ctx,recordId)=>repo.get(ctx,recordId));}
export async function PATCH(request:Request,{params}:Context){
 try{sameOrigin(request);const parsed=update.safeParse(await readJson(request,128_000));if(!parsed.success)throw new DocumentError('Invalid record update.','record_validation',400);return handle(request,params,async(repo,ctx,recordId)=>repo.update(ctx,recordId,parsed.data));}catch(error){return failure(error);}
}
async function handle(request:Request,params:Context['params'],action:(repo:SharedRecordRepository,ctx:{actor:{id:string};workspaceId:string;tenantId:string},recordId:string)=>Promise<unknown>){try{const {id:workspaceId,tenantId,recordId}=await params,{actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordRepository(await repository(),authority);return response(await action(repo,{actor,workspaceId,tenantId},recordId));}catch(error){return failure(error);}}
function response(value:unknown){return Response.json(value,{headers:{'Cache-Control':'no-store','Vary':'Cookie, Authorization'}});}
function failure(error:unknown){if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers:{'Cache-Control':'no-store','Vary':'Cookie, Authorization'}});return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers:{'Cache-Control':'no-store','Vary':'Cookie, Authorization'}});}
