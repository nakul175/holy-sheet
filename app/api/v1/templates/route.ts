import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../lib/auth';
import { repository } from '../../../../lib/repository';
import { DocumentError } from '../../../../lib/document';
import { listTemplates,changeTemplate,type TemplateCommand } from '../../../../lib/templates';
export async function GET(req:Request){return api(req,async actor=>{const query=new URL(req.url).searchParams,workspaceId=query.get('workspaceId');if(!workspaceId)throw new DocumentError('Choose a workspace');return listTemplates(await repository(localPreview(req)),actor,workspaceId,(query.get('q')??'').slice(0,200),query.get('scope')??'all');});}
const common={operationId:z.string().uuid()},schema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('save'),id:z.string().min(1).optional(),expectedDraftVersion:z.number().int().positive().optional(),name:z.string().max(100),description:z.string().max(500).default(''),document:z.unknown().optional(),sourcePageId:z.string().min(1).optional(),sourcePageVersion:z.number().int().positive().optional()}).strict(),
 z.object({...common,kind:z.enum(['publish','archive']),id:z.string().min(1),expectedDraftVersion:z.number().int().positive()}).strict(),
 z.object({...common,kind:z.literal('instantiate'),id:z.string().min(1),revision:z.number().int().positive(),spaceId:z.string().min(1),title:z.string().max(240)}).strict(),
]);
export async function POST(req:Request){return api(req,async actor=>{const workspaceId=new URL(req.url).searchParams.get('workspaceId');if(!workspaceId)throw new DocumentError('Choose a workspace');const parsed=schema.safeParse(await readJson(req,25_000_000));if(!parsed.success)throw new DocumentError('Invalid template command');return changeTemplate(await repository(localPreview(req)),actor,workspaceId,parsed.data as TemplateCommand);},true);}
