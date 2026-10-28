import { templateCommandSchema } from '../../../../lib/template-command-schema';
import { api,localPreview,readJson } from '../../../../lib/auth';
import { repository } from '../../../../lib/repository';
import { DocumentError } from '../../../../lib/document';
import { listTemplates,changeTemplate,type TemplateCommand } from '../../../../lib/templates';
export async function GET(req:Request){return api(req,async actor=>{const query=new URL(req.url).searchParams,workspaceId=query.get('workspaceId');if(!workspaceId)throw new DocumentError('Choose a workspace');return listTemplates(await repository(localPreview(req)),actor,workspaceId,(query.get('q')??'').slice(0,200),query.get('scope')??'all');});}
export async function POST(req:Request){return api(req,async actor=>{const workspaceId=new URL(req.url).searchParams.get('workspaceId');if(!workspaceId)throw new DocumentError('Choose a workspace');const parsed=templateCommandSchema.safeParse(await readJson(req,25_000_000));if(!parsed.success)throw new DocumentError('Invalid template command');return changeTemplate(await repository(localPreview(req)),actor,workspaceId,parsed.data as TemplateCommand);},true);}
