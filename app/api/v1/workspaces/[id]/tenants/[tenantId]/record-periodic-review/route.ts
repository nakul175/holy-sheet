import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordPeriodicReviewRepository} from '../../../../../../../../lib/shared-record-periodic-review';

type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const filter=z.object({field:z.string().min(1).max(100),operator:z.enum(['equal','contains','prefix','greater','less','in','includes','empty']),value:z.unknown().optional()}).strict();
const definition=z.object({workflowId:uuid,intervalDays:z.number().int().min(1).max(3650),windowDays:z.number().int().min(0).max(3650),layoutId:z.string().uuid().nullable().default(null),filters:z.array(filter).max(5).default([])}).strict();
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),id:uuid,operationId:uuid,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict(),
 z.object({kind:z.literal('start'),scheduleId:uuid,recordId:uuid,expectedScheduleVersion:z.number().int().positive(),expectedRecordVersion:z.number().int().positive(),operationId:uuid}).strict(),
]);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
async function respond(request:Request,c:Context,mutation:boolean){
 try{
  if(mutation)sameOrigin(request);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const {id:workspaceId,tenantId}=await c.params;
  const ctx={actor,workspaceId,tenantId};
  const schedules=new SharedRecordPeriodicReviewRepository(await repository(),authority);
  let result:unknown;
  if(mutation){
   const parsed=command.safeParse(await readJson(request,128_000));
   if(!parsed.success)throw new DocumentError('Invalid periodic review request.','record_periodic_review_validation',400);
   if(parsed.data.kind==='save'){const {kind:_,...input}=parsed.data;result=await schedules.savePeriodicSchedule(ctx,input);}
   else {const {kind:_,...input}=parsed.data;result=await schedules.startPeriodicReview(ctx,input);}
  }else{
   const query=z.object({collection:z.string().min(1).max(100).optional(),scheduleId:uuid.optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),form:z.literal('1').optional(),due:z.literal('1').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
   const data=query.success?query.data:undefined;
   const form=!!data?.form,due=!!data?.due,open=!!data?.scheduleId&&!due,list=!!data?.collection&&!form&&!due&&!data.scheduleId;
   if(!data||[form,due,open,list].filter(Boolean).length!==1||form&&(!data.collection||data.scheduleId||data.cursor||data.due)||due&&(!data.collection||!data.scheduleId||data.form)||open&&(data.collection||data.cursor||data.form||data.due))throw new DocumentError('Choose a periodic review schedule or collection.','record_periodic_review_validation',400);
   result=form?await schedules.periodicReviewCatalogue(ctx,data.collection!):due?await schedules.listDueRecords(ctx,data.collection!,data.scheduleId!,data.cursor):open?await schedules.openPeriodicSchedule(ctx,data.scheduleId!):await schedules.listPeriodicSchedules(ctx,data.collection!,data.cursor);
  }
  return Response.json(result,{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  console.error('HS periodic review request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
export async function GET(request:Request,c:Context){return respond(request,c,false);}
export async function POST(request:Request,c:Context){return respond(request,c,true);}
