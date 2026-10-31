import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordIntakeRepository} from '../../../../../../../../lib/shared-record-intake';

type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const relationships=z.object({parentOrganisation:z.boolean().default(false),legalOrganisations:z.boolean().default(false),accounts:z.boolean().default(false)}).strict();
const definition=z.object({purpose:z.enum(['create','update']),instructions:z.string().max(500).default(''),rename:z.boolean().default(false),fields:z.array(z.string().min(1).max(100)).min(1).max(40),relationships:relationships.default({parentOrganisation:false,legalOrganisations:false,accounts:false})}).strict();
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),id:uuid,operationId:uuid,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict(),
 z.object({kind:z.literal('submit'),formId:uuid,formVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),operationId:uuid,name:z.string().optional(),values:z.record(z.string(),z.unknown()).default({}),record:z.object({id:uuid,expectedVersion:z.number().int().positive()}).strict().optional(),parentOrganisationId:uuid.optional(),legalOrganisationIds:z.array(uuid).min(1).max(100).optional(),accountIds:z.array(uuid).max(100).optional()}).strict(),
]);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
async function respond(request:Request,c:Context,mutation:boolean){
 try{
  if(mutation)sameOrigin(request);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const {id:workspaceId,tenantId}=await c.params;
  const ctx={actor,workspaceId,tenantId};
  const intake=new SharedRecordIntakeRepository(await repository(),authority);
  let result:unknown;
  if(mutation){
   const parsed=command.safeParse(await readJson(request,128_000));
   if(!parsed.success)throw new DocumentError('Invalid intake request.','record_intake_validation',400);
   const data=parsed.data;
   if(data.kind==='save'){const {kind:_,...input}=data;result=await intake.saveIntakeForm(ctx,input);}
   else {const {kind:_,...input}=data;result=await intake.submitIntakeForm(ctx,input);}
  }else{
   const query=z.object({collection:z.string().min(1).max(100).optional(),formId:uuid.optional(),recordId:uuid.optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),form:z.literal('1').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
   if(!query.success||Number(!!query.data.form)+Number(!!query.data.formId)+Number(!!query.data.collection&&!query.data.form&&!query.data.formId)!==1||!!query.data.form&&(!query.data.collection||!!query.data.formId||!!query.data.recordId||!!query.data.cursor)||!!query.data.formId&&(!!query.data.collection||!!query.data.cursor)||!!query.data.recordId&&!query.data.formId)throw new DocumentError('Choose a catalogue or intake form.','record_intake_validation',400);
   result=query.data.form?await intake.intakeFieldCatalogue(ctx,query.data.collection!):query.data.formId?await intake.openIntakeForm(ctx,query.data.formId,query.data.recordId):await intake.listIntakeForms(ctx,query.data.collection!,query.data.cursor);
  }
  return Response.json(result,{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  console.error('HS intake request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
export async function GET(request:Request,c:Context){return respond(request,c,false);}
export async function POST(request:Request,c:Context){return respond(request,c,true);}
