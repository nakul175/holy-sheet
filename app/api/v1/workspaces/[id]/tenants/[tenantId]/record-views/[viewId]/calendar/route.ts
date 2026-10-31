import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {calendarDate,calendarSpan} from '../../../../../../../../../../lib/shared-record-view-query';
import {SharedRecordViewRepository} from '../../../../../../../../../../lib/shared-record-views';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string;viewId:string}>};
const id=z.string().uuid();
const reschedule=z.object({kind:z.literal('reschedule'),operationId:id,recordId:id,expectedVersion:z.number().int().positive(),schemaVersion:z.number().int().positive(),date:z.string()}).strict();

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!id.safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const url=new URL(request.url),from=url.searchParams.get('from')??'',to=url.searchParams.get('to')??'',cursor=url.searchParams.get('cursor')??undefined;
  if(!calendarSpan(from,to))throw new DocumentError('Review the calendar range.','record_calendar_validation',400);
  if(cursor!==undefined&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw new DocumentError('Invalid view cursor.','record_view_cursor_invalid',400);
  const repo=new SharedRecordViewRepository(await repository(),authority);
  return Response.json(await repo.queryCalendar({actor,workspaceId,tenantId},viewId,{from,to,cursor}),{headers});
 }catch(error){return failure(error);}
}

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=reschedule.safeParse(await readJson(request,16_000));
  if(!parsed.success)throw new DocumentError('Review the calendar date.','record_calendar_validation',400);
  const {id:workspaceId,tenantId,viewId}=await params;
  if(!id.safeParse(viewId).success)throw new DocumentError('The view is restricted or unavailable.','record_view_unavailable',404);
  const {actor,authority}=await authenticateRecordAuthority(request);
  if(!calendarDate(parsed.data.date))throw new DocumentError('Review the calendar date.','record_calendar_validation',400);
  const repo=new SharedRecordViewRepository(await repository(),authority),{kind:_,...input}=parsed.data;
  return Response.json(await repo.rescheduleCalendarEvent({actor,workspaceId,tenantId},viewId,input),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
