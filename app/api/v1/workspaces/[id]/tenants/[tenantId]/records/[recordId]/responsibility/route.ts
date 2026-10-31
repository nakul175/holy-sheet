import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordResponsibilityRepository} from '../../../../../../../../../../lib/shared-record-responsibility';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};
const uuid=z.string().uuid();
const query=z.object({q:z.string().max(80).optional()}).strict();
const command=z.object({operationId:uuid,action:z.enum(['offer','accept','cancel']),toUserId:z.string().min(1).max(200).optional()}).strict().superRefine((value,ctx)=>{
 if(value.action==='offer'&&!value.toUserId)ctx.addIssue({code:'custom',message:'Choose the member who will take responsibility.'});
 if(value.action!=='offer'&&value.toUserId)ctx.addIssue({code:'custom',message:'Accepting or cancelling does not take a member.'});
});

export async function GET(request:Request,c:Context){
 try{
  const url=new URL(request.url);
  const parsed=query.safeParse(Object.fromEntries(url.searchParams));
  if(!parsed.success)throw new DocumentError('Review the handover request.','record_handover_validation',400);
  const {repo,ctx,recordId}=await open(request,c);
  const result=parsed.data.q===undefined?await repo.state(ctx,recordId):await repo.people(ctx,recordId,parsed.data.q);
  return Response.json(result,{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,c:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,8_000));
  if(!parsed.success)throw new DocumentError('Review the handover and try again.','record_handover_validation',400);
  const {repo,ctx,recordId}=await open(request,c);
  const {operationId,action,toUserId}=parsed.data;
  const result=action==='offer'
   ? await repo.offer(ctx,recordId,{operationId,toUserId:toUserId!})
   : action==='accept'
    ? await repo.accept(ctx,recordId,{operationId})
    : await repo.cancel(ctx,recordId,{operationId});
  return Response.json(result,{headers});
 }catch(error){return failure(error);}
}

async function open(request:Request,c:Context){
 const {actor,authority}=await authenticateRecordAuthority(request);
 const {id:workspaceId,tenantId,recordId}=await c.params;
 return {repo:new SharedRecordResponsibilityRepository(await repository(),authority),ctx:{actor,workspaceId,tenantId},recordId};
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 console.error('HS record responsibility request failed',error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
