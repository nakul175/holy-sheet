import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordCommentsRepository} from '../../../../../../../../../../lib/shared-record-comments';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};
const uuid=z.string().uuid();
const command=z.object({operationId:uuid,body:z.string().max(10000),mentionIds:z.array(z.string().min(1).max(200)).max(50)}).strict();
const query=z.object({q:z.string().max(80).optional()}).strict();

export async function GET(request:Request,c:Context){
 try{
  const url=new URL(request.url);
  const parsed=query.safeParse(Object.fromEntries(url.searchParams));
  if(!parsed.success)throw new DocumentError('Review the comment request.','record_comment_validation',400);
  const {repo,ctx,recordId}=await open(request,c);
  const result=parsed.data.q===undefined?await repo.listComments(ctx,recordId):await repo.mentionPeople(ctx,recordId,parsed.data.q);
  return Response.json(result,{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,c:Context){
 try{
  sameOrigin(request);
  const {repo,ctx,recordId}=await open(request,c);
  const parsed=command.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Review the comment and try again.','record_comment_validation',400);
  return Response.json(await repo.createComment(ctx,recordId,parsed.data),{headers});
 }catch(error){return failure(error);}
}

async function open(request:Request,c:Context){
 const {actor,authority}=await authenticateRecordAuthority(request);
 const {id:workspaceId,tenantId,recordId}=await c.params;
 return {repo:new SharedRecordCommentsRepository(await repository(),authority),ctx:{actor,workspaceId,tenantId},recordId};
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 console.error('HS record comment request failed',error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
