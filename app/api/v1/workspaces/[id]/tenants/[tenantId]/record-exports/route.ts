import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {recordExportCollections,recordExportRequestLimit} from '../../../../../../../../lib/record-export-contract';
import {repository} from '../../../../../../../../lib/repository';
import {SharedRecordExportRepository} from '../../../../../../../../lib/shared-record-exports';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

export const maxDuration=30;
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const uuid=z.string().uuid();
const reserved=new Set(['id','parentOrganisationId','legalOrganisationIds','accountIds']);
const flags={id:uuid,format:z.enum(['csv','xlsx']),expectedSchemaVersion:z.number().int().positive(),includeIds:z.boolean(),includeRelationships:z.boolean()};
const records=z.object({
  ...flags,
  kind:z.literal('records'),
  collection:z.enum(recordExportCollections),
  recordIds:z.array(uuid).min(1).max(10000),
  columns:z.array(z.string().min(1).max(100)).min(1).max(100),
}).strict().superRefine((value,ctx)=>{
  if(new Set(value.recordIds).size!==value.recordIds.length)ctx.addIssue({code:'custom',message:'Choose each record once.'});
  if(new Set(value.columns).size!==value.columns.length)ctx.addIssue({code:'custom',message:'Choose each column once.'});
  if(value.columns.some(key=>reserved.has(key)))ctx.addIssue({code:'custom',message:'IDs and relationship IDs stay opt-in.'});
});
const prepare=z.discriminatedUnion('kind',[
  z.object({...flags,kind:z.literal('view'),viewId:uuid,expectedViewVersion:z.number().int().positive()}).strict(),
  records,
]);

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const parsed=prepare.safeParse(await readJson(request,recordExportRequestLimit));
  if(!parsed.success)throw new DocumentError('Review the record export scope.','record_export_validation',400);
  // No typed-reference adapter is configured. Nonempty attachment and record values fail closed in the repository.
  const repo=new SharedRecordExportRepository(await repository(),authority);
  return Response.json(await repo.prepareRecordExport({actor,workspaceId,tenantId},parsed.data),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
