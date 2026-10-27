import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { reserveMedia, mediaPolicy } from "../../../../../../lib/media";
import { repository } from "../../../../../../lib/repository";
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const p=z.object({operationId:z.string().uuid(),name:z.string(),size:z.number().int().positive(),replacedId:z.string().uuid().optional(),recoveryDraftId:z.string().uuid().optional()}).strict().safeParse(await readJson(req,8192));if(!p.success)throw new DocumentError("Invalid upload reservation");return reserveMedia(await repository(localPreview(req)),actor,(await params).id,p.data);},true);}
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){return api(req,async actor=>{const r=await repository(localPreview(req));await r.access(r.db,(await params).id,actor);return mediaPolicy;});}
