import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordNotificationsRepository} from '../../../../../../../../lib/record-notifications';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const query=z.object({}).strict();
const command=z.object({id:z.string().uuid()}).strict();

export async function GET(request:Request,c:Context){
 try{
  const parsed=query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!parsed.success)throw new DocumentError('Review the notification request.','record_notification_validation',400);
  const {repo,ctx}=await open(request,c);
  return Response.json(await repo.listNotifications(ctx),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,c:Context){
 try{
  sameOrigin(request);
  const parsed=command.safeParse(await readJson(request,1024));
  if(!parsed.success)throw new DocumentError('Review the notification request.','record_notification_validation',400);
  const {repo,ctx}=await open(request,c);
  return Response.json(await repo.readNotification(ctx,parsed.data.id),{headers});
 }catch(error){return failure(error);}
}

async function open(request:Request,c:Context){
 const {actor,authority}=await authenticateRecordAuthority(request);
 const {id:workspaceId,tenantId}=await c.params;
 return {repo:new SharedRecordNotificationsRepository(await repository(),authority),ctx:{actor,workspaceId,tenantId}};
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 console.error('HS record notification request failed',error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
