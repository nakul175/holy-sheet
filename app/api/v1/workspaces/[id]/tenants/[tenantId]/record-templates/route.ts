import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordTemplateRepository} from '../../../../../../../../lib/shared-record-templates';

type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const defaults=z.object({name:z.string().optional(),values:z.record(z.string(),z.unknown()).default({}),parentOrganisationId:uuid.optional(),legalOrganisationIds:z.array(uuid).min(1).max(100).optional(),accountIds:z.array(uuid).max(100).optional()}).strict();
const selection=z.object({templateId:uuid,templateVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),overrides:defaults}).strict();
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('save'),id:uuid,operationId:uuid,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),defaults}).strict(),
 z.object({kind:z.literal('preview'),selection}).strict(),
 z.object({kind:z.literal('instantiate'),previewId:uuid,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:uuid,selection}).strict(),
]);
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
async function respond(request:Request,c:Context,mutation:boolean){
 try{
  if(mutation)sameOrigin(request);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const {id:workspaceId,tenantId}=await c.params;
  const ctx={actor,workspaceId,tenantId};
  const templates=new SharedRecordTemplateRepository(await repository(),authority);
  let result:unknown;
  if(mutation){
   const parsed=command.safeParse(await readJson(request,128_000));
   if(!parsed.success)throw new DocumentError('Invalid template request.','record_template_validation',400);
   const data=parsed.data;
   if(data.kind==='save'){const {kind:_,...input}=data;result=await templates.saveRecordTemplate(ctx,input);}
   else if(data.kind==='preview')result=await templates.previewRecordTemplate(ctx,data.selection);
   else {const {kind:_,...input}=data;result=await templates.instantiateRecordTemplate(ctx,input);}
  }else{
   const query=z.object({collection:z.string().min(1).max(100).optional(),templateId:uuid.optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),form:z.literal('1').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
   if(!query.success||!!query.data.collection===!!query.data.templateId||query.data.templateId&&(query.data.cursor||query.data.form)||query.data.form&&query.data.cursor)throw new DocumentError('Choose a catalogue or template.','record_template_validation',400);
   result=query.data.form?await templates.recordTemplateForm(ctx,query.data.collection!):query.data.templateId?await templates.getRecordTemplate(ctx,query.data.templateId):await templates.listRecordTemplates(ctx,query.data.collection!,query.data.cursor);
  }
  return Response.json(result,{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  console.error('HS template request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
export async function GET(request:Request,c:Context){return respond(request,c,false);}
export async function POST(request:Request,c:Context){return respond(request,c,true);}
