import { z } from 'zod';
import { api,localPreview } from '../../../../../../lib/auth';
import { repository } from '../../../../../../lib/repository';
import { listHistory } from '../../../../../../lib/history';
import { DocumentError } from '../../../../../../lib/document';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const raw=new URL(req.url).searchParams.get('before'),before=raw===null?undefined:z.coerce.number().int().positive().safeParse(raw);if(before&&!before.success)throw new DocumentError('Invalid history cursor');return listHistory(await repository(localPreview(req)),actor,(await params).id,before?.data);});}
