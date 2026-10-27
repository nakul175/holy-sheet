import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { draftKey,discardRecovery } from "../../../../../../lib/drafts";
import { repository } from "../../../../../../lib/repository";
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const p=z.object({id:z.string().uuid(),renew:z.boolean().optional(),existingOnly:z.boolean().optional(),attachmentIds:z.array(z.string().uuid()).max(100).optional(),baseVersion:z.number().int().positive().optional()}).strict().safeParse(await readJson(req,16384));if(!p.success)throw new DocumentError("Invalid recovery request");return draftKey(await repository(localPreview(req)),actor,(await params).id,p.data);},true);}
export async function DELETE(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const id=z.string().uuid().safeParse(new URL(req.url).searchParams.get('draftId'));if(!id.success)throw new DocumentError('Invalid recovery identifier');return discardRecovery(await repository(localPreview(req)),actor,(await params).id,id.data);},true);}
