import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordFollowsRepository} from '../../../../../../../../../../lib/shared-record-follows';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;recordId:string}>};
const empty=z.object({}).strict();

export async function GET(request:Request,c:Context){
 try{
  const {repo,ctx,recordId}=await open(request,c);
  return Response.json(await repo.followState(ctx,recordId),{headers});
 }catch(error){return failure(error);}
}

export async function PUT(request:Request,c:Context){return change(request,c,true);}
export async function DELETE(request:Request,c:Context){return change(request,c,false);}

async function change(request:Request,c:Context,following:boolean){
 try{
  sameOrigin(request);
  const parsed=empty.safeParse(await readJson(request,1024));
  if(!parsed.success)throw new DocumentError('Review the follow request.','record_follow_validation',400);
  const {repo,ctx,recordId}=await open(request,c);
  return Response.json(following?await repo.follow(ctx,recordId):await repo.unfollow(ctx,recordId),{headers});
 }catch(error){return failure(error);}
}

async function open(request:Request,c:Context){
 const {actor,authority}=await authenticateRecordAuthority(request);
 const {id:workspaceId,tenantId,recordId}=await c.params;
 return {repo:new SharedRecordFollowsRepository(await repository(),authority),ctx:{actor,workspaceId,tenantId},recordId};
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 console.error('HS record follow request failed',error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
