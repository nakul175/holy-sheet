import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../../../../lib/auth';
import { repository } from '../../../../../../../lib/repository';
import { restoreHistory } from '../../../../../../../lib/history';
import { DocumentError } from '../../../../../../../lib/document';
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const input=z.object({operationId:z.string().uuid(),previewId:z.string().uuid(),sourceVersion:z.number().int().positive(),expectedVersion:z.number().int().positive()}).strict().safeParse(await readJson(req,4096));if(!input.success)throw new DocumentError('Invalid restore request');return restoreHistory(await repository(localPreview(req)),actor,(await params).id,input.data);},true);}
