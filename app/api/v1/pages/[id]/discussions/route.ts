import { z } from 'zod';
import { api,localPreview,readJson } from '../../../../../../lib/auth';
import { DocumentError } from '../../../../../../lib/document';
import { repository } from '../../../../../../lib/repository';
import { discussions,changeDiscussion } from '../../../../../../lib/discussions';
const operationId=z.string().uuid(),body=z.string().refine(s=>[...s].length<=10000),mentionIds=z.array(z.string().min(1).max(200)).max(50),expectedVersion=z.number().int().positive();
const input=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('create'),operationId,body,mentionIds,baseVersion:expectedVersion,anchors:z.array(z.object({blockId:z.string().min(1).max(100),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict()).max(100)}).strict(),
  z.object({kind:z.literal('reply'),operationId,body,mentionIds,threadId:z.string().uuid()}).strict(),
  z.object({kind:z.literal('edit'),operationId,body,mentionIds,commentId:z.string().uuid(),expectedVersion}).strict(),
  z.object({kind:z.literal('delete'),operationId,commentId:z.string().uuid(),expectedVersion}).strict(),
  z.object({kind:z.literal('restore'),operationId,commentId:z.string().uuid(),expectedVersion}).strict(),
  z.object({kind:z.literal('resolve'),operationId,threadId:z.string().uuid(),expectedVersion}).strict(),
  z.object({kind:z.literal('reopen'),operationId,threadId:z.string().uuid(),expectedVersion}).strict(),
]);
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,{params}:Context){return api(req,async actor=>discussions(await repository(localPreview(req)),actor,(await params).id));}
export async function POST(req:Request,{params}:Context){return api(req,async actor=>{const parsed=input.safeParse(await readJson(req,100000));if(!parsed.success)throw new DocumentError('Invalid discussion request','invalid_comment',422);return changeDiscussion(await repository(localPreview(req)),actor,(await params).id,parsed.data);},true);}
