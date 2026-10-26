import { api,localPreview } from '../../../../../lib/auth';
import { repository } from '../../../../../lib/repository';
import { DocumentError } from '../../../../../lib/document';
import { readTemplate } from '../../../../../lib/templates';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const query=new URL(req.url).searchParams,workspaceId=query.get('workspaceId');if(!workspaceId)throw new DocumentError('Choose a workspace');return readTemplate(await repository(localPreview(req)),actor,workspaceId,(await params).id,query.get('draft')==='1');});}
