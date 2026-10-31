import {z} from 'zod';
import {DocumentError} from '../../../../../../../../lib/document';
import {repository} from '../../../../../../../../lib/repository';
import {authenticateRecordAuthority} from '../../../../../../../../lib/suite-tenant-authority';
import {SharedRecordCatalogueRepository} from '../../../../../../../../lib/shared-record-catalogue';

const headers={'Cache-Control':'no-store','Vary':'Cookie, Authorization'};
type Context={params:Promise<{id:string;tenantId:string}>};

export async function GET(request:Request,{params}:Context){
 try{
  const {id:workspaceId,tenantId}=await params,{actor,authority}=await authenticateRecordAuthority(request);
  const query=z.object({collection:z.string().min(1).max(100).optional()}).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if(!query.success)throw new DocumentError('Review the catalogue request.','record_catalogue_validation',400);
  const repo=new SharedRecordCatalogueRepository(await repository(),authority),ctx={actor,workspaceId,tenantId};
  const result=query.data.collection?await repo.describeCatalogue(ctx,query.data.collection):await repo.listCatalogue(ctx);
  return Response.json(result,{headers});
 }catch(error){return failure(error);}
}

function failure(error:unknown){
 if(error instanceof DocumentError)return Response.json({error:error.message,code:error.code,retryable:error.status>=500},{status:error.status,headers});
 console.error('HS catalogue request failed',error instanceof Error?error.name:'UnknownError');
 return Response.json({error:'Service temporarily unavailable',code:'service_unavailable',retryable:true},{status:503,headers});
}
