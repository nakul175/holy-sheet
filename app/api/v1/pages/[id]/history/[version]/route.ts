import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../../../../lib/auth';
import { repository } from '../../../../../../../lib/repository';
import { previewHistory,recordHistoryCompare } from '../../../../../../../lib/history';
import { DocumentError } from '../../../../../../../lib/document';
type Context={params:Promise<{id:string;version:string}>};
async function version(context:Context){const params=await context.params,parsed=z.coerce.number().int().positive().safeParse(params.version);if(!parsed.success)throw new DocumentError('Invalid saved version');return {id:params.id,version:parsed.data};}
export async function GET(req:Request,context:Context){return api(req,async actor=>{const p=await version(context);return previewHistory(await repository(localPreview(req)),actor,p.id,p.version);});}
export async function POST(req:Request,context:Context){return api(req,async actor=>{const input=z.object({action:z.literal('compare')}).strict().safeParse(await readJson(req,1024));if(!input.success)throw new DocumentError('Invalid history action');const p=await version(context);return recordHistoryCompare(await repository(localPreview(req)),actor,p.id,p.version);},true);}
