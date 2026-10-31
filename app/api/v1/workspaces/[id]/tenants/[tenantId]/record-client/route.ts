import {readJson,sameOrigin} from '../../../../../../../../lib/auth';
import {DocumentError} from '../../../../../../../../lib/document';
import {publishRecordClientResult,unavailableRecordClientAuthority} from '../../../../../../../../lib/record-client-authority';
import {repository} from '../../../../../../../../lib/repository';
import {SharedRecordApiV1} from '../../../../../../../../lib/shared-record-api';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};

export async function POST(request:Request,{params}:Context){
 try{
  sameOrigin(request);
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const command=await readJson(request,128_000);
  // No production delegation verifier and no owning-source or historical-reference adapter.
  // The bearer token stays on the request and is not copied into the command context.
  const api=new SharedRecordApiV1(await repository(),authority,unavailableRecordClientAuthority());
  return Response.json(publishRecordClientResult(await api.execute({actor,workspaceId,tenantId,credential:{}},command)),{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 return Response.json({error:'Service temporarily unavailable.',code:'service_unavailable',retryable:true},{status:503,headers});
}
