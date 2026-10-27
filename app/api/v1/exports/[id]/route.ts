import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../lib/auth';
import {repository} from '../../../../../lib/repository';
import {readExport,cancelExport} from '../../../../../lib/page-exports';
import {DocumentError} from '../../../../../lib/document';
async function idOf(params:Promise<{id:string}>){const id=(await params).id;if(!z.string().uuid().safeParse(id).success)throw new DocumentError('Export unavailable','not_found',404);return id;}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>readExport(await repository(localPreview(req)),actor,await idOf(params)));}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{if(!z.object({action:z.literal('cancel')}).strict().safeParse(await readJson(req,1024)).success)throw new DocumentError('Invalid export action');return cancelExport(await repository(localPreview(req)),actor,await idOf(params));},true);}
