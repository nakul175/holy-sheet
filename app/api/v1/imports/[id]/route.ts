import {z} from 'zod';
import {api,localPreview,readJson} from '../../../../../lib/auth';
import {repository} from '../../../../../lib/repository';
import {readImport,changeImport} from '../../../../../lib/document-imports';
import {DocumentError} from '../../../../../lib/document';
const schema=z.object({action:z.enum(['commit','cancel']),reviewHash:z.string().regex(/^[a-f0-9]{64}$/),omitImages:z.boolean().optional()}).strict();
async function idOf(params:Promise<{id:string}>){const id=(await params).id;if(!z.string().uuid().safeParse(id).success)throw new DocumentError('Import unavailable','not_found',404);return id;}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>readImport(await repository(localPreview(req)),actor,await idOf(params)));}
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const input=schema.safeParse(await readJson(req,2048));if(!input.success)throw new DocumentError('Invalid import action');return changeImport(await repository(localPreview(req)),actor,await idOf(params),input.data);},true);}
