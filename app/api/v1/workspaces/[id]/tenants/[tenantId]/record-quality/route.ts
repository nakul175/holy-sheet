import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordQualityRepository} from '../../../../../../../../lib/shared-record-quality';

type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const clause=z.object({field:z.string().min(1).max(100),operator:z.enum(['is-empty','is-not-empty','equals','not-equals','greater-than','less-than','contains-any','contains-all']),value:z.unknown().optional()}).strict();
const when=z.union([z.object({all:z.array(clause).min(1).max(5)}).strict(),z.object({any:z.array(clause).min(1).max(5)}).strict()]);
const predicate=z.object({operator:z.enum(['is-not-empty','equals','not-equals','greater-than','less-than','min-length','max-length']),value:z.unknown().optional()}).strict();
const check=z.discriminatedUnion('kind',[
 z.object({id:uuid,field:z.string().min(1).max(100),kind:z.literal('required'),when:when.optional()}).strict(),
 z.object({id:uuid,field:z.string().min(1).max(100),kind:z.literal('quality'),predicate,when:when.optional()}).strict(),
]);
const definition=z.object({layoutId:z.string().uuid().nullable().default(null),enforcement:z.enum(['advisory','block']).default('advisory'),checks:z.array(check).min(1).max(40)}).strict();
const command=z.object({kind:z.literal('save'),id:uuid,operationId:uuid,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict();
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
async function respond(request:Request,c:Context,mutation:boolean){
 try{
  if(mutation)sameOrigin(request);
  const {actor,authority}=await authenticateRecordAuthority(request);
  const {id:workspaceId,tenantId}=await c.params;
  const ctx={actor,workspaceId,tenantId};
  const quality=new SharedRecordQualityRepository(await repository(),authority);
  let result:unknown;
  if(mutation){
   const parsed=command.safeParse(await readJson(request,128_000));
   if(!parsed.success)throw new DocumentError('Invalid quality request.','record_quality_validation',400);
   const {kind:_,...input}=parsed.data;
   result=await quality.saveQualityRule(ctx,input);
  }else{
   const query=z.object({collection:z.string().min(1).max(100).optional(),ruleId:uuid.optional(),recordId:uuid.optional(),cursor:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),form:z.literal('1').optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
   const data=query.success?query.data:undefined;
   const form=!!data?.form,rule=!!data?.ruleId,evaluate=!!data?.recordId,list=!!data?.collection&&!form&&!rule&&!evaluate;
   if(!data||[form,rule,evaluate,list].filter(Boolean).length!==1||form&&(!data.collection||data.ruleId||data.recordId||data.cursor)||rule&&(data.collection||data.recordId||data.cursor||data.form)||evaluate&&(!data.collection||data.ruleId||data.cursor||data.form))throw new DocumentError('Choose a quality catalogue or record.','record_quality_validation',400);
   result=form?await quality.qualityFieldCatalogue(ctx,data.collection!):rule?await quality.openQualityRule(ctx,data.ruleId!):evaluate?await quality.evaluateQuality(ctx,data.collection!,data.recordId!):await quality.listQualityRules(ctx,data.collection!,data.cursor);
  }
  return Response.json(result,{headers});
 }catch(error){
  if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
  console.error('HS quality request failed',error instanceof Error?error.name:'UnknownError');
  return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
 }
}
export async function GET(request:Request,c:Context){return respond(request,c,false);}
export async function POST(request:Request,c:Context){return respond(request,c,true);}
