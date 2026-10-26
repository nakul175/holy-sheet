import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../../../lib/auth';
import { DocumentError } from '../../../../../../lib/document';
import { repository } from '../../../../../../lib/repository';
import { sharingState,changeSharing } from '../../../../../../lib/sharing';
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,{params}:Context){return api(req,async actor=>sharingState(await repository(localPreview(req)),actor,(await params).id));}
export async function POST(req:Request,{params}:Context){return api(req,async actor=>{
  const parsed=z.object({operationId:z.string().uuid(),expectedVersion:z.number().int().positive(),recipientId:z.string().min(1).max(200),role:z.enum(['editor','viewer']).nullable()}).strict().safeParse(await readJson(req,4096));
  if(!parsed.success)throw new DocumentError('Invalid sharing change');return changeSharing(await repository(localPreview(req)),actor,(await params).id,parsed.data);
},true);}
