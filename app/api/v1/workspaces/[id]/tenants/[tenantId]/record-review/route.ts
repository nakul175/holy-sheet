import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordReviewRepository} from '../../../../../../../../lib/shared-record-review';

type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const definition=z.object({instructions:z.string().max(500).default(''),fields:z.array(z.string().min(1).max(100)).min(1).max(40),commentRequired:z.boolean().default(false)}).strict();
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),id:uuid,operationId:uuid,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict(),
 z.object({kind:z.literal('submit'),workflowId:uuid,workflowVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),recordId:uuid,expectedRecordVersion:z.number().int().positive(),operationId:uuid}).strict(),
 z.object({kind:z.literal('decide'),reviewId:uuid,expectedVersion:z.number().int().positive(),expectedRecordVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),workflowVersion:z.number().int().positive(),decision:z.enum(['approve','reject','request-changes']),comment:z.string().max(1000).optional(),operationId:uuid}).strict(),
]);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
async function respond(request:Request,c:Context,mutation:boolean){
 try{
  if(mutation)sameOrigin(request);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const {id:workspaceId,tenantId}=await c.params;
  const ctx={actor,workspaceId,tenantId};
  const reviews=new SharedRecordReviewRepository(await repository(),authority);
  let result:unknown;
  if(mutation){
   const parsed=command.safeParse(await readJson(request,128_000));
   if(!parsed.success)throw new DocumentError('Invalid review request.','record_review_validation',400);
   const data=parsed.data;
   if(data.kind==='save'){const {kind:_,...input}=data;result=await reviews.saveReviewWorkflow(ctx,input);}
   else if(data.kind==='submit'){const {kind:_,...input}=data;result=await reviews.submitReview(ctx,input);}
   else {const {kind:_,...input}=data;result=await reviews.decideReview(ctx,input);}
  }else{
   const query=z.object({collection:z.string().min(1).max(100).optional(),workflowId:uuid.optional(),recordId:uuid.optional(),reviewId:uuid.optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),form:z.literal('1').optional(),queue:z.literal('pending').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
   const data=query.success?query.data:undefined;
   const modes=data?[!!data.form,!!data.reviewId,!!data.workflowId,!!data.queue,!!data.collection&&!data.form&&!data.reviewId&&!data.workflowId&&!data.queue]:[];
   if(!data||modes.filter(Boolean).length!==1||!!data.form&&(!data.collection||!!data.workflowId||!!data.recordId||!!data.reviewId||!!data.cursor||!!data.queue)||!!data.reviewId&&(!!data.collection||!!data.workflowId||!!data.recordId||!!data.cursor||!!data.form||!!data.queue)||!!data.workflowId&&(!!data.collection||!!data.reviewId||!!data.cursor||!!data.form||!!data.queue)||!!data.queue&&(!data.collection||!!data.workflowId||!!data.recordId||!!data.reviewId||!!data.form)||!!data.recordId&&!data.workflowId)throw new DocumentError('Choose a review catalogue or record.','record_review_validation',400);
   result=data.form?await reviews.reviewFieldCatalogue(ctx,data.collection!):data.reviewId?await reviews.openReview(ctx,data.reviewId):data.workflowId?await reviews.openReviewWorkflow(ctx,data.workflowId,data.recordId):data.queue?await reviews.listReviewQueue(ctx,data.collection!,data.cursor):await reviews.listReviewWorkflows(ctx,data.collection!,data.cursor);
  }
  return Response.json(result,{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  console.error('HS review request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
export async function GET(request:Request,c:Context){return respond(request,c,false);}
export async function POST(request:Request,c:Context){return respond(request,c,true);}
