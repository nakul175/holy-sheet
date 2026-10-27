import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {exportPolicy,changeExportPolicy} from '../../../../../../lib/page-exports';
import {DocumentError} from '../../../../../../lib/document';
const schema=z.object({operationId:z.string().uuid(),expectedVersion:z.number().int().positive(),enabled:z.boolean()}).strict();
async function workspaceId(params:Promise<{id:string}>){const id=(await params).id;if(!id||id.length>200)throw new DocumentError('Workspace unavailable','not_found',404);return id;}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>exportPolicy(await repository(localPreview(req)),actor,await workspaceId(params)));}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const input=schema.safeParse(await readJson(req,2048));if(!input.success)throw new DocumentError('Invalid export policy request');return changeExportPolicy(await repository(localPreview(req)),actor,await workspaceId(params),input.data);},true);}
