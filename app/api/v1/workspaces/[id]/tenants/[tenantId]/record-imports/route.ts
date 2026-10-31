import {z} from 'zod';
import {readBytes,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {recordImportSourceLimit} from '../../../../../../../../lib/record-import-contract';
import {repository} from '../../../../../../../../lib/repository';
import {SharedRecordImportRepository} from '../../../../../../../../lib/shared-record-imports';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

export const maxDuration=30;
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};
const sourceName=z.string().trim().min(1).max(200).refine(value=>!/[\p{Cc}\\/]/u.test(value));
const stage=z.object({id:z.string().uuid(),collection:z.string().min(1).max(100),name:sourceName,format:z.enum(['csv','xlsx']),sheetIndex:z.number().int().min(0).max(99).optional()}).strict();

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const header=request.headers.get('x-hs-record-import')??'';
  if(!header||header.length>4096||!/^[A-Za-z0-9_-]+$/.test(header))throw new DocumentError('Import metadata is required.','record_import_validation',400);
  let metadata:unknown;
  try{metadata=JSON.parse(Buffer.from(header,'base64url').toString('utf8'));}catch{throw new DocumentError('Invalid import metadata.','record_import_validation',400);}
  const parsed=stage.safeParse(metadata);
  if(!parsed.success)throw new DocumentError('Choose a supported import source.','record_import_validation',400);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/octet-stream')throw new DocumentError('Send one binary source file.','record_import_type',400);
  const bytes=await readBytes(request,recordImportSourceLimit);
  const repo=new SharedRecordImportRepository(await repository(),authority);
  return Response.json(await repo.stageImport({actor,workspaceId,tenantId},parsed.data,bytes),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
