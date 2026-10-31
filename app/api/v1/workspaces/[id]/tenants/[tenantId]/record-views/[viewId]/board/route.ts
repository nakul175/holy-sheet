import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordViewRepository} from '../../../../../../../../../../lib/shared-record-views';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;viewId:string}>};
const id=z.string().uuid();
const column=z.discriminatedUnion('kind',[z.object({kind:z.literal('choice'),value:z.string().min(1).max(200)}).strict(),z.object({kind:z.literal('unassigned')}).strict()]);
const move=z.object({kind:z.literal('move'),operationId:id,recordId:id,expectedVersion:z.number().int().positive(),schemaVersion:z.number().int().positive(),column}).strict();

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!id.safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const url=new URL(request.url),columnKey=url.searchParams.get('column')??undefined,cursor=url.searchParams.get('cursor')??undefined;
  if(cursor!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw new DocumentError('Invalid view cursor.','record_view_cursor_invalid',400);
  if(cursor!==undefined&&columnKey===undefined)throw new DocumentError('Invalid view cursor.','record_view_cursor_invalid',400);
  const {actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordViewRepository(await repository(),authority);
  return Response.json(await repo.queryBoard({actor,workspaceId,tenantId},viewId,{columnKey,cursor}),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=move.safeParse(await readJson(request,16_000));
  if(!parsed.success)throw new DocumentError('Review the board move.','record_board_validation',400);
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!id.safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const {actor,authority}=await authenticateRecordAuthority(request),repo=new SharedRecordViewRepository(await repository(),authority),{kind:_,...input}=parsed.data;
  return Response.json(await repo.moveBoardCard({actor,workspaceId,tenantId},viewId,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
