import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../../lib/auth';
import {repository} from '../../../../../../lib/repository';
import {previewExport,createExport} from '../../../../../../lib/page-exports';
import {DocumentError} from '../../../../../../lib/document';
const format=z.enum(['pdf','markdown']),schema=z.object({id:z.string().uuid(),expectedVersion:z.number().int().positive(),format}).strict();
async function pageId(params:Promise<{id:string}>){const id=(await params).id;if(!id||id.length>200)throw new DocumentError('Page unavailable','not_found',404);return id;}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const query=z.object({format:format.default('pdf')}).strict().safeParse(Object.fromEntries(new URL(req.url).searchParams));if(!query.success)throw new DocumentError('Choose PDF or Markdown for the current saved page.');return previewExport(await repository(localPreview(req)),actor,await pageId(params),query.data.format);});}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const input=schema.safeParse(await readJson(req,2048));if(!input.success)throw new DocumentError('Invalid export request');return createExport(await repository(localPreview(req)),actor,await pageId(params),input.data);},true);}
