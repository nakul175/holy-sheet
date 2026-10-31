import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordImportRepository} from '../../../../../../../../../../lib/shared-record-imports';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
type Context={params:Promise<{id:string;tenantId:string;jobId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordImportRepository(await repository(),authority);
  const report=await repo.importReport({actor,workspaceId,tenantId},jobId);
  const bytes=report.bytes instanceof Uint8Array?report.bytes:null;
  if(!bytes)throw new DocumentError('The import report is unavailable.','record_import_unavailable',404);
  const type=typeof report.contentType==='string'&&report.contentType.startsWith('text/csv')?report.contentType:'text/csv; charset=utf-8';
  return new Response(Buffer.from(bytes),{headers:{...headers,'Content-Type':type,'Content-Disposition':'attachment; filename="record-import-report.csv"'}});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
