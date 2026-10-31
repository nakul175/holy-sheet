import {z} from 'zod';
import {readJson,sameOrigin} from '../../../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../../../lib/document';
import {repository} from '../../../../../../../../../../lib/repository';
import {SharedRecordExportRepository} from '../../../../../../../../../../lib/shared-record-exports';
import {authenticateRecordAuthority} from '../../../../../../../../../../lib/suite-tenant-authority';

export const maxDuration=30;
const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
type Context={params:Promise<{id:string;tenantId:string;jobId:string}>};
const csv='text/csv; charset=utf-8';
const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const download=z.object({reviewHash:z.string().regex(/^[a-f0-9]{64}$/),acknowledgeEscaping:z.boolean()}).strict();

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const parsed=download.safeParse(await readJson(request,64_000));
  if(!parsed.success)throw new DocumentError('Confirm the reviewed export.','record_export_validation',400);
  const {id:workspaceId,tenantId,jobId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const repo=new SharedRecordExportRepository(await repository(),authority);
  const file=await repo.downloadRecordExport({actor,workspaceId,tenantId},jobId,parsed.data);
  const bytes=file.bytes instanceof Uint8Array?file.bytes:null;
  const type=file.contentType===csv?csv:file.contentType===xlsx?xlsx:'';
  const filename=type===csv?'holy-sheet-records.csv':type===xlsx?'holy-sheet-records.xlsx':'';
  if(!bytes||!filename)throw new DocumentError('The export file is unavailable.','record_export_unavailable',404);
  return new Response(Buffer.from(bytes),{headers:{...headers,'Content-Type':type,'Content-Disposition':`attachment; filename="${filename}"`}});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
