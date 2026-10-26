import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../lib/auth';
import { repository } from '../../../../lib/repository';
import { inbox,readNotification } from '../../../../lib/notifications';
import { DocumentError } from '../../../../lib/document';
export async function GET(req:Request){return api(req,async actor=>inbox(await repository(localPreview(req)),actor));}
export async function POST(req:Request){return api(req,async actor=>{const parsed=z.object({id:z.string().uuid()}).strict().safeParse(await readJson(req,1024));if(!parsed.success)throw new DocumentError('Invalid notification');return readNotification(await repository(localPreview(req)),actor,parsed.data.id);},true);}
